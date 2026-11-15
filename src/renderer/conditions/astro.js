// Sun and moon times worked out here (no data, no download): sunrise,
// sunset, first light, moonrise and moonset, the moon's phase, and solunar
// periods (majors when the moon is overhead or underfoot, minors at moonrise
// and moonset). Low-precision formulas, good to a few minutes. Kept in step
// with the Android app's Astro.kt.

const RAD = Math.PI / 180;
const DAY_MS = 86400000;
const STEP_MS = 5 * 60000;

const daysSinceJ2000 = (ms) => ms / DAY_MS - 10957.5;
const sidereal = (d, lng) => 280.46061837 + 360.98564736629 * d + lng;
const obliquity = (d) => (23.439 - 0.0000004 * d) * RAD;

function sun(d) {
  const g = (357.528 + 0.9856003 * d) * RAD;
  const lambda = (280.460 + 0.9856474 * d + 1.915 * Math.sin(g) + 0.020 * Math.sin(2 * g)) * RAD;
  const e = obliquity(d);
  return { ra: Math.atan2(Math.cos(e) * Math.sin(lambda), Math.cos(lambda)), dec: Math.asin(Math.sin(e) * Math.sin(lambda)), lon: lambda };
}

function moon(d) {
  const l = (218.316 + 13.176396 * d) * RAD;
  const m = (134.963 + 13.064993 * d) * RAD;
  const f = (93.272 + 13.229350 * d) * RAD;
  const lon = l + 6.289 * RAD * Math.sin(m);
  const b = 5.128 * RAD * Math.sin(f);
  const e = obliquity(d);
  return {
    ra: Math.atan2(Math.sin(lon) * Math.cos(e) - Math.tan(b) * Math.sin(e), Math.cos(lon)),
    dec: Math.asin(Math.sin(b) * Math.cos(e) + Math.cos(b) * Math.sin(e) * Math.sin(lon)),
    lon
  };
}

function altitude(p, d, lat, lng) {
  const h = sidereal(d, lng) * RAD - p.ra;
  const phi = lat * RAD;
  return Math.asin(Math.sin(phi) * Math.sin(p.dec) + Math.cos(phi) * Math.cos(p.dec) * Math.cos(h)) / RAD;
}

export const sunAltitude = (ms, lat, lng) => { const d = daysSinceJ2000(ms); return altitude(sun(d), d, lat, lng); };
export const moonAltitude = (ms, lat, lng) => { const d = daysSinceJ2000(ms); return altitude(moon(d), d, lat, lng); };

function moonHourAngle(ms, lng) {
  const d = daysSinceJ2000(ms);
  let h = (sidereal(d, lng) - moon(d).ra / RAD) % 360;
  if (h > 180) h -= 360;
  if (h <= -180) h += 360;
  return h;
}

/** [lit fraction 0..1, waxing]. */
export function moonPhase(ms) {
  const d = daysSinceJ2000(ms);
  let elongation = ((moon(d).lon - sun(d).lon) / RAD) % 360;
  if (elongation < 0) elongation += 360;
  return [(1 - Math.cos(elongation * RAD)) / 2, elongation < 180];
}

function crossings(start, threshold, alt) {
  let rise = null;
  let set = null;
  let prev = alt(start) - threshold;
  for (let t = start; t < start + DAY_MS; t += STEP_MS) {
    const now = alt(t + STEP_MS) - threshold;
    if (prev < 0 && now >= 0 && rise === null) rise = t + (-prev / (now - prev)) * STEP_MS;
    if (prev >= 0 && now < 0 && set === null) set = t + (prev / (prev - now)) * STEP_MS;
    prev = now;
  }
  return [rise, set];
}

function transits(start, lng) {
  const out = [];
  let prev = moonHourAngle(start, lng);
  for (let t = start; t < start + DAY_MS; t += STEP_MS) {
    const now = moonHourAngle(t + STEP_MS, lng);
    if (prev < 0 && now >= 0 && now - prev < 90) out.push(t + (-prev / (now - prev)) * STEP_MS);
    if (prev > 90 && now < -90) out.push(t + ((180 - prev) / (now + 360 - prev)) * STEP_MS);
    prev = now;
  }
  return out;
}

export function phaseName(illumination, waxing) {
  if (illumination < 0.03) return 'new moon';
  if (illumination > 0.97) return 'full moon';
  if (Math.abs(illumination - 0.5) < 0.06) return waxing ? 'first quarter' : 'last quarter';
  if (illumination < 0.5) return waxing ? 'waxing crescent' : 'waning crescent';
  return waxing ? 'waxing gibbous' : 'waning gibbous';
}

/** The day starting at [start] (local midnight) at [lat]/[lng]. */
export function astroDay(start, lat, lng) {
  const [sunrise, sunset] = crossings(start, -0.833, (t) => sunAltitude(t, lat, lng));
  const [firstLight, lastLight] = crossings(start, -6, (t) => sunAltitude(t, lat, lng));
  const [moonrise, moonset] = crossings(start, 0.125, (t) => moonAltitude(t, lat, lng));
  const [illumination, waxing] = moonPhase(start + DAY_MS / 2);
  return {
    sunrise, sunset, firstLight, lastLight, moonrise, moonset,
    majors: transits(start, lng),
    minors: [moonrise, moonset].filter((x) => x !== null).sort((a, b) => a - b),
    illumination, waxing, phaseName: phaseName(illumination, waxing)
  };
}
