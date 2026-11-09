// Great-circle maths, coordinate formatting/parsing and GPX, ported from the
// Android app's GeoMath / CoordinateFormatter / GpxExporter.

const EARTH_RADIUS_NM = 3440.065;
export const KM_PER_NM = 1.852;
const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

export function distanceNm(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLng = rad(b.lng - a.lng);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_NM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function totalNm(points) {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += distanceNm(points[i - 1], points[i]);
  return total;
}

export function bearing(a, b) {
  const dLng = rad(b.lng - a.lng);
  const y = Math.sin(dLng) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(dLng);
  return (deg(Math.atan2(y, x)) + 360) % 360;
}

export function eta(nm, knots) {
  if (!(nm > 0) || !(knots > 0)) return '—';
  const hours = nm / knots;
  const h = Math.floor(hours);
  const m = Math.round((hours - h) * 60);
  return h > 0 ? `${h}h ${m}m` : `${m}m`;
}

export function formatDistance(nm) {
  if (nm < 0.1) return `${Math.round(nm * KM_PER_NM * 1000)} m`;
  return `${nm.toFixed(nm < 10 ? 2 : 1)} nm`;
}

function formatAxis(value, positive, negative, format) {
  const hemi = value >= 0 ? positive : negative;
  const abs = Math.abs(value);
  if (format === 'dd') return value.toFixed(5);
  const d = Math.floor(abs);
  const minutes = (abs - d) * 60;
  if (format === 'ddm') return `${d}°${minutes.toFixed(3).padStart(6, '0')}′${hemi}`;
  const m = Math.floor(minutes);
  const s = (minutes - m) * 60;
  return `${d}°${String(m).padStart(2, '0')}′${s.toFixed(1).padStart(4, '0')}″${hemi}`;
}

export function formatLatLng(lat, lng, format = 'ddm') {
  return `${formatAxis(lat, 'N', 'S', format)}  ${formatAxis(lng, 'E', 'W', format)}`;
}

export function formatLat(lat, format) { return formatAxis(lat, 'N', 'S', format); }
export function formatLng(lng, format) { return formatAxis(lng, 'E', 'W', format); }

/**
 * Parses "-34.2", "34 12.345 S", "34°12'20.7\"S" and similar. Returns null
 * when it cannot be read or is out of range.
 */
export function parseCoordinate(text, isLat) {
  if (typeof text !== 'string') return null;
  let s = text.trim().toUpperCase();
  if (!s) return null;
  let sign = 1;
  const hemi = s.match(/[NSEW]/);
  if (hemi) {
    if (hemi[0] === 'S' || hemi[0] === 'W') sign = -1;
    if (isLat && /[EW]/.test(hemi[0])) return null;
    if (!isLat && /[NS]/.test(hemi[0])) return null;
    s = s.replace(/[NSEW]/g, ' ');
  }
  if (s.trim().startsWith('-')) {
    sign *= -1;
    s = s.replace('-', ' ');
  }
  const parts = s.replace(/[°º'′"″,]/g, ' ').trim().split(/\s+/).filter(Boolean).map(Number);
  if (!parts.length || parts.length > 3 || parts.some((n) => !Number.isFinite(n) || n < 0)) return null;
  const [d, m = 0, sec = 0] = parts;
  if (m >= 60 || sec >= 60) return null;
  const value = sign * (d + m / 60 + sec / 3600);
  const limit = isLat ? 90 : 180;
  return Math.abs(value) <= limit ? value : null;
}

const xmlEscape = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&apos;');

const GPX_SYMBOLS = {
  marker: 'Waypoint', diamond: 'Diamond, Red', flag: 'Flag, Blue', anchor: 'Anchor',
  fish: 'Fishing Area', wreck: 'Shipwreck', mob: 'Man Overboard'
};

export function toGpx(waypoints, routes) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="SeaBathy Desktop" xmlns="http://www.topografix.com/GPX/1/1">'
  ];
  for (const w of waypoints) {
    lines.push(`  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lng.toFixed(7)}">`);
    lines.push(`    <name>${xmlEscape(w.name)}</name>`);
    if (w.desc) lines.push(`    <desc>${xmlEscape(w.desc)}</desc>`);
    lines.push(`    <sym>${xmlEscape(GPX_SYMBOLS[w.icon] || 'Waypoint')}</sym>`);
    lines.push(`    <extensions><color>${xmlEscape(w.color)}</color><icon>${xmlEscape(w.icon)}</icon></extensions>`);
    lines.push('  </wpt>');
  }
  for (const r of routes) {
    lines.push('  <rte>', `    <name>${xmlEscape(r.name)}</name>`);
    r.points.forEach((p, i) => {
      lines.push(`    <rtept lat="${p.lat.toFixed(7)}" lon="${p.lng.toFixed(7)}"><name>${xmlEscape(p.name || `${r.name} ${i + 1}`)}</name></rtept>`);
    });
    lines.push('  </rte>');
  }
  lines.push('</gpx>');
  return lines.join('\n');
}

/** Reads waypoints (wpt) and routes (rte, plus trk as routes) from GPX text. */
export function fromGpx(text) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  if (doc.querySelector('parsererror')) throw new Error('This file is not valid GPX/XML');
  const child = (el, name) => el.getElementsByTagName(name)[0]?.textContent?.trim() || '';
  const point = (el) => ({ lat: parseFloat(el.getAttribute('lat')), lng: parseFloat(el.getAttribute('lon')) });
  const valid = (p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Math.abs(p.lat) <= 90 && Math.abs(p.lng) <= 180;
  const symToIcon = Object.fromEntries(Object.entries(GPX_SYMBOLS).map(([k, v]) => [v.toLowerCase(), k]));

  const waypoints = [...doc.getElementsByTagName('wpt')].map((el) => {
    const p = point(el);
    const icon = child(el, 'icon') || symToIcon[child(el, 'sym').toLowerCase()] || 'marker';
    const color = child(el, 'color');
    return { ...p, name: child(el, 'name'), desc: child(el, 'desc') || child(el, 'cmt'), icon, color: /^#[0-9a-f]{6}$/i.test(color) ? color : null };
  }).filter(valid);

  const routes = [];
  for (const rte of doc.getElementsByTagName('rte')) {
    const points = [...rte.getElementsByTagName('rtept')].map((el) => ({ ...point(el), name: child(el, 'name') || null })).filter(valid);
    if (points.length >= 2) routes.push({ name: child(rte, 'name') || 'Imported route', points });
  }
  for (const trk of doc.getElementsByTagName('trk')) {
    const points = [...trk.getElementsByTagName('trkpt')].map(point).filter(valid);
    if (points.length >= 2) routes.push({ name: child(trk, 'name') || 'Imported track', points: thin(points, 500) });
  }
  return { waypoints, routes };
}

function thin(points, max) {
  if (points.length <= max) return points;
  const step = points.length / max;
  const out = [];
  for (let i = 0; i < max; i++) out.push(points[Math.floor(i * step)]);
  out.push(points[points.length - 1]);
  return out;
}
