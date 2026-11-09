// Tide settings, forecasts and offline tides, as on the phone
// (tides/TideStore.kt): modelled sea level from the Open-Meteo marine API
// (free, no key), one forecast per place, saved so it works offline, plus a
// harmonic fit to a year of data for tides months ahead. Heights are shown
// above chart datum (the lowest tide, LAT) like a tide table.

import { prefs, api, NetworkError } from '../core.js';
import { TideCurve, TideHarmonics, CONSTITUENTS, HOUR_MS } from './model.js';

export const TideMode = { OFF: 'OFF', MODEL: 'MODEL', MANUAL: 'MANUAL' };
export const TideDatum = { MEAN_SEA_LEVEL: 'MEAN_SEA_LEVEL', CHART_DATUM: 'CHART_DATUM' };
export const MAX_CHART_DATUM_M = 10;
export const MAX_TIDE_HEIGHT_M = 17;
export const validChartDatum = (m) => Number.isFinite(m) && m >= 0 && m <= MAX_CHART_DATUM_M;
export const validTideHeight = (m) => Number.isFinite(m) && m >= -2 && m <= MAX_TIDE_HEIGHT_M;

const DIR = 'tides';
const DAY_MS = 24 * HOUR_MS;
const REQUEST_LAT = 'seabathy_request_lat';
const REQUEST_LNG = 'seabathy_request_lng';
const REFRESH_DISTANCE_M = 15_000;
const REFRESH_AGE_MS = 12 * HOUR_MS;
const REBUILD_MS = 6 * HOUR_MS;
const SEAM_MS = 24 * HOUR_MS;
const USER_AGENT = 'SeaBathy (Windows tide places)';

export function loadTideSettings() {
  const num = (k) => Number.parseFloat(prefs.getString(k, ''));
  const offset = num('tide_datum_offset_m');
  const manual = num('tide_manual_m');
  return {
    mode: TideMode[prefs.getString('tide_mode')] || TideMode.MODEL,
    datum: TideDatum[prefs.getString('tide_datum')] || TideDatum.MEAN_SEA_LEVEL,
    chartDatumBelowMslM: validChartDatum(offset) ? offset : 0,
    chartDatumAuto: prefs.getBoolean('tide_datum_auto', true),
    manualHeightM: validTideHeight(manual) ? manual : 0,
    showChip: prefs.getBoolean('tide_show_chip', true),
    correctDepths: prefs.getBoolean('tide_correct_depths', true),
    placeId: prefs.getString('tide_place_id'),
    locationChosen: prefs.getBoolean('tide_location_chosen', false)
  };
}

export function saveTideSettings(s) {
  prefs.put('tide_mode', s.mode);
  prefs.put('tide_datum', s.datum);
  prefs.put('tide_datum_offset_m', String(s.chartDatumBelowMslM));
  prefs.put('tide_datum_auto', s.chartDatumAuto);
  prefs.put('tide_manual_m', String(s.manualHeightM));
  prefs.put('tide_show_chip', s.showChip);
  prefs.put('tide_correct_depths', s.correctDepths);
  prefs.put('tide_place_id', s.placeId);
  prefs.put('tide_location_chosen', s.locationChosen);
}

/** How far ahead tides are saved for offline use. */
export const SAVE_PERIODS = [
  { id: 'WEEK', label: '1 week', days: 7 },
  { id: 'TWO_WEEKS', label: '2 weeks', days: 14 },
  { id: 'MONTH', label: '1 month', months: 1 },
  { id: 'THREE_MONTHS', label: '3 months', months: 3 },
  { id: 'SIX_MONTHS', label: '6 months', months: 6 },
  { id: 'YEAR', label: '1 year', months: 12 },
  { id: 'TWO_YEARS', label: '2 years', months: 24 }
];

/** The end of the period, at the end of that day. */
export function periodEnd(period, now = new Date()) {
  const d = new Date(now);
  d.setDate(d.getDate() + (period.days || 0));
  d.setMonth(d.getMonth() + (period.months || 0));
  d.setHours(23, 59, 59, 0);
  return d.getTime();
}

export function distanceM(aLat, aLng, bLat, bLng) {
  const p1 = (aLat * Math.PI) / 180;
  const p2 = (bLat * Math.PI) / 180;
  const dp = p2 - p1;
  const dl = ((bLng - aLng) * Math.PI) / 180;
  const h = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return 2 * 6371008.8 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, h))));
}

async function get(url, what) {
  const result = await api.httpGet(url, { userAgent: USER_AGENT });
  if (result.ok) return result.body;
  if (result.error === 'offline') throw new NetworkError('No internet connection. Tides already downloaded keep working offline.');
  if (result.error === 'timeout') throw new NetworkError(`${what} didn't answer — check the connection and try again.`);
  if (result.error) throw new NetworkError(`${what} couldn't be reached: ${result.error}`);
  throw new Error(`${what} returned an error (HTTP ${result.status})`);
}

/** Hourly times (ms) and heights from a marine API reply, skipping gaps. */
function parseHourly(root) {
  const hourly = root.hourly;
  if (!hourly) throw new Error('No tide data in the reply');
  const t = [];
  const h = [];
  const n = Math.min(hourly.time.length, hourly.sea_level_height_msl.length);
  for (let i = 0; i < n; i++) {
    const v = hourly.sea_level_height_msl[i];
    if (v === null || v === undefined) continue;
    t.push(hourly.time[i] * 1000);
    h.push(v);
  }
  if (t.length < 6) throw new Error('No tides here — too far from the sea. Pick a spot on the water.');
  return [t, h];
}

function parseForecast(json, fetched) {
  const root = JSON.parse(json);
  const [t, h] = parseHourly(root);
  const requestLat = root[REQUEST_LAT] ?? 0;
  const requestLng = root[REQUEST_LNG] ?? 0;
  return {
    requestLat, requestLng,
    modelLat: root.latitude ?? requestLat,
    modelLng: root.longitude ?? requestLng,
    fetchedMillis: fetched,
    curve: new TideCurve(t, h)
  };
}

const safe = (key) => key.replace(/[^A-Za-z0-9-]/g, '');

/** A place's tides: forecast, saved long-range prediction and lowest tide. */
export class TideStore {
  constructor() {
    this.forecasts = new Map();
    this.saved = new Map();
    this.lowest = new Map();
    this.merged = new Map();
    this.sizes = new Map();
  }

  /** The forecast while it lasts, then the saved prediction; null when neither is downloaded. */
  forecast(key) {
    const now = Date.now();
    const cached = this.merged.get(key);
    if (cached && now - cached.builtAt < REBUILD_MS) return cached.value;
    const raw = this.forecasts.get(key);
    const long = this.saved.get(key);
    let result = raw || null;
    // Saved tides that have run out are left for the user to renew or delete.
    if (long && long.untilMillis >= now) {
      const from = Math.min(raw?.curve.startMillis ?? now, now - 2 * DAY_MS);
      const to = Math.max(long.untilMillis, raw?.curve.endMillis ?? 0);
      const start = from - (from % HOUR_MS);
      const count = Math.floor((to - start) / HOUR_MS) + 1;
      const times = Array.from({ length: count }, (_, i) => start + i * HOUR_MS);
      const predicted = long.harmonics.heights(start, count);
      // Where the forecast ends, ease from its last level into the prediction.
      const rawEnd = raw?.curve.endMillis ?? null;
      const step = raw && rawEnd !== null ? (raw.curve.heightAt(rawEnd) ?? 0) - long.harmonics.heightAt(rawEnd) : 0;
      const heights = times.map((t, i) => {
        const r = raw?.curve.heightAt(t);
        if (r !== null && r !== undefined) return r;
        const fade = rawEnd === null ? 0 : Math.min(1, Math.max(0, 1 - (t - rawEnd) / SEAM_MS));
        return predicted[i] + step * fade;
      });
      result = {
        requestLat: raw?.requestLat ?? long.requestLat,
        requestLng: raw?.requestLng ?? long.requestLng,
        modelLat: raw?.modelLat ?? long.modelLat,
        modelLng: raw?.modelLng ?? long.modelLng,
        fetchedMillis: raw?.fetchedMillis ?? long.savedMillis,
        curve: new TideCurve(times, heights),
        savedUntilMillis: long.untilMillis
      };
    }
    if (result) {
      result = { ...result, storedBytes: this.storedBytes(key), lowestTideM: this.lowest.get(key)?.metres ?? null };
      result.modelDistanceM = distanceM(result.requestLat, result.requestLng, result.modelLat, result.modelLng);
      this.merged.set(key, { builtAt: now, value: result });
    } else {
      this.merged.delete(key);
    }
    return result;
  }

  async readSizes() {
    for (const f of await api.listFiles(DIR)) this.sizes.set(f.name, f.size);
  }

  storedBytes(key) {
    return (this.sizes.get(`${safe(key)}.json`) || 0) + (this.sizes.get(`${safe(key)}.saved.json`) || 0);
  }

  async write(name, text) {
    this.sizes.set(name, await api.saveFile(DIR, name, text));
  }

  /** Loads a place's downloaded and saved tides from disk. */
  async load(key) {
    await this.readSizes();
    if (!this.forecasts.has(key)) {
      const text = await api.loadFile(DIR, `${safe(key)}.json`);
      if (text) {
        try {
          const meta = JSON.parse(text);
          this.forecasts.set(key, parseForecast(text, meta.seabathy_fetched || Date.now()));
        } catch {
          // An unreadable cache is ignored.
        }
      }
    }
    if (!this.saved.has(key)) {
      const text = await api.loadFile(DIR, `${safe(key)}.saved.json`);
      if (text) {
        try {
          this.saved.set(key, this.parseSaved(text));
        } catch {
          // Saved by another version: can't be used.
        }
      }
    }
    if (!this.lowest.has(key)) {
      const text = await api.loadFile(DIR, `${safe(key)}.lat.json`);
      if (text) {
        try {
          const o = JSON.parse(text);
          this.lowest.set(key, { metres: o.lowest, requestLat: o.requestLat, requestLng: o.requestLng });
        } catch {
          // Worked out again when needed.
        }
      }
    }
    this.merged.delete(key);
    return this.forecast(key);
  }

  parseSaved(json) {
    const o = JSON.parse(json);
    if (o.constituents !== CONSTITUENTS.map((c) => c.name).join(',')) throw new Error('saved tides from another version');
    return {
      harmonics: new TideHarmonics(o.mean, o.cos, o.sin, o.epoch, o.nodal === true),
      untilMillis: o.until,
      requestLat: o.requestLat, requestLng: o.requestLng,
      modelLat: o.modelLat, modelLng: o.modelLng,
      savedMillis: o.saved
    };
  }

  /** Downloads the past year of tides here, fits the harmonics and keeps them for [period]. */
  async saveOffline(key, lat, lng, period) {
    const { harmonics, root } = await this.fitYear(lat, lng);
    const low = await this.lowestFrom(key, harmonics, lat, lng);
    const entry = {
      harmonics, untilMillis: periodEnd(period), requestLat: lat, requestLng: lng,
      modelLat: root.latitude ?? lat, modelLng: root.longitude ?? lng, savedMillis: Date.now()
    };
    await this.write(`${safe(key)}.saved.json`, JSON.stringify({
      mean: harmonics.mean, cos: [...harmonics.cosines], sin: [...harmonics.sines], epoch: harmonics.epochMillis,
      until: entry.untilMillis, requestLat: lat, requestLng: lng, modelLat: entry.modelLat, modelLng: entry.modelLng,
      saved: entry.savedMillis, constituents: CONSTITUENTS.map((c) => c.name).join(','), nodal: harmonics.nodal
    }));
    this.saved.set(key, entry);
    this.lowest.set(key, low);
    this.merged.delete(key);
    return this.forecast(key);
  }

  needsLowest(key, lat, lng) {
    const l = this.lowest.get(key);
    return !l || distanceM(lat, lng, l.requestLat, l.requestLng) > REFRESH_DISTANCE_M;
  }

  /** The lowest tide (LAT) for a place: from its saved tides, or from a year of the model (once). */
  async findLowest(key, lat, lng) {
    const s = this.saved.get(key);
    const usable = s && s.harmonics.nodal && distanceM(lat, lng, s.requestLat, s.requestLng) <= REFRESH_DISTANCE_M;
    const harmonics = usable ? s.harmonics : (await this.fitYear(lat, lng)).harmonics;
    const entry = await this.lowestFrom(key, harmonics, lat, lng);
    this.lowest.set(key, entry);
    this.merged.delete(key);
    return entry.metres;
  }

  async lowestFrom(key, harmonics, lat, lng) {
    const entry = { metres: harmonics.lowestAstronomical(Date.now()), requestLat: lat, requestLng: lng };
    await this.write(`${safe(key)}.lat.json`, JSON.stringify({ lowest: entry.metres, requestLat: lat, requestLng: lng }));
    return entry;
  }

  async fitYear(lat, lng) {
    const end = new Date(Date.now() - 2 * DAY_MS);
    const start = new Date(end.getTime() - 365 * DAY_MS);
    const iso = (d) => d.toISOString().slice(0, 10);
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      `&hourly=sea_level_height_msl&timeformat=unixtime&cell_selection=sea&start_date=${iso(start)}&end_date=${iso(end)}`;
    const root = JSON.parse(await get(url, 'Tide service'));
    const [t, h] = parseHourly(root);
    if (t.length < 24 * 60) throw new Error('Not enough tide history here to save tides offline.');
    return { harmonics: TideHarmonics.fit(t, h), root };
  }

  async deleteSaved(key) {
    this.forecasts.delete(key);
    this.saved.delete(key);
    this.merged.delete(key);
    for (const name of [`${safe(key)}.json`, `${safe(key)}.saved.json`]) {
      await api.deleteFile(DIR, name);
      this.sizes.delete(name);
    }
  }

  async forget(key) {
    await this.deleteSaved(key);
    this.lowest.delete(key);
    await api.deleteFile(DIR, `${safe(key)}.lat.json`);
  }

  /** When a place's saved tides run out, without loading them all; null if none are saved. */
  async savedUntil(key) {
    if (this.saved.has(key)) return this.saved.get(key).untilMillis;
    const text = await api.loadFile(DIR, `${safe(key)}.saved.json`);
    try {
      return text ? JSON.parse(text).until : null;
    } catch {
      return null;
    }
  }

  /** The nearest town or suburb to a spot (OpenStreetMap Nominatim), to suggest a name; null offshore or offline. */
  async nearbyName(lat, lng) {
    const result = await api.httpGet(`https://nominatim.openstreetmap.org/reverse?lat=${lat.toFixed(5)}&lon=${lng.toFixed(5)}&format=json&zoom=14`, { userAgent: USER_AGENT });
    if (!result.ok) return null;
    const root = JSON.parse(result.body);
    // A country or state means the spot is out at sea: no useful name.
    if (['country', 'state', 'region'].includes(root.addresstype)) return null;
    const a = root.address || {};
    for (const k of ['suburb', 'town', 'village', 'city_district', 'city', 'hamlet', 'locality', 'bay', 'island']) if (a[k]) return a[k];
    return root.name || null;
  }

  /** The forecast is missing, far from the spot, old, or runs out within a day. */
  needsRefresh(key, lat, lng, now = Date.now()) {
    const f = this.forecasts.get(key);
    if (!f) return true;
    return distanceM(lat, lng, f.requestLat, f.requestLng) > REFRESH_DISTANCE_M || now - f.fetchedMillis > REFRESH_AGE_MS || !f.curve.covers(now + 24 * HOUR_MS);
  }

  /** Downloads a fresh forecast for lat/lng and keeps it under [key]. */
  async refresh(key, lat, lng) {
    const url = `https://marine-api.open-meteo.com/v1/marine?latitude=${lat.toFixed(4)}&longitude=${lng.toFixed(4)}` +
      '&hourly=sea_level_height_msl&timeformat=unixtime&past_days=1&forecast_days=16&cell_selection=sea';
    const root = JSON.parse(await get(url, 'Tide service'));
    const now = Date.now();
    root[REQUEST_LAT] = lat;
    root[REQUEST_LNG] = lng;
    root.seabathy_fetched = now;
    const json = JSON.stringify(root);
    const forecast = parseForecast(json, now);
    await this.write(`${safe(key)}.json`, json);
    this.forecasts.set(key, forecast);
    this.merged.delete(key);
    return this.forecast(key);
  }

  /** Towns and places matching [query] (Open-Meteo geocoding). */
  async search(query) {
    const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query.trim())}&count=10&language=en&format=json`;
    const root = JSON.parse(await get(url, 'Place search'));
    return (root.results || []).filter((o) => Number.isFinite(o.latitude) && Number.isFinite(o.longitude)).map((o) => ({
      name: o.name || 'Place',
      detail: [o.admin1, o.country].filter(Boolean).join(', '),
      lat: o.latitude,
      lng: o.longitude
    }));
  }
}

/** How far chart datum (LAT) is below mean sea level: typed in, or from the tide model; null until known. */
export const chartDatumBelowMsl = (s, f) => (!s.chartDatumAuto ? s.chartDatumBelowMslM : (f?.lowestTideM !== null && f?.lowestTideM !== undefined ? -f.lowestTideM : null));

/** What shown heights are measured from: chart datum, or mean sea level until that is known. */
export const showsChartDatum = (s, f) => s.mode === TideMode.MANUAL || chartDatumBelowMsl(s, f) !== null;

export const shownOffset = (s, f) => chartDatumBelowMsl(s, f) ?? 0;

/** The tide as a tide table gives it: metres above chart datum (or mean sea level until known). */
export function shownHeight(s, f, t) {
  if (s.mode === TideMode.OFF) return null;
  if (s.mode === TideMode.MANUAL) return s.manualHeightM;
  const h = f?.curve.heightAt(t);
  return h === null || h === undefined ? null : h + shownOffset(s, f);
}
