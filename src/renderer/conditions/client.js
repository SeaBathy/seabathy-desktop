// Downloads sea conditions for an area, as on the phone
// (conditions/ConditionsClient.kt). All free, no account:
// - Open-Meteo Marine: surface currents (Météo-France SMOC, tidal flow
//   included, about 8 km), waves, swell and sea temperature, hourly for up
//   to 8 days. Open-Meteo forecast: wind and gusts at 10 m.
// - NOAA CoastWatch ERDDAP, worldwide, with a backup for each where one exists
//   as these servers do go down: daily satellite sea temperature (NASA JPL MUR,
//   about 1 km, cloud-free; then NOAA Geo-polar Blended, about 5 km),
//   chlorophyll (a 5-day blend from about 4 km pictures, so clouds leave few
//   gaps), sea level anomaly from altimetry and salinity (both about 25 km).
// - HYCOM: sea temperature below the surface, from its ocean model (about 9 km).

import { api, NetworkError } from '../core.js';
import { GeoGrid, ForecastGrid, ForecastField as F, Flow, SatelliteGrid, SatelliteKind, DEFAULT_BELOW_DEPTH_M } from './data.js';
import { readNetCdf3 } from './netcdf3.js';

export const MAX_DAYS = 8;
const POINTS_PER_REQUEST = 48;
export const MAX_SATELLITE_SIDE = 250;
/** Five days of pictures come back as one row per point per day. */
const MAX_BLEND_SIDE = 120;
const BLEND_DAYS = 5;
const RETRY_PAUSE_MS = 2500;
const PFEG = 'https://coastwatch.pfeg.noaa.gov/erddap';
/** The same data as PFEG, on another server. */
const UPWELL = 'https://upwell.pfeg.noaa.gov/erddap';
const NOAA = 'https://coastwatch.noaa.gov/erddap';
const HYCOM = 'https://ncss.hycom.org/thredds/ncss/FMRC_ESPC-D-V02_t3z/FMRC_ESPC-D-V02_t3z_best.ncd';
const HYCOM_STEP = 0.08;
/** HYCOM's server often fails at random for a moment ("No space left on device"), and has no backup. */
const HYCOM_ATTEMPTS = 5;
const USER_AGENT = 'SeaBathy (Windows sea conditions)';

/**
 * How far a point may be from the nearest ocean-model cell and still take
 * its values. The models' coastline is coarse (cells about 9 km): water by
 * the shore, round islands and in channels is often 8–16 km from the
 * nearest cell. Where a satellite coastline is saved it hides the land.
 */
export const SEA_REACH_KM = 20.0;

/** Status files of the models the sea forecast comes from. */
const RUN_STATUS_URLS = [
  'https://marine-api.open-meteo.com/data/meteofrance_currents/static/meta.json',
  'https://marine-api.open-meteo.com/data/meteofrance_wave/static/meta.json',
  'https://marine-api.open-meteo.com/data/ecmwf_wam025/static/meta.json',
  'https://api.open-meteo.com/data/ecmwf_ifs025/static/meta.json',
  'https://api.open-meteo.com/data/ncep_gfs025/static/meta.json'
];

const MARINE_VARIABLES = 'ocean_current_velocity,ocean_current_direction,wave_height,wave_direction,' +
  'wave_period,swell_wave_height,swell_wave_direction,swell_wave_period,sea_surface_temperature';
const WIND_VARIABLES = 'wind_speed_10m,wind_direction_10m,wind_gusts_10m';

/** The server is overloaded or down for now: worth asking again. */
export class ServiceBusyError extends Error {}

/** GET, with the service's own error text when it gives one. */
async function httpGet(url, binary = false) {
  const result = await api.httpGet(url, { userAgent: USER_AGENT, binary });
  if (result.ok) return result.body;
  const service = url.includes('open-meteo') ? 'Open-Meteo' : url.includes('hycom') ? 'HYCOM' : 'NOAA';
  if (result.error === 'offline') throw new NetworkError('no internet connection');
  if (result.error === 'timeout') throw new NetworkError("the service didn't answer in time");
  if (result.error) throw new NetworkError(`${service}: ${result.error}`);
  if (result.status >= 500) throw new ServiceBusyError(`${service} isn't answering just now (${result.status})`);
  const text = typeof result.body === 'string' ? result.body : new TextDecoder().decode(result.body || new Uint8Array());
  let reason = null;
  try {
    reason = JSON.parse(text).reason || null;
  } catch {
    reason = /message="([^"]+)"/.exec(text)?.[1] || null;
  }
  if (result.status === 429) throw new Error(`${service} is busy (too many requests). Try again in a minute.`);
  throw new Error(reason ? `${service}: ${reason}` : `${service} answered ${result.status}`);
}

const f4 = (v) => v.toFixed(4);
const coords = (points) => `latitude=${points.map((p) => f4(p[0])).join(',')}&longitude=${points.map((p) => f4(p[1])).join(',')}`;

export const marineUrl = (points, days) => 'https://marine-api.open-meteo.com/v1/marine?' + coords(points) +
  `&hourly=${MARINE_VARIABLES}&wind_speed_unit=ms&timeformat=unixtime&cell_selection=sea&forecast_days=${Math.min(MAX_DAYS, Math.max(1, days))}`;

export const windUrl = (points, days) => 'https://api.open-meteo.com/v1/forecast?' + coords(points) +
  `&hourly=${WIND_VARIABLES}&wind_speed_unit=ms&timeformat=unixtime&forecast_days=${Math.min(MAX_DAYS, Math.max(1, days))}`;

/** Where to get [kind] for the area, best first. */
export function satelliteUrls(kind, south, west, north, east) {
  const f = (v) => v.toFixed(3);
  const clamp = (v, limit) => Math.min(limit, Math.max(-limit, v));
  /** One griddap request. Coarse data reaches a cell beyond the area, so its picture fills the area. */
  const url = (base, dataset, variable, resolution, { time = 'last', altitude = false, northFirst = false, maxSide = MAX_SATELLITE_SIDE } = {}) => {
    const pad = resolution >= 0.04 ? resolution : 0;
    const latLimit = 90 - resolution / 2;
    const lngLimit = 180 - resolution / 2;
    const s = clamp(south - pad, latLimit);
    const n = clamp(north + pad, latLimit);
    const w = clamp(west - pad, lngLimit);
    const e = clamp(east + pad, lngLimit);
    const stride = Math.max(1, Math.ceil(Math.max(n - s, e - w) / resolution / maxSide));
    const lat = northFirst ? `(${f(n)}):${stride}:(${f(s)})` : `(${f(s)}):${stride}:(${f(n)})`;
    return `${base}/griddap/${dataset}.csv?${variable}%5B${time}%5D${altitude ? '%5B(0.0)%5D' : ''}%5B${lat}%5D%5B(${f(w)}):${stride}:(${f(e)})%5D`;
  };
  switch (kind) {
    case SatelliteKind.SEA_TEMP: return [
      url(PFEG, 'jplMURSST41', 'analysed_sst', 0.01),
      url(UPWELL, 'jplMURSST41', 'analysed_sst', 0.01),
      url(NOAA, 'noaacwBLENDEDsstDNDaily', 'analysed_sst', 0.05)
    ];
    case SatelliteKind.CHLOROPHYLL: {
      const blend = { time: `last-${BLEND_DAYS - 1}:1:last`, altitude: true, northFirst: true, maxSide: MAX_BLEND_SIDE };
      return [
        url(NOAA, 'noaacwN20VIIRSchlaDaily', 'chlor_a', 0.0375, blend),
        url(PFEG, 'nesdisVHNnoaa20chlaDaily', 'chlor_a', 0.0375, blend),
        url(NOAA, 'noaacwS3AOLCIchlaDaily', 'chlor_a', 0.0375, blend)
      ];
    }
    case SatelliteKind.SEA_LEVEL: return [url(NOAA, 'noaacwBLENDEDsshDaily', 'sla', 0.25)];
    case SatelliteKind.SALINITY: return [
      url(NOAA, 'noaacwSMAPsssDaily', 'sss', 0.25, { altitude: true }),
      url(NOAA, 'noaacwSMOSsssDaily', 'sss', 0.25, { altitude: true })
    ];
    default: return [];
  }
}

/** HYCOM's temperature [depthM] metres down at the moment, over the area. */
export function hycomUrl(south, west, north, east, depthM) {
  const f = (v) => v.toFixed(3);
  const stride = Math.max(1, Math.ceil(Math.max(north - south, east - west) / HYCOM_STEP / MAX_SATELLITE_SIDE));
  return `${HYCOM}?var=water_temp&south=${f(Math.max(-80, south - HYCOM_STEP))}&north=${f(Math.min(89.9, north + HYCOM_STEP))}` +
    `&west=${f(Math.max(-180, west - HYCOM_STEP))}&east=${f(Math.min(180, east + HYCOM_STEP))}` +
    `&vertCoord=${depthM}&time=present&horizStride=${stride}&accept=netcdf`;
}

/** HYCOM's NetCDF answer as a picture. Its longitudes may run 0 to 360. */
export function parseHycom(bytes, kind) {
  const file = readNetCdf3(bytes);
  const t = file.water_temp;
  if (!t) throw new Error('HYCOM sent no temperature');
  if (!file.lat || !file.lon) throw new Error('HYCOM sent no position');
  const lats = file.lat.values;
  // West of the date line it counts on past 180, starting from 180 itself.
  const pastDateLine = file.lon.values.some((v) => v > 180);
  const lngs = Array.from(file.lon.values, (v) => (v > 180 || (pastDateLine && v === 180) ? v - 360 : v));
  const rows = lats.length;
  const cols = lngs.length;
  if (t.values.length !== rows * cols) throw new Error('HYCOM sent an unexpected table');
  const rowOrder = Array.from(lats.keys()).sort((a, b) => lats[a] - lats[b]);
  const colOrder = Array.from(lngs.keys()).sort((a, b) => lngs[a] - lngs[b]);
  const grid = new GeoGrid(rowOrder.map((i) => lats[i]), colOrder.map((i) => lngs[i]));
  const first = (name) => t.attributes[name]?.[0];
  const fill = first('_FillValue') ?? first('missing_value');
  const scale = first('scale_factor') ?? 1;
  const offset = first('add_offset') ?? 0;
  const values = new Float32Array(grid.size).fill(NaN);
  let any = false;
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const raw = t.values[rowOrder[r] * cols + colOrder[c]];
      if (Number.isNaN(raw) || raw === fill) continue;
      values[grid.index(r, c)] = raw * scale + offset;
      any = true;
    }
  }
  if (!any) throw new Error('HYCOM has no temperature this deep here (land or shallow water)');
  const base = /hours since (\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(file.time?.attributes.units || '');
  const date = base && file.time.values.length ? Date.parse(`${base[1]}T${base[2]}Z`) + file.time.values[0] * 3_600_000 : 0;
  return new SatelliteGrid(kind, grid, date || 0, values);
}

const pointsOf = (grid) => {
  const out = [];
  for (let r = 0; r < grid.rows; r++) for (let c = 0; c < grid.cols; c++) out.push([grid.lats[r], grid.lngs[c]]);
  return out;
};

const chunked = (list, n) => Array.from({ length: Math.ceil(list.length / n) }, (_, i) => list.slice(i * n, i * n + n));

/**
 * The forecast for [grid], [days] days from today; onProgress gets 0..1.
 * Wind changes slowly across an area, so it is fetched on the coarser
 * [windGrid] and blended onto [grid].
 */
export async function forecast(grid, days, windGrid = grid, onProgress = () => {}) {
  const points = pointsOf(grid);
  const chunks = chunked(points, POINTS_PER_REQUEST);
  const windChunks = chunked(pointsOf(windGrid), POINTS_PER_REQUEST);
  const total = chunks.length + windChunks.length;
  const marine = [];
  for (let i = 0; i < chunks.length; i++) {
    marine.push(...parseOpenMeteo(await httpGet(marineUrl(chunks[i], days))));
    onProgress((i + 1) / total);
  }
  // Wind is a separate service; a forecast without it still has the sea.
  let weather = null;
  try {
    weather = [];
    for (let i = 0; i < windChunks.length; i++) {
      weather.push(...parseOpenMeteo(await httpGet(windUrl(windChunks[i], days))));
      onProgress((chunks.length + i + 1) / total);
    }
  } catch {
    weather = null;
  }
  return assemble(grid, points, marine, weather, SEA_REACH_KM, windGrid);
}

/** When the newest forecast run behind the sea forecast came out, or null when none could be read. */
export async function latestRunMillis() {
  const runs = await Promise.all(RUN_STATUS_URLS.map(async (url) => {
    try {
      const t = JSON.parse(await httpGet(url)).last_run_availability_time;
      return Number.isFinite(t) ? t * 1000 : null;
    } catch {
      return null;
    }
  }));
  const known = runs.filter((r) => r !== null);
  return known.length ? Math.max(...known) : null;
}

/** Asks again if the server was busy. */
async function retrying(fetch, pause, attempts = 2) {
  for (let i = 1; i < attempts; i++) {
    try {
      return await fetch();
    } catch (error) {
      if (!(error instanceof ServiceBusyError)) throw error;
      await pause(RETRY_PAUSE_MS);
    }
  }
  return fetch();
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * The latest picture of [kind] over the area: from the first of its sources
 * that has it, asking a busy server once more before moving on.
 */
export async function satellite(kind, south, west, north, east, belowDepthM = DEFAULT_BELOW_DEPTH_M, { get = httpGet, pause = wait } = {}) {
  if (kind === SatelliteKind.TEMP_BELOW) {
    return retrying(async () => parseHycom(await get(hycomUrl(south, west, north, east, belowDepthM), true), kind), pause, HYCOM_ATTEMPTS);
  }
  let failure = null;
  for (const url of satelliteUrls(kind, south, west, north, east)) {
    try {
      return await retrying(async () => parseErddapCsv(await get(url), kind), pause);
    } catch (error) {
      failure = error;
    }
  }
  throw failure || new Error(`No source for ${kind.label}`);
}

/** An Open-Meteo answer: one location is an object, several an array. */
export function parseOpenMeteo(body) {
  const root = JSON.parse(body);
  const items = Array.isArray(root) ? root : [root];
  return items.map((o) => {
    if (o.error === true) throw new Error(`Open-Meteo: ${o.reason}`);
    const hourly = o.hourly;
    if (!hourly) throw new Error('Open-Meteo sent no hourly data');
    const times = hourly.time.map((t) => t * 1000);
    const values = {};
    for (const key of Object.keys(hourly)) {
      if (key === 'time') continue;
      values[key] = Float64Array.from({ length: times.length }, (_, i) => {
        const v = hourly[key]?.[i];
        return v === null || v === undefined ? NaN : v;
      });
    }
    return { lat: o.latitude, lng: o.longitude, times, values };
  });
}

function distanceM(aLat, aLng, bLat, bLng) {
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((bLng - aLng) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

function vector(p, speedKey, directionKey, k, towards) {
  const speed = p.values[speedKey]?.[k];
  const direction = p.values[directionKey]?.[k];
  if (!Number.isFinite(speed) || !Number.isFinite(direction)) return null;
  return Flow.parts(speed, towards ? direction : direction + 180);
}

/**
 * Puts the points' series onto the grid. Open-Meteo moves a point to the
 * nearest cell of its ocean model; a point moved further than [reachKm] is
 * inland, and its sea values are left blank. Wind is kept everywhere.
 */
export function assemble(grid, requested, marine, weather, reachKm = SEA_REACH_KM, windGrid = grid) {
  if (marine.length !== requested.length) throw new Error(`Open-Meteo sent ${marine.length} of ${requested.length} points`);
  const times = marine[0].times;
  const hours = times.length;
  const fields = {};
  const field = (f) => (fields[f] ??= new Float32Array(hours * grid.size).fill(NaN));
  const sea = requested.map(([lat, lng], i) => distanceM(lat, lng, marine[i].lat, marine[i].lng) <= reachKm * 1000);

  const wave = (p, heightKey, directionKey, periodKey, k, at, height, u, v, period) => {
    const h = p.values[heightKey]?.[k];
    if (!Number.isFinite(h)) return;
    field(height)[at] = h;
    const dir = vector(p, heightKey, directionKey, k, false);
    if (dir) {
      // A unit direction: the height is blended on its own.
      const length = Math.hypot(dir[0], dir[1]);
      if (length > 0) {
        field(u)[at] = dir[0] / length;
        field(v)[at] = dir[1] / length;
      }
    }
    const t = p.values[periodKey]?.[k];
    if (Number.isFinite(t)) field(period)[at] = t;
  };

  for (let i = 0; i < requested.length; i++) {
    if (!sea[i]) continue;
    const p = marine[i];
    const same = p.times.length === times.length && p.times.every((t, j) => t === times[j]);
    const byTime = same ? null : new Map(p.times.map((t, j) => [t, j]));
    for (let h = 0; h < hours; h++) {
      const k = byTime ? byTime.get(times[h]) : h;
      if (k === undefined) continue;
      const at = h * grid.size + i;
      const current = vector(p, 'ocean_current_velocity', 'ocean_current_direction', k, true);
      if (current) {
        field(F.CURRENT_U)[at] = current[0];
        field(F.CURRENT_V)[at] = current[1];
      }
      wave(p, 'wave_height', 'wave_direction', 'wave_period', k, at, F.WAVE_HEIGHT, F.WAVE_U, F.WAVE_V, F.WAVE_PERIOD);
      wave(p, 'swell_wave_height', 'swell_wave_direction', 'swell_wave_period', k, at, F.SWELL_HEIGHT, F.SWELL_U, F.SWELL_V, F.SWELL_PERIOD);
      const sst = p.values.sea_surface_temperature?.[k];
      if (Number.isFinite(sst)) field(F.SEA_TEMP)[at] = sst;
    }
  }

  if (weather && weather.length === windGrid.size) {
    // Wind on its own grid first, then onto the points.
    const windU = new Float32Array(hours * windGrid.size).fill(NaN);
    const windV = new Float32Array(hours * windGrid.size).fill(NaN);
    const gust = new Float32Array(hours * windGrid.size).fill(NaN);
    for (let i = 0; i < windGrid.size; i++) {
      const p = weather[i];
      const byTime = new Map(p.times.map((t, j) => [t, j]));
      for (let h = 0; h < hours; h++) {
        const k = byTime.get(times[h]);
        if (k === undefined) continue;
        const at = h * windGrid.size + i;
        const w = vector(p, 'wind_speed_10m', 'wind_direction_10m', k, false);
        if (w) {
          windU[at] = w[0];
          windV[at] = w[1];
        }
        const g = p.values.wind_gusts_10m?.[k];
        if (Number.isFinite(g)) gust[at] = g;
      }
    }
    for (let i = 0; i < requested.length; i++) {
      const [lat, lng] = requested[i];
      for (let h = 0; h < hours; h++) {
        const at = h * grid.size + i;
        const offset = h * windGrid.size;
        const u = windGrid.sample(windU, offset, lat, lng, false);
        const v = windGrid.sample(windV, offset, lat, lng, false);
        if (!Number.isNaN(u) && !Number.isNaN(v)) {
          field(F.WIND_U)[at] = u;
          field(F.WIND_V)[at] = v;
        }
        const g = windGrid.sample(gust, offset, lat, lng, false);
        if (!Number.isNaN(g)) field(F.GUST)[at] = g;
      }
    }
  }
  if (!Object.keys(fields).length) throw new Error("There's no sea forecast for this area (all land?)");
  return new ForecastGrid(grid, times, fields);
}

/**
 * An ERDDAP griddap CSV (a names row, a units row, then time,[altitude,]lat,lon,value
 * rows). Several days of a point are blended, as chlorophyll varies by orders of
 * magnitude on a log scale; the date given is the newest. Sea level comes in
 * metres and is kept in cm.
 */
export function parseErddapCsv(body, kind) {
  const label = kind.label.toLowerCase();
  const lines = body.split(/\r?\n/).filter((l) => l.trim());
  if (lines.length < 3) throw new Error(`NOAA sent no ${label} for this area`);
  const names = lines[0].split(',');
  const latCol = names.indexOf('latitude');
  const lngCol = names.indexOf('longitude');
  const timeCol = names.indexOf('time');
  const valueCol = names.length - 1;
  if (latCol < 0 || lngCol < 0) throw new Error('NOAA sent an unexpected table');
  const lats = new Set();
  const lngs = new Set();
  const rows = [];
  let dateMillis = 0;
  let lastTime = '';
  for (const line of lines.slice(2)) {
    const cells = line.split(',');
    if (cells.length <= valueCol) continue;
    const lat = Number.parseFloat(cells[latCol]);
    const lng = Number.parseFloat(cells[lngCol]);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) continue;
    const value = Number.parseFloat(cells[valueCol]);
    if (timeCol >= 0 && cells[timeCol] !== lastTime) {
      lastTime = cells[timeCol];
      dateMillis = Math.max(dateMillis, Date.parse(lastTime) || 0);
    }
    lats.add(lat);
    lngs.add(lng);
    rows.push([lat, lng, value]);
  }
  if (!lats.size || !lngs.size) throw new Error(`NOAA sent no ${label} for this area`);
  const grid = new GeoGrid([...lats].sort((a, b) => a - b), [...lngs].sort((a, b) => a - b));
  const latIndex = new Map([...grid.lats].map((v, i) => [v, i]));
  const lngIndex = new Map([...grid.lngs].map((v, i) => [v, i]));
  const sums = new Float64Array(grid.size);
  const counts = new Int32Array(grid.size);
  const blendLogs = kind === SatelliteKind.CHLOROPHYLL;
  let any = false;
  for (const [lat, lng, value] of rows) {
    if (!Number.isFinite(value) || (blendLogs && value <= 0)) continue;
    const at = grid.index(latIndex.get(lat), lngIndex.get(lng));
    sums[at] += blendLogs ? Math.log(value) : value;
    counts[at]++;
    any = true;
  }
  if (!any) throw new Error(`NOAA has no ${label} here today (land, or no data)`);
  const values = new Float32Array(grid.size).fill(NaN);
  for (let i = 0; i < grid.size; i++) {
    if (!counts[i]) continue;
    const mean = sums[i] / counts[i];
    values[i] = blendLogs ? Math.exp(mean) : kind === SatelliteKind.SEA_LEVEL ? mean * 100 : mean;
  }
  return new SatelliteGrid(kind, grid, dateMillis, values);
}
