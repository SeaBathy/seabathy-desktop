// The tide chart, as on the phone (tides/TideGraphView.kt): the next day and
// a half as a smooth curve, highs and lows marked, night shaded, a NOW
// marker, and the tide at any time while dragging along it.

const BEFORE_MS = 3 * 3_600_000;
const AFTER_MS = 33 * 3_600_000;
const SAMPLES = 240;
const CARD = '#0F1A27';
const WATER = '#38BDF8';
const HIGH = '#38BDF8';
const LOW = '#94A3B8';
const NOW = '#FFB020';
const MUTED = '#94A3B8';
const HEIGHT = 250;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const pad = (n) => String(n).padStart(2, '0');
const hm = (t) => {
  const d = new Date(t);
  return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
};

/** A canvas showing [curve] from [windowStart]; heights get [offset] added. */
export function tideGraph({ curve, offset, now, windowStart, nights, format }) {
  const canvas = document.createElement('canvas');
  canvas.className = 'tide-graph';
  let cursor = null;
  let plotLeft = 0;
  let plotRight = 0;

  function draw() {
    const dpr = window.devicePixelRatio || 1;
    const width = canvas.clientWidth || 440;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, HEIGHT);
    ctx.fillStyle = CARD;
    ctx.beginPath();
    ctx.roundRect(0, 0, width, HEIGHT, 14);
    ctx.fill();
    const from = windowStart;
    const to = windowStart + BEFORE_MS + AFTER_MS;
    const samples = [];
    for (let i = 0; i <= SAMPLES; i++) {
      const t = from + ((to - from) * i) / SAMPLES;
      const h = curve.heightAt(t);
      if (h !== null) samples.push([t, h + offset]);
    }
    if (samples.length < 2) return;
    const left = 36;
    const right = width - 12;
    plotLeft = left;
    plotRight = right;
    const top = 46;
    const bottom = HEIGHT - 62;
    const minH = Math.floor(Math.min(...samples.map((s) => s[1])) * 2) / 2;
    const maxH = Math.ceil(Math.max(...samples.map((s) => s[1])) * 2) / 2;
    const range = Math.max(0.5, maxH - minH);
    const x = (t) => left + ((t - from) / (to - from)) * (right - left);
    const y = (v) => top + ((maxH - v) / range) * (bottom - top);

    ctx.fillStyle = 'rgba(0,0,0,0.45)';
    for (const [dusk, dawn] of nights) {
      if (dawn <= from || dusk >= to) continue;
      ctx.fillRect(x(Math.max(dusk, from)), top - 6, x(Math.min(dawn, to)) - x(Math.max(dusk, from)), bottom - top + 6);
    }

    const step = format.tideChartStep(range);
    const perMetre = format.tideUnitsPerMetre();
    ctx.font = '11px Roboto, "Segoe UI", sans-serif';
    for (let level = Math.ceil(minH * perMetre / step - 1e-6) * step; level / perMetre <= maxH + 1e-6; level += step) {
      const lineY = y(level / perMetre);
      ctx.strokeStyle = 'rgba(255,255,255,0.12)';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(left, lineY);
      ctx.lineTo(right, lineY);
      ctx.stroke();
      ctx.fillStyle = MUTED;
      ctx.fillText(level.toFixed(step < 1 ? 1 : 0), 8, lineY + 4);
    }

    // Midnights (dashed, with the day) and 6-hourly times along the bottom.
    const c = new Date(from);
    c.setMinutes(0, 0, 0);
    c.setHours(c.getHours() + 1);
    for (; c.getTime() < to; c.setHours(c.getHours() + 1)) {
      const t = c.getTime();
      const hour = c.getHours();
      if (hour === 0) {
        ctx.setLineDash([4, 4]);
        ctx.strokeStyle = 'rgba(255,255,255,0.25)';
        ctx.beginPath();
        ctx.moveTo(x(t), top - 6);
        ctx.lineTo(x(t), bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        if (Math.abs(x(t) - x(now)) > 30) {
          const label = `${WEEKDAYS[c.getDay()]} ${c.getDate()}`;
          ctx.font = 'bold 12px Roboto, "Segoe UI", sans-serif';
          const w = ctx.measureText(label).width;
          ctx.fillStyle = '#E2E8F0';
          ctx.fillText(label, Math.min(right - w, Math.max(left, x(t) - w / 2)), bottom + 52);
        }
      } else if (hour % 6 === 0 && Math.abs(x(t) - x(now)) > 26) {
        const label = `${pad(hour)}:00`;
        ctx.font = '11px Roboto, "Segoe UI", sans-serif';
        ctx.fillStyle = MUTED;
        ctx.fillText(label, x(t) - ctx.measureText(label).width / 2, bottom + 52);
      }
    }

    ctx.beginPath();
    samples.forEach(([t, v], i) => (i ? ctx.lineTo(x(t), y(v)) : ctx.moveTo(x(t), y(v))));
    const line = new Path2D();
    samples.forEach(([t, v], i) => (i ? line.lineTo(x(t), y(v)) : line.moveTo(x(t), y(v))));
    ctx.lineTo(x(samples[samples.length - 1][0]), bottom);
    ctx.lineTo(x(samples[0][0]), bottom);
    ctx.closePath();
    const grad = ctx.createLinearGradient(0, top, 0, bottom);
    grad.addColorStop(0, 'rgba(56,189,248,0.4)');
    grad.addColorStop(1, 'rgba(56,189,248,0.03)');
    ctx.fillStyle = grad;
    ctx.fill();
    ctx.strokeStyle = WATER;
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke(line);

    const dot = (cx, cy, r, colour) => {
      ctx.beginPath();
      ctx.arc(cx, cy, r, 0, Math.PI * 2);
      ctx.fillStyle = colour;
      ctx.fill();
      ctx.lineWidth = 2;
      ctx.strokeStyle = CARD;
      ctx.stroke();
    };
    ctx.textAlign = 'center';
    for (const e of curve.extremes(from, to)) {
      const v = e.heightM + offset;
      const cx = x(e.timeMillis);
      const cy = y(v);
      dot(cx, cy, 5, e.isHigh ? HIGH : LOW);
      // Already past: just the dot, so its label doesn't crowd the NOW marker.
      if (e.timeMillis < now) continue;
      const lx = Math.min(right - 22, Math.max(left + 22, cx));
      ctx.font = 'bold 12px Roboto, "Segoe UI", sans-serif';
      ctx.fillStyle = '#F8FAFC';
      ctx.fillText(hm(e.timeMillis), lx, e.isHigh ? cy - 22 : cy + 21);
      ctx.font = '11px Roboto, "Segoe UI", sans-serif';
      ctx.fillStyle = MUTED;
      ctx.fillText(format.tideMark(v), lx, e.isHigh ? cy - 9 : cy + 34);
    }

    if (now >= from && now <= to) {
      const h = curve.heightAt(now);
      if (h !== null) {
        ctx.strokeStyle = NOW;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x(now), top - 4);
        ctx.lineTo(x(now), bottom);
        ctx.stroke();
        dot(x(now), y(h + offset), 6, NOW);
        ctx.font = 'bold 11px Roboto, "Segoe UI", sans-serif';
        ctx.fillStyle = NOW;
        ctx.fillText('NOW', Math.min(right - 14, Math.max(left + 14, x(now))), bottom + 52);
      }
    }

    if (cursor !== null) {
      const h = curve.heightAt(cursor);
      if (h !== null) {
        const rate = curve.rateMPerHour(cursor) ?? 0;
        const arrow = rate > 0.02 ? '▲' : rate < -0.02 ? '▼' : '■';
        const d = new Date(cursor);
        const label = `${WEEKDAYS[d.getDay()]} ${hm(cursor)}   ${format.tideHeight(h + offset)} ${arrow}`;
        const cx = x(cursor);
        ctx.strokeStyle = 'rgba(255,255,255,0.8)';
        ctx.lineWidth = 1.5;
        ctx.beginPath();
        ctx.moveTo(cx, top - 4);
        ctx.lineTo(cx, bottom);
        ctx.stroke();
        dot(cx, y(h + offset), 6, '#FFFFFF');
        ctx.font = 'bold 13px Roboto, "Segoe UI", sans-serif';
        const w = ctx.measureText(label).width + 16;
        const bx = Math.min(width - w - 4, Math.max(4, cx - w / 2));
        ctx.fillStyle = '#F8FAFC';
        ctx.beginPath();
        ctx.roundRect(bx, 4, w, 24, 8);
        ctx.fill();
        ctx.fillStyle = CARD;
        ctx.fillText(label, bx + w / 2, 21);
      }
    }
    ctx.textAlign = 'left';
  }

  const scrub = (event) => {
    if (plotRight <= plotLeft) return;
    const box = canvas.getBoundingClientRect();
    const fraction = Math.min(1, Math.max(0, (event.clientX - box.left - plotLeft) / (plotRight - plotLeft)));
    cursor = windowStart + (BEFORE_MS + AFTER_MS) * fraction;
    draw();
  };
  canvas.addEventListener('pointerdown', (e) => {
    canvas.setPointerCapture(e.pointerId);
    scrub(e);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (e.buttons) scrub(e);
  });
  new ResizeObserver(draw).observe(canvas);
  return canvas;
}

export { BEFORE_MS };
