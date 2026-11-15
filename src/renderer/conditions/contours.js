// Contour lines from a grid (marching squares), for temperature lines
// (isotherms), the edges of a chosen temperature band, and eddy outlines on
// the sea level map. Kept in step with the Android app's Contours.kt.

/** Steps offered for temperature lines, in the user's degrees. */
export const CONTOUR_STEPS = [0.25, 0.5, 1, 2];

/** A tidy step that gives about 6 to 12 lines over [span]. */
export function autoStep(span) {
  if (!Number.isFinite(span) || span <= 0) return 1;
  return CONTOUR_STEPS.find((s) => span / s <= 12) ?? Math.ceil(span / 12 / 2) * 2;
}

/** Whole multiples of [step] from [low] to [high]. */
export function levels(low, high, step) {
  if (!Number.isFinite(low) || !Number.isFinite(high) || step <= 0 || high < low) return [];
  const first = Math.ceil(low / step);
  const last = Math.floor(high / step);
  if (last - first > 200) return [];
  const out = [];
  for (let k = first; k <= last; k++) out.push(k * step);
  return out;
}

/** The 1st to 99th percentile of [values], or null with none. */
export function range(values) {
  const finite = Array.from(values).filter(Number.isFinite).sort((a, b) => a - b);
  if (!finite.length) return null;
  return [finite[Math.floor(finite.length * 0.01)], finite[Math.min(finite.length - 1, Math.floor(finite.length * 0.99))]];
}

/** Each point averaged with its sea neighbours, [passes] times; land (NaN) stays land. */
export function smooth(grid, values, passes = 1) {
  let src = values;
  for (let p = 0; p < passes; p++) {
    const out = new Float32Array(src.length);
    for (let r = 0; r < grid.rows; r++) {
      for (let c = 0; c < grid.cols; c++) {
        const i = r * grid.cols + c;
        if (Number.isNaN(src[i])) { out[i] = NaN; continue; }
        let sum = 0;
        let n = 0;
        for (let dr = -1; dr <= 1; dr++) {
          for (let dc = -1; dc <= 1; dc++) {
            const rr = r + dr;
            const cc = c + dc;
            if (rr < 0 || cc < 0 || rr >= grid.rows || cc >= grid.cols) continue;
            const v = src[rr * grid.cols + cc];
            if (Number.isFinite(v)) { sum += v; n++; }
          }
        }
        out[i] = sum / n;
      }
    }
    src = out;
  }
  return src;
}

/** Lines at each level: [{ level, points: [[lng, lat], ...] }]; shorter than [minPoints] dropped. */
export function lines(grid, values, levelList, minPoints = 3) {
  const out = [];
  if (grid.rows < 2 || grid.cols < 2) return out;
  for (const level of levelList) out.push(...linesAt(grid, values, level, minPoints));
  return out;
}

function linesAt(grid, values, level, minPoints) {
  const cols = grid.cols;
  const v = (r, c) => values[r * cols + c];
  const segA = [];
  const segB = [];
  // Edges: 2 * corner for the edge east of the corner, + 1 for the edge north of it.
  for (let r = 0; r < grid.rows - 1; r++) {
    for (let c = 0; c < cols - 1; c++) {
      const v00 = v(r, c); const v01 = v(r, c + 1); const v11 = v(r + 1, c + 1); const v10 = v(r + 1, c);
      if (Number.isNaN(v00) || Number.isNaN(v01) || Number.isNaN(v11) || Number.isNaN(v10)) continue;
      const b00 = v00 >= level; const b01 = v01 >= level; const b11 = v11 >= level; const b10 = v10 >= level;
      const bottom = 2 * (r * cols + c);
      const top = 2 * ((r + 1) * cols + c);
      const left = 2 * (r * cols + c) + 1;
      const right = 2 * (r * cols + c + 1) + 1;
      const crossed = [];
      if (b00 !== b01) crossed.push(bottom);
      if (b01 !== b11) crossed.push(right);
      if (b11 !== b10) crossed.push(top);
      if (b10 !== b00) crossed.push(left);
      if (crossed.length === 2) { segA.push(crossed[0]); segB.push(crossed[1]); } else if (crossed.length === 4) {
        // A saddle: the middle decides which corners join up.
        const middle = (v00 + v01 + v11 + v10) / 4 >= level;
        if (middle === b00) { segA.push(bottom, top); segB.push(right, left); } else { segA.push(bottom, right); segB.push(left, top); }
      }
    }
  }
  if (!segA.length) return [];
  const point = (edge) => {
    const corner = Math.floor(edge / 2);
    const r = Math.floor(corner / cols);
    const c = corner % cols;
    const north = edge % 2 === 1;
    const r2 = north ? r + 1 : r;
    const c2 = north ? c : c + 1;
    const a = v(r, c);
    const b = v(r2, c2);
    const t = b === a ? 0.5 : Math.min(1, Math.max(0, (level - a) / (b - a)));
    return [grid.lngs[c] + (grid.lngs[c2] - grid.lngs[c]) * t, grid.lats[r] + (grid.lats[r2] - grid.lats[r]) * t];
  };
  const touching = new Map();
  const attach = (edge, seg) => { const l = touching.get(edge); if (l) l.push(seg); else touching.set(edge, [seg]); };
  for (let i = 0; i < segA.length; i++) { attach(segA[i], i); attach(segB[i], i); }
  const used = new Uint8Array(segA.length);
  const walk = (chain) => {
    for (;;) {
      const end = chain[chain.length - 1];
      const next = touching.get(end)?.find((s) => !used[s]);
      if (next === undefined) return;
      used[next] = 1;
      chain.push(segA[next] === end ? segB[next] : segA[next]);
    }
  };
  const out = [];
  for (let start = 0; start < segA.length; start++) {
    if (used[start]) continue;
    used[start] = 1;
    const forward = [segA[start], segB[start]];
    walk(forward);
    const backward = [segA[start]];
    walk(backward);
    const edges = backward.slice(1).reverse().concat(forward);
    if (edges.length < minPoints) continue;
    out.push({ level, points: edges.map(point) });
  }
  return out;
}

/** Eddy middles: at least [minCm] from average and the highest (or lowest) within [radius] grid steps. */
export function eddies(grid, valuesCm, minCm = 10, radius = 3) {
  const out = [];
  for (let r = 0; r < grid.rows; r++) {
    for (let c = 0; c < grid.cols; c++) {
      const here = valuesCm[r * grid.cols + c];
      if (!Number.isFinite(here) || Math.abs(here) < minCm) continue;
      // Not at the area's edge or beside land: a high or low there is cut off, not an eddy.
      if (r === 0 || c === 0 || r === grid.rows - 1 || c === grid.cols - 1) continue;
      let byLand = false;
      for (let dr = -1; dr <= 1; dr++) for (let dc = -1; dc <= 1; dc++) if (!Number.isFinite(valuesCm[(r + dr) * grid.cols + c + dc])) byLand = true;
      if (byLand) continue;
      const warm = here > 0;
      let best = true;
      outer: for (let dr = -radius; dr <= radius; dr++) {
        for (let dc = -radius; dc <= radius; dc++) {
          if (!dr && !dc) continue;
          const rr = r + dr;
          const cc = c + dc;
          if (rr < 0 || cc < 0 || rr >= grid.rows || cc >= grid.cols) continue;
          const v = valuesCm[rr * grid.cols + cc];
          if (!Number.isFinite(v)) continue;
          const earlier = dr < 0 || (dr === 0 && dc < 0);
          if (warm ? v > here || (v === here && earlier) : v < here || (v === here && earlier)) { best = false; break outer; }
        }
      }
      if (best) out.push({ lat: grid.lats[r], lng: grid.lngs[c], valueCm: here, warm });
    }
  }
  return out;
}

/** GeoJSON: lines with kind and label; eddy middles as points (kind warm or cold). */
export function contourGeoJson(lineList, eddyList = []) {
  const round = (x) => Math.round(x * 1e4) / 1e4;
  const features = lineList.map(({ line, kind, label }) => ({
    type: 'Feature', properties: { kind, label },
    geometry: { type: 'LineString', coordinates: line.points.map(([x, y]) => [round(x), round(y)]) }
  }));
  for (const e of eddyList) {
    features.push({
      type: 'Feature', properties: { kind: e.warm ? 'warm' : 'cold', label: e.warm ? 'W' : 'C' },
      geometry: { type: 'Point', coordinates: [round(e.lng), round(e.lat)] }
    });
  }
  return { type: 'FeatureCollection', features };
}
