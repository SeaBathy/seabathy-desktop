// Sea-condition data, as on the phone (conditions/ConditionsData.kt and
// conditions/ConditionsPolicy.kt): grids of points, hourly forecasts,
// satellite pictures, saved areas, and the rules for updating and removing them.

export const HOUR_MS = 3_600_000;

/** A grid of points: lats south to north, lngs west to east, values row by row from the south. */
export class GeoGrid {
  constructor(lats, lngs) {
    if (!lats.length || !lngs.length) throw new Error('empty grid');
    this.lats = Float64Array.from(lats);
    this.lngs = Float64Array.from(lngs);
    this.latStep = evenStep(this.lats);
    this.lngStep = evenStep(this.lngs);
  }

  get rows() { return this.lats.length; }
  get cols() { return this.lngs.length; }
  get size() { return this.rows * this.cols; }
  get south() { return this.lats[0]; }
  get north() { return this.lats[this.lats.length - 1]; }
  get west() { return this.lngs[0]; }
  get east() { return this.lngs[this.lngs.length - 1]; }

  index(row, col) {
    return row * this.cols + col;
  }

  contains(lat, lng) {
    const padLat = this.rows > 1 ? (this.north - this.south) / (this.rows - 1) / 2 : 0.05;
    const padLng = this.cols > 1 ? (this.east - this.west) / (this.cols - 1) / 2 : 0.05;
    return lat >= this.south - padLat && lat <= this.north + padLat && lng >= this.west - padLng && lng <= this.east + padLng;
  }

  /**
   * The value at lat/lng, blended from the four nearest points. Land (NaN)
   * is left blank where the nearest point is land, so values don't bleed
   * onto the shore; with strict off, any sea corner gives a value.
   */
  sample(values, offset, lat, lng, strict = true) {
    if (!this.contains(lat, lng)) return NaN;
    const ry = position(this.lats, this.latStep, lat);
    const cx = position(this.lngs, this.lngStep, lng);
    const rows = this.rows;
    const cols = this.cols;
    const r0 = Math.min(rows - 1, Math.max(0, Math.trunc(ry)));
    const c0 = Math.min(cols - 1, Math.max(0, Math.trunc(cx)));
    const fr = Math.min(1, Math.max(0, ry - r0));
    const fc = Math.min(1, Math.max(0, cx - c0));
    const r1 = Math.min(rows - 1, r0 + 1);
    const c1 = Math.min(cols - 1, c0 + 1);
    const nearest = values[offset + (fr < 0.5 ? r0 : r1) * cols + (fc < 0.5 ? c0 : c1)];
    if (Number.isNaN(nearest) && strict) return NaN;
    let sum = 0;
    let weight = 0;
    const v00 = values[offset + r0 * cols + c0];
    const w00 = (1 - fr) * (1 - fc);
    if (!Number.isNaN(v00) && w00 > 0) { sum += v00 * w00; weight += w00; }
    const v01 = values[offset + r0 * cols + c1];
    const w01 = (1 - fr) * fc;
    if (!Number.isNaN(v01) && w01 > 0) { sum += v01 * w01; weight += w01; }
    const v10 = values[offset + r1 * cols + c0];
    const w10 = fr * (1 - fc);
    if (!Number.isNaN(v10) && w10 > 0) { sum += v10 * w10; weight += w10; }
    const v11 = values[offset + r1 * cols + c1];
    const w11 = fr * fc;
    if (!Number.isNaN(v11) && w11 > 0) { sum += v11 * w11; weight += w11; }
    return weight > 0 ? sum / weight : NaN;
  }

  /** Points every [step] degrees covering the box, at most [maxPerSide] a side. */
  static covering(south, west, north, east, step, maxPerSide) {
    const axis = (from, to) => {
      const count = Math.min(maxPerSide, Math.max(2, Math.floor((to - from) / step + 1e-9) + 1));
      return Array.from({ length: count }, (_, i) => from + ((to - from) * i) / (count - 1));
    };
    return new GeoGrid(axis(south, north), axis(west, east));
  }
}

/** The spacing of an evenly spaced axis, or 0 when it isn't even. */
function evenStep(axis) {
  if (axis.length < 2) return 0;
  const step = (axis[axis.length - 1] - axis[0]) / (axis.length - 1);
  if (step <= 0) return 0;
  for (let i = 0; i < axis.length; i++) if (Math.abs(axis[i] - (axis[0] + step * i)) > step * 1e-6) return 0;
  return step;
}

/** Where [value] falls along [axis] as a fractional index. */
function position(axis, step, value) {
  if (axis.length === 1 || value <= axis[0]) return 0;
  if (value >= axis[axis.length - 1]) return axis.length - 1;
  if (step > 0) return (value - axis[0]) / step;
  let lo = 0;
  let hi = axis.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >>> 1;
    if (axis[mid] <= value) lo = mid;
    else hi = mid;
  }
  const span = axis[hi] - axis[lo];
  return lo + (span > 0 ? (value - axis[lo]) / span : 0);
}

/** What is kept for each forecast point and hour. Directions are stored as east/north parts so they blend. */
export const ForecastField = {
  CURRENT_U: 'CURRENT_U', CURRENT_V: 'CURRENT_V',
  WAVE_HEIGHT: 'WAVE_HEIGHT', WAVE_U: 'WAVE_U', WAVE_V: 'WAVE_V', WAVE_PERIOD: 'WAVE_PERIOD',
  SWELL_HEIGHT: 'SWELL_HEIGHT', SWELL_U: 'SWELL_U', SWELL_V: 'SWELL_V', SWELL_PERIOD: 'SWELL_PERIOD',
  SEA_TEMP: 'SEA_TEMP',
  WIND_U: 'WIND_U', WIND_V: 'WIND_V', GUST: 'GUST'
};

/** A movement: [speed] towards compass bearing [towardsDegrees]. */
export class Flow {
  constructor(speed, towardsDegrees) {
    this.speed = speed;
    this.towardsDegrees = towardsDegrees;
  }

  /** Where it comes from, as winds and waves are named. */
  get fromDegrees() {
    return (this.towardsDegrees + 180) % 360;
  }

  static of(east, north) {
    const bearing = (Math.atan2(east, north) * 180) / Math.PI;
    return new Flow(Math.hypot(east, north), (bearing + 360) % 360);
  }

  /** East and north parts of [speed] heading towards [towardsDegrees]. */
  static parts(speed, towardsDegrees) {
    const r = (towardsDegrees * Math.PI) / 180;
    return [speed * Math.sin(r), speed * Math.cos(r)];
  }
}

/** Hourly forecast values on a grid: each field holds times.length × grid.size values, hour by hour. */
export class ForecastGrid {
  constructor(grid, times, fields) {
    if (!times.length) throw new Error('no hours');
    this.grid = grid;
    this.times = times;
    this.fields = fields; // field name -> Float32Array
    for (const v of Object.values(fields)) if (v.length !== times.length * grid.size) throw new Error('field size');
    const t = times;
    this.timeStep = t.length > 1 && t.every((x, i) => i === 0 || x - t[i - 1] === t[1] - t[0]) ? t[1] - t[0] : 0;
  }

  get startMillis() { return this.times[0]; }
  get endMillis() { return this.times[this.times.length - 1]; }

  has(field) {
    return field in this.fields;
  }

  hourPosition(time) {
    const t = this.times;
    if (time <= t[0]) return 0;
    if (time >= t[t.length - 1]) return t.length - 1;
    if (this.timeStep > 0) return (time - t[0]) / this.timeStep;
    let lo = 0;
    let hi = t.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >>> 1;
      if (t[mid] <= time) lo = mid;
      else hi = mid;
    }
    return lo + (time - t[lo]) / (t[hi] - t[lo]);
  }

  /** The value at a place and time, blended between the hours either side; coastal reaches right to the shore. */
  sample(field, lat, lng, time, coastal = false) {
    const values = this.fields[field];
    if (!values) return NaN;
    if (time < this.startMillis - HOUR_MS / 2 || time > this.endMillis + HOUR_MS / 2) return NaN;
    const hour = this.hourPosition(time);
    const h0 = Math.min(this.times.length - 1, Math.max(0, Math.trunc(hour)));
    const fh = hour - h0;
    const a = this.grid.sample(values, h0 * this.grid.size, lat, lng, !coastal);
    if (fh <= 0 || h0 + 1 >= this.times.length) return a;
    const b = this.grid.sample(values, (h0 + 1) * this.grid.size, lat, lng, !coastal);
    if (Number.isNaN(a)) return b;
    if (Number.isNaN(b)) return a;
    return a + (b - a) * fh;
  }

  /** A direction-and-strength pair, from its east and north parts. */
  vector(u, v, lat, lng, time, coastal = false) {
    const east = this.sample(u, lat, lng, time, coastal);
    const north = this.sample(v, lat, lng, time, coastal);
    if (Number.isNaN(east) || Number.isNaN(north)) return null;
    return Flow.of(east, north);
  }
}

/** A day's picture of the sea: from satellites, or for TEMP_BELOW the HYCOM ocean model. */
export const SatelliteKind = {
  SEA_TEMP: { name: 'SEA_TEMP', label: 'Sea temperature', unit: '°C', required: true },
  CHLOROPHYLL: { name: 'CHLOROPHYLL', label: 'Chlorophyll', unit: 'mg/m³', required: true },
  /** Height of the sea against its long-term average: eddies stand out. Stored in cm. */
  SEA_LEVEL: { name: 'SEA_LEVEL', label: 'Sea level', unit: 'cm' },
  SALINITY: { name: 'SALINITY', label: 'Salinity', unit: 'PSU' },
  TEMP_BELOW: { name: 'TEMP_BELOW', label: 'Temperature at depth', unit: '°C' }
};

export const DEFAULT_BELOW_DEPTH_M = 50;
/** Sea conditions stop here: the forecast models don't go nearer the poles. */
export const MAX_LAT = 80;
export const MAX_LNG = 180;
const KM_PER_DEGREE = 111.195;

export class SatelliteGrid {
  constructor(kind, grid, dateMillis, values) {
    if (values.length !== grid.size) throw new Error('satellite size');
    this.kind = kind;
    this.grid = grid;
    this.dateMillis = dateMillis;
    this.values = values;
  }

  sample(lat, lng) {
    return this.grid.sample(this.values, 0, lat, lng);
  }

  /** As sample, but any sea corner gives a value: for coarse data, where a finer coastline hides the land. */
  sampleToShore(lat, lng) {
    return this.grid.sample(this.values, 0, lat, lng, false);
  }
}

/**
 * How fast sea temperature changes across each point of sst, in °C per km:
 * the breaks fish gather on stand out however warm the water is.
 */
export function temperatureBreaks(sst) {
  const g = sst.grid;
  const out = new Float32Array(g.size).fill(NaN);
  const at = (r, c) => (r < 0 || c < 0 || r >= g.rows || c >= g.cols ? NaN : sst.values[g.index(r, c)]);
  /** Change per degree along an axis, from whichever neighbours are sea; 0 with none. */
  const slope = (here, lo, hi, loAt, hereAt, hiAt) => {
    if (!Number.isNaN(lo) && !Number.isNaN(hi) && hiAt > loAt) return (hi - lo) / (hiAt - loAt);
    if (!Number.isNaN(hi) && hiAt > hereAt) return (hi - here) / (hiAt - hereAt);
    if (!Number.isNaN(lo) && hereAt > loAt) return (here - lo) / (hereAt - loAt);
    return 0;
  };
  for (let r = 0; r < g.rows; r++) {
    const kmPerLng = KM_PER_DEGREE * Math.max(0.01, Math.cos((g.lats[r] * Math.PI) / 180));
    for (let c = 0; c < g.cols; c++) {
      const here = at(r, c);
      if (Number.isNaN(here)) continue;
      const north = slope(here, at(r - 1, c), at(r + 1, c), g.lats[Math.max(0, r - 1)], g.lats[r], g.lats[Math.min(g.rows - 1, r + 1)]) / KM_PER_DEGREE;
      const east = slope(here, at(r, c - 1), at(r, c + 1), g.lngs[Math.max(0, c - 1)], g.lngs[c], g.lngs[Math.min(g.cols - 1, c + 1)]) / kmPerLng;
      out[g.index(r, c)] = Math.hypot(north, east);
    }
  }
  return new SatelliteGrid(sst.kind, g, sst.dateMillis, out);
}

/** A saved area: its bounds, and whatever forecast and satellite data was downloaded for it. */
export class ConditionsArea {
  constructor({ id, name, south, west, north, east, fetchedMillis, forecast, satellites, belowDepthM = DEFAULT_BELOW_DEPTH_M }) {
    Object.assign(this, { id, name, south, west, north, east, fetchedMillis, forecast, satellites, belowDepthM });
  }

  /** The temperature breaks, worked out once from the saved temperature. */
  get breaks() {
    if (this.breaksGrid === undefined) {
      Object.defineProperty(this, 'breaksGrid', { value: this.satellites.SEA_TEMP ? temperatureBreaks(this.satellites.SEA_TEMP) : null, enumerable: false });
    }
    return this.breaksGrid;
  }

  contains(lat, lng) {
    return lat >= this.south && lat <= this.north && lng >= this.west && lng <= this.east;
  }

  /**
   * Whether lat/lng is sea by the satellite temperature's coastline; null
   * when there's no satellite temperature to tell. Any sea cell round the
   * point counts, so the colours reach the beach.
   */
  isSea(lat, lng) {
    const sst = this.satellites.SEA_TEMP;
    if (!sst || !sst.grid.contains(lat, lng)) return null;
    return !Number.isNaN(sst.grid.sample(sst.values, 0, lat, lng, false));
  }

  get isEmpty() {
    return !this.forecast && !Object.keys(this.satellites).length;
  }

  /**
   * In the middle half of the area, well away from its edges. An edge at the
   * date line or the polar limit doesn't count: nothing lies beyond it to
   * download, and a spot beside one would otherwise never settle.
   */
  middleContains(lat, lng) {
    const dLat = (this.north - this.south) / 4;
    const dLng = (this.east - this.west) / 4;
    return (this.south <= -MAX_LAT || lat >= this.south + dLat) && (this.north >= MAX_LAT || lat <= this.north - dLat) &&
      (this.west <= -MAX_LNG || lng >= this.west + dLng) && (this.east >= MAX_LNG || lng <= this.east - dLng);
  }

  /** About the same water as the given bounds (a re-download of this area). */
  sameBoundsAs(s, w, n, e) {
    return Math.abs(this.south - s) < 0.01 && Math.abs(this.west - w) < 0.01 && Math.abs(this.north - n) < 0.01 && Math.abs(this.east - e) < 0.01;
  }
}

// ------------------------------------------------------------------ policy

/** Updated at least this often when online, even with no word of a new forecast (the satellites are daily). */
export const MAX_AGE_MS = 12 * HOUR_MS;
/** A saved area whose forecast ran out this long ago is removed. */
export const EXPIRED_KEEP_MS = 2 * 24 * HOUR_MS;
/** A saved area with satellite pictures only is removed this long after it was downloaded. */
export const SATELLITE_ONLY_KEEP_MS = 7 * 24 * HOUR_MS;
/** How much bigger a newer area may be and still count as a copy of the same block. */
const SAME_BLOCK = 1.25;

/** Newer data to get than a copy downloaded at [fetchedMillis]: a newer forecast run, or it's over [MAX_AGE_MS] old. */
export function needsUpdate(fetchedMillis, latestRunMillis, nowMillis) {
  return (latestRunMillis !== null && latestRunMillis !== undefined && latestRunMillis > fetchedMillis) || nowMillis - fetchedMillis > MAX_AGE_MS;
}

/** The newest saved area (summary) covering lat/lng. */
export function newestCovering(lat, lng, areas) {
  return areas.filter((a) => lat >= a.south && lat <= a.north && lng >= a.west && lng <= a.east)
    .reduce((best, a) => (!best || a.fetchedMillis > best.fetchedMillis ? a : best), null);
}

const span = (a) => Math.max(a.north - a.south, a.east - a.west);

function covers(newer, older) {
  if (newer.fetchedMillis <= older.fetchedMillis) return false;
  if (span(newer) > span(older) * SAME_BLOCK) return false;
  const slack = 1e-6;
  const inside = older.south >= newer.south - slack && older.north <= newer.north + slack &&
    older.west >= newer.west - slack && older.east <= newer.east + slack;
  const hasForecast = older.forecastUntilMillis === null || newer.forecastUntilMillis !== null;
  return inside && hasForecast && older.satellites.every((s) => newer.satellites.includes(s));
}

/**
 * Saved areas to remove (never [keepId]): forecasts that ran out over
 * [EXPIRED_KEEP_MS] ago, satellite-only areas over [SATELLITE_ONLY_KEEP_MS]
 * old, or an older copy of the same block of water. Returns [summary, reason] pairs.
 */
export function toRemove(areas, keepId, nowMillis) {
  return areas.filter((a) => a.id !== keepId).flatMap((area) => {
    const until = area.forecastUntilMillis;
    const expired = until !== null ? nowMillis - until > EXPIRED_KEEP_MS : nowMillis - area.fetchedMillis > SATELLITE_ONLY_KEEP_MS;
    if (expired) return [[area, 'EXPIRED']];
    if (areas.some((newer) => newer.id !== area.id && covers(newer, area))) return [[area, 'COVERED_BY_NEWER']];
    return [];
  });
}
