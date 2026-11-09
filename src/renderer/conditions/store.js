// Saved sea-condition areas, so they show with no connection (the phone's
// conditions/ConditionsStore.kt). Each area is one gzipped file
// ("<id>.area": JSON with the numbers packed as base64 Float32), with a
// small "<id>.sum" beside it so the list doesn't read every area.

import { api } from '../core.js';
import { GeoGrid, ForecastGrid, SatelliteGrid, SatelliteKind, ConditionsArea } from './data.js';

const DIR = 'conditions';

function packFloats(values) {
  const bytes = new Uint8Array(values.buffer, values.byteOffset, values.byteLength);
  let text = '';
  for (let i = 0; i < bytes.length; i += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(text);
}

function unpackFloats(base64) {
  const text = atob(base64);
  const bytes = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i);
  return new Float32Array(bytes.buffer);
}

const gridJson = (g) => ({ lats: [...g.lats], lngs: [...g.lngs] });

export function summaryOf(area, bytes = 0) {
  return {
    id: area.id, name: area.name, south: area.south, west: area.west, north: area.north, east: area.east,
    fetchedMillis: area.fetchedMillis,
    forecastUntilMillis: area.forecast ? area.forecast.endMillis : null,
    satellites: Object.keys(area.satellites),
    bytes
  };
}

export function serialize(area) {
  const f = area.forecast;
  return JSON.stringify({
    version: 1,
    id: area.id, name: area.name, south: area.south, west: area.west, north: area.north, east: area.east,
    fetchedMillis: area.fetchedMillis,
    belowDepthM: area.belowDepthM,
    forecast: f && {
      grid: gridJson(f.grid),
      times: [...f.times],
      fields: Object.fromEntries(Object.entries(f.fields).map(([k, v]) => [k, packFloats(v)]))
    },
    satellites: Object.fromEntries(Object.entries(area.satellites).map(([k, s]) => [k, { grid: gridJson(s.grid), dateMillis: s.dateMillis, values: packFloats(s.values) }]))
  });
}

export function deserialize(text) {
  const o = JSON.parse(text);
  if (o.version !== 1) throw new Error(`sea conditions file version ${o.version}`);
  const forecast = o.forecast && new ForecastGrid(
    new GeoGrid(o.forecast.grid.lats, o.forecast.grid.lngs),
    o.forecast.times,
    Object.fromEntries(Object.entries(o.forecast.fields).map(([k, v]) => [k, unpackFloats(v)]))
  );
  const satellites = {};
  for (const [k, s] of Object.entries(o.satellites || {})) {
    if (!SatelliteKind[k]) continue;
    satellites[k] = new SatelliteGrid(SatelliteKind[k], new GeoGrid(s.grid.lats, s.grid.lngs), s.dateMillis, unpackFloats(s.values));
  }
  return new ConditionsArea({ ...o, forecast, satellites });
}

export class ConditionsStore {
  constructor() {
    this.cache = new Map();
    this.summaryCache = null;
  }

  /** The list as last read, without touching the disk: null until summaries() has run. */
  cachedSummaries() {
    return this.summaryCache;
  }

  /** The saved areas, newest first. */
  async summaries() {
    return this.summaryCache ?? this.rescan();
  }

  async rescan() {
    const files = await api.listFiles(DIR);
    const sizes = new Map(files.filter((f) => f.name.endsWith('.area')).map((f) => [f.name.slice(0, -5), f.size]));
    const out = [];
    for (const file of files.filter((f) => f.name.endsWith('.sum'))) {
      const id = file.name.slice(0, -4);
      if (!sizes.has(id)) continue;
      try {
        out.push({ ...JSON.parse(await api.loadFile(DIR, file.name)), bytes: sizes.get(id) });
      } catch {
        // An unreadable summary leaves its area out of the list.
      }
    }
    out.sort((a, b) => b.fetchedMillis - a.fetchedMillis);
    this.summaryCache = out;
    return out;
  }

  async load(id) {
    if (this.cache.has(id)) return this.cache.get(id);
    const text = await api.loadFile(DIR, `${id}.area`);
    if (!text) return null;
    try {
      const area = deserialize(text);
      this.cache.set(id, area);
      return area;
    } catch {
      return null;
    }
  }

  async save(area) {
    const bytes = await api.saveFile(DIR, `${area.id}.area`, serialize(area));
    await api.saveFile(DIR, `${area.id}.sum`, JSON.stringify(summaryOf(area, bytes)));
    this.cache.set(area.id, area);
    await this.rescan();
  }

  async rename(id, name) {
    const area = await this.load(id);
    if (!area) return null;
    const renamed = new ConditionsArea({ ...area, name });
    await this.save(renamed);
    return renamed;
  }

  async delete(id) {
    this.cache.delete(id);
    await api.deleteFile(DIR, `${id}.area`);
    await api.deleteFile(DIR, `${id}.sum`);
    await this.rescan();
  }
}
