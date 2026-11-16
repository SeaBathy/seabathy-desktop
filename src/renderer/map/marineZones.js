// Marine park zones (every Australian marine park, Commonwealth and state, from CAPAD),
// reef and island names, and boat ramps. Kept in step with the phone app's MarineZones.kt;
// the data is built by testing/zones in the dev folder. This map has no fonts, so names
// are drawn as small images, made when first needed.
import ZONES from '../data/zones.geojson';
import PLACES from '../data/places.geojson';
import RAMPS from '../data/ramps.geojson';
import { prefs } from '../core.js';
import { addImageResolver } from './imageResolver.js';

export const ZONES_CREDIT = 'Marine parks: CAPAD 2024, DCCEEW (CC BY 4.0)';
export const NAMES_CREDIT = 'Names: Geoscience Australia gazetteer, GBRMPA (CC BY 4.0)';
export const RAMPS_CREDIT = 'Boat ramps: © OpenStreetMap contributors';
export const NOT_OFFICIAL = 'A guide only, from national data that can lag behind changes. The official zoning map and rules '
  + 'for the park are the law: check them before you fish. Not for navigation.';

export const ZoneMode = { OFF: 'OFF', NO_TAKE: 'NO_TAKE', ALL: 'ALL' };
export const ZONE_MODE_LABELS = { OFF: 'Off', NO_TAKE: 'No-take zones only', ALL: 'All zones' };

const COLOURS = { nt: '#22C55E', lim: '#EAB308', gen: '#60A5FA' };
const RANK = { nt: 3, lim: 2, gen: 1 };
const TEXT = 'txt:';

export function describeZone(q) {
  const title = q.c === 'nt' ? 'No-take zone' : q.c === 'lim' ? 'Limited fishing zone' : 'General use zone';
  const what = q.c === 'nt'
    ? `No-take zone: no fishing or collecting of any kind.${q.i === 'Ia' ? ' Some zones like this are also no entry.' : ''}`
    : q.c === 'lim' ? 'Limited fishing: some fishing is allowed, with limits on gear and methods (for example no trawling).'
      : 'Fishing allowed under the usual rules for the park.';
  const where = [q.n, q.t, q.s === 'COM' ? 'Commonwealth waters' : q.s].filter(Boolean).join(' · ');
  return { title, lines: [where, what, NOT_OFFICIAL, ZONES_CREDIT] };
}

/** A label as an image: "txt:<colour>~<text>", with a dark halo. ("|" is the buoy icons' separator.) */
function textImage(id) {
  const [colour, ...rest] = id.slice(TEXT.length).split('~');
  const lines = rest.join('~').split('\n');
  const ratio = 2;
  const size = 11 * ratio;
  const c = document.createElement('canvas');
  const g = c.getContext('2d');
  const font = `600 ${size}px system-ui, sans-serif`;
  g.font = font;
  const w = Math.ceil(Math.max(...lines.map((l) => g.measureText(l).width))) + 8 * ratio;
  const h = Math.ceil(size * 1.25 * lines.length) + 4 * ratio;
  c.width = w;
  c.height = h;
  g.font = font;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  g.lineJoin = 'round';
  g.lineWidth = 3 * ratio;
  g.strokeStyle = '#0B1622';
  g.fillStyle = colour;
  lines.forEach((l, i) => {
    const y = 2 * ratio + size * 1.25 * (i + 0.5);
    g.strokeText(l, w / 2, y);
    g.fillText(l, w / 2, y);
  });
  return { data: g.getImageData(0, 0, w, h), ratio };
}

function rampIcon() {
  const s = 2;
  const c = document.createElement('canvas');
  c.width = 22 * s;
  c.height = 22 * s;
  const g = c.getContext('2d');
  g.fillStyle = '#0284C7';
  g.strokeStyle = '#fff';
  g.lineWidth = 1.5 * s;
  g.beginPath();
  g.roundRect(1 * s, 1 * s, 20 * s, 20 * s, 5 * s);
  g.fill();
  g.stroke();
  g.fillStyle = '#fff';
  g.beginPath(); g.moveTo(4 * s, 17 * s); g.lineTo(18 * s, 17 * s); g.lineTo(18 * s, 13 * s); g.closePath(); g.fill();
  g.beginPath(); g.moveTo(7 * s, 9 * s); g.lineTo(16 * s, 9 * s); g.lineTo(14 * s, 12 * s); g.lineTo(9 * s, 12 * s); g.closePath(); g.fill();
  return g.getImageData(0, 0, c.width, c.height);
}

export class MarineZones {
  constructor(map) {
    this.map = map;
    this.mode = ZoneMode[prefs.getString('zones_mode')] || ZoneMode.OFF;
    this.names = prefs.getBoolean('zones_names', false);
    this.ramps = prefs.getBoolean('zones_ramps', false);
    this.popup = null;
    addImageResolver(map, (id) => {
      if (!id?.startsWith(TEXT)) return false;
      const { data, ratio } = textImage(id);
      map.addImage(id, data, { pixelRatio: ratio });
      return true;
    });
  }

  get acknowledged() { return prefs.getBoolean('zones_ack', false); }
  acknowledge() { prefs.put('zones_ack', true); }
  get anyShown() { return this.mode !== ZoneMode.OFF || this.names || this.ramps; }

  credits() {
    return [this.mode !== ZoneMode.OFF && ZONES_CREDIT, this.names && NAMES_CREDIT, this.ramps && RAMPS_CREDIT].filter(Boolean);
  }

  setMode(m) { this.mode = m; prefs.put('zones_mode', m); this.apply(); }
  setNames(on) { this.names = on; prefs.put('zones_names', on); this.apply(); }
  setRamps(on) { this.ramps = on; prefs.put('zones_ramps', on); this.apply(); }

  /** The zone areas: under the buoys and the user's own marks. */
  installAreas() {
    const map = this.map;
    if (map.getSource('zones-src')) return;
    map.addSource('zones-src', { type: 'geojson', data: ZONES });
    const colour = ['match', ['get', 'c'], 'nt', COLOURS.nt, 'lim', COLOURS.lim, COLOURS.gen];
    map.addLayer({ id: 'zones-fill', type: 'fill', source: 'zones-src',
      paint: { 'fill-color': colour, 'fill-opacity': ['match', ['get', 'c'], 'nt', 0.3, 'lim', 0.14, 0.07] } });
    map.addLayer({ id: 'zones-line', type: 'line', source: 'zones-src',
      paint: { 'line-color': colour, 'line-opacity': 0.9,
        'line-width': ['interpolate', ['linear'], ['zoom'], 5, ['match', ['get', 'c'], 'nt', 1.2, 0.6], 12, ['match', ['get', 'c'], 'nt', 2.6, 1.2]] } });
    map.addLayer({ id: 'zones-label', type: 'symbol', source: 'zones-src', minzoom: 8,
      layout: { 'icon-image': ['match', ['get', 'c'],
        'nt', ['concat', TEXT, '#BBF7D0~NO TAKE\n', ['get', 'n']],
        'lim', ['concat', TEXT, '#FEF08A~Limited fishing\n', ['get', 'n']],
        ['concat', TEXT, '#BFDBFE~', ['get', 'n']]] } });
    this.apply();
  }

  /** Names and ramps: above everything else on the chart. */
  installPoints() {
    const map = this.map;
    if (map.getSource('places-src')) return;
    map.addSource('places-src', { type: 'geojson', data: PLACES });
    map.addSource('ramps-src', { type: 'geojson', data: RAMPS });
    if (!map.hasImage('ramp-icon')) map.addImage('ramp-icon', rampIcon(), { pixelRatio: 2 });
    const underwater = ['in', ['get', 'k'], ['literal', ['reef', 'shoal', 'bank', 'seamount']]];
    const label = { 'icon-image': ['concat', TEXT, ['case', underwater, '#7DD3FC', '#F1F5F9'], '~', ['get', 'n']],
      'icon-padding': 4, 'symbol-sort-key': ['match', ['get', 'k'], 'island', 0, 'reef', 1, 2] };
    map.addLayer({ id: 'places-label', type: 'symbol', source: 'places-src', minzoom: 7, filter: ['!', ['has', 'id']], layout: label });
    // Numbered reefs ("Reef 19-131") only close in, so the names stay readable further out.
    map.addLayer({ id: 'places-label-numbered', type: 'symbol', source: 'places-src', minzoom: 10, filter: ['has', 'id'], layout: label });
    map.addLayer({ id: 'ramps', type: 'symbol', source: 'ramps-src', minzoom: 8,
      layout: { 'icon-image': 'ramp-icon', 'icon-allow-overlap': true,
        'icon-size': ['interpolate', ['linear'], ['zoom'], 8, 0.55, 14, 1] } });
    this.apply();
  }

  apply() {
    const map = this.map;
    const vis = (on) => (on ? 'visible' : 'none');
    const filter = this.mode === ZoneMode.NO_TAKE ? ['==', ['get', 'c'], 'nt'] : null;
    for (const id of ['zones-fill', 'zones-line', 'zones-label']) {
      if (!map.getLayer(id)) continue;
      map.setLayoutProperty(id, 'visibility', vis(this.mode !== ZoneMode.OFF));
      map.setFilter(id, filter);
    }
    for (const id of ['places-label', 'places-label-numbered']) if (map.getLayer(id)) map.setLayoutProperty(id, 'visibility', vis(this.names));
    if (map.getLayer('ramps')) map.setLayoutProperty('ramps', 'visibility', vis(this.ramps));
    if (!this.anyShown) this.popup?.remove();
  }

  /** Shows what's under a click: a ramp, the strictest zone, or a name. True when something was shown. */
  click(lat, lng) {
    if (!this.anyShown) return false;
    const map = this.map;
    const p = map.project([lng, lat]);
    const box = [[p.x - 11, p.y - 11], [p.x + 11, p.y + 11]];
    let title = null;
    let lines = [];
    const ramp = this.ramps && map.queryRenderedFeatures(box, { layers: ['ramps'] })[0];
    if (ramp) {
      title = 'Boat ramp';
      lines = [ramp.properties.n || 'Boat ramp', ramp.properties.fee && 'A fee applies.', 'From OpenStreetMap: check it’s open and suits your boat.'];
    } else if (this.mode !== ZoneMode.OFF) {
      const zone = map.queryRenderedFeatures(p, { layers: ['zones-fill'] }).sort((a, b) => (RANK[b.properties.c] || 0) - (RANK[a.properties.c] || 0))[0];
      if (zone) ({ title, lines } = describeZone(zone.properties));
    }
    if (!title && this.names) {
      const place = map.queryRenderedFeatures(box, { layers: ['places-label', 'places-label-numbered'] })[0];
      if (place) {
        const kind = (place.properties.k || '').replace(/^./, (x) => x.toUpperCase());
        title = place.properties.n;
        lines = [kind, NAMES_CREDIT];
      }
    }
    if (!title) return false;
    const content = document.createElement('div');
    content.className = 'navmark-popup';
    const b = document.createElement('b');
    b.textContent = title;
    content.append(b);
    for (const line of lines) {
      if (!line) continue;
      const d = document.createElement('div');
      d.textContent = line;
      content.append(d);
    }
    this.popup?.remove();
    this.popup = new maplibregl.Popup({ offset: 12, maxWidth: '300px' }).setLngLat([lng, lat]).setDOMContent(content).addTo(map);
    return true;
  }
}
