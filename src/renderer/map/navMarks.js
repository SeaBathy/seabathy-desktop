// Buoys, beacons, lights, pipelines, submarine cables and mooring areas from free government
// data (and OpenStreetMap), as on the phone (map/NavMarks.kt). Off by default, and only shown
// once turned on (the first-launch agreement covers it). The data is built by
// testing/navmarks in the dev folder.

import * as maplibregl from 'maplibre-gl';
import { addImageResolver } from './imageResolver.js';
import MARKS from '../data/navmarks.geojson';
import LINES from '../data/navlines.geojson';

export const NAV_MARKS_CREDIT = 'Nav marks: Transport for NSW, WA DoT, Vic Gov, Qld Gov, AMSA, NOPTA, Geoscience Australia, ACMA, © OpenStreetMap';
export const NOT_FOR_NAVIGATION = 'Positions may be old or wrong, and many marks are missing.';
const LAYERS = ['navlines-area-fill', 'navlines-area-line', 'navlines-pipelines', 'navlines-cables', 'navmarks'];
const AREA_KINDS = ['area_anchorage', 'area_mooring', 'area_marina', 'area_channel'];
const KIND_TITLES = { pipeline: 'Pipeline', cable: 'Submarine cable', area_anchorage: 'Anchorage', area_mooring: 'Mooring area', area_marina: 'Marina', area_channel: 'Shipping channel' };

// ---------- icons: IALA region A, drawn as they look from the boat ----------
const RED = '#e3262f', GREEN = '#17a34a', YEL = '#f5c518', BLK = '#111', MAG = '#d6249f', WHITE = '#fff', GREY = '#94a3b8';
const TOPMARKED = ['port', 'stbd', 'pref_port', 'pref_stbd', 'card_n', 'card_e', 'card_s', 'card_w', 'isolated', 'safe', 'special'];

function tri(c, x, y, s, up) {
  c.beginPath();
  if (up) { c.moveTo(x, y - s); c.lineTo(x + s, y + s * 0.7); c.lineTo(x - s, y + s * 0.7); } else { c.moveTo(x, y + s); c.lineTo(x + s, y - s * 0.7); c.lineTo(x - s, y - s * 0.7); }
  c.closePath(); c.fill(); c.stroke();
}
function ball(c, x, y, r, col) { c.fillStyle = col; c.beginPath(); c.arc(x, y, r, 0, 7); c.fill(); c.stroke(); }
function topmark(c, cat, x, y) {
  c.fillStyle = BLK;
  if (cat === 'card_n') { tri(c, x, y - 7, 4, true); tri(c, x, y + 1, 4, true); }
  else if (cat === 'card_s') { tri(c, x, y - 7, 4, false); tri(c, x, y + 1, 4, false); }
  else if (cat === 'card_e') { tri(c, x, y - 8, 4, true); tri(c, x, y + 2, 4, false); }
  else if (cat === 'card_w') { tri(c, x, y - 6, 4, false); tri(c, x, y + 1, 4, true); }
  else if (cat === 'isolated') { ball(c, x, y - 7, 3.2, BLK); ball(c, x, y, 3.2, BLK); }
  else if (cat === 'safe') ball(c, x, y - 3, 4, RED);
  else if (cat === 'special') {
    c.strokeStyle = YEL; c.lineWidth = 3; c.beginPath();
    c.moveTo(x - 4, y - 7); c.lineTo(x + 4, y + 1); c.moveTo(x + 4, y - 7); c.lineTo(x - 4, y + 1); c.stroke();
    c.strokeStyle = BLK; c.lineWidth = 1;
  }
  else if (cat === 'port' || cat === 'pref_port') { c.fillStyle = RED; c.fillRect(x - 4.5, y - 8, 9, 9); c.strokeRect(x - 4.5, y - 8, 9, 9); }
  else if (cat === 'stbd' || cat === 'pref_stbd') { c.fillStyle = GREEN; tri(c, x, y - 3, 5.5, true); }
}
function bodyColours(cat) {
  return ({ port: [RED], stbd: [GREEN], pref_port: [RED, GREEN, RED], pref_stbd: [GREEN, RED, GREEN],
    card_n: [BLK, YEL], card_s: [YEL, BLK], card_e: [BLK, YEL, BLK], card_w: [YEL, BLK, YEL],
    isolated: [BLK, RED, BLK], safe: [RED, WHITE, RED], special: [YEL], lead: ['#f97316'], mooring: ['#f8fafc'] })[cat] || [GREY];
}
function bands(c, x, y, w, h, cols) { const bh = h / cols.length; cols.forEach((col, i) => { c.fillStyle = col; c.fillRect(x, y + i * bh, w, bh + 0.5); }); }
function buoyShape(c, cat, x, base) {
  c.beginPath();
  if (cat === 'port') c.rect(x - 7, base - 15, 14, 13);
  else if (cat === 'stbd') { c.moveTo(x - 8, base - 2); c.lineTo(x, base - 18); c.lineTo(x + 8, base - 2); c.closePath(); }
  else if (cat === 'mooring' || cat === 'other') c.arc(x, base - 8, 7, 0, 7);
  else { c.moveTo(x - 8, base - 2); c.lineTo(x - 3, base - 20); c.lineTo(x + 3, base - 20); c.lineTo(x + 8, base - 2); c.closePath(); }
}

export function drawIcon(cat, struct) {
  const S = 2, W = 34, H = 40;
  const cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const c = cv.getContext('2d'); c.scale(S, S); c.lineJoin = 'round'; c.strokeStyle = BLK; c.lineWidth = 1;
  const x = 17, base = 34;
  if (cat === 'wreck') {
    c.lineWidth = 2; c.beginPath();
    c.moveTo(6, 22); c.lineTo(28, 22); c.moveTo(12, 15); c.lineTo(12, 29); c.moveTo(17, 13); c.lineTo(17, 31); c.moveTo(22, 15); c.lineTo(22, 29); c.stroke();
  } else if (struct === 'light') {
    if (cat === 'lighthouse') {
      c.fillStyle = WHITE; c.beginPath(); c.moveTo(x - 4, base); c.lineTo(x - 2.5, 18); c.lineTo(x + 2.5, 18); c.lineTo(x + 4, base); c.closePath(); c.fill(); c.stroke();
      c.fillStyle = RED; c.fillRect(x - 3.5, 15, 7, 4); c.strokeRect(x - 3.5, 15, 7, 4);
    } else {
      c.fillStyle = '#334155'; c.fillRect(x - 1.5, 20, 3, base - 20); c.strokeRect(x - 1.5, 20, 3, base - 20);
      ball(c, x, 19, 3.2, cat === 'lead' ? '#f97316' : '#fde047');
      c.fillStyle = BLK; c.fillRect(x - 5, base - 1, 10, 2);
    }
  } else if (struct === 'virtual') {
    c.setLineDash([3, 2]); c.strokeStyle = MAG; c.lineWidth = 2; c.beginPath(); c.arc(x, 22, 9, 0, 7); c.stroke();
    c.setLineDash([]); c.strokeStyle = BLK; c.lineWidth = 1; topmark(c, cat, x, 25);
  } else if (struct === 'beacon') {
    bands(c, x - 2, 15, 4, base - 15, bodyColours(cat)); c.strokeRect(x - 2, 15, 4, base - 15);
    if (TOPMARKED.includes(cat)) topmark(c, cat, x, 12);
    else if (cat === 'lead') { c.fillStyle = '#f97316'; tri(c, x, 9, 5, true); }
    else ball(c, x, 11, 3, GREY);
    c.fillStyle = BLK; c.fillRect(x - 6, base - 1, 12, 2);
  } else if (struct === 'buoy') {
    c.save(); buoyShape(c, cat, x, base); c.clip(); bands(c, x - 9, base - 21, 18, 20, bodyColours(cat)); c.restore();
    buoyShape(c, cat, x, base); c.stroke();
    if (!['port', 'stbd', 'mooring', 'other'].includes(cat)) topmark(c, cat, x, base - 24);
    c.strokeStyle = '#38bdf8'; c.lineWidth = 1.5; c.beginPath();
    c.moveTo(x - 11, base); c.quadraticCurveTo(x - 5, base - 2, x, base); c.quadraticCurveTo(x + 5, base + 2, x + 11, base); c.stroke();
  } else {
    ball(c, x, 22, 5, GREY);
  }
  return cv;
}

function cableWave() {
  const S = 2, W = 16, H = 7, cv = document.createElement('canvas'); cv.width = W * S; cv.height = H * S;
  const c = cv.getContext('2d'); c.scale(S, S); c.strokeStyle = '#dc2626'; c.lineWidth = 1.4; c.beginPath();
  for (let i = 0; i <= W; i++) { const y = H / 2 + Math.sin(i / W * Math.PI * 2) * 2.2; if (i) c.lineTo(i, y); else c.moveTo(i, y); }
  c.stroke();
  return c.getImageData(0, 0, cv.width, cv.height);
}

export class NavMarks {
  constructor(map) {
    this.map = map;
    this.visible = false;
    this.popup = null;
    addImageResolver(map, (id) => {
      if (!id?.includes('|') || id.startsWith('txt:')) return false;
      const [cat, struct] = id.split('|');
      const cv = drawIcon(cat, struct);
      map.addImage(id, cv.getContext('2d').getImageData(0, 0, cv.width, cv.height), { pixelRatio: 2 });
      return true;
    });
  }

  /** Adds the layers to a new style, over the imported layers. */
  install() {
    const map = this.map;
    if (map.getSource('navmarks-src')) return;
    if (!map.hasImage('navlines-cable-wave')) map.addImage('navlines-cable-wave', cableWave(), { pixelRatio: 2 });
    map.addSource('navlines-src', { type: 'geojson', data: LINES });
    map.addSource('navmarks-src', { type: 'geojson', data: MARKS });
    const vis = this.visible ? 'visible' : 'none';
    const areaColour = ['match', ['get', 'kind'], 'area_channel', '#64748b', 'area_anchorage', '#7c3aed', '#0ea5e9'];
    const areas = ['in', ['get', 'kind'], ['literal', AREA_KINDS]];
    map.addLayer({ id: 'navlines-area-fill', type: 'fill', source: 'navlines-src', filter: areas,
      layout: { visibility: vis }, paint: { 'fill-color': areaColour, 'fill-opacity': 0.12 } });
    map.addLayer({ id: 'navlines-area-line', type: 'line', source: 'navlines-src', filter: areas,
      layout: { visibility: vis }, paint: { 'line-color': areaColour, 'line-width': 1.5, 'line-dasharray': [3, 2] } });
    map.addLayer({ id: 'navlines-pipelines', type: 'line', source: 'navlines-src', filter: ['==', ['get', 'kind'], 'pipeline'],
      layout: { visibility: vis, 'line-cap': 'round' },
      paint: { 'line-color': '#111', 'line-width': ['interpolate', ['linear'], ['zoom'], 5, 1.5, 12, 3], 'line-dasharray': [0.1, 2] } });
    map.addLayer({ id: 'navlines-cables', type: 'line', source: 'navlines-src', filter: ['==', ['get', 'kind'], 'cable'],
      layout: { visibility: vis }, paint: { 'line-pattern': 'navlines-cable-wave', 'line-width': 7 } });
    map.addLayer({ id: 'navmarks', type: 'symbol', source: 'navmarks-src',
      layout: { visibility: vis, 'icon-image': ['get', 'icon'], 'icon-anchor': 'bottom', 'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 6, 0.5, 10, 0.8, 14, 1.15, 17, 1.5] } });
  }

  setVisible(on) {
    this.visible = on;
    if (!on) this.popup?.remove();
    for (const id of LAYERS) if (this.map.getLayer(id)) this.map.setLayoutProperty(id, 'visibility', on ? 'visible' : 'none');
  }

  /** Shows what's under a click, if anything. True when something was shown. */
  click(lat, lng) {
    if (!this.visible) return false;
    const map = this.map;
    const p = map.project([lng, lat]);
    const box = [[p.x - 12, p.y - 12], [p.x + 12, p.y + 12]];
    const f = map.queryRenderedFeatures(box, { layers: ['navmarks'] })[0]
      || map.queryRenderedFeatures(box, { layers: ['navlines-pipelines', 'navlines-cables'] })[0]
      || map.queryRenderedFeatures(p, { layers: ['navlines-area-fill'] })[0];
    if (!f) return false;
    const q = f.properties;
    const content = document.createElement('div');
    content.className = 'navmark-popup';
    const title = document.createElement('b');
    title.textContent = q.label || KIND_TITLES[q.kind] || 'Mark';
    content.append(title);
    for (const line of [q.name, q.src && `Source: ${q.src}`, NOT_FOR_NAVIGATION]) {
      if (!line || line === 'null') continue;
      const d = document.createElement('div');
      d.textContent = line;
      content.append(d);
    }
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ offset: 18, maxWidth: '280px' }).setLngLat([lng, lat]).setDOMContent(content).addTo(map);
    return true;
  }
}

/** Turning the layer on: the first-launch agreement (ui/safetyTerms.js) already covers it. */
export function confirmNotForNavigation(onResult) {
  onResult(true);
}
