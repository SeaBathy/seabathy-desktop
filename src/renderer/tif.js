// GeoTIFF loading. Reads a downsampled grid (using internal overviews when the
// file has them, otherwise in row chunks so huge rasters never have to fit in
// memory at full resolution) and resolves its CRS to lon/lat.

import { fromUrl } from 'geotiff';
import proj4 from 'proj4';
import { api, prefs } from './core.js';

const MAX_CHUNK_SOURCE_BYTES = 96 * 1024 * 1024;

const GRS80_TOWGS = '+ellps=GRS80 +towgs84=0,0,0,0,0,0,0 +units=m +no_defs';

/** proj4 definition for a projected EPSG code, or null when unsupported. */
function projectedDef(code) {
  if ([3857, 3785, 900913, 102100, 102113].includes(code)) return { def: 'EPSG:3857', label: 'Web Mercator' };
  if (code >= 32601 && code <= 32660) return { def: `+proj=utm +zone=${code - 32600} +datum=WGS84 +units=m +no_defs`, label: `WGS84 UTM ${code - 32600}N` };
  if (code >= 32701 && code <= 32760) return { def: `+proj=utm +zone=${code - 32700} +south +datum=WGS84 +units=m +no_defs`, label: `WGS84 UTM ${code - 32700}S` };
  if (code >= 28348 && code <= 28358) return { def: `+proj=utm +zone=${code - 28300} +south ${GRS80_TOWGS}`, label: `GDA94 MGA ${code - 28300}` };
  if (code >= 7846 && code <= 7859) return { def: `+proj=utm +zone=${code - 7800} +south ${GRS80_TOWGS}`, label: `GDA2020 MGA ${code - 7800}` };
  if (code >= 26901 && code <= 26923) return { def: `+proj=utm +zone=${code - 26900} +datum=NAD83 +units=m +no_defs`, label: `NAD83 UTM ${code - 26900}N` };
  if (code >= 25828 && code <= 25838) return { def: `+proj=utm +zone=${code - 25800} ${GRS80_TOWGS}`, label: `ETRS89 UTM ${code - 25800}N` };
  if (code === 3577 || code === 9473) return { def: `+proj=aea +lat_0=0 +lon_0=132 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GRS80_TOWGS}`, label: 'Australian Albers' };
  if (code === 3112 || code === 7845) return { def: `+proj=lcc +lat_0=0 +lon_0=134 +lat_1=-18 +lat_2=-36 +x_0=0 +y_0=0 ${GRS80_TOWGS}`, label: 'GA Lambert' };
  if (code === 2193) return { def: `+proj=tmerc +lat_0=0 +lon_0=173 +k=0.9996 +x_0=1600000 +y_0=10000000 ${GRS80_TOWGS}`, label: 'NZTM 2000' };
  if (code >= 26701 && code <= 26722) return { def: `+proj=utm +zone=${code - 26700} +datum=NAD27 +units=m +no_defs`, label: `NAD27 UTM ${code - 26700}N` };
  if (code === 27700) return { def: '+proj=tmerc +lat_0=49 +lon_0=-2 +k=0.9996012717 +x_0=400000 +y_0=-100000 +ellps=airy +towgs84=446.448,-125.157,542.06,0.15,0.247,0.842,-20.489 +units=m +no_defs', label: 'British National Grid' };
  if (code === 3035) return { def: `+proj=laea +lat_0=52 +lon_0=10 +x_0=4321000 +y_0=3210000 ${GRS80_TOWGS}`, label: 'ETRS89 LAEA Europe' };
  if (code === 3034) return { def: `+proj=lcc +lat_0=52 +lon_0=10 +lat_1=35 +lat_2=65 +x_0=4000000 +y_0=2800000 ${GRS80_TOWGS}`, label: 'ETRS89 LCC Europe' };
  if (code === 3395) return { def: '+proj=merc +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs', label: 'World Mercator' };
  const looked = lookedUpDefs.get(code);
  if (looked) return { def: looked, label: `EPSG:${code}` };
  if (code === 3031) return { def: '+proj=stere +lat_0=-90 +lat_ts=-71 +lon_0=0 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs', label: 'Antarctic Polar Stereographic' };
  if (code === 3413) return { def: '+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +k=1 +x_0=0 +y_0=0 +datum=WGS84 +units=m +no_defs', label: 'NSIDC Polar Stereographic North' };
  return null;
}

/** Definitions fetched from epsg.io this session, or kept from an earlier one. */
const lookedUpDefs = new Map();

/** A map projection not in the list above: asks epsg.io once, then remembers it, so it also works offline later. */
async function lookUpProjection(code) {
  if (!code || code === 32767 || projectedDef(code)) return;
  const saved = prefs.getString(`epsg_${code}`);
  if (saved) {
    lookedUpDefs.set(code, saved);
    return;
  }
  try {
    const result = await api.httpGet(`https://epsg.io/${code}.proj4`);
    const def = result.ok ? String(result.body).trim() : '';
    if (!def.startsWith('+')) return;
    proj4(def, 'EPSG:4326');
    lookedUpDefs.set(code, def);
    prefs.put(`epsg_${code}`, def);
  } catch {
    // Offline, or a definition proj4 can't use: reported as unsupported as before.
  }
}

const GEOGRAPHIC_CODES = new Set([4326, 4283, 4269, 7844, 4258, 4167, 4979, 4617, 4019]);

function resolveCrs(keys, bbox) {
  const projected = keys.ProjectedCSTypeGeoKey;
  const geographic = keys.GeographicTypeGeoKey;
  const looksLikeDegrees = Math.abs(bbox[0]) <= 360 && Math.abs(bbox[2]) <= 360 && Math.abs(bbox[1]) <= 90 && Math.abs(bbox[3]) <= 90;

  if (projected && projected !== 32767) {
    const found = projectedDef(projected);
    if (!found) return { supported: false, label: `EPSG:${projected} (unsupported)`, geographic: false };
    const converter = proj4(found.def, 'EPSG:4326');
    return {
      supported: true,
      geographic: false,
      mercator: found.def === 'EPSG:3857',
      label: `${found.label} (EPSG:${projected})`,
      toLonLat: (x, y) => converter.forward([x, y]),
      fromLonLat: (lng, lat) => converter.inverse([lng, lat])
    };
  }
  if ((geographic && GEOGRAPHIC_CODES.has(geographic)) || keys.GTModelTypeGeoKey === 2 || (!projected && looksLikeDegrees)) {
    return {
      supported: true,
      geographic: true,
      label: geographic ? `Geographic (EPSG:${geographic})` : 'Geographic (assumed)',
      toLonLat: (x, y) => [x > 180 ? x - 360 : x, y],
      fromLonLat: (lng, lat) => [lng, lat]
    };
  }
  return { supported: false, geographic: false, label: 'Unknown CRS' };
}

/**
 * Picks the smallest overview that still has at least the requested
 * resolution. `fraction` is the share of the full width being read.
 */
async function pickImage(tiff, first, cols, fraction = 1) {
  const count = await tiff.getImageCount();
  let best = first;
  for (let i = 1; i < count; i++) {
    const image = await tiff.getImage(i);
    const subfileType = image.fileDirectory.NewSubfileType || 0;
    if (subfileType & 4) continue; // transparency mask
    if (image.getSamplesPerPixel() !== first.getSamplesPerPixel()) continue;
    if (image.getWidth() * fraction >= cols && image.getWidth() < best.getWidth()) best = image;
  }
  return best;
}

/** `win` is [x0, y0, x1, y1] as fractions of the full image. */
async function readChunked(image, samples, cols, rows, onProgress, win = [0, 0, 1, 1]) {
  const x0 = Math.floor(win[0] * image.getWidth());
  const x1 = Math.max(x0 + 1, Math.ceil(win[2] * image.getWidth()));
  const y0 = Math.floor(win[1] * image.getHeight());
  const width = x1 - x0;
  const height = Math.max(1, Math.ceil(win[3] * image.getHeight()) - y0);
  const bytesPerRow = width * samples.length * 4;
  const sourceRowsPerChunk = Math.max(1, Math.floor(MAX_CHUNK_SOURCE_BYTES / bytesPerRow));
  const outRowsPerChunk = Math.max(1, Math.floor((sourceRowsPerChunk * rows) / height));
  const out = samples.map(() => new Float32Array(cols * rows));

  for (let r0 = 0; r0 < rows; r0 += outRowsPerChunk) {
    const r1 = Math.min(rows, r0 + outRowsPerChunk);
    const sy0 = Math.floor((r0 * height) / rows);
    const sy1 = Math.max(sy0 + 1, Math.min(height, Math.round((r1 * height) / rows)));
    const data = await image.readRasters({
      window: [x0, y0 + sy0, x1, y0 + sy1],
      width: cols,
      height: r1 - r0,
      samples,
      resampleMethod: 'nearest',
      interleave: false
    });
    samples.forEach((_, s) => out[s].set(data[s], r0 * cols));
    onProgress?.(r1 / rows);
  }
  return out;
}

/**
 * Loads a GeoTIFF from a URL. Returns a depth model for single-band rasters
 * or an image model for RGB(A) imagery. `crop` ([x0, y0, x1, y1] as fractions
 * of the full image) reads just that region, at up to `maxDim` cells across.
 */
export async function loadTif(url, name, { maxDim = 1024, onProgress, crop = null, flipped = null } = {}) {
  const tiff = await fromUrl(url, { allowFullFile: false, cacheSize: 512 });
  const first = await tiff.getImage(0);
  const width = first.getWidth();
  const height = first.getHeight();
  const spp = first.getSamplesPerPixel();

  let fullBbox;
  try {
    fullBbox = first.getBoundingBox();
  } catch {
    throw new Error('This TIFF has no georeferencing (no tie point / pixel scale), so it cannot be placed.');
  }
  const keys = first.getGeoKeys() || {};
  await lookUpProjection(keys.ProjectedCSTypeGeoKey);
  const crs = resolveCrs(keys, fullBbox);

  const win = crop || [0, 0, 1, 1];
  const spanX = fullBbox[2] - fullBbox[0];
  const spanY = fullBbox[3] - fullBbox[1];
  const bbox = [
    fullBbox[0] + win[0] * spanX, fullBbox[3] - win[3] * spanY,
    fullBbox[0] + win[2] * spanX, fullBbox[3] - win[1] * spanY
  ];
  const winWidth = Math.max(1, Math.round(width * (win[2] - win[0])));
  const winHeight = Math.max(1, Math.round(height * (win[3] - win[1])));
  const scale = Math.min(1, maxDim / Math.max(winWidth, winHeight));
  const cols = Math.max(2, Math.round(winWidth * scale));
  const rows = Math.max(2, Math.round(winHeight * scale));
  const source = await pickImage(tiff, first, cols, win[2] - win[0]);

  const corners = crs.supported
    ? [[bbox[0], bbox[3]], [bbox[2], bbox[3]], [bbox[2], bbox[1]], [bbox[0], bbox[1]]].map(([x, y]) => crs.toLonLat(x, y))
    : null;
  const centerLonLat = corners
    ? crs.toLonLat((bbox[0] + bbox[2]) / 2, (bbox[1] + bbox[3]) / 2)
    : null;

  // Cell size in metres for the 3D mesh.
  let cellX = (bbox[2] - bbox[0]) / cols;
  let cellY = (bbox[3] - bbox[1]) / rows;
  if (crs.geographic) {
    const lat = (bbox[1] + bbox[3]) / 2;
    cellX *= 111320 * Math.cos((lat * Math.PI) / 180);
    cellY *= 110574;
  } else if (crs.mercator && centerLonLat) {
    const k = Math.cos((centerLonLat[1] * Math.PI) / 180);
    cellX *= k;
    cellY *= k;
  }

  const base = { name, url, width, height, cols, rows, bbox, crs, corners, centerLonLat, cellX, cellY, maxDim, crop };

  if (spp >= 3) {
    const bands = await readChunked(source, spp >= 4 ? [0, 1, 2, 3] : [0, 1, 2], cols, rows, onProgress, win);
    const bits = first.getBitsPerSample(0);
    const k = bits > 8 ? 255 / (2 ** bits - 1) : 1;
    const rgba = new Uint8ClampedArray(cols * rows * 4);
    for (let i = 0; i < cols * rows; i++) {
      rgba[i * 4] = bands[0][i] * k;
      rgba[i * 4 + 1] = bands[1][i] * k;
      rgba[i * 4 + 2] = bands[2][i] * k;
      rgba[i * 4 + 3] = bands[3] ? bands[3][i] * k : 255;
    }
    return { ...base, kind: 'image', rgba };
  }

  const [values] = await readChunked(source, [0], cols, rows, onProgress, win);
  const noData = first.getGDALNoData();
  let min = Infinity;
  let max = -Infinity;
  let covered = 0;
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    if (!Number.isFinite(v) || Math.abs(v) >= 1e30 || (noData !== null && Math.abs(v - noData) <= Math.abs(noData) * 1e-6 + 1e-6)) {
      values[i] = NaN;
      continue;
    }
    covered++;
    if (v < min) min = v;
    if (v > max) max = v;
  }
  if (!covered) throw new Error('Every pixel in this TIFF is marked as no-data.');

  const model = { ...base, kind: 'depth', values, min, max, covered, flipped: false };
  // Bathymetry ships in both sign conventions. All-positive values are
  // treated as positive-down soundings; the user can flip it back. A crop
  // follows whatever was decided for the whole file.
  if (flipped ?? (min >= 0 && max > 0)) flipSign(model);
  return model;
}

export function flipSign(model) {
  const v = model.values;
  for (let i = 0; i < v.length; i++) v[i] = -v[i];
  const min = -model.max;
  model.max = -model.min;
  model.min = min;
  model.flipped = !model.flipped;
}

/** Bilinear depth at grid coordinates (col,row in cell units), or null. */
export function sampleGrid(model, col, row) {
  const { cols, rows, values } = model;
  if (col < 0 || row < 0 || col > cols - 1 || row > rows - 1) return null;
  const c0 = Math.floor(col);
  const r0 = Math.floor(row);
  const c1 = Math.min(cols - 1, c0 + 1);
  const r1 = Math.min(rows - 1, r0 + 1);
  const fc = col - c0;
  const fr = row - r0;
  const a = values[r0 * cols + c0];
  const b = values[r0 * cols + c1];
  const c = values[r1 * cols + c0];
  const d = values[r1 * cols + c1];
  if ([a, b, c, d].some(Number.isNaN)) {
    const nearest = values[Math.round(row) * cols + Math.round(col)];
    return Number.isNaN(nearest) ? null : nearest;
  }
  return (a * (1 - fc) + b * fc) * (1 - fr) + (c * (1 - fc) + d * fc) * fr;
}

/** Grid coordinates (fractional col,row of cell centres) for a lon/lat, or null. */
export function lonLatToGrid(model, lng, lat) {
  if (!model.crs.supported) return null;
  const [x, y] = model.crs.fromLonLat(lng, lat);
  const { bbox, cols, rows } = model;
  const col = ((x - bbox[0]) / (bbox[2] - bbox[0])) * cols - 0.5;
  const row = ((bbox[3] - y) / (bbox[3] - bbox[1])) * rows - 0.5;
  return { col, row };
}

export function gridToLonLat(model, col, row) {
  if (!model.crs.supported) return null;
  const { bbox, cols, rows } = model;
  const x = bbox[0] + ((col + 0.5) / cols) * (bbox[2] - bbox[0]);
  const y = bbox[3] - ((row + 0.5) / rows) * (bbox[3] - bbox[1]);
  const [lng, lat] = model.crs.toLonLat(x, y);
  return { lng, lat };
}

export function sampleLonLat(model, lng, lat) {
  if (model.kind !== 'depth') return null;
  const g = lonLatToGrid(model, lng, lat);
  return g ? sampleGrid(model, g.col, g.row) : null;
}

/**
 * Renders the depth grid as an RGBA image (palette + optional hillshade),
 * in the raster's own pixel space.
 */
export function renderDepthImage(model, lut, rampMin, rampMax, hillshade, contourStep = 0) {
  const { cols, rows, values, cellX, cellY } = model;
  const out = new Uint8ClampedArray(cols * rows * 4);
  const span = rampMax - rampMin || 1;
  // Sun from the north-west, 45° up; mild exaggeration so subtle relief shows.
  const az = (315 * Math.PI) / 180;
  const alt = (45 * Math.PI) / 180;
  const z = 2;
  const lx = Math.sin(az) * Math.cos(alt);
  const ly = Math.cos(az) * Math.cos(alt);
  const lz = Math.sin(alt);

  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      const i = r * cols + c;
      const v = values[i];
      if (Number.isNaN(v)) continue;
      const t = Math.max(0, Math.min(1, (v - rampMin) / span));
      const li = Math.round(t * 255) * 3;
      let shade = 1;
      if (hillshade) {
        const left = values[r * cols + Math.max(0, c - 1)];
        const right = values[r * cols + Math.min(cols - 1, c + 1)];
        const up = values[Math.max(0, r - 1) * cols + c];
        const down = values[Math.min(rows - 1, r + 1) * cols + c];
        const dzdx = ((Number.isNaN(right) ? v : right) - (Number.isNaN(left) ? v : left)) / (2 * cellX) * z;
        const dzdy = ((Number.isNaN(up) ? v : up) - (Number.isNaN(down) ? v : down)) / (2 * cellY) * z;
        const len = Math.hypot(dzdx, dzdy, 1);
        const lambert = (-dzdx * lx - dzdy * ly + lz) / len;
        shade = 0.45 + 0.75 * Math.max(0, lambert);
      }
      if (contourStep > 0) {
        // Darken a pixel when a contour level falls between it and its right or lower neighbour.
        const level = Math.floor(v / contourStep);
        const right = c + 1 < cols ? values[i + 1] : NaN;
        const below = r + 1 < rows ? values[i + cols] : NaN;
        const crosses = (!Number.isNaN(right) && Math.floor(right / contourStep) !== level) ||
          (!Number.isNaN(below) && Math.floor(below / contourStep) !== level);
        if (crosses) shade *= Math.abs(level % 5) === 0 || Math.abs((level + 1) % 5) === 0 ? 0.35 : 0.65;
      }
      out[i * 4] = Math.min(255, lut[li] * shade);
      out[i * 4 + 1] = Math.min(255, lut[li + 1] * shade);
      out[i * 4 + 2] = Math.min(255, lut[li + 2] * shade);
      out[i * 4 + 3] = 255;
    }
  }
  return out;
}
