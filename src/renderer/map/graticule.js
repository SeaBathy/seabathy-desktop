// A latitude and longitude grid for what's on screen, as on the phone
// (map/Graticule.kt). Labels are markers rather than map text: a style with
// no fonts (a custom tile link) would otherwise leave them blank.

import maplibregl from 'maplibre-gl';

const SOURCE = 'grid-src';
const LINE_LAYER = 'grid-line';
/** Degrees between lines, coarse to fine: the round figures charts use, down to a tenth of a minute. */
const STEPS = [30, 20, 10, 5, 2, 1, 30 / 60, 20 / 60, 10 / 60, 5 / 60, 2 / 60, 1 / 60, 0.5 / 60, 0.2 / 60, 0.1 / 60];
const MAX_LINES_ACROSS = 6;
const MAX_LAT = 85;
/** Where the labels sit, as a share of what's on screen: under the top bar, and just in from the left. */
const LABEL_INSET_TOP = 0.09;
const LABEL_INSET_LEFT = 0.01;
const EMPTY = { type: 'FeatureCollection', features: [] };

/** The spacing for an area [span] degrees across its longer side. */
export function stepFor(span) {
  return STEPS.find((s) => span / s >= MAX_LINES_ACROSS - 2 && span / s <= MAX_LINES_ACROSS + 2)
    ?? STEPS.find((s) => span / s >= MAX_LINES_ACROSS - 2) ?? STEPS[STEPS.length - 1];
}

/** "18°30′S", with the minutes only when the spacing needs them. */
export function gridLabel(value, isLatitude, step) {
  const a = Math.abs(value);
  // The equator, the prime meridian and the date line belong to neither side.
  const hemisphere = a < 1e-9 || (!isLatitude && Math.abs(a - 180) < 1e-9) ? '' : isLatitude ? (value < 0 ? 'S' : 'N') : (value < 0 ? 'W' : 'E');
  let whole = Math.floor(a + 1e-9);
  const fraction = (a - whole) * 60;
  if (step >= 1) return `${whole}°${hemisphere}`;
  if (step >= 1 / 60 - 1e-9) {
    let minutes = Math.round(fraction);
    if (minutes === 60) {
      minutes = 0;
      whole += 1;
    }
    return `${whole}°${String(minutes).padStart(2, '0')}′${hemisphere}`;
  }
  return `${whole}°${Math.max(0, fraction).toFixed(1).padStart(4, '0')}′${hemisphere}`;
}

/** Lines and labels for the area on screen. east may be past 180 when the date line is on screen. */
export function gridFor(south, west, north, east) {
  const s = Math.min(MAX_LAT, Math.max(-MAX_LAT, south));
  const n = Math.min(MAX_LAT, Math.max(-MAX_LAT, north));
  const width = Math.min(360, east - west);
  const height = n - s;
  if (height <= 0 || width <= 0) return { lines: [], labels: [] };
  const step = stepFor(Math.max(height, width));
  const lines = [];
  const labels = [];
  const labelLat = n - height * LABEL_INSET_TOP;
  const labelLng = west + width * LABEL_INSET_LEFT;
  // Counted from zero, so lines land on round figures rather than building up rounding errors.
  for (let i = Math.ceil(west / step - 1e-9); i <= Math.floor(east / step + 1e-9); i++) {
    const lng = i * step;
    lines.push([[lng, s], [lng, n]]);
    labels.push({ lng, lat: labelLat, text: gridLabel(((lng + 540) % 360) - 180, false, step), meridian: true });
  }
  for (let i = Math.ceil(s / step - 1e-9); i <= Math.floor(n / step + 1e-9); i++) {
    const lat = i * step;
    lines.push([[west, lat], [east, lat]]);
    labels.push({ lng: labelLng, lat, text: gridLabel(lat, true, step), meridian: false });
  }
  return { lines, labels };
}

/** Shows or hides the grid, and redraws it when the map stops moving. */
export class Graticule {
  constructor(map) {
    this.map = map;
    this.visible = false;
    this.markers = [];
    map.on('moveend', () => this.refresh());
  }

  /** Adds the lines to a new style, over the imported layers and under the measure line and colours' arrows. */
  install() {
    const map = this.map;
    map.addSource(SOURCE, { type: 'geojson', data: EMPTY });
    map.addLayer({
      id: LINE_LAYER, type: 'line', source: SOURCE,
      layout: { visibility: this.visible ? 'visible' : 'none' },
      paint: { 'line-color': '#F4F6F8', 'line-opacity': 0.35, 'line-width': 1 }
    });
    this.refresh();
  }

  setVisible(value) {
    this.visible = value;
    if (this.map.getLayer(LINE_LAYER)) this.map.setLayoutProperty(LINE_LAYER, 'visibility', value ? 'visible' : 'none');
    this.refresh();
  }

  refresh() {
    if (!this.visible) {
      this.markers.forEach((m) => m.remove());
      this.markers = [];
      return;
    }
    const b = this.map.getBounds();
    const { lines, labels } = gridFor(b.getSouth(), b.getWest(), b.getNorth(), b.getEast());
    this.map.getSource(SOURCE)?.setData({
      type: 'FeatureCollection',
      features: lines.map((coordinates) => ({ type: 'Feature', properties: {}, geometry: { type: 'LineString', coordinates } }))
    });
    this.markers.forEach((m) => m.remove());
    this.markers = labels.map((l) => {
      const node = document.createElement('div');
      node.className = 'grid-label';
      node.textContent = l.text;
      return new maplibregl.Marker({ element: node, anchor: 'left', offset: [4, 0] }).setLngLat([l.lng, l.lat]).addTo(this.map);
    });
  }
}
