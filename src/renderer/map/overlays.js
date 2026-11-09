// The layer stack, as on the phone (map/OverlayLayerController.kt): GeoTIFF
// surveys, MBTiles files and online tile layers, bottom to top, all drawn
// below the anchor so waypoints and routes stay on top.

import maplibregl from 'maplibre-gl';
import { api, log, logError, saveList, loadList, uuid } from '../core.js';
import { OVERLAY_ANCHOR } from './style.js';
import { Survey } from '../geotiff/survey.js';
import { autoFitRamp, normalised, renderDepth } from '../geotiff/depth.js';
import { rasterQuality } from '../settings/presets.js';

export const LayerKind = { GEOTIFF: 'GEOTIFF', MBTILES: 'MBTILES', XYZ: 'XYZ' };
const CONTOUR_COLOR = '#00C8B4';
const TILE_PROTOCOL = 'sbsurvey';

const sourceId = (id) => `layer-src-${id}`;
const layerId = (id) => `layer-${id}`;
const detailSourceId = (id) => `layer-detail-src-${id}`;
const detailLayerId = (id) => `layer-detail-${id}`;

const rampKey = (ramp) => JSON.stringify(normalised(ramp));

// ------------------------------------------------------------------ survey detail tiles

const surveys = new Map(); // layer id -> { survey, ramp, size }
const tileCache = new Map(); // "id/z/x/y" -> Float32Array | null (LRU by insertion order)
const TILE_CACHE_LIMIT = 96;
let emptyPng = null;

async function transparentPng() {
  if (!emptyPng) {
    const canvas = new OffscreenCanvas(1, 1);
    emptyPng = await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer();
  }
  return emptyPng.slice(0);
}

maplibregl.addProtocol(TILE_PROTOCOL, async (params) => {
  const url = new URL(params.url);
  const id = url.hostname;
  const [z, x, y] = url.pathname.split('/').filter(Boolean).map(Number);
  const entry = surveys.get(id);
  if (!entry) return { data: await transparentPng() };
  const key = `${id}/${z}/${x}/${y}/${entry.size}`;
  let values;
  if (tileCache.has(key)) {
    values = tileCache.get(key);
    tileCache.delete(key);
    tileCache.set(key, values);
  } else {
    // A failed read is tried once more and never cached, so the tile is
    // asked for again next time instead of showing the overview for good.
    let failed = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        values = await entry.survey.tileValues(z, x, y, entry.size);
        failed = false;
        break;
      } catch (error) {
        failed = true;
        values = null;
        if (attempt === 2) logError('SeaBathyLayers', `tile ${z}/${x}/${y} FAILED`, error.errors?.[0] || error);
      }
    }
    if (!failed) {
      tileCache.set(key, values);
      while (tileCache.size > TILE_CACHE_LIMIT) tileCache.delete(tileCache.keys().next().value);
    }
  }
  if (!values) return { data: await transparentPng() };
  const metres = entry.survey.pixelMetres(z, entry.size);
  const rgba = renderDepth(values, entry.size, entry.size, entry.ramp, { cellX: metres, cellY: metres });
  const canvas = new OffscreenCanvas(entry.size, entry.size);
  canvas.getContext('2d').putImageData(new ImageData(rgba, entry.size, entry.size), 0, 0);
  return { data: await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer() };
});

// ------------------------------------------------------------------ the stack

export class OverlayLayers {
  /** callbacks: onStackChanged(), onVisibilityChanged(), onMessage(text), showArea(bounds) */
  constructor(map, callbacks) {
    this.map = map;
    this.callbacks = callbacks;
    this.layers = []; // bottom to top
    this.unavailable = []; // saved but couldn't load this session
    this.mbtiles = new Map(); // layer id -> { id, url, isVector, bounds, minZoom, maxZoom }
    this.overviews = new Map(); // layer id -> { url, corners }
    this.restored = false;
  }

  get stackTopFirst() {
    return [...this.layers].reverse();
  }

  surveyFor(id) {
    return surveys.get(id)?.survey || null;
  }

  depthSourceFor(id) {
    const survey = this.surveyFor(id);
    return survey?.isDepth ? survey : null;
  }

  // ---------------------------------------------------------------- restore

  async restore(onLayer) {
    const saved = await loadList('layers');
    const unavailable = await loadList('layers-unavailable').catch(() => []);
    for (const record of [...unavailable, ...saved]) {
      if (this.layers.some((l) => l.id === record.id)) continue;
      const ok = await this.prepare(record);
      log('SeaBathyLayers', `restore prepare ${record.kind}:${record.name} -> ${ok ? 'ok' : 'NULL (kept, retried next launch)'}`);
      if (ok) {
        this.layers.push(record);
        this.attach(record);
        onLayer?.();
      } else {
        this.unavailable.push(record);
      }
    }
    this.restored = true;
    this.persist();
    this.callbacks.onStackChanged();
  }

  /** Opens what a saved layer needs; false when its file can't be read now. */
  async prepare(layer) {
    try {
      if (layer.kind === LayerKind.XYZ) return true;
      if (layer.kind === LayerKind.MBTILES) {
        const result = await api.openMbtiles(layer.source);
        if (!result.ok) return false;
        this.mbtiles.set(layer.id, result.layer);
        return true;
      }
      const info = await api.tifFromPath(layer.source);
      if (!info) return false;
      const survey = await Survey.open(info, { maxDim: rasterQuality().maxDimension, flipped: layer.flipped ?? null });
      this.registerSurvey(layer, survey);
      return true;
    } catch (error) {
      logError('SeaBathyLayers', `restore ${layer.kind}:${layer.name} FAILED`, error);
      return false;
    }
  }

  registerSurvey(layer, survey) {
    surveys.set(layer.id, { survey, ramp: layer.ramp || autoFitRamp(survey.shallowestMetres ?? 0, survey.deepestMetres ?? -100), size: rasterQuality().tilePixels });
    if (survey.isDepth && !layer.ramp) layer.ramp = surveys.get(layer.id).ramp;
    layer.maxZoom = survey.nativeMaxZoom;
    this.renderOverview(layer);
  }

  // ---------------------------------------------------------------- adding

  /** A GeoTIFF the user picked; resolves to the new layer. */
  async addGeoTiff(info, { onProgress, attribution = '' } = {}) {
    const survey = await Survey.open(info, { maxDim: rasterQuality().maxDimension, onProgress });
    if (!survey.bounds) {
      survey.close();
      throw new Error("This GeoTIFF's map projection isn't supported, so it can't be placed on the chart.");
    }
    const layer = {
      id: uuid(), kind: LayerKind.GEOTIFF, name: info.name.replace(/\.tiff?$/i, ''), source: info.path,
      visible: true, opacity: 1, ramp: null, attribution, flipped: survey.model.flipped
    };
    this.registerSurvey(layer, survey);
    this.append(layer, { belowDepthLayers: !survey.isDepth });
    return layer;
  }

  async addMbtiles(path, { name = null, attribution = '' } = {}) {
    const result = await api.openMbtiles(path);
    if (!result.ok) throw new Error(result.message);
    const info = result.layer;
    const layer = {
      id: uuid(), kind: LayerKind.MBTILES, name: name || info.name || path.split(/[\\/]/).pop().replace(/\.mbtiles$/i, ''),
      source: path, visible: true, opacity: 1, attribution: attribution || info.attribution || ''
    };
    this.mbtiles.set(layer.id, info);
    // Imagery and raster charts go under depth surveys; a vector chart's lines stay on top.
    this.append(layer, { belowDepthLayers: !info.isVector });
    return layer;
  }

  addXyz(name, urlTemplate, attribution, opacity = 1, maxZoom = 22) {
    const layer = { id: uuid(), kind: LayerKind.XYZ, name, source: urlTemplate, visible: true, opacity, attribution, maxZoom };
    this.append(layer, { belowDepthLayers: true });
    return layer;
  }

  append(layer, { belowDepthLayers = false } = {}) {
    if (belowDepthLayers) {
      const firstDepth = this.layers.findIndex((l) => this.depthSourceFor(l.id));
      if (firstDepth >= 0) this.layers.splice(firstDepth, 0, layer);
      else this.layers.push(layer);
    } else {
      this.layers.push(layer);
    }
    this.reattachAll();
    this.persist();
    this.callbacks.onStackChanged();
  }

  // ---------------------------------------------------------------- editing

  remove(id) {
    const unavailableIndex = this.unavailable.findIndex((l) => l.id === id);
    if (unavailableIndex >= 0) {
      this.unavailable.splice(unavailableIndex, 1);
    } else {
      this.detach(id);
      this.layers = this.layers.filter((l) => l.id !== id);
      surveys.get(id)?.survey.close();
      surveys.delete(id);
      const tiles = this.mbtiles.get(id);
      if (tiles) api.closeMbtiles(tiles.id);
      this.mbtiles.delete(id);
      const overview = this.overviews.get(id);
      if (overview) URL.revokeObjectURL(overview.url);
      this.overviews.delete(id);
    }
    this.persist();
    this.callbacks.onStackChanged();
  }

  /** delta +1 moves up the stack (drawn above), -1 down. */
  move(id, delta) {
    const i = this.layers.findIndex((l) => l.id === id);
    const j = i + delta;
    if (i < 0 || j < 0 || j >= this.layers.length) return;
    [this.layers[i], this.layers[j]] = [this.layers[j], this.layers[i]];
    this.reattachAll();
    this.persist();
    this.callbacks.onStackChanged();
  }

  sendToBottom(id) {
    const i = this.layers.findIndex((l) => l.id === id);
    if (i <= 0) return;
    this.layers.unshift(...this.layers.splice(i, 1));
    this.reattachAll();
    this.persist();
    this.callbacks.onStackChanged();
  }

  setVisible(id, visible) {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.visible = visible;
    for (const lid of [layerId(id), detailLayerId(id)]) {
      if (this.map.getLayer(lid)) this.map.setLayoutProperty(lid, 'visibility', visible ? 'visible' : 'none');
    }
    this.persist();
    this.callbacks.onVisibilityChanged();
  }

  setOpacity(id, opacity, persistNow = true) {
    const layer = this.layers.find((l) => l.id === id);
    if (!layer) return;
    layer.opacity = opacity;
    for (const lid of [layerId(id), detailLayerId(id)]) {
      const style = this.map.getLayer(lid);
      if (!style) continue;
      this.map.setPaintProperty(lid, style.type === 'line' ? 'line-opacity' : 'raster-opacity', opacity);
    }
    if (persistNow) this.persist();
  }

  setRamp(id, ramp) {
    const layer = this.layers.find((l) => l.id === id);
    const entry = surveys.get(id);
    if (!layer || !entry) return;
    layer.ramp = normalised(ramp);
    entry.ramp = layer.ramp;
    this.renderOverview(layer);
    const overview = this.overviews.get(id);
    this.map.getSource(sourceId(id))?.updateImage({ url: overview.url, coordinates: overview.corners });
    // A new tile link so the map fetches freshly coloured tiles.
    this.map.getSource(detailSourceId(id))?.setTiles([this.detailUrl(layer)]);
    this.persist();
    this.callbacks.onStackChanged();
  }

  /** GeoTIFF quality changed: overviews and tiles redrawn at the new size. */
  async setQuality() {
    for (const layer of this.layers.filter((l) => l.kind === LayerKind.GEOTIFF)) {
      const entry = surveys.get(layer.id);
      if (!entry) continue;
      entry.size = rasterQuality().tilePixels;
      this.map.getSource(detailSourceId(layer.id))?.setTiles([this.detailUrl(layer)]);
    }
  }

  // ---------------------------------------------------------------- drawing

  renderOverview(layer) {
    const entry = surveys.get(layer.id);
    if (!entry) return;
    const { model } = entry.survey;
    const rgba = model.kind === 'image'
      ? model.rgba
      : renderDepth(model.values, model.cols, model.rows, entry.ramp, { cellX: model.cellX, cellY: model.cellY });
    const canvas = document.createElement('canvas');
    canvas.width = model.cols;
    canvas.height = model.rows;
    canvas.getContext('2d').putImageData(new ImageData(rgba, model.cols, model.rows), 0, 0);
    const old = this.overviews.get(layer.id);
    if (old) URL.revokeObjectURL(old.url);
    // A data URL is synchronous, so the map gets the new colours at once.
    this.overviews.set(layer.id, { url: canvas.toDataURL('image/png'), corners: model.corners });
  }

  detailUrl(layer) {
    const entry = surveys.get(layer.id);
    return `${TILE_PROTOCOL}://${layer.id}/{z}/{x}/{y}?ramp=${encodeURIComponent(rampKey(entry.ramp))}&px=${entry.size}`;
  }

  /** Re-adds every layer to the current style (after a style change, or a reorder). */
  reattachAll() {
    if (!this.map.getLayer(OVERLAY_ANCHOR)) return;
    for (const layer of this.layers) this.detach(layer.id);
    for (const layer of this.layers) this.attach(layer);
  }

  detach(id) {
    for (const lid of [detailLayerId(id), layerId(id)]) if (this.map.getLayer(lid)) this.map.removeLayer(lid);
    for (const sid of [detailSourceId(id), sourceId(id)]) if (this.map.getSource(sid)) this.map.removeSource(sid);
  }

  attach(layer) {
    if (!this.map.getLayer(OVERLAY_ANCHOR)) return;
    const visibility = layer.visible ? 'visible' : 'none';
    const opacity = Math.min(1, Math.max(0, layer.opacity ?? 1));
    try {
      if (layer.kind === LayerKind.XYZ) {
        this.map.addSource(sourceId(layer.id), { type: 'raster', tiles: [layer.source], tileSize: 256, maxzoom: layer.maxZoom || 22 });
        this.map.addLayer({ id: layerId(layer.id), type: 'raster', source: sourceId(layer.id), layout: { visibility }, paint: { 'raster-opacity': opacity } }, OVERLAY_ANCHOR);
      } else if (layer.kind === LayerKind.MBTILES) {
        const info = this.mbtiles.get(layer.id);
        if (!info) return;
        const bounds = info.bounds ? [info.bounds.west, info.bounds.south, info.bounds.east, info.bounds.north] : undefined;
        if (info.isVector) {
          this.map.addSource(sourceId(layer.id), { type: 'vector', tiles: [info.url], minzoom: info.minZoom, maxzoom: info.maxZoom, bounds });
          this.map.addLayer({ id: layerId(layer.id), type: 'line', source: sourceId(layer.id), 'source-layer': 'contours', layout: { visibility }, paint: { 'line-color': CONTOUR_COLOR, 'line-width': 1, 'line-opacity': opacity } }, OVERLAY_ANCHOR);
        } else {
          this.map.addSource(sourceId(layer.id), { type: 'raster', tiles: [info.url], tileSize: 256, minzoom: info.minZoom, maxzoom: info.maxZoom, bounds });
          this.map.addLayer({ id: layerId(layer.id), type: 'raster', source: sourceId(layer.id), layout: { visibility }, paint: { 'raster-opacity': opacity } }, OVERLAY_ANCHOR);
        }
      } else {
        const overview = this.overviews.get(layer.id);
        const entry = surveys.get(layer.id);
        if (!overview || !entry) return;
        this.map.addSource(sourceId(layer.id), { type: 'image', url: overview.url, coordinates: overview.corners });
        this.map.addLayer({
          id: layerId(layer.id), type: 'raster', source: sourceId(layer.id), layout: { visibility },
          paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
        }, OVERLAY_ANCHOR);
        if (entry.survey.isDepth && entry.survey.image) {
          const b = entry.survey.bounds;
          // A tile of N × 256 pixels holds the full detail one zoom early.
          const extraZoom = Math.max(0, Math.floor(Math.log2(entry.size / 256)));
          this.map.addSource(detailSourceId(layer.id), {
            type: 'raster', tiles: [this.detailUrl(layer)], tileSize: 256,
            maxzoom: Math.max(1, (layer.maxZoom || 14) - extraZoom), bounds: [b.west, b.south, b.east, b.north]
          });
          this.map.addLayer({
            id: detailLayerId(layer.id), type: 'raster', source: detailSourceId(layer.id), layout: { visibility },
            paint: { 'raster-opacity': opacity, 'raster-fade-duration': 0, 'raster-resampling': 'linear' }
          }, OVERLAY_ANCHOR);
        }
      }
    } catch (error) {
      logError('SeaBathyLayers', `attach ${layer.kind}:${layer.name} FAILED`, error);
      this.callbacks.onMessage(`Could not display ${layer.name}`);
    }
  }

  // ---------------------------------------------------------------- queries

  /** Survey depth at a point from the visible depth layers (top first), metres negative down, or null. */
  async depthMetres(lat, lng) {
    for (const layer of this.stackTopFirst) {
      if (!layer.visible) continue;
      const survey = this.depthSourceFor(layer.id);
      if (!survey) continue;
      const b = survey.bounds;
      if (lng < b.west || lng > b.east || lat < b.south || lat > b.north) continue;
      try {
        const v = await survey.sampleExact(lng, lat);
        if (v !== null) return v;
      } catch (error) {
        logError('SeaBathyLayers', 'depth sample FAILED', error);
      }
    }
    return null;
  }

  visibleDepthSurveys() {
    return this.stackTopFirst.filter((l) => l.visible).map((l) => this.depthSourceFor(l.id)).filter(Boolean);
  }

  boundsOf(id) {
    return this.surveyFor(id)?.bounds || this.mbtiles.get(id)?.bounds || null;
  }

  minZoomOf(id) {
    return this.mbtiles.get(id)?.minZoom ?? null;
  }

  visibleAttributions() {
    // A pack loaded without a credit uses the one written in the file.
    const creditOf = (l) => (l.attribution?.trim() || this.mbtiles.get(l.id)?.attribution?.trim() || '');
    return this.layers.filter((l) => l.visible && creditOf(l)).map((l) => {
      const text = creditOf(l);
      // Esri's terms ask for "Powered by Esri"; layers added by older builds were saved without it.
      return /arcgis/i.test(l.source || '') && !/Powered by Esri/i.test(text) ? `${text} · Powered by Esri` : text;
    });
  }

  persist() {
    if (!this.restored) return;
    saveList('layers', this.layers);
    saveList('layers-unavailable', this.unavailable);
  }
}
