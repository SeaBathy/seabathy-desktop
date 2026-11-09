// Builds a texture of web-map tiles (satellite, an offline MBTiles pack,
// seamarks...) in the depth grid's own pixel space, so it can be draped over
// the 3D terrain. Shared as-is by the phone's 3D page and SeaBathy Desktop.

const TILE = 256;

function lonLatToWorldPx(lng, lat, z) {
  const scale = TILE * 2 ** z;
  const sin = Math.sin((Math.max(-85.05, Math.min(85.05, lat)) * Math.PI) / 180);
  return [((lng + 180) / 360) * scale, (0.5 - Math.log((1 + sin) / (1 - sin)) / (4 * Math.PI)) * scale];
}

// Decoded tiles, most recently used last, so moving the 3D view about
// re-uses what it already fetched. Missing tiles aren't kept: with no
// signal now, they may come back later.
const tileCache = new Map();
let tileCacheLimit = 256;

/** How many decoded tiles to keep (each is 256 KB of memory). */
export function setTileCacheSize(count) {
  tileCacheLimit = count;
  trimCache();
}

function trimCache() {
  while (tileCache.size > tileCacheLimit) {
    const [url, bitmap] = tileCache.entries().next().value;
    tileCache.delete(url);
    bitmap.close();
  }
}

async function loadTile(url) {
  const cached = tileCache.get(url);
  if (cached) {
    tileCache.delete(url);
    tileCache.set(url, cached);
    return cached;
  }
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const bitmap = await createImageBitmap(await response.blob());
    tileCache.set(url, bitmap);
    trimCache();
    return bitmap;
  } catch {
    return null;
  }
}

/**
 * The part [rect] ({ c0, r0, c1, r1 }, cell-edge units) of [grid] as a grid
 * of its own, to build a sharper drape for just that part.
 */
export function subGrid(grid, rect) {
  const cols = rect.c1 - rect.c0;
  const rows = rect.r1 - rect.r0;
  // toLonLat takes cell-centre coordinates: an edge is half a cell before its centre.
  const toLonLat = (col, row) => grid.toLonLat(rect.c0 + col, rect.r0 + row);
  const corner = (c, r) => {
    const ll = grid.toLonLat(rect.c0 + c - 0.5, rect.r0 + r - 0.5);
    return [ll.lng, ll.lat];
  };
  return {
    cols,
    rows,
    widthMetres: grid.widthMetres * (cols / grid.cols),
    corners: [corner(0, 0), corner(cols, 0), corner(cols, rows), corner(0, rows)],
    centreLat: toLonLat(cols / 2 - 0.5, rows / 2 - 0.5).lat,
    toLonLat
  };
}

function tileRange(corners, z) {
  const pts = corners.map(([lng, lat]) => lonLatToWorldPx(lng, lat, z));
  const xs = pts.map((p) => Math.floor(p[0] / TILE));
  const ys = pts.map((p) => Math.floor(p[1] / TILE));
  const range = { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
  range.count = (range.x1 - range.x0 + 1) * (range.y1 - range.y0 + 1);
  return range;
}

/**
 * The zoom for a layer: the one matching the texture's pixel size, within the
 * layer's own zooms, lowered while it would take more than [maxTiles] tiles.
 * Null when even the layer's least zoom needs far too many (an offline pack
 * made only for close zooms, over a big area).
 */
function zoomFor(layer, ideal, corners, maxTiles) {
  const minZoom = layer.minzoom ?? 0;
  let z = Math.max(minZoom, Math.min(layer.maxzoom ?? 19, ideal));
  while (z > minZoom && tileRange(corners, z).count > maxTiles) z--;
  return tileRange(corners, z).count <= maxTiles * 4 ? z : null;
}

/**
 * grid: { cols, rows, widthMetres, corners: [[lng, lat] x4], centreLat,
 *         toLonLat(col, row) -> { lng, lat } } (row 0 = north).
 * layers: [{ tiles: 'https://…/{z}/{x}/{y}', minzoom, maxzoom }], bottom to top.
 * Returns a canvas aligned with the grid, the zoom of the top layer, and how
 * many tiles came back, or a null canvas when none did.
 */
export async function buildDrape(grid, layers, { maxSize = 2048, maxTiles = 160, onProgress } = {}) {
  // The longer side at the full texture size: the drape is usually far
  // sharper than the depth grid, which is the point of it.
  const outW = grid.cols >= grid.rows ? maxSize : Math.max(2, Math.round((maxSize * grid.cols) / grid.rows));
  const outH = grid.cols >= grid.rows ? Math.max(2, Math.round((maxSize * grid.rows) / grid.cols)) : maxSize;
  const metresPerPx = grid.widthMetres / outW;
  const ideal = Math.max(0, Math.floor(Math.log2((156543.03 * Math.cos((grid.centreLat * Math.PI) / 180)) / metresPerPx)));

  const plans = layers.map((layer) => {
    const z = zoomFor(layer, ideal, grid.corners, maxTiles);
    return z === null ? null : { layer, z, range: tileRange(grid.corners, z) };
  }).filter(Boolean);
  const total = plans.reduce((n, p) => n + p.range.count, 0);
  const out = new ImageData(outW, outH);
  const dst = out.data;
  let done = 0;
  let loaded = 0;

  for (const { layer, z, range } of plans) {
    const mosaic = new OffscreenCanvas((range.x1 - range.x0 + 1) * TILE, (range.y1 - range.y0 + 1) * TILE);
    const ctx = mosaic.getContext('2d');
    const jobs = [];
    for (let ty = range.y0; ty <= range.y1; ty++) {
      for (let tx = range.x0; tx <= range.x1; tx++) {
        const url = layer.tiles.replace('{z}', z).replace('{x}', tx).replace('{y}', ty);
        jobs.push(loadTile(url).then((bitmap) => {
          if (bitmap) {
            ctx.drawImage(bitmap, (tx - range.x0) * TILE, (ty - range.y0) * TILE);
            loaded++;
          }
          onProgress?.(++done / total);
        }));
      }
    }
    await Promise.all(jobs);
    const src = ctx.getImageData(0, 0, mosaic.width, mosaic.height).data;

    // Each output pixel's mosaic pixel. The projection is worked out on a
    // coarse lattice and interpolated, which is exact enough at this scale.
    const STEP = 16;
    const lw = Math.ceil(outW / STEP) + 1;
    const lh = Math.ceil(outH / STEP) + 1;
    const lattice = new Float64Array(lw * lh * 2);
    for (let j = 0; j < lh; j++) {
      for (let i = 0; i < lw; i++) {
        const col = (Math.min(outW, i * STEP) / outW) * grid.cols - 0.5;
        const row = (Math.min(outH, j * STEP) / outH) * grid.rows - 0.5;
        const ll = grid.toLonLat(col, row);
        const [px, py] = lonLatToWorldPx(ll.lng, ll.lat, z);
        lattice[(j * lw + i) * 2] = px - range.x0 * TILE;
        lattice[(j * lw + i) * 2 + 1] = py - range.y0 * TILE;
      }
    }

    // Bilinear from the mosaic, laid over the layers below (alpha "over"),
    // so a pack that covers only part of the survey leaves the rest as it was.
    for (let y = 0; y < outH; y++) {
      const j = Math.min(lh - 2, Math.floor(y / STEP));
      const fy = (y - j * STEP) / STEP;
      for (let x = 0; x < outW; x++) {
        const i = Math.min(lw - 2, Math.floor(x / STEP));
        const fx = (x - i * STEP) / STEP;
        const a = (j * lw + i) * 2;
        const b = a + 2;
        const c = a + lw * 2;
        const d = c + 2;
        const mx = (lattice[a] * (1 - fx) + lattice[b] * fx) * (1 - fy) + (lattice[c] * (1 - fx) + lattice[d] * fx) * fy - 0.5;
        const my = (lattice[a + 1] * (1 - fx) + lattice[b + 1] * fx) * (1 - fy) + (lattice[c + 1] * (1 - fx) + lattice[d + 1] * fx) * fy - 0.5;
        const x0 = Math.max(0, Math.min(mosaic.width - 2, Math.floor(mx)));
        const y0 = Math.max(0, Math.min(mosaic.height - 2, Math.floor(my)));
        const tx = Math.max(0, Math.min(1, mx - x0));
        const ty = Math.max(0, Math.min(1, my - y0));
        const s00 = (y0 * mosaic.width + x0) * 4;
        const s10 = s00 + 4;
        const s01 = s00 + mosaic.width * 4;
        const s11 = s01 + 4;
        const o = (y * outW + x) * 4;
        const w00 = (1 - tx) * (1 - ty);
        const w10 = tx * (1 - ty);
        const w01 = (1 - tx) * ty;
        const w11 = tx * ty;
        const alpha = (src[s00 + 3] * w00 + src[s10 + 3] * w10 + src[s01 + 3] * w01 + src[s11 + 3] * w11) / 255;
        if (alpha <= 0) continue;
        for (let k = 0; k < 3; k++) {
          // Colours weighted by their alpha, so a transparent edge doesn't bleed black.
          const v = (src[s00 + k] * src[s00 + 3] * w00 + src[s10 + k] * src[s10 + 3] * w10 + src[s01 + k] * src[s01 + 3] * w01 + src[s11 + k] * src[s11 + 3] * w11) / (alpha * 255);
          dst[o + k] = v * alpha + dst[o + k] * (1 - alpha);
        }
        dst[o + 3] = Math.min(255, alpha * 255 + dst[o + 3] * (1 - alpha));
      }
    }
  }

  if (!loaded) return { canvas: null, zoom: null, loaded: 0, total };
  const canvas = document.createElement('canvas');
  canvas.width = outW;
  canvas.height = outH;
  canvas.getContext('2d').putImageData(out, 0, 0);
  return { canvas, zoom: plans[plans.length - 1].z, loaded, total, metresPerPx };
}
