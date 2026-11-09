// Tide maths, as on the phone: the tide curve (tides/TideCurve.kt), harmonic
// analysis with nodal corrections (tides/TideHarmonics.kt), sunrise, sunset
// and the moon (tides/SunMoon.kt), and saved places (tides/TidePlaces.kt).

import { prefs, uuid } from '../core.js';

export const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const RATE_STEP_MS = 10 * 60_000;
const SCAN_STEP_MS = 3 * 60_000;
const LOOKAHEAD_MS = 7 * 24 * HOUR_MS;

// ------------------------------------------------------------------ curve

/** Sea level over time from hourly samples, smoothed with a cubic Hermite curve. Heights in metres. */
export class TideCurve {
  constructor(timesMillis, heightsM) {
    if (timesMillis.length !== heightsM.length) throw new Error('times and heights differ in length');
    this.times = timesMillis;
    this.heights = heightsM;
  }

  get startMillis() { return this.times.length ? this.times[0] : null; }
  get endMillis() { return this.times.length ? this.times[this.times.length - 1] : null; }

  covers(t) {
    return this.times.length >= 2 && t >= this.times[0] && t <= this.times[this.times.length - 1];
  }

  slope(i) {
    const { times: t, heights: h } = this;
    const n = t.length;
    if (n < 2) return 0;
    if (i === 0) return (h[1] - h[0]) / (t[1] - t[0]);
    if (i === n - 1) return (h[i] - h[i - 1]) / (t[i] - t[i - 1]);
    return (h[i + 1] - h[i - 1]) / (t[i + 1] - t[i - 1]);
  }

  /** Height at [t], or null outside the data. */
  heightAt(t) {
    if (!this.covers(t)) return null;
    const times = this.times;
    let lo = 0;
    let hi = times.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (times[mid] <= t) lo = mid;
      else hi = mid;
    }
    if (times[lo] === t) return this.heights[lo];
    if (times[hi] === t) return this.heights[hi];
    const i = lo;
    const span = times[i + 1] - times[i];
    const u = (t - times[i]) / span;
    const m0 = this.slope(i) * span;
    const m1 = this.slope(i + 1) * span;
    const u2 = u * u;
    const u3 = u2 * u;
    return (2 * u3 - 3 * u2 + 1) * this.heights[i] + (u3 - 2 * u2 + u) * m0 + (-2 * u3 + 3 * u2) * this.heights[i + 1] + (u3 - u2) * m1;
  }

  /** Metres per hour; positive = rising. */
  rateMPerHour(t) {
    const a = this.heightAt(t - RATE_STEP_MS) ?? this.heightAt(t);
    const b = this.heightAt(t + RATE_STEP_MS) ?? this.heightAt(t);
    if (a === null || b === null) return null;
    return (b - a) / ((2 * RATE_STEP_MS) / HOUR_MS);
  }

  /** Highs and lows between [from] and [to], in time order: { timeMillis, heightM, isHigh }. */
  extremes(from, to) {
    if (this.startMillis === null) return [];
    const start = Math.max(from, this.startMillis);
    const end = Math.min(to, this.endMillis);
    if (end - start < 2 * SCAN_STEP_MS) return [];
    const out = [];
    let hPrev = this.heightAt(start);
    let t = start + SCAN_STEP_MS;
    let h = this.heightAt(t);
    if (hPrev === null || h === null) return [];
    while (t + SCAN_STEP_MS <= end) {
      const tNext = t + SCAN_STEP_MS;
      const hNext = this.heightAt(tNext);
      if (hNext === null) break;
      const isHigh = h >= hPrev && h > hNext;
      const isLow = h <= hPrev && h < hNext;
      if (isHigh || isLow) {
        // A parabola through the three samples, so the time doesn't depend on where the scan started.
        const bend = hPrev - 2 * h + hNext;
        const shift = bend === 0 ? 0 : Math.min(0.5, Math.max(-0.5, (0.5 * (hPrev - hNext)) / bend));
        const exact = t + Math.trunc(shift * SCAN_STEP_MS);
        out.push({ timeMillis: exact, heightM: this.heightAt(exact) ?? h, isHigh });
      }
      hPrev = h;
      t = tNext;
      h = hNext;
    }
    return out;
  }

  nextExtremes(from, count) {
    return this.extremes(from, from + LOOKAHEAD_MS).slice(0, count);
  }
}

// ------------------------------------------------------------------ harmonics

const NodalKind = { NONE: 0, M2: 1, M3: 2, M4: 3, M6: 4, K2: 5, K1: 6, O1: 7, J1: 8, OO1: 9, MF: 10, MM: 11 };

/** The constituents a year of hourly data can separate. */
export const CONSTITUENTS = [
  ['M2', 28.9841042, NodalKind.M2], ['S2', 30.0, NodalKind.NONE], ['N2', 28.4397295, NodalKind.M2],
  ['K2', 30.0821373, NodalKind.K2], ['2N2', 27.8953548, NodalKind.M2],
  ['MU2', 27.9682084, NodalKind.M2], ['NU2', 28.5125831, NodalKind.M2],
  ['L2', 29.5284789, NodalKind.M2], ['T2', 29.9589333, NodalKind.NONE],
  ['K1', 15.0410686, NodalKind.K1], ['O1', 13.9430356, NodalKind.O1], ['P1', 14.9589314, NodalKind.NONE],
  ['Q1', 13.3986609, NodalKind.O1], ['J1', 15.5854433, NodalKind.J1],
  ['OO1', 16.1391017, NodalKind.OO1],
  ['M4', 57.9682084, NodalKind.M4], ['MS4', 58.9841042, NodalKind.M2],
  ['MN4', 57.4238337, NodalKind.M4],
  ['M6', 86.9523127, NodalKind.M6], ['M3', 43.4761563, NodalKind.M3],
  ['MF', 1.0980331, NodalKind.MF], ['MM', 0.5443747, NodalKind.MM],
  ['SSA', 0.0821373, NodalKind.NONE], ['SA', 0.0410686, NodalKind.NONE]
].map(([name, degreesPerHour, nodal]) => ({ name, degreesPerHour, nodal }));

/** Amplitude factor f and phase shift u (degrees) of the lunar constituents for the day containing [t]. */
function nodalFactors(t) {
  const midday = Math.floor(t / DAY_MS) * DAY_MS + DAY_MS / 2;
  const centuries = (midday / DAY_MS + 2440587.5 - 2451545.0) / 36525;
  const n = ((125.0445479 - 1934.1362891 * centuries) * Math.PI) / 180;
  const c1 = Math.cos(n); const c2 = Math.cos(2 * n); const c3 = Math.cos(3 * n);
  const s1 = Math.sin(n); const s2 = Math.sin(2 * n); const s3 = Math.sin(3 * n);
  const fM2 = 1.0004 - 0.0373 * c1 + 0.0002 * c2;
  const uM2 = -2.14 * s1;
  const f = [1, fM2, fM2 ** 1.5, fM2 * fM2, fM2 ** 3,
    1.0241 + 0.2863 * c1 + 0.0083 * c2 - 0.0015 * c3,
    1.0060 + 0.1150 * c1 - 0.0088 * c2 + 0.0006 * c3,
    1.0089 + 0.1871 * c1 - 0.0147 * c2 + 0.0014 * c3,
    1.1029 + 0.1676 * c1 - 0.0170 * c2 + 0.0016 * c3,
    1.1027 + 0.6504 * c1 + 0.0317 * c2 - 0.0014 * c3,
    1.0429 + 0.4135 * c1 - 0.0040 * c2,
    1.0 - 0.1300 * c1 + 0.0013 * c2];
  const u = [0, uM2, 1.5 * uM2, 2 * uM2, 3 * uM2,
    -17.74 * s1 + 0.68 * s2 - 0.04 * s3,
    -8.86 * s1 + 0.68 * s2 - 0.07 * s3,
    10.80 * s1 - 1.34 * s2 + 0.19 * s3,
    -12.94 * s1 + 1.34 * s2 - 0.19 * s3,
    -36.68 * s1 + 4.02 * s2 - 0.57 * s3,
    -23.74 * s1 + 2.68 * s2 - 0.38 * s3,
    0];
  return { f, u };
}

const RAD = Math.PI / 180;
const LAT_YEARS = 19;
const LAT_CANDIDATES = 40;

/** The tide as a sum of cosines at the moon's and sun's frequencies, fitted to a year of hourly heights. */
export class TideHarmonics {
  constructor(mean, cosines, sines, epochMillis, nodal = true) {
    Object.assign(this, { mean, cosines, sines, epochMillis, nodal });
  }

  heightAt(t) {
    return this.heights(t, 1)[0];
  }

  /** [count] heights from [start], one every [step] (angles stepped by rotation, nodal factors daily). */
  heights(start, count, step = HOUR_MS) {
    const n = CONSTITUENTS.length;
    const out = new Float64Array(count);
    const c = new Float64Array(n);
    const s = new Float64Array(n);
    const a = new Float64Array(n);
    const b = new Float64Array(n);
    const stepCos = CONSTITUENTS.map((k) => Math.cos(k.degreesPerHour * (step / HOUR_MS) * RAD));
    const stepSin = CONSTITUENTS.map((k) => Math.sin(k.degreesPerHour * (step / HOUR_MS) * RAD));
    let k = 0;
    while (k < count) {
      const t = start + k * step;
      const hours = (t - this.epochMillis) / HOUR_MS;
      const factors = this.nodal ? nodalFactors(t) : null;
      for (let i = 0; i < n; i++) {
        const angle = CONSTITUENTS[i].degreesPerHour * hours * RAD;
        c[i] = Math.cos(angle);
        s[i] = Math.sin(angle);
        const f = factors ? factors.f[CONSTITUENTS[i].nodal] : 1;
        const u = factors ? factors.u[CONSTITUENTS[i].nodal] * RAD : 0;
        const cu = Math.cos(u);
        const su = Math.sin(u);
        a[i] = f * (this.cosines[i] * cu + this.sines[i] * su);
        b[i] = f * (this.sines[i] * cu - this.cosines[i] * su);
      }
      const nextDay = (Math.floor(t / DAY_MS) + 1) * DAY_MS;
      const end = Math.min(count, k + Math.max(1, Math.ceil((nextDay - t) / step)));
      while (k < end) {
        let h = this.mean;
        for (let i = 0; i < n; i++) {
          h += a[i] * c[i] + b[i] * s[i];
          const nc = c[i] * stepCos[i] - s[i] * stepSin[i];
          s[i] = s[i] * stepCos[i] + c[i] * stepSin[i];
          c[i] = nc;
        }
        out[k++] = h;
      }
    }
    return out;
  }

  /** Hourly heights from [from] to [to], as a TideCurve. */
  curve(from, to) {
    const start = from - (from % HOUR_MS);
    const count = Math.floor((to - start) / HOUR_MS) + 2;
    const times = Array.from({ length: count }, (_, i) => start + i * HOUR_MS);
    return new TideCurve(times, this.heights(start, count));
  }

  /** Lowest Astronomical Tide over the 18.6-year nodal cycle from [from], on the same level as heightAt. */
  lowestAstronomical(from) {
    const start = from - (from % HOUR_MS);
    const count = Math.trunc(LAT_YEARS * 365.25 * 24);
    const hourly = this.heights(start, count);
    const lows = [];
    for (let i = 1; i < count - 1; i++) if (hourly[i] <= hourly[i - 1] && hourly[i] < hourly[i + 1]) lows.push(i);
    lows.sort((x, y) => hourly[x] - hourly[y]);
    const candidates = lows.slice(0, LAT_CANDIDATES);
    if (!candidates.length) return Math.min(...hourly);
    return Math.min(...candidates.map((i) => Math.min(...this.heights(start + (i - 1) * HOUR_MS, 121, 60_000))));
  }

  toJSON() {
    return { mean: this.mean, cosines: [...this.cosines], sines: [...this.sines], epochMillis: this.epochMillis, nodal: this.nodal };
  }

  static fromJSON(o) {
    return new TideHarmonics(o.mean, o.cosines, o.sines, o.epochMillis, o.nodal !== false);
  }

  /** Least-squares fit to hourly samples (about a year for the long-period constituents). */
  static fit(times, heights, nodal = true) {
    if (times.length !== heights.length || times.length <= 2 * CONSTITUENTS.length + 1) throw new Error('Not enough tide data to analyse');
    const epoch = times[Math.floor(times.length / 2)];
    const n = 1 + 2 * CONSTITUENTS.length;
    const ata = Array.from({ length: n }, () => new Float64Array(n));
    const atb = new Float64Array(n);
    const row = new Float64Array(n);
    let factors = null;
    let factorsDay = null;
    for (let k = 0; k < times.length; k++) {
      const hours = (times[k] - epoch) / HOUR_MS;
      const day = Math.floor(times[k] / DAY_MS);
      if (nodal && day !== factorsDay) {
        factors = nodalFactors(times[k]);
        factorsDay = day;
      }
      row[0] = 1;
      for (let i = 0; i < CONSTITUENTS.length; i++) {
        const kind = CONSTITUENTS[i].nodal;
        const f = nodal ? factors.f[kind] : 1;
        const u = nodal ? factors.u[kind] : 0;
        const angle = (CONSTITUENTS[i].degreesPerHour * hours + u) * RAD;
        row[1 + 2 * i] = f * Math.cos(angle);
        row[2 + 2 * i] = f * Math.sin(angle);
      }
      for (let a = 0; a < n; a++) {
        const ra = row[a];
        atb[a] += ra * heights[k];
        const line = ata[a];
        for (let b = a; b < n; b++) line[b] += ra * row[b];
      }
    }
    for (let a = 0; a < n; a++) for (let b = 0; b < a; b++) ata[a][b] = ata[b][a];
    const x = solve(ata, atb);
    return new TideHarmonics(
      x[0],
      CONSTITUENTS.map((_, i) => x[1 + 2 * i]),
      CONSTITUENTS.map((_, i) => x[2 + 2 * i]),
      epoch,
      nodal
    );
  }
}

/** Gaussian elimination with partial pivoting; a tiny ridge for near-singular fits. */
function solve(matrix, rhs) {
  const n = rhs.length;
  const a = matrix.map((r, i) => {
    const copy = Float64Array.from(r);
    copy[i] += 1e-9;
    return copy;
  });
  const b = Float64Array.from(rhs);
  for (let col = 0; col < n; col++) {
    let pivot = col;
    for (let r = col + 1; r < n; r++) if (Math.abs(a[r][col]) > Math.abs(a[pivot][col])) pivot = r;
    if (pivot !== col) {
      [a[col], a[pivot]] = [a[pivot], a[col]];
      [b[col], b[pivot]] = [b[pivot], b[col]];
    }
    const p = a[col][col];
    if (Math.abs(p) < 1e-12) continue;
    for (let r = col + 1; r < n; r++) {
      const f = a[r][col] / p;
      if (f === 0) continue;
      for (let c = col; c < n; c++) a[r][c] -= f * a[col][c];
      b[r] -= f * b[col];
    }
  }
  const x = new Float64Array(n);
  for (let r = n - 1; r >= 0; r--) {
    let sum = b[r];
    for (let c = r + 1; c < n; c++) sum -= a[r][c] * x[c];
    x[r] = Math.abs(a[r][r]) < 1e-12 ? 0 : sum / a[r][r];
  }
  return x;
}

// ------------------------------------------------------------------ sun and moon

const J2000_MS = 946_728_000_000;
const NEW_MOON_MS = 947_182_440_000;
const SYNODIC_DAYS = 29.530588853;
const TIDE_LAG_DAYS = 1.5;
const mod = (a, b) => ((a % b) + b) % b;

/** Sunrise and sunset (ms) on the UTC day containing [dayMillis]; null when the sun doesn't rise or set. */
export function sunTimes(dayMillis, lat, lng) {
  const dayStart = Math.floor(dayMillis / DAY_MS) * DAY_MS;
  const n = (dayStart - J2000_MS) / DAY_MS + 0.5 - lng / 360;
  const meanAnomaly = mod(357.5291 + 0.98560028 * n, 360) * RAD;
  const centre = 1.9148 * Math.sin(meanAnomaly) + 0.02 * Math.sin(2 * meanAnomaly) + 0.0003 * Math.sin(3 * meanAnomaly);
  const eclipticLng = mod(meanAnomaly / RAD + centre + 180 + 102.9372, 360) * RAD;
  const transit = J2000_MS + (n + 0.0053 * Math.sin(meanAnomaly) - 0.0069 * Math.sin(2 * eclipticLng)) * DAY_MS;
  const declination = Math.asin(Math.sin(eclipticLng) * Math.sin(23.44 * RAD));
  const phi = lat * RAD;
  const cosHour = (Math.sin(-0.833 * RAD) - Math.sin(phi) * Math.sin(declination)) / (Math.cos(phi) * Math.cos(declination));
  if (cosHour < -1 || cosHour > 1) return null;
  const halfDay = (Math.acos(cosHour) / RAD / 360) * DAY_MS;
  return [Math.round(transit - halfDay), Math.round(transit + halfDay)];
}

export function moonAge(t) {
  const days = (t - NEW_MOON_MS) / DAY_MS;
  return days - Math.floor(days / SYNODIC_DAYS) * SYNODIC_DAYS;
}

export function phaseName(t) {
  const eighth = Math.trunc((moonAge(t) / SYNODIC_DAYS) * 8 + 0.5) % 8;
  return ['New moon', 'Waxing crescent', 'First quarter', 'Waxing gibbous', 'Full moon', 'Waning gibbous', 'Last quarter', 'Waning crescent'][eighth];
}

/** Springs come a day or two after new and full moon, neaps after the quarters; null in between. */
export function springOrNeap(t) {
  const half = SYNODIC_DAYS / 2;
  const since = mod(moonAge(t) - TIDE_LAG_DAYS, half);
  if (since < 2.5 || since > half - 2.5) return 'spring tides';
  if (Math.abs(since - half / 2) < 2.5) return 'neap tides';
  return null;
}

// ------------------------------------------------------------------ places

/** The user's saved tide places, in the order they were added. */
export class TidePlaceStore {
  constructor() {
    const raw = prefs.getJson('tide_places', []);
    this.places = (Array.isArray(raw) ? raw : []).filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng));
  }

  get all() {
    return [...this.places];
  }

  byId(id) {
    return this.places.find((p) => p.id === id) || null;
  }

  add(name, lat, lng) {
    const place = { id: uuid(), name: this.freeName(name), lat, lng };
    this.places.push(place);
    this.persist();
    return place;
  }

  rename(id, name) {
    const p = this.byId(id);
    if (!p || !name.trim()) return;
    p.name = name.trim();
    this.persist();
  }

  delete(id) {
    this.places = this.places.filter((p) => p.id !== id);
    this.persist();
  }

  freeName(base) {
    const clean = base.trim() || 'Tide spot';
    const taken = (n) => this.places.some((p) => p.name.toLowerCase() === n.toLowerCase());
    if (!taken(clean)) return clean;
    for (let i = 2; ; i++) if (!taken(`${clean} (${i})`)) return `${clean} (${i})`;
  }

  persist() {
    prefs.put('tide_places', this.places);
  }
}
