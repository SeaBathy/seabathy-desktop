// The 3D view of a survey layer: the desktop's own 3D engine (terrain3d.js,
// the same engine as the phone's 3D page), opened full-screen from a layer's
// 3D VIEW chip like the phone's Terrain3DScreen. It starts on the area on
// screen when that's clearly smaller than the survey, at close to the
// file's own resolution.

import { Terrain3D } from '../terrain3d.js';
import { loadTif, flipSign, lonLatToGrid, gridToLonLat } from '../tif.js';
import { buildDrape, subGrid } from '../drape.js';
import { contourLabelPoints, labelStep } from '../contours.js';
import { prefs, toast, api, logError, uuid } from '../core.js';
import { el } from '../ui/panels.js';
import { xyzValidationError } from '../settings/presets.js';
import { features } from '../features.js';
import { paletteById, colorAt, normalised } from '../geotiff/depth.js';
import { formatDdm } from '../util/coords.js';

const $ = (id) => document.getElementById(id);
const CONTOUR_STEPS = [0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500];
// The one online map in the Map list: Esri's World Imagery, shown with the
// credit Esri's terms ask for. Its id is the one older saves use.
const ESRI_CREDIT = 'Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community · Powered by Esri';
const DEFAULT_DRAPES = [
  { id: 'imagery', label: 'Esri satellite', colour: '#15803d', group: 'default',
    tiles: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}', maxzoom: 19, attribution: ESRI_CREDIT }
];
const DEPTH_CHOICE = { id: 'depth', label: 'Depth colours', sub: 'The survey coloured by depth, no map', swatch: '◐', colour: '#0e7490', group: 'default' };
const DRAPE_GROUPS = [['default', 'DEFAULT'], ['layer', 'YOUR LAYERS'], ['custom', 'CUSTOM']];
const CUSTOM_KEY = 'terrain_custom_drapes';
const LAYER_PREFIX = 'layer:';
// Desktop GPUs take a 4096 texture easily; it is what makes reefs sharp.
const DRAPE_MAX_SIZE = 4096;
const DRAPE_MAX_TILES = 256;
// Past this share of the grid, the view's own drape could be no sharper than the whole grid's.
const DETAIL_MAX_SHARE = 0.9;
/** Saving an area offline suggests no deeper than this (about 1 m per pixel). */
const MAX_SAVE_ZOOM = 17;
const SEAMARK_TILES = 'https://tiles.openseamap.org/seamark/{z}/{x}/{y}.png';

const DEFAULTS = {
  exaggeration: 3, sunAz: 315, sunEl: 35, colorMode: 'depth', slopeMax: 20,
  contourMetres: null, contourOn: true, contourLabels: true,
  surface: 'depth', drapeMix: 1, drapeSeamarks: false, drapeDetail: true,
  shadows: true, sea: false, waypoints3d: true, detail: 1024
};

/** "22.4 m" for a depth, "+5 m" above sea level, as on the chart. */
function depthText(level) {
  const v = Math.round(Math.abs(level) * 10) / 10;
  return level <= 0 ? `${v} m` : `+${v} m`;
}

/** The layer's ramp as the 3D engine wants it: 256 RGB entries from deep to shallow. */
function lutFor(rampIn) {
  const ramp = normalised(rampIn);
  const palette = paletteById(ramp.paletteId);
  const lut = new Uint8Array(256 * 3);
  for (let i = 0; i < 256; i++) {
    let position = 1 - i / 255; // 1 = the deep end
    if (ramp.invert) position = 1 - position;
    lut.set(colorAt(palette, position), i * 3);
  }
  return lut;
}

export function create(app) {
  const s = { ...DEFAULTS, ...prefs.getJson('terrain_settings', {}) };
  const save = () => prefs.put('terrain_settings', s);
  let terrain = null;
  let model = null;
  let layer = null;
  let survey = null;
  let isolate = null;
  let crop = null;
  let rampMin = 0;
  let rampMax = 0;

  const visible = () => !$('terrain').hidden;

  function engine() {
    if (terrain) return terrain;
    terrain = new Terrain3D($('terrain-canvas'), {
      onViewSettled: () => refreshDetail(),
      onHover: (hit) => {
        if (!hit) {
          $('terrain-status').textContent = '';
          return;
        }
        const ll = gridToLonLat(model, hit.col, hit.row);
        const slope = terrain.slopeAt(hit.col, hit.row);
        $('terrain-status').textContent = `${ll ? formatDdm(ll.lat, ll.lng) : ''}   ${depthText(hit.depth)}${slope === null ? '' : ` · slope ${slope.toFixed(slope < 10 ? 1 : 0)}°`}`;
      },
      onPick: (hit) => {
        const ll = gridToLonLat(model, hit.col, hit.row);
        if (!ll) return toast("This survey's map projection isn't recognised, so waypoints can't be placed on it.");
        close();
        import('../app.js').then((m) => m.newWaypointAt(ll.lat, ll.lng));
      },
      onWaypointClick: () => {},
      onProfile: drawProfile
    });
    return terrain;
  }

  function applySettings() {
    const t = engine();
    t.setExaggeration(s.exaggeration);
    t.setSun(s.sunAz, s.sunEl);
    t.setShadows(s.shadows);
    t.setSeaSurface(s.sea);
    t.setAutoRotate($('auto-rotate').checked);
    t.setColorMode(s.colorMode, s.slopeMax);
    t.setContourInterval(contourMetres());
    if (model) t.setPalette(lutFor(layer.ramp), rampMin, rampMax);
  }

  function syncControls() {
    showExaggeration(s.exaggeration);
    $('sun-az').value = s.sunAz;
    $('sun-el').value = s.sunEl;
    $('contour-on').checked = s.contourOn;
    $('contour-labels').checked = s.contourLabels;
    $('shadows').checked = s.shadows;
    $('sea-surface').checked = s.sea;
    $('wpt-3d').checked = s.waypoints3d;
    $('color-mode').value = s.colorMode;
    $('slope-max').value = String(s.slopeMax);
    $('slope-max-wrap').hidden = s.colorMode !== 'slope';
    $('detail').value = String(s.detail);
    fillSurfaceChoices();
    $('drape-mix').value = s.drapeMix;
    $('drape-seamarks').checked = s.drapeSeamarks;
    $('drape-detail').checked = s.drapeDetail;
  }

  // ---------------------------------------------------------------- loading

  /** The part of the survey on screen, as fractions of the file, when clearly smaller than all of it. */
  function visibleCrop(target) {
    const b = app.map.getBounds();
    const full = target.bounds;
    const west = Math.max(full.west, b.getWest());
    const east = Math.min(full.east, b.getEast());
    const south = Math.max(full.south, b.getSouth());
    const north = Math.min(full.north, b.getNorth());
    if (east <= west || north <= south) return null;
    const share = ((east - west) * (north - south)) / ((full.east - full.west) * (full.north - full.south));
    if (share > 0.6) return null;
    const corners = [[west, north], [east, north], [east, south], [west, south]].map(([x, y]) => {
      const [px, py] = target.pixelAt(x, y);
      return [px / target.model.width, py / target.model.height];
    });
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    return [Math.max(0, Math.min(...xs)), Math.max(0, Math.min(...ys)), Math.min(1, Math.max(...xs)), Math.min(1, Math.max(...ys))];
  }

  async function load({ keepView = false } = {}) {
    const info = await api.tifFromPath(layer.source);
    if (!info) throw new Error(`${layer.name} is no longer at ${layer.source}`);
    const next = await loadTif(info.url, layer.name, {
      maxDim: s.detail, crop, flipped: survey.model.flipped,
      onProgress: (k) => app.setLoading?.('Building 3D view', `${Math.round(k * 100)}%`)
    });
    if (next.kind !== 'depth') throw new Error(`${layer.name} has no depths to show in 3D`);
    if (isolate) maskToRange(next, isolate);
    model = next;
    const ramp = normalised(layer.ramp);
    rampMin = isolate ? isolate.deep : ramp.deepMetres;
    rampMax = isolate ? isolate.shallow : ramp.shallowMetres;
    const t = engine();
    t.setModel(model);
    applySettings();
    if (isolate) setExaggeration(t.autoExaggeration());
    autoContour(Boolean(isolate));
    resetClipControls();
    updateContourLabel();
    updateWaypoints(app.waypoints.all);
    rebuildDrape();
    $('isolate-info').textContent = (isolate ? `Isolated ${depthText(isolate.shallow)} – ${depthText(isolate.deep)}. ` : '') +
      `${model.cols}×${model.rows} cells, ${Math.min(model.cellX, model.cellY).toFixed(1)} m each.`;
    if (!keepView) t.cameraPreset('45');
  }

  async function open(target) {
    layer = target;
    survey = app.overlays.depthSourceFor(target.id);
    if (!survey) {
      toast(`${target.name} has no depths to show in 3D`);
      return;
    }
    document.getElementById('side-panel').classList.remove('open');
    document.getElementById('scrim').hidden = true;
    isolate = null;
    crop = visibleCrop(survey);
    $('terrain-title').textContent = `${target.name} — 3D`;
    $('terrain').hidden = false;
    syncControls();
    const { setLoading } = await import('../app.js');
    app.setLoading = setLoading;
    setLoading('Building 3D view', target.name);
    try {
      engine().activate();
      await load();
    } catch (error) {
      logError('Terrain3D', 'open FAILED', error);
      toast(`Couldn't show ${target.name} in 3D: ${error.message}`);
      close();
    } finally {
      setLoading(null);
    }
  }

  function close() {
    $('terrain').hidden = true;
    $('profile').hidden = true;
    terrain?.deactivate();
    app.map.resize();
  }

  // ---------------------------------------------------------------- contours and labels

  function autoContour(force = false) {
    if (s.contourMetres !== null && !force) {
      $('contour').value = Math.max(0, CONTOUR_STEPS.indexOf(s.contourMetres));
      return;
    }
    const range = model.max - model.min;
    const i = CONTOUR_STEPS.findIndex((step) => range / step <= 30);
    $('contour').value = i < 0 ? CONTOUR_STEPS.length - 1 : i;
  }

  const contourMetres = () => (s.contourOn ? CONTOUR_STEPS[$('contour').value] : 0);

  function updateContourLabel() {
    $('contour-val').textContent = `${CONTOUR_STEPS[$('contour').value]} m`;
    terrain?.setContourInterval(contourMetres());
    if (!model) return;
    const points = contourLabelPoints(model, labelStep(model.min, model.max, CONTOUR_STEPS[$('contour').value]));
    terrain?.setContourLabels(s.contourOn && s.contourLabels ? points.map((p) => ({ ...p, text: depthText(p.level) })) : []);
  }

  // ---------------------------------------------------------------- depth range and isolate

  function maskToRange(m, { deep, shallow }) {
    let min = Infinity;
    let max = -Infinity;
    let covered = 0;
    for (let i = 0; i < m.values.length; i++) {
      const v = m.values[i];
      if (Number.isNaN(v)) continue;
      if (v < deep || v > shallow) {
        m.values[i] = NaN;
        continue;
      }
      covered++;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!covered) throw new Error('No data in that depth range');
    Object.assign(m, { min, max, covered });
  }

  const clip = {
    toValue: (v) => model.max - (v / 1000) * (model.max - model.min),
    fromValue: (v) => Math.round(((model.max - v) / (model.max - model.min || 1)) * 1000)
  };

  function readClip() {
    const a = -parseFloat($('clip-shallow').value);
    const b = -parseFloat($('clip-deep').value);
    if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
    return { deep: Math.min(a, b), shallow: Math.max(a, b) };
  }

  function resetClipControls() {
    $('clip-on').checked = false;
    $('clip-shallow').value = (-model.max).toFixed(1);
    $('clip-deep').value = (-model.min).toFixed(1);
    $('clip-shallow-slider').value = 0;
    $('clip-deep-slider').value = 1000;
    terrain?.setClip(null, null);
    $('btn-show-all').disabled = !isolate;
  }

  function applyClip() {
    const range = readClip();
    const on = $('clip-on').checked && range;
    terrain?.setClip(on ? range.deep : null, on ? range.shallow : null);
    // Colours stretch over the range shown, for the most contrast.
    const ramp = normalised(layer.ramp);
    rampMin = on ? range.deep : ramp.deepMetres;
    rampMax = on ? range.shallow : ramp.shallowMetres;
    terrain?.setPalette(lutFor(layer.ramp), rampMin, rampMax);
    terrain?.refreshContourLabelVisibility();
  }

  // ---------------------------------------------------------------- drape

  /** Raster layers in the stack (offline MBTiles packs and XYZ layers) that can cover the terrain. */
  function layerDrapes() {
    const out = [];
    for (const l of app.overlays.stackTopFirst) {
      if (l.kind === 'XYZ') {
        out.push({ id: LAYER_PREFIX + l.id, label: l.name, group: 'layer', tiles: l.source, maxzoom: l.maxZoom || 19, attribution: l.attribution });
      } else if (l.kind === 'MBTILES') {
        const info = app.overlays.mbtiles.get(l.id);
        if (info && !info.isVector) {
          out.push({ id: LAYER_PREFIX + l.id, label: l.name, group: 'layer', offline: true, tiles: info.url, minzoom: info.minZoom, maxzoom: info.maxZoom, attribution: l.attribution || info.attribution });
        }
      }
    }
    return out;
  }

  const customLinks = () => (prefs.getJson(CUSTOM_KEY, []) || []).filter((c) => c && c.id && c.url && !xyzValidationError(c.url));

  function drapeChoices() {
    return [
      DEPTH_CHOICE,
      ...DEFAULT_DRAPES,
      ...layerDrapes(),
      ...customLinks().map((c) => ({ id: c.id, label: c.name, group: 'custom', tiles: c.url, maxzoom: 22 }))
    ];
  }

  const currentDrape = () => drapeChoices().find((c) => c.id === s.surface && c.tiles) || null;

  function drapeSub(d) {
    if (d.sub) return d.sub;
    const zooms = d.minzoom > 0 ? `zoom ${d.minzoom}–${d.maxzoom}` : `sharp to zoom ${d.maxzoom}`;
    return `${d.offline ? 'Offline' : 'Online'} · ${zooms}`;
  }

  /** The Map list, grouped like the layer panel; a saved map that has since gone falls back to depth colours. */
  function fillSurfaceChoices() {
    const choices = drapeChoices();
    if (!choices.some((c) => c.id === s.surface)) s.surface = 'depth';
    const box = $('map-list');
    box.replaceChildren();
    for (const [group, title] of DRAPE_GROUPS) {
      const items = choices.filter((c) => c.group === group);
      if (!items.length && group !== 'custom') continue;
      box.append(el('div', 'map-group', title));
      for (const d of items) box.append(mapItem(d));
      if (group === 'custom') {
        const add = el('button', 'map-item map-add', '+ Add a map link');
        add.addEventListener('click', () => showCustomForm(true));
        box.append(add);
      }
    }
    const drape = currentDrape();
    $('drape-controls').hidden = !drape;
    $('btn-save-offline').hidden = !drape || drape.offline;
    showCredits();
  }

  /** The chosen map's credit, on screen in 3D as the providers ask (the chart's credit line is hidden here). */
  function showCredits() {
    const drape = currentDrape();
    const parts = [];
    if (drape) {
      let host = drape.label;
      try {
        host = new URL(drape.tiles.replace(/[{}]/g, '')).host || host;
      } catch { /* an offline pack's address has no host to show */ }
      parts.push(drape.attribution || (drape.offline ? drape.label : `Map: ${host}`));
    }
    if (s.drapeSeamarks) parts.push('Seamarks © OpenSeaMap contributors');
    $('terrain-credits').textContent = parts.join(' · ');
    $('terrain-credits').hidden = !parts.length;
  }

  function mapItem(d) {
    const item = el('div', 'map-item' + (d.id === s.surface ? ' selected' : ''));
    item.setAttribute('role', 'button');
    const swatch = el('span', 'map-swatch', d.swatch || d.label.trim().charAt(0).toUpperCase());
    swatch.style.setProperty('--sw', d.colour || (d.offline ? '#0f766e' : '#475569'));
    const text = el('span', 'map-text');
    text.append(el('span', 'map-name', d.label), el('span', 'map-sub', drapeSub(d)));
    item.append(swatch, text, el('span', 'map-tick', '✓'));
    if (d.group === 'custom') {
      const remove = el('button', 'map-remove', '✕');
      remove.title = `Remove ${d.label}`;
      remove.addEventListener('click', (e) => {
        e.stopPropagation();
        prefs.put(CUSTOM_KEY, customLinks().filter((c) => c.id !== d.id));
        fillSurfaceChoices();
        if (s.surface === 'depth') rebuildDrape();
      });
      item.append(remove);
    }
    item.addEventListener('click', () => {
      if (s.surface === d.id) return;
      s.surface = d.id;
      save();
      fillSurfaceChoices();
      rebuildDrape();
    });
    return item;
  }

  function showCustomForm(on) {
    $('custom-form').hidden = !on;
    $('custom-error').hidden = true;
    if (on) {
      $('custom-name').value = '';
      $('custom-url').value = '';
      $('custom-url').focus();
    }
  }

  function addCustomLink() {
    const url = $('custom-url').value.trim();
    const error = xyzValidationError(url) || (customLinks().some((c) => c.url === url) ? 'That map is already in the list' : null);
    if (error) {
      $('custom-error').textContent = error;
      $('custom-error').hidden = false;
      return;
    }
    let host = 'Custom map';
    try {
      host = new URL(url.replace(/[{}]/g, '')).host || host;
    } catch { /* a link with odd characters keeps the plain name */ }
    const link = { id: `custom-${uuid()}`, name: ($('custom-name').value.trim() || host).slice(0, 60), url };
    prefs.put(CUSTOM_KEY, [...customLinks(), link]);
    showCustomForm(false);
    s.surface = link.id;
    save();
    fillSurfaceChoices();
    rebuildDrape();
  }

  let drapeToken = 0;
  let baseZoom = null;
  let baseStatus = '';

  function showDrapeStatus(text, warn = false) {
    $('drape-status').textContent = text || '';
    $('drape-status').hidden = !text;
    $('drape-status').classList.toggle('warn', warn);
  }

  const metresText = (m) => (m < 10 ? m.toFixed(1) : Math.round(m));

  function drapeLayers() {
    const chosen = currentDrape();
    const layers = chosen ? [chosen] : [];
    if (s.drapeSeamarks) layers.push({ tiles: SEAMARK_TILES, maxzoom: 18 });
    return { chosen, layers };
  }

  const drapeOptions = (token, prefix) => ({
    maxSize: Math.min(DRAPE_MAX_SIZE, terrain.maxTextureSize()),
    maxTiles: DRAPE_MAX_TILES,
    onProgress: (f) => { if (token === drapeToken) showDrapeStatus(`${prefix} ${Math.round(f * 100)}%`); }
  });

  /** The map over the whole grid; the view's sharper one follows once the camera rests. */
  async function rebuildDrape() {
    if (!terrain || !model) return;
    const { chosen, layers } = drapeLayers();
    const token = ++drapeToken;
    baseZoom = null;
    terrain.setDetailDrape(null);
    showDrapeStatus(null);
    if (!layers.length) return terrain.setDrape(null, 0);
    if (!model.corners) {
      terrain.setDrape(null, 0);
      showDrapeStatus("This survey's map projection isn't recognised, so maps can't be laid on it.", true);
      return;
    }
    showDrapeStatus('Fetching map tiles…');
    try {
      const result = await buildDrape(drapeGrid(model), layers, drapeOptions(token, 'Fetching map tiles…'));
      if (token !== drapeToken) return;
      if (!result.canvas) {
        terrain.setDrape(null, 0);
        showDrapeStatus(chosen?.minzoom > 0
          ? 'This map has no tiles here at a zoom that fits: zoom in further on the chart before opening 3D, or pick a map that covers this area.'
          : 'No map tiles came back: no internet, or nothing here.', true);
        return;
      }
      terrain.setDrape(result.canvas, chosen ? s.drapeMix : 1);
      baseZoom = result.zoom;
      baseStatus = `Zoom ${result.zoom}, about ${metresText(result.metresPerPx)} m per pixel` +
        (result.loaded < result.total ? ` · ${result.total - result.loaded} of ${result.total} tiles missing` : '');
      showDrapeStatus(baseStatus);
      refreshDetail();
    } catch (error) {
      if (token === drapeToken) showDrapeStatus(`Couldn't build the map: ${error.message}`, true);
    }
  }

  /** A sharper map for the part of the terrain in view, laid over the whole-grid one. */
  async function refreshDetail() {
    if (!terrain || !model || baseZoom === null || !visible()) return;
    const { layers } = drapeLayers();
    const token = drapeToken;
    const rect = s.drapeDetail ? terrain.viewGridRect() : null;
    const share = rect ? ((rect.c1 - rect.c0) * (rect.r1 - rect.r0)) / (model.cols * model.rows) : 1;
    if (share > DETAIL_MAX_SHARE) {
      terrain.setDetailDrape(null);
      showDrapeStatus(baseStatus);
      return;
    }
    try {
      const result = await buildDrape(subGrid(drapeGrid(model), rect), layers, drapeOptions(token, 'Sharpening the view…'));
      if (token !== drapeToken) return;
      // No better than the whole-grid map here (the map's deepest zoom, or no tiles).
      if (!result.canvas || result.zoom <= baseZoom) {
        terrain.setDetailDrape(null);
        showDrapeStatus(baseStatus);
        return;
      }
      terrain.setDetailDrape(result.canvas, rect);
      showDrapeStatus(`In view: zoom ${result.zoom}, about ${metresText(result.metresPerPx)} m per pixel` +
        (result.loaded < result.total ? ` · ${result.total - result.loaded} tiles missing` : ''));
    } catch {
      if (token === drapeToken) showDrapeStatus(baseStatus);
    }
  }

  /** Closes 3D and opens the offline download for the chosen online map over the 3D area. */
  function saveOffline() {
    const drape = currentDrape();
    if (!drape || drape.offline || !model?.corners) return;
    const lngs = model.corners.map((c) => c[0]);
    const lats = model.corners.map((c) => c[1]);
    const bounds = { west: Math.min(...lngs), south: Math.min(...lats), east: Math.max(...lngs), north: Math.max(...lats) };
    close();
    features.offlineMaps?.download(
      { id: drape.id, name: drape.label, urlTemplate: drape.tiles, attribution: drape.attribution || '' },
      { bounds, maxZoom: Math.min(drape.maxzoom, MAX_SAVE_ZOOM), areaNote: "The area shown in 3D. Check the map's terms allow offline copies. Load the file when it's done, and it's in 3D's Map list." }
    );
  }

  /** The 3D model as the drape builder wants it. */
  function drapeGrid(m) {
    return {
      cols: m.cols,
      rows: m.rows,
      widthMetres: m.cols * m.cellX,
      corners: m.corners,
      centreLat: m.centerLonLat[1],
      toLonLat: (col, row) => gridToLonLat(m, col, row)
    };
  }

  // ---------------------------------------------------------------- waypoints

  function updateWaypoints(waypoints) {
    if (!terrain || !model) return;
    const items = waypoints.map((w) => ({ ...w, ...lonLatToGrid(model, w.lng, w.lat) })).filter((w) => Number.isFinite(w.col));
    terrain.setWaypoints(items, s.waypoints3d);
  }

  // ---------------------------------------------------------------- exaggeration

  const exagFromSlider = (v) => 0.5 * 200 ** (v / 1000);
  const sliderFromExag = (e) => Math.round((1000 * Math.log(e / 0.5)) / Math.log(200));
  function showExaggeration(value) {
    $('exag').value = sliderFromExag(value);
    $('exag-val').textContent = `${value < 10 ? Math.round(value * 10) / 10 : Math.round(value)}×`;
  }
  function setExaggeration(value) {
    s.exaggeration = Math.max(0.5, Math.min(100, value));
    showExaggeration(s.exaggeration);
    terrain?.setExaggeration(s.exaggeration);
    save();
  }

  // ---------------------------------------------------------------- profile

  function drawProfile({ samples, lengthM }) {
    $('profile').hidden = false;
    const canvas = $('profile-canvas');
    const ctx = canvas.getContext('2d');
    const W = canvas.width;
    const H = canvas.height;
    const pad = { l: 46, r: 10, t: 10, b: 22 };
    ctx.clearRect(0, 0, W, H);
    const valid = samples.filter((p) => p.depth !== null);
    if (valid.length < 2) return;
    let lo = Math.min(...valid.map((p) => p.depth));
    let hi = Math.max(...valid.map((p) => p.depth));
    if (hi - lo < 1) { hi += 0.5; lo -= 0.5; }
    const x = (d) => pad.l + (d / lengthM) * (W - pad.l - pad.r);
    const y = (v) => pad.t + ((hi - v) / (hi - lo)) * (H - pad.t - pad.b);
    let maxSlope = 0;
    for (let i = 1; i < valid.length; i++) {
      const run = valid[i].distance - valid[i - 1].distance;
      if (run > 0) maxSlope = Math.max(maxSlope, Math.abs(valid[i].depth - valid[i - 1].depth) / run);
    }
    const length = lengthM >= 1000 ? `${(lengthM / 1000).toFixed(2)} km` : `${lengthM.toFixed(0)} m`;
    $('profile-title').textContent = `Profile · ${length} · ${depthText(lo)} to ${depthText(hi)} · steepest ${((Math.atan(maxSlope) * 180) / Math.PI).toFixed(0)}°`;
    ctx.strokeStyle = '#3a434d';
    ctx.fillStyle = '#aeb7c2';
    ctx.font = '10px Segoe UI';
    ctx.lineWidth = 1;
    for (let i = 0; i <= 4; i++) {
      const v = lo + ((hi - lo) * i) / 4;
      ctx.beginPath();
      ctx.moveTo(pad.l, y(v));
      ctx.lineTo(W - pad.r, y(v));
      ctx.stroke();
      ctx.fillText(depthText(v), 4, y(v) + 3);
    }
    ctx.fillText('0', pad.l, H - 6);
    ctx.fillText(length, W - pad.r - 40, H - 6);
    const grad = ctx.createLinearGradient(0, pad.t, 0, H - pad.b);
    grad.addColorStop(0, 'rgba(25,198,179,.55)');
    grad.addColorStop(1, 'rgba(12,44,99,.35)');
    ctx.beginPath();
    ctx.moveTo(x(valid[0].distance), H - pad.b);
    for (const p of valid) ctx.lineTo(x(p.distance), y(p.depth));
    ctx.lineTo(x(valid[valid.length - 1].distance), H - pad.b);
    ctx.closePath();
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.beginPath();
    valid.forEach((p, i) => (i ? ctx.lineTo(x(p.distance), y(p.depth)) : ctx.moveTo(x(p.distance), y(p.depth))));
    ctx.strokeStyle = '#ffd23f';
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // ---------------------------------------------------------------- controls

  $('btn-terrain-close').addEventListener('click', close);
  $('exag').addEventListener('input', (e) => setExaggeration(exagFromSlider(Number(e.target.value))));
  $('exag-true').addEventListener('click', () => setExaggeration(1));
  $('exag-auto').addEventListener('click', () => terrain && setExaggeration(terrain.autoExaggeration()));
  document.querySelectorAll('[data-exag]').forEach((b) => b.addEventListener('click', () => setExaggeration(Number(b.dataset.exag))));
  for (const id of ['sun-az', 'sun-el']) {
    $(id).addEventListener('input', () => {
      s.sunAz = Number($('sun-az').value);
      s.sunEl = Number($('sun-el').value);
      terrain?.setSun(s.sunAz, s.sunEl);
      save();
    });
  }
  $('contour').addEventListener('input', () => {
    s.contourMetres = CONTOUR_STEPS[$('contour').value];
    updateContourLabel();
    save();
  });
  $('contour-on').addEventListener('change', (e) => { s.contourOn = e.target.checked; updateContourLabel(); save(); });
  $('contour-labels').addEventListener('change', (e) => { s.contourLabels = e.target.checked; updateContourLabel(); save(); });
  $('shadows').addEventListener('change', (e) => { s.shadows = e.target.checked; terrain?.setShadows(s.shadows); save(); });
  $('sea-surface').addEventListener('change', (e) => { s.sea = e.target.checked; terrain?.setSeaSurface(s.sea); save(); });
  $('wpt-3d').addEventListener('change', (e) => { s.waypoints3d = e.target.checked; updateWaypoints(app.waypoints.all); save(); });
  $('auto-rotate').addEventListener('change', (e) => terrain?.setAutoRotate(e.target.checked));
  for (const id of ['color-mode', 'slope-max']) {
    $(id).addEventListener('change', () => {
      s.colorMode = $('color-mode').value;
      s.slopeMax = Number($('slope-max').value);
      $('slope-max-wrap').hidden = s.colorMode !== 'slope';
      terrain?.setColorMode(s.colorMode, s.slopeMax);
      save();
    });
  }
  $('detail').addEventListener('change', async (e) => {
    s.detail = Number(e.target.value);
    save();
    if (model) await reload();
  });
  $('custom-cancel').addEventListener('click', () => showCustomForm(false));
  $('custom-add').addEventListener('click', addCustomLink);
  $('custom-url').addEventListener('keydown', (e) => { if (e.key === 'Enter') addCustomLink(); });
  $('btn-save-offline').addEventListener('click', saveOffline);
  $('drape-detail').addEventListener('change', (e) => {
    s.drapeDetail = e.target.checked;
    save();
    if (s.drapeDetail) refreshDetail();
    else {
      terrain?.setDetailDrape(null);
      showDrapeStatus(baseStatus);
    }
  });
  $('drape-seamarks').addEventListener('change', (e) => { s.drapeSeamarks = e.target.checked; save(); showCredits(); rebuildDrape(); });
  $('drape-mix').addEventListener('input', (e) => { s.drapeMix = Number(e.target.value); terrain?.setDrape(undefined, s.drapeMix); save(); });
  document.querySelectorAll('[data-cam]').forEach((b) => b.addEventListener('click', () => terrain?.cameraPreset(b.dataset.cam)));
  document.querySelectorAll('[data-face]').forEach((b) => b.addEventListener('click', () => terrain?.face(Number(b.dataset.face))));
  $('btn-screenshot').addEventListener('click', async () => {
    if (!terrain) return;
    const saved = await api.savePng(`${layer.name}-3d.png`, terrain.screenshot());
    if (saved) toast(`Saved ${saved}`);
  });
  $('profile-close').addEventListener('click', () => {
    $('profile').hidden = true;
    terrain?.clearProfile();
  });
  for (const id of ['clip-shallow-slider', 'clip-deep-slider']) {
    $(id).addEventListener('input', () => {
      if (!model) return;
      const a = clip.toValue(Number($('clip-shallow-slider').value));
      const b = clip.toValue(Number($('clip-deep-slider').value));
      $('clip-shallow').value = (-Math.max(a, b)).toFixed(1);
      $('clip-deep').value = (-Math.min(a, b)).toFixed(1);
      $('clip-on').checked = true;
      applyClip();
    });
  }
  for (const id of ['clip-shallow', 'clip-deep']) {
    $(id).addEventListener('change', () => {
      const range = readClip();
      if (!model || !range) return;
      $('clip-shallow-slider').value = clip.fromValue(range.shallow);
      $('clip-deep-slider').value = clip.fromValue(range.deep);
      $('clip-on').checked = true;
      applyClip();
    });
  }
  $('clip-on').addEventListener('change', applyClip);

  async function reload(options = {}) {
    const { setLoading } = await import('../app.js');
    setLoading('Building 3D view', layer.name);
    try {
      await load({ keepView: true, ...options });
    } catch (error) {
      toast(error.message);
    } finally {
      setLoading(null);
    }
  }

  $('btn-isolate').addEventListener('click', () => {
    const range = readClip();
    if (!model || !range) return;
    let c0 = Infinity;
    let r0 = Infinity;
    let c1 = -Infinity;
    let r1 = -Infinity;
    for (let r = 0; r < model.rows; r++) {
      for (let c = 0; c < model.cols; c++) {
        const v = model.values[r * model.cols + c];
        if (v >= range.deep && v <= range.shallow) {
          c0 = Math.min(c0, c);
          c1 = Math.max(c1, c);
          r0 = Math.min(r0, r);
          r1 = Math.max(r1, r);
        }
      }
    }
    if (c0 === Infinity) return toast('No data in that depth range');
    const pad = Math.max(2, Math.round(Math.max(c1 - c0, r1 - r0) * 0.03));
    const base = model.crop || [0, 0, 1, 1];
    const fx = (c) => Math.max(0, Math.min(1, base[0] + (c / model.cols) * (base[2] - base[0])));
    const fy = (r) => Math.max(0, Math.min(1, base[1] + (r / model.rows) * (base[3] - base[1])));
    crop = [fx(c0 - pad), fy(r0 - pad), fx(c1 + 1 + pad), fy(r1 + 1 + pad)];
    isolate = range;
    reload();
  });
  $('btn-show-all').addEventListener('click', () => {
    isolate = null;
    crop = null;
    reload();
  });

  window.addEventListener('keydown', (e) => {
    if (!visible() || e.target.matches('input, textarea, select')) return;
    const key = e.key.toLowerCase();
    if (key === 'escape') close();
    else if (key === 'f') terrain?.cameraPreset('reset');
    else if (key === 't') terrain?.cameraPreset('top');
    else if (key === '5') terrain?.cameraPreset('45');
  });

  return {
    name: 'terrain',
    open,
    close,
    updateWaypoints: (waypoints) => visible() && updateWaypoints(waypoints)
  };
}
