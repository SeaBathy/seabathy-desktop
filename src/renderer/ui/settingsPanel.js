// The Settings panel, as on the phone (ui/SettingsPanel.kt). The anchor
// alarm row is left out: it needs the boat's GPS.

import { body, sectionHeader, caption, row, addRow, setRowText, showPanel, showChoicePanel } from './panels.js';
import { RASTER_QUALITIES } from '../settings/presets.js';
import licences from '../licenses.txt';

export const COLOUR_NAMES = ['Marine teal', 'Green', 'Orange', 'Red', 'Purple', 'White'];
export const COLOUR_VALUES = ['#19C6B3', '#22C55E', '#F97316', '#EF4444', '#A855F7', '#F4F6F8'];
const COORDINATE_SIZES = [11, 12, 13, 14, 15, 16];
const DEPTH_SIZES = [10, 11, 12, 13, 14, 15, 16];

export const DepthDisplayMode = {
  BOTH: 'both', NORMAL: 'normal', WAYPOINT: 'waypoint', OFF: 'off',
  VALUES: ['both', 'normal', 'waypoint', 'off'],
  LABELS: ['On the map and with the waypoint tool', 'On the map only', 'With the waypoint tool only', 'Off'],
  labelFor(value) {
    const i = this.VALUES.indexOf(value);
    return this.LABELS[i >= 0 ? i : 0];
  }
};

const colourName = (value) => {
  const i = COLOUR_VALUES.indexOf(String(value).toUpperCase());
  return i >= 0 ? COLOUR_NAMES[i] : 'Custom';
};

let settingsHandle = null;

/** Closes Settings (tides and sea conditions work on the chart). */
export function closeSettings() {
  settingsHandle?.dismiss();
}

/**
 * c: currentVisual(), onVisualChanged(v), customBasemapConfigured(),
 * onOnlineLayers(), onLoadMbtiles(), onLoadGeoTiff(), rasterQuality(),
 * onRasterQualityChanged(q), onEditDepthColours(), showWaypointNames(),
 * onShowWaypointNamesChanged(b), onOfflineMaps(), onNavigationSettings(),
 * onRoutes(), onTides(), onConditions(), onImportGpx(),
 * onExportGpx(), onExportLog()
 */
export function showSettings(c) {
  const content = body();
  const visual = () => c.currentVisual();
  const onlineLayersDetail = () => (c.customBasemapConfigured() ? 'Custom basemap set' : 'Satellite, topo, or your own tile link');

  const choice = (title, labels, selected, apply) => () => showChoicePanel(title, labels, selected(), (i) => {
    apply(i);
    refresh();
  });

  content.append(sectionHeader('MAP DISPLAY'));
  const crosshair = addRow(content, row('Crosshair colour', '', choice('Crosshair colour', COLOUR_NAMES,
    () => COLOUR_VALUES.indexOf(visual().cursorColor), (i) => c.onVisualChanged({ ...visual(), cursorColor: COLOUR_VALUES[i] }))));
  const coordinate = addRow(content, row('Coordinate colour', '', choice('Coordinate colour', COLOUR_NAMES,
    () => COLOUR_VALUES.indexOf(visual().coordinateColor), (i) => c.onVisualChanged({ ...visual(), coordinateColor: COLOUR_VALUES[i] }))));
  const depthMode = addRow(content, row('Crosshair depth', '', choice('Crosshair depth', DepthDisplayMode.LABELS,
    () => DepthDisplayMode.VALUES.indexOf(visual().depthDisplayMode), (i) => c.onVisualChanged({ ...visual(), depthDisplayMode: DepthDisplayMode.VALUES[i] }))));
  const coordSize = addRow(content, row('Coordinate text size', '', choice('Coordinate text size', COORDINATE_SIZES.map((s) => `${s} sp`),
    () => COORDINATE_SIZES.indexOf(Math.round(visual().coordinateTextSize)), (i) => c.onVisualChanged({ ...visual(), coordinateTextSize: COORDINATE_SIZES[i] }))));
  const depthSize = addRow(content, row('Depth text size', '', choice('Depth text size', DEPTH_SIZES.map((s) => `${s} sp`),
    () => DEPTH_SIZES.indexOf(Math.round(visual().depthTextSize)), (i) => c.onVisualChanged({ ...visual(), depthTextSize: DEPTH_SIZES[i] }))));
  const names = addRow(content, row('Show waypoint names on map', '', choice('Show waypoint names on map', ['Off', 'On'],
    () => (c.showWaypointNames() ? 1 : 0), (i) => c.onShowWaypointNamesChanged(i === 1))));

  const grid = addRow(content, row('Latitude and longitude grid', '', choice('Latitude and longitude grid', ['Off', 'On'],
    () => (c.showGrid() ? 1 : 0), (i) => c.onShowGridChanged(i === 1))));

  content.append(sectionHeader('MAP LAYERS'));
  addRow(content, row('Get seabed depths for this area', 'Free depth data, anywhere in the world', () => { closeSettings(); c.onGetSeabed(); }));
  addRow(content, row('Load MBTiles file', 'Charts and map packs (.mbtiles)', c.onLoadMbtiles));
  addRow(content, row('Load GeoTIFF', 'Depth surveys (.tif)', c.onLoadGeoTiff));
  const quality = addRow(content, row('GeoTIFF quality', c.rasterQuality().label, () => showChoicePanel(
    'GeoTIFF quality', RASTER_QUALITIES.map((q) => `${q.label} — ${q.detail}`), RASTER_QUALITIES.indexOf(c.rasterQuality()), (i) => {
      c.onRasterQualityChanged(RASTER_QUALITIES[i]);
      setRowText(quality, 'GeoTIFF quality', RASTER_QUALITIES[i].label);
    })));

  content.append(sectionHeader('DEPTH COLOURS'));
  content.append(caption('Colours and depth range for survey layers. Depths outside the range are hidden.', 0));
  addRow(content, row('Survey colours', 'Palette, depth range, shading', c.onEditDepthColours));

  content.append(sectionHeader('ONLINE MAPS'));
  const xyz = addRow(content, row('Online map layers', '', c.onOnlineLayers));

  content.append(sectionHeader('OFFLINE DATA'));
  addRow(content, row('Offline maps', 'Download the area on screen', c.onOfflineMaps));

  content.append(sectionHeader('NAVIGATION'));
  addRow(content, row('Boat & navigation', 'Speed, fuel, draft, units', c.onNavigationSettings));
  addRow(content, row('Saved routes', 'Load, rename, export', c.onRoutes));
  addRow(content, row('Tides', 'Heights, highs and lows, offline', () => { closeSettings(); c.onTides(); }));
  addRow(content, row('Sea conditions', 'Currents, waves, wind, sea temperature, offline', () => { closeSettings(); c.onConditions(); }));

  content.append(sectionHeader('DATA'));
  addRow(content, row('Import GPX', 'From a plotter, the phone or another app', c.onImportGpx));
  addRow(content, row('Export waypoints and route', 'Save as a GPX file', c.onExportGpx));
  content.append(caption('If something goes wrong, save this log so it can be fixed.', 0));
  addRow(content, row('Export debug log', 'What the app did, and any errors', c.onExportLog));
  addRow(content, row('Licences and credits', 'Open-source libraries and data sources', () => {
    const notices = body();
    const text = document.createElement('pre');
    text.textContent = licences;
    text.style.cssText = 'white-space: pre-wrap; font-size: 11px; margin: 0;';
    notices.append(text);
    showPanel('Licences and credits', notices);
  }));

  function refresh() {
    const v = visual();
    setRowText(crosshair, 'Crosshair colour', colourName(v.cursorColor));
    setRowText(coordinate, 'Coordinate colour', colourName(v.coordinateColor));
    setRowText(depthMode, 'Crosshair depth', DepthDisplayMode.labelFor(v.depthDisplayMode));
    setRowText(coordSize, 'Coordinate text size', `${Math.round(v.coordinateTextSize)} sp`);
    setRowText(depthSize, 'Depth text size', `${Math.round(v.depthTextSize)} sp`);
    setRowText(xyz, 'Online map layers', onlineLayersDetail());
    setRowText(names, 'Show waypoint names on map', c.showWaypointNames() ? 'On' : 'Off');
    setRowText(grid, 'Latitude and longitude grid', c.showGrid() ? 'On' : 'Off');
  }
  refresh();
  settingsHandle = showPanel('Settings', content, { onDismiss: () => { settingsHandle = null; } });
  return { refresh };
}
