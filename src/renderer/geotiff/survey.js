// A loaded GeoTIFF survey: an overview grid of the whole file (for low zooms,
// the 3D view and colour fitting) plus full-detail tiles read on demand from
// the file, the way the phone's GDAL tile source works. Depths are metres,
// negative down (a file stored positive-down is flipped on load).

import { fromUrl, Pool } from 'geotiff';
import { loadTif } from '../tif.js';
import { histogramOf } from './depth.js';

let pool = null;
const decodePool = () => (pool ??= new Pool(Math.max(1, Math.min(4, (navigator.hardwareConcurrency || 4) - 1))));

const EARTH_CIRCUMFERENCE = 2 * Math.PI * 6378137;
/** Above this many source pixels across, a tile is left to the overview (reading it would take too long). */
const MAX_WINDOW_PIXELS = 4096;

/** The tile's corners in lon/lat. */
export function tileBounds(z, x, y) {
  const n = 2 ** z;
  const lng = (v) => (v / n) * 360 - 180;
  const lat = (v) => (Math.atan(Math.sinh(Math.PI * (1 - (2 * v) / n))) * 180) / Math.PI;
  return { west: lng(x), east: lng(x + 1), north: lat(y), south: lat(y + 1) };
}

export class Survey {
  /** Opens [info] (a picked file); [maxDim] is the overview size (GeoTIFF quality). */
  static async open(info, { maxDim = 2048, flipped = null, onProgress } = {}) {
    const model = await loadTif(info.url, info.name, { maxDim, flipped, onProgress });
    const survey = new Survey(info, model);
    if (model.kind === 'depth' && model.crs.supported) {
      survey.tiff = await fromUrl(info.url, { allowFullFile: false, cacheSize: 256 });
      survey.image = await survey.tiff.getImage(0);
      survey.noData = survey.image.getGDALNoData();
      survey.useFileStatistics();
    }
    return survey;
  }

  constructor(info, model) {
    this.info = info;
    this.model = model;
    this.isDepth = model.kind === 'depth';
    const lngs = (model.corners || []).map((c) => c[0]);
    const lats = (model.corners || []).map((c) => c[1]);
    this.bounds = model.corners
      ? { west: Math.min(...lngs), east: Math.max(...lngs), south: Math.min(...lats), north: Math.max(...lats) }
      : null;
    if (this.isDepth) {
      this.shallowestMetres = model.max;
      this.deepestMetres = model.min;
      this.histogram = histogramOf(model.values);
    }
    // Ground size of one source pixel, for the most detailed zoom worth drawing.
    const sourceMetres = Math.min(model.cellX * (model.cols / model.width), model.cellY * (model.rows / model.height));
    const midLat = this.bounds ? (this.bounds.north + this.bounds.south) / 2 : 0;
    const perPixelZ0 = (EARTH_CIRCUMFERENCE * Math.cos((midLat * Math.PI) / 180)) / 256;
    this.nativeMaxZoom = Math.min(22, Math.max(1, Math.ceil(Math.log2(perPixelZ0 / Math.max(0.01, sourceMetres)) - 1e-9)));
  }

  /** The file's own depth range when GDAL saved one in it (the overview's is slightly narrower). */
  useFileStatistics() {
    try {
      const meta = this.image.getGDALMetadata(0) || {};
      let lo = Number.parseFloat(meta.STATISTICS_MINIMUM);
      let hi = Number.parseFloat(meta.STATISTICS_MAXIMUM);
      if (!Number.isFinite(lo) || !Number.isFinite(hi) || hi <= lo) return;
      if (this.model.flipped) [lo, hi] = [-hi, -lo];
      this.shallowestMetres = hi;
      this.deepestMetres = lo;
    } catch {
      // No statistics: the overview's range stands.
    }
  }

  /** Full-resolution source pixel (fractional x, y) for a lon/lat. */
  pixelAt(lng, lat) {
    const { crs, bbox, width, height } = this.model;
    const [x, y] = crs.fromLonLat(lng, lat);
    return [((x - bbox[0]) / (bbox[2] - bbox[0])) * width, ((bbox[3] - y) / (bbox[3] - bbox[1])) * height];
  }

  /** The stored depth at the nearest source pixel, or null outside the survey or on no data. */
  async sampleExact(lng, lat) {
    if (!this.image) return null;
    const [px, py] = this.pixelAt(lng, lat);
    const x = Math.floor(px);
    const y = Math.floor(py);
    if (x < 0 || y < 0 || x >= this.model.width || y >= this.model.height) return null;
    const data = await this.image.readRasters({ window: [x, y, x + 1, y + 1], samples: [0], interleave: false });
    return this.clean(data[0][0]);
  }

  clean(v) {
    if (!Number.isFinite(v) || Math.abs(v) >= 1e30) return null;
    if (this.noData !== null && Math.abs(v - this.noData) <= Math.abs(this.noData) * 1e-6 + 1e-6) return null;
    return this.model.flipped ? -v : v;
  }

  /**
   * Depths for tile z/x/y at [size] x [size] (north-up), NaN where there's
   * no data; null when the tile misses the survey or covers too much of the
   * file to read quickly (the overview shows there instead).
   */
  async tileValues(z, x, y, size) {
    if (!this.image || !this.bounds) return null;
    const t = tileBounds(z, x, y);
    if (t.east <= this.bounds.west || t.west >= this.bounds.east || t.north <= this.bounds.south || t.south >= this.bounds.north) return null;

    // Source pixel for each output pixel (a grid of projected points, as
    // a UTM survey is turned slightly against the web map).
    const STEP = 16;
    const nodes = size / STEP + 1;
    const gx = new Float64Array(nodes * nodes);
    const gy = new Float64Array(nodes * nodes);
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    const n = 2 ** z;
    for (let j = 0; j < nodes; j++) {
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * (y + j / (nodes - 1))) / n))) * 180) / Math.PI;
      for (let i = 0; i < nodes; i++) {
        const lng = ((x + i / (nodes - 1)) / n) * 360 - 180;
        const [px, py] = this.pixelAt(lng, lat);
        gx[j * nodes + i] = px;
        gy[j * nodes + i] = py;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
      }
    }
    const { width, height } = this.model;
    const x0 = Math.max(0, Math.floor(minX));
    const y0 = Math.max(0, Math.floor(minY));
    const x1 = Math.min(width, Math.ceil(maxX) + 1);
    const y1 = Math.min(height, Math.ceil(maxY) + 1);
    if (x1 <= x0 || y1 <= y0) return null;
    if (x1 - x0 > MAX_WINDOW_PIXELS || y1 - y0 > MAX_WINDOW_PIXELS) return null;

    // Read at the source's own resolution, or scaled to about twice the tile.
    const scale = Math.min(1, (size * 2) / Math.max(x1 - x0, y1 - y0));
    const rw = Math.max(1, Math.round((x1 - x0) * scale));
    const rh = Math.max(1, Math.round((y1 - y0) * scale));
    const data = await this.image.readRasters({
      window: [x0, y0, x1, y1], width: rw, height: rh, samples: [0], interleave: false,
      resampleMethod: 'nearest', pool: decodePool()
    });
    const raw = data[0];
    const out = new Float32Array(size * size).fill(NaN);
    for (let r = 0; r < size; r++) {
      const fj = r / STEP;
      const j = Math.min(nodes - 2, Math.floor(fj));
      const tj = fj - j;
      for (let c = 0; c < size; c++) {
        const fi = c / STEP;
        const i = Math.min(nodes - 2, Math.floor(fi));
        const ti = fi - i;
        const k = j * nodes + i;
        const px = (gx[k] * (1 - ti) + gx[k + 1] * ti) * (1 - tj) + (gx[k + nodes] * (1 - ti) + gx[k + nodes + 1] * ti) * tj;
        const py = (gy[k] * (1 - ti) + gy[k + 1] * ti) * (1 - tj) + (gy[k + nodes] * (1 - ti) + gy[k + nodes + 1] * ti) * tj;
        const sx = Math.floor((px - x0) * scale);
        const sy = Math.floor((py - y0) * scale);
        if (px < 0 || py < 0 || px >= width || py >= height || sx < 0 || sy < 0 || sx >= rw || sy >= rh) continue;
        const v = this.clean(raw[sy * rw + sx]);
        if (v !== null) out[r * size + c] = v;
      }
    }
    return out;
  }

  /** Metres per tile pixel at zoom z, at the survey's latitude (for relief shading). */
  pixelMetres(z, size) {
    const midLat = (this.bounds.north + this.bounds.south) / 2;
    return (EARTH_CIRCUMFERENCE * Math.cos((midLat * Math.PI) / 180)) / (2 ** z * size);
  }

  close() {
    this.tiff?.close?.();
    this.tiff = null;
    this.image = null;
  }
}
