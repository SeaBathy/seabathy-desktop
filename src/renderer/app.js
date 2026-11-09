// The chart screen, as on the phone (MainActivity.kt): the map, top bar,
// crosshair readout, tools, side panel, waypoints and layers, wired to the
// features in their own modules.

import * as maplibregl from 'maplibre-gl';
import { api, prefs, loadPrefs, toast, log, logError, isOnline } from './core.js';
import { el, dismissAll, showPanel, body, caption } from './ui/panels.js';
import { icon, svg } from './ui/icons.js';
import { StyleCoordinator, BasemapType } from './map/style.js';
import { OverlayLayers } from './map/overlays.js';
import { LayerPanel } from './ui/layerPanel.js';
import { WaypointStore, NewWaypointSheet, renderWaypointList, showWaypointEditor, showCoordinateEditor, iconById } from './ui/waypoints.js';
import { showSettings, DepthDisplayMode } from './ui/settingsPanel.js';
import { NavFormat, loadNavSettings, setSystemCountry } from './nav/units.js';
import { formatDdm } from './util/coords.js';
import { rasterQuality } from './settings/presets.js';
import { features } from './features.js';
import { Graticule } from './map/graticule.js';

const $ = (id) => document.getElementById(id);

export const ToolMode = { NONE: 'none', WAYPOINT: 'waypoint', ROUTE: 'route', MEASURE: 'measure' };
const HINTS = {
  waypoint: 'Click the map to drop a waypoint there',
  route: 'Click the map to add each point of the route',
  measure: 'Click the map to measure — click CLEAR when done'
};
const GO_TO_ZOOM = 15;
const MEASURE_COLOR = '#F59E0B';
const CASING = '#0B1622';
const EMPTY = { type: 'FeatureCollection', features: [] };

// ------------------------------------------------------------------ state

const app = {
  tool: ToolMode.NONE,
  measure: [],
  visual: null,
  showWaypointNames: false,
  waypoints: new WaypointStore(),
  map: null,
  style: null,
  overlays: null,
  layerPanel: null,
  sheet: null,
  markers: new Map()
};
export default app;

function loadVisual() {
  const mode = prefs.getString('depth_display_mode', DepthDisplayMode.BOTH);
  return {
    cursorColor: prefs.getString('cursor_color', '#19C6B3'),
    coordinateColor: prefs.getString('coord_color', '#19C6B3'),
    depthDisplayMode: DepthDisplayMode.VALUES.includes(mode) ? mode : DepthDisplayMode.BOTH,
    depthTextSize: prefs.getNumber('depth_text_size', 12),
    coordinateTextSize: prefs.getNumber('coord_text_size', 13)
  };
}

function saveVisual(v) {
  prefs.put('cursor_color', v.cursorColor);
  prefs.put('coord_color', v.coordinateColor);
  prefs.put('depth_display_mode', v.depthDisplayMode);
  prefs.put('depth_text_size', v.depthTextSize);
  prefs.put('coord_text_size', v.coordinateTextSize);
}

function applyVisual() {
  const v = app.visual;
  $('crosshair').style.color = v.cursorColor;
  $('coords').style.color = v.coordinateColor;
  $('coords').style.fontSize = `${v.coordinateTextSize}px`;
  $('crosshair-depth').style.fontSize = `${v.depthTextSize + 1}px`;
}

// ------------------------------------------------------------------ loading overlay

export function setLoading(title, text = '') {
  $('loading').hidden = !title;
  if (title) {
    $('loading-title').textContent = title;
    $('loading-text').textContent = text;
  }
}

export function showAlert(message, title = 'SeaBathy') {
  const content = body();
  content.append(caption(message, 0));
  showPanel(title, content);
}

// ------------------------------------------------------------------ map

function cameraFromPrefs() {
  return {
    // A first start shows the world: nobody's home water is special.
    center: [prefs.getNumber('camera_lng', 0), prefs.getNumber('camera_lat', 15)],
    zoom: prefs.getNumber('camera_zoom', 1.5),
    bearing: prefs.getNumber('camera_bearing', 0),
    pitch: prefs.getNumber('camera_tilt', 0)
  };
}

function saveCamera() {
  const c = app.map.getCenter();
  prefs.put('camera_lat', c.lat);
  prefs.put('camera_lng', c.lng);
  prefs.put('camera_zoom', app.map.getZoom());
  prefs.put('camera_bearing', app.map.getBearing());
  prefs.put('camera_tilt', app.map.getPitch());
}

export function mapCentre() {
  const c = app.map.getCenter().wrap();
  return [c.lat, c.lng];
}

export function flyTo(lat, lng, zoom = GO_TO_ZOOM) {
  app.map.flyTo({ center: [lng, lat], zoom, duration: 1200 });
}

/** Fits [bounds] on screen, e.g. a survey that was just loaded. */
export function showArea(bounds) {
  app.map.fitBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 48, duration: 900 });
}

function showLayer(layer) {
  const bounds = app.overlays.boundsOf(layer.id);
  if (!bounds) {
    toast(`${layer.name} has no known area to show`);
    return;
  }
  closeSidePanel();
  const minZoom = app.overlays.minZoomOf(layer.id);
  const camera = app.map.cameraForBounds([[bounds.west, bounds.south], [bounds.east, bounds.north]], { padding: 48 });
  // A map pack drawn only from zoom 10 in shows nothing when its whole area fits on screen.
  if (camera && minZoom !== null && camera.zoom < minZoom) {
    app.map.flyTo({ center: camera.center, zoom: minZoom, duration: 900 });
  } else {
    showArea(bounds);
  }
}

function installAppLayers() {
  const map = app.map;
  app.graticule.install();
  map.addSource('measure', { type: 'geojson', data: EMPTY });
  map.addLayer({ id: 'measure-casing', type: 'line', source: 'measure', filter: ['==', '$type', 'LineString'], paint: { 'line-color': CASING, 'line-width': 6 } });
  map.addLayer({ id: 'measure-line', type: 'line', source: 'measure', filter: ['==', '$type', 'LineString'], paint: { 'line-color': MEASURE_COLOR, 'line-width': 2 } });
  map.addLayer({ id: 'measure-points', type: 'circle', source: 'measure', filter: ['==', '$type', 'Point'], paint: { 'circle-radius': 5, 'circle-color': MEASURE_COLOR, 'circle-stroke-width': 1.5, 'circle-stroke-color': CASING } });
  refreshMeasure();
}

function onStyleInstalled() {
  installAppLayers();
  app.overlays.reattachAll();
  for (const feature of features.all()) feature.onStyleInstalled?.();
}

// ------------------------------------------------------------------ crosshair readout

let depthTimer = null;
let depthGeneration = 0;

function depthEnabledForCurrentTool() {
  switch (app.visual.depthDisplayMode) {
    case DepthDisplayMode.OFF: return false;
    case DepthDisplayMode.NORMAL: return app.tool === ToolMode.NONE;
    case DepthDisplayMode.WAYPOINT: return app.tool === ToolMode.WAYPOINT;
    default: return app.tool === ToolMode.NONE || app.tool === ToolMode.WAYPOINT;
  }
}

export function navFormat() {
  return new NavFormat(loadNavSettings().units);
}

/** A survey depth (negative down) as the chart shows it: "12.4 m", or "+0.6 m dries". */
export function formatSurveyDepth(metres) {
  const format = navFormat();
  return metres > 0 ? `+${format.depth(metres)} dries` : format.depth(-metres);
}

function showDepth(text) {
  $('crosshair-depth').textContent = text;
  $('crosshair-depth').hidden = !text;
}

export function scheduleDepthQuery() {
  clearTimeout(depthTimer);
  const generation = ++depthGeneration;
  if (!depthEnabledForCurrentTool()) {
    showDepth('');
    return;
  }
  depthTimer = setTimeout(async () => {
    const [lat, lng] = mapCentre();
    const metres = await app.overlays.depthMetres(lat, lng);
    if (generation !== depthGeneration) return;
    showDepth(metres === null ? '' : formatSurveyDepth(metres));
  }, 180);
}

function showCoordinates() {
  const [lat, lng] = mapCentre();
  $('coords').textContent = formatDdm(lat, lng);
}

// ------------------------------------------------------------------ tools

function highlightTools() {
  for (const [mode, id] of [[ToolMode.WAYPOINT, 'btn-wpt'], [ToolMode.ROUTE, 'btn-route'], [ToolMode.MEASURE, 'btn-measure']]) {
    $(id).classList.toggle('active', app.tool === mode);
  }
}

export function showHint(text) {
  $('hint').textContent = text || '';
  $('hint').hidden = !text;
}

export function toggleTool(mode) {
  const next = app.tool === mode ? ToolMode.NONE : mode;
  if (app.tool === ToolMode.MEASURE && next !== ToolMode.MEASURE) clearMeasurement();
  app.tool = next;
  showHint(next === ToolMode.NONE ? null : HINTS[next]);
  $('crosshair').hidden = next === ToolMode.MEASURE;
  app.map.getCanvas().style.cursor = next === ToolMode.NONE ? '' : 'crosshair';
  features.route?.onToolChanged(next);
  showDepth('');
  highlightTools();
  scheduleDepthQuery();
}

function handleMapClick(lat, lng) {
  switch (app.tool) {
    case ToolMode.WAYPOINT:
      if (!app.sheet.isVisible) app.sheet.show(lat, lng);
      break;
    case ToolMode.ROUTE:
      features.route?.addPoint(lat, lng);
      break;
    case ToolMode.MEASURE:
      app.measure.push({ lat, lng });
      refreshMeasure();
      break;
    default:
      features.onMapClick?.(lat, lng);
  }
}

// ------------------------------------------------------------------ measure

const EARTH_RADIUS_NM = 3440.065;

function distanceNm(a, b) {
  const dLat = ((b.lat - a.lat) * Math.PI) / 180;
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.sqrt(h));
}

export function bearingDegrees(a, b) {
  const dLng = ((b.lng - a.lng) * Math.PI) / 180;
  const y = Math.sin(dLng) * Math.cos((b.lat * Math.PI) / 180);
  const x = Math.cos((a.lat * Math.PI) / 180) * Math.sin((b.lat * Math.PI) / 180) -
    Math.sin((a.lat * Math.PI) / 180) * Math.cos((b.lat * Math.PI) / 180) * Math.cos(dLng);
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
}

/** "84 m", or "1.25 nm (2.3 km)". */
export function formatDistance(nm) {
  return nm < 0.1 ? `${Math.round(nm * 1852)} m` : `${nm.toFixed(2)} nm (${(nm * 1.852).toFixed(1)} km)`;
}

function measureSummary() {
  const p = app.measure;
  if (!p.length) return null;
  if (p.length < 2) return 'Click another point…';
  let total = 0;
  for (let i = 1; i < p.length; i++) total += distanceNm(p[i - 1], p[i]);
  return `${formatDistance(total)}  —  ${String(Math.round(bearingDegrees(p[p.length - 2], p[p.length - 1])) % 360).padStart(3, '0')}°T`;
}

function refreshMeasure() {
  const p = app.measure;
  const source = app.map.getSource('measure');
  if (source) {
    const features = p.map((q) => ({ type: 'Feature', properties: {}, geometry: { type: 'Point', coordinates: [q.lng, q.lat] } }));
    if (p.length >= 2) features.unshift({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates: p.map((q) => [q.lng, q.lat]) } });
    source.setData({ type: 'FeatureCollection', features });
  }
  const summary = measureSummary();
  $('measure-text').textContent = summary || '';
  $('measure-card').hidden = !summary;
}

function clearMeasurement() {
  app.measure = [];
  refreshMeasure();
}

// ------------------------------------------------------------------ waypoints

function markerFor(w) {
  const node = el('div', 'wpt-marker');
  const pin = el('div', 'pin');
  const label = el('div', 'lbl');
  node.append(pin, label);
  node.addEventListener('click', (event) => {
    event.stopPropagation();
    const waypoint = app.waypoints.byId(node.dataset.id);
    if (!waypoint) return;
    // Route and measure snap to a clicked waypoint instead of opening its editor.
    if (app.tool === ToolMode.ROUTE) features.route?.addPoint(waypoint.lat, waypoint.lng, waypoint.name);
    else if (app.tool === ToolMode.MEASURE) {
      app.measure.push({ lat: waypoint.lat, lng: waypoint.lng });
      refreshMeasure();
    } else editWaypoint(waypoint);
  });
  return new maplibregl.Marker({ element: node, anchor: 'top', offset: [0, -11] });
}

function renderMarkers() {
  const seen = new Set();
  const zoom = app.map.getZoom();
  // As on the phone: names hidden below zoom 11, growing from 10 to 16 px by zoom 18.
  const showNames = app.showWaypointNames && zoom > 11;
  const size = Math.min(16, 10 + ((zoom - 11) / 7) * 6);
  for (const w of app.waypoints.all) {
    seen.add(w.id);
    let marker = app.markers.get(w.id);
    if (!marker) {
      marker = markerFor(w).setLngLat([w.lng, w.lat]).addTo(app.map);
      app.markers.set(w.id, marker);
    }
    const node = marker.getElement();
    node.dataset.id = w.id;
    marker.setLngLat([w.lng, w.lat]);
    const pin = node.querySelector('.pin');
    pin.style.background = w.color;
    pin.innerHTML = svg(iconById(w.icon).drawable, false);
    const label = node.querySelector('.lbl');
    label.textContent = showNames ? w.name : '';
    label.style.fontSize = `${size}px`;
    label.style.opacity = showNames ? String(Math.min(1, zoom - 11)) : '0';
    node.title = w.desc ? `${w.name}\n${w.desc}` : w.name;
  }
  for (const [id, marker] of app.markers) {
    if (!seen.has(id)) {
      marker.remove();
      app.markers.delete(id);
    }
  }
}

function refreshWaypointPanel() {
  renderWaypointList($('waypoints-list'), $('wpt-search'), app.waypoints.all, {
    onGoTo: (w) => {
      flyTo(w.lat, w.lng);
      closeSidePanel();
    },
    onEdit: (w) => editWaypoint(w)
  });
}

export function refreshWaypoints() {
  renderMarkers();
  refreshWaypointPanel();
  app.waypoints.save();
  features.terrain?.updateWaypoints(app.waypoints.all);
}

function editWaypoint(w) {
  showWaypointEditor(w, {
    isNameTaken: (name) => app.waypoints.isNameTaken(name, w),
    onChanged: refreshWaypoints,
    onJumpTo: (target) => {
      flyTo(target.lat, target.lng);
      closeSidePanel();
    },
    onDelete: (target) => {
      app.waypoints.remove(target);
      refreshWaypoints();
    }
  });
}

/** Returns an error for the name field, or null once saved. */
function saveNewWaypoint(request) {
  const name = request.name || app.waypoints.nextDefaultName();
  if (app.waypoints.isNameTaken(name)) return `A waypoint called "${name}" already exists`;
  app.waypoints.add({ name, lat: request.lat, lng: request.lng, color: request.color, description: request.description, icon: request.icon });
  refreshWaypoints();
  if (app.tool === ToolMode.WAYPOINT) toggleTool(ToolMode.WAYPOINT);
  return null;
}

/** Opens the new-waypoint sheet at a position (the 3D view's Shift+click). */
export function newWaypointAt(lat, lng) {
  app.sheet.show(lat, lng);
}

// ------------------------------------------------------------------ side panel

export function openSidePanel() {
  $('side-panel').classList.add('open');
  $('scrim').hidden = false;
}

export function closeSidePanel() {
  $('side-panel').classList.remove('open');
  $('scrim').hidden = true;
}

function bindSidePanel() {
  $('btn-menu').append(icon('ic_menu'));
  $('btn-panel-close').append(icon('ic_close'));
  $('btn-settings').append(icon('ic_chevron_right'));
  $('btn-menu').addEventListener('click', openSidePanel);
  $('btn-panel-close').addEventListener('click', closeSidePanel);
  $('scrim').addEventListener('click', closeSidePanel);
  $('btn-settings').addEventListener('click', openSettings);
  $('wpt-search').addEventListener('input', refreshWaypointPanel);
  $('basemap').value = app.style.currentType;
  $('basemap').addEventListener('change', () => {
    const selected = $('basemap').value;
    // Custom always opens its picker, to switch presets or edit the saved link.
    if (selected === BasemapType.CUSTOM) {
      features.onlineMaps?.showCustomBasemap(() => syncBasemap());
      return;
    }
    if (selected !== app.style.currentType) app.style.rebuild(selected);
  });
}

export function syncBasemap() {
  $('basemap').value = app.style.currentType;
}

// ------------------------------------------------------------------ files

export async function loadGeoTiff(info, { attribution = '' } = {}) {
  if (!info) return;
  dismissAll();
  closeSidePanel();
  setLoading('Loading GeoTIFF', info.name);
  try {
    const layer = await app.overlays.addGeoTiff(info, {
      attribution,
      onProgress: (f) => setLoading('Loading GeoTIFF', `${info.name} — ${Math.round(f * 100)}%`)
    });
    const bounds = app.overlays.boundsOf(layer.id);
    if (bounds) showArea(bounds);
    toast(`Loaded ${layer.name}`);
  } catch (error) {
    logError('Import', `GeoTIFF ${info.name} FAILED`, error);
    showAlert(error.message || `Couldn't load ${info.name}`);
  } finally {
    setLoading(null);
  }
}

export async function loadMbtilesPath(path, options = {}) {
  dismissAll();
  closeSidePanel();
  setLoading('Loading MBTiles', path.split(/[\\/]/).pop());
  try {
    const layer = await app.overlays.addMbtiles(path, options);
    const bounds = app.overlays.boundsOf(layer.id);
    if (bounds) showLayer(layer);
    toast(`Loaded ${layer.name}`);
  } catch (error) {
    logError('Import', `MBTiles ${path} FAILED`, error);
    showAlert(error.message || "Couldn't load the MBTiles file");
  } finally {
    setLoading(null);
  }
}

function bindDragAndDrop() {
  let depth = 0;
  window.addEventListener('dragenter', (e) => {
    e.preventDefault();
    depth++;
    $('drop-hint').hidden = false;
  });
  window.addEventListener('dragleave', () => {
    if (--depth <= 0) $('drop-hint').hidden = true;
  });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    depth = 0;
    $('drop-hint').hidden = true;
    const file = e.dataTransfer.files[0];
    if (!file) return;
    const path = api.pathForFile(file);
    if (/\.tiff?$/i.test(path)) loadGeoTiff(await api.tifFromPath(path));
    else if (/\.mbtiles$/i.test(path)) loadMbtilesPath(path);
    else if (/\.gpx$/i.test(path)) features.gpx?.importText(file.name, await file.text());
    else toast('Drop a GeoTIFF (.tif), MBTiles or GPX file');
  });
}

// ------------------------------------------------------------------ settings

function openSettings() {
  showSettings({
    currentVisual: () => app.visual,
    onVisualChanged: (v) => {
      app.visual = v;
      saveVisual(v);
      applyVisual();
      scheduleDepthQuery();
    },
    customBasemapConfigured: () => app.style.hasCustom,
    onOnlineLayers: () => features.onlineMaps?.showOnlineLayers(),
    onLoadMbtiles: async () => {
      const path = await api.openMbtilesFile();
      if (path) loadMbtilesPath(path);
    },
    onLoadGeoTiff: async () => loadGeoTiff(await api.openTif()),
    rasterQuality,
    onRasterQualityChanged: (q) => {
      prefs.put('raster_quality', q.id);
      app.overlays.setQuality();
      toast('Detail tiles redraw now; the overview of each survey changes the next time SeaBathy starts.');
    },
    onEditDepthColours: () => features.depthColours?.pickLayer(),
    showWaypointNames: () => app.showWaypointNames,
    onShowWaypointNamesChanged: (on) => {
      app.showWaypointNames = on;
      prefs.put('show_waypoint_names', on);
      renderMarkers();
    },
    onOfflineMaps: () => features.offlineMaps?.show(),
    onNavigationSettings: () => features.route?.showBoatSettings(),
    onRoutes: () => features.route?.showLibrary(),
    onTides: () => features.tides?.showMain(),
    onConditions: () => features.conditions?.showDialog(),
    onImportGpx: () => features.gpx?.importFile(),
    showGrid: () => app.graticule.visible,
    onShowGridChanged: (on) => {
      prefs.put('show_grid', on);
      app.graticule.setVisible(on);
    },
    onGetSeabed: () => features.seabed?.show(),
    onExportGpx: () => features.gpx?.exportAll(),
    onExportLog: async () => {
      const path = await api.exportLog();
      if (path) toast(`Saved the debug log to ${path}`);
    }
  });
}

// ------------------------------------------------------------------ start

async function init() {
  await loadPrefs();
  setSystemCountry(await api.countryCode());
  log('App', 'renderer start');
  app.visual = loadVisual();
  app.showWaypointNames = prefs.getBoolean('show_waypoint_names', false);
  await app.waypoints.load();

  // The map's worker is bundled next to the page (see build.mjs).
  maplibregl.setWorkerUrl(new URL('../dist/maplibre-gl-worker.cjs', location.href).href);
  const map = new maplibregl.Map({
    container: 'map',
    style: { version: 8, sources: {}, layers: [{ id: 'bg', type: 'background', paint: { 'background-color': '#111418' } }] },
    ...cameraFromPrefs(),
    maxPitch: 60,
    attributionControl: false,
    fadeDuration: 0
  });
  app.map = map;
  map.addControl(new maplibregl.NavigationControl({ showZoom: false, visualizePitch: true }), 'top-right');
  app.graticule = new Graticule(map);
  app.graticule.visible = prefs.getBoolean('show_grid', false);

  app.overlays = new OverlayLayers(map, {
    onStackChanged: () => {
      app.layerPanel.rebuild();
      app.style.refreshAttribution();
      scheduleDepthQuery();
      features.onLayersChanged?.();
    },
    onVisibilityChanged: () => {
      app.style.refreshAttribution();
      scheduleDepthQuery();
      features.onLayersChanged?.();
    },
    onMessage: toast,
    showArea
  });
  app.style = new StyleCoordinator(map, {
    onInstalled: onStyleInstalled,
    onMessage: toast,
    onAttribution: (text) => {
      $('credits').textContent = text;
      $('credits').hidden = !text;
    },
    overlayCredits: () => app.overlays.visibleAttributions(),
    extraCredits: () => features.credits()
  });
  app.layerPanel = new LayerPanel($('layers-list'), app.overlays, {
    onEditDepthColours: (layer) => features.depthColours?.show(layer),
    onOpen3d: (layer) => features.terrain?.open(layer),
    onShowLayer: showLayer
  });
  app.sheet = new NewWaypointSheet(saveNewWaypoint);

  $('btn-wpt').append(icon('ic_waypoint_x'));
  $('btn-route').append(icon('ic_route'));
  $('btn-measure').append(icon('ic_measure_ruler'));
  $('btn-wpt').addEventListener('click', () => toggleTool(ToolMode.WAYPOINT));
  $('btn-route').addEventListener('click', () => toggleTool(ToolMode.ROUTE));
  $('btn-measure').addEventListener('click', () => toggleTool(ToolMode.MEASURE));
  $('btn-measure-clear').addEventListener('click', () => {
    clearMeasurement();
    if (app.tool === ToolMode.MEASURE) toggleTool(ToolMode.MEASURE);
  });
  $('coords').addEventListener('click', () => {
    const [lat, lng] = mapCentre();
    showCoordinateEditor({
      title: 'Go to coordinates', lat, lng, positiveLabel: 'Create waypoint',
      onMoveMap: (la, ln) => flyTo(la, ln),
      onPositive: (la, ln) => app.sheet.show(la, ln)
    });
  });

  bindSidePanel();
  bindDragAndDrop();
  applyVisual();
  highlightTools();

  map.on('move', showCoordinates);
  map.on('moveend', () => {
    saveCamera();
    showCoordinates();
    if (app.tool !== ToolMode.MEASURE) scheduleDepthQuery();
  });
  map.on('zoomend', renderMarkers);
  map.on('click', (e) => handleMapClick(e.lngLat.lat, e.lngLat.lng));

  document.addEventListener('keydown', (e) => {
    if (e.target.matches('input, textarea, select') || document.querySelector('.pd-scrim')) return;
    if (e.key === 'Escape') {
      if ($('side-panel').classList.contains('open')) closeSidePanel();
      else if (app.sheet.isVisible) app.sheet.hide();
      else if (app.tool !== ToolMode.NONE) toggleTool(app.tool);
    } else if (e.key === 'Backspace' && app.tool === ToolMode.MEASURE && app.measure.length) {
      app.measure.pop();
      refreshMeasure();
    } else if (e.key === 'Backspace' && app.tool === ToolMode.ROUTE) {
      features.route?.undo();
    }
  });

  // Back online: the basemap and the sea conditions catch up.
  window.addEventListener('online', () => {
    app.style.onConnectivityRestored();
    for (const feature of features.all()) feature.onConnectivityRestored?.();
  });

  // For the test scripts (driven through the DevTools protocol).
  window.seabathyTest = { app, features, loadGeoTiff, loadMbtilesPath, toggleTool, flyTo };
  await features.init(app);
  showCoordinates();
  await app.style.rebuild();
  refreshWaypoints();
  app.layerPanel.rebuild();
  app.overlays.restore(() => scheduleDepthQuery());
  log('App', `ready: online=${await isOnline()}`);
}

init().catch((error) => {
  logError('App', 'start FAILED', error);
  showAlert(`SeaBathy couldn't start: ${error.message}`);
});
