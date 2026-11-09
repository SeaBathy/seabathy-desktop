// Moving flow lines over the chart, as on the phone
// (conditions/FlowLinesView.kt): specks that drift with the current (or the
// wind, waves or swell) and leave short fading trails. They live in
// web-Mercator coordinates, so the trails stay put as the map moves.

import { mercatorY, latitudeOf } from './picture.js';

/** Positions kept per speck: its trail. */
const TRAIL = 12;
const FRAME_MS = 40;
const NEWEST_ALPHA = 230;
const OLDEST_ALPHA = 20;
const LINE_PX = 1.3;
const MAX_STEP_PX = 2.4;
// The phone's density (one speck per ~540 dp²), on a bigger screen.
const PIXELS_PER_SPECK = 540;
const MIN_SPECKS = 200;
const MAX_SPECKS = 2400;
const MIN_LIFE = 50;
const MAX_LIFE = 140;
const SPAWN_TRIES = 6;

const toRad = (d) => (d * Math.PI) / 180;
const toDeg = (r) => (r * 180) / Math.PI;

export class FlowLines {
  constructor(map) {
    this.map = map;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'overlay-canvas';
    this.canvas.hidden = true;
    map.getContainer().append(this.canvas);
    this.ctx = this.canvas.getContext('2d');
    this.field = null;
    this.running = false;
    this.count = 0;
    this.flow = new Float64Array(2);
    this.lastFrame = 0;
    this.frame = (now) => {
      if (!this.running) return;
      if (now - this.lastFrame >= FRAME_MS) {
        this.lastFrame = now;
        this.step();
        this.draw();
      }
      requestAnimationFrame(this.frame);
    };
    new ResizeObserver(() => this.resize()).observe(map.getContainer());
    this.resize();
  }

  resize() {
    const box = this.map.getContainer();
    const dpr = window.devicePixelRatio || 1;
    this.width = box.clientWidth;
    this.height = box.clientHeight;
    this.canvas.width = Math.round(this.width * dpr);
    this.canvas.height = Math.round(this.height * dpr);
    this.canvas.style.width = `${this.width}px`;
    this.canvas.style.height = `${this.height}px`;
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // A new size wants a different number of specks.
    this.count = 0;
  }

  /**
   * What to draw: field(lat, lng, out) writes east and north parts into out
   * (false where there's none), over the area; a speck moves fastest at
   * [reference] strength. A null field stops it.
   */
  show(field, reference, south, west, north, east) {
    const newArea = south !== this.south || west !== this.west || north !== this.north || east !== this.east;
    Object.assign(this, { field, reference: Math.max(1e-6, reference), south, west, north, east });
    this.southY = mercatorY(south);
    this.northY = mercatorY(north);
    if (!field) {
      this.stop();
      return;
    }
    if (newArea) this.count = 0;
    this.canvas.hidden = false;
    if (!this.running) {
      this.running = true;
      requestAnimationFrame(this.frame);
    }
  }

  stop() {
    this.running = false;
    this.count = 0;
    this.canvas.hidden = true;
  }

  /** The map's current Mercator-to-screen transform; false while the map can't say. */
  takeTransform() {
    const centre = this.map.getCenter();
    const lat = Math.min(80, Math.max(-80, centre.lat));
    const lng = centre.lng;
    const d = 0.01;
    const p0 = this.map.project([lng, lat]);
    const pe = this.map.project([lng + toDeg(d), lat]);
    const y0 = mercatorY(lat);
    const pn = this.map.project([lng, latitudeOf(y0 + d)]);
    this.m00 = (pe.x - p0.x) / d;
    this.m10 = (pe.y - p0.y) / d;
    this.m01 = (pn.x - p0.x) / d;
    this.m11 = (pn.y - p0.y) / d;
    const x0 = toRad(lng);
    this.tx = p0.x - (this.m00 * x0 + this.m01 * y0);
    this.ty = p0.y - (this.m10 * x0 + this.m11 * y0);
    return Number.isFinite(this.m00) && Number.isFinite(this.m11);
  }

  seed() {
    this.count = Math.min(MAX_SPECKS, Math.max(MIN_SPECKS, Math.trunc((this.width * this.height) / PIXELS_PER_SPECK)));
    const n = this.count;
    this.trailX = new Float64Array(n * TRAIL);
    this.trailY = new Float64Array(n * TRAIL);
    this.head = new Int32Array(n);
    this.length = new Int32Array(n);
    this.ages = new Int32Array(n);
    this.lifetimes = new Int32Array(n);
    for (let i = 0; i < n; i++) {
      this.respawn(i);
      // Part way through their lives, so they don't all fade at once.
      this.ages[i] = Math.floor(Math.random() * Math.max(1, this.lifetimes[i]));
    }
  }

  /** Puts a speck somewhere on screen over the area's water, with no trail yet. */
  respawn(i) {
    this.lifetimes[i] = MIN_LIFE + Math.floor(Math.random() * (MAX_LIFE - MIN_LIFE));
    this.ages[i] = 0;
    this.head[i] = 0;
    this.length[i] = 1;
    const det = this.m00 * this.m11 - this.m01 * this.m10;
    if (det !== 0 && this.field) {
      for (let t = 0; t < SPAWN_TRIES; t++) {
        const sx = Math.random() * this.width - this.tx;
        const sy = Math.random() * this.height - this.ty;
        const x = (this.m11 * sx - this.m01 * sy) / det;
        const y = (-this.m10 * sx + this.m00 * sy) / det;
        const lat = latitudeOf(y);
        const lng = toDeg(x);
        if (lat >= this.south && lat <= this.north && lng >= this.west && lng <= this.east && this.field(lat, lng, this.flow)) {
          this.trailX[i * TRAIL] = x;
          this.trailY[i * TRAIL] = y;
          return;
        }
      }
    }
    // Nowhere found this time: parked off screen until the next try.
    this.trailX[i * TRAIL] = toRad(this.west) - 1;
    this.trailY[i * TRAIL] = this.southY;
    this.ages[i] = this.lifetimes[i];
    this.length[i] = 0;
  }

  /** Moves every speck one frame along the flow. */
  step() {
    if (!this.field) return;
    this.haveTransform = this.takeTransform();
    if (!this.haveTransform || !this.width || !this.height) return;
    if (!this.count) this.seed();
    const { m00, m01, m10, m11, tx, ty } = this;
    const det = m00 * m11 - m01 * m10;
    if (det === 0) return;
    for (let i = 0; i < this.count; i++) {
      this.ages[i]++;
      const at = i * TRAIL + this.head[i];
      const x = this.trailX[at];
      const y = this.trailY[at];
      if (this.ages[i] > this.lifetimes[i] || !this.field(latitudeOf(y), toDeg(x), this.flow)) {
        this.respawn(i);
        continue;
      }
      const strength = Math.hypot(this.flow[0], this.flow[1]);
      if (strength < 1e-6) continue;
      // Which way east-and-north points on the screen (the map may be turned).
      const sx = m00 * this.flow[0] + m01 * this.flow[1];
      const sy = m10 * this.flow[0] + m11 * this.flow[1];
      const len = Math.hypot(sx, sy);
      if (len === 0) continue;
      const pixels = MAX_STEP_PX * Math.min(1, Math.sqrt(strength / this.reference));
      const dx = (sx / len) * pixels;
      const dy = (sy / len) * pixels;
      const nx = x + (m11 * dx - m01 * dy) / det;
      const ny = y + (-m10 * dx + m00 * dy) / det;
      const screenX = m00 * nx + m01 * ny + tx;
      const screenY = m10 * nx + m11 * ny + ty;
      const nLng = toDeg(nx);
      if (screenX < 0 || screenY < 0 || screenX > this.width || screenY > this.height ||
        nLng < this.west || nLng > this.east || ny < this.southY || ny > this.northY) {
        this.respawn(i);
        continue;
      }
      this.head[i] = (this.head[i] + 1) % TRAIL;
      this.trailX[i * TRAIL + this.head[i]] = nx;
      this.trailY[i * TRAIL + this.head[i]] = ny;
      if (this.length[i] < TRAIL) this.length[i]++;
    }
  }

  draw() {
    const ctx = this.ctx;
    ctx.clearRect(0, 0, this.width, this.height);
    if (!this.running || !this.haveTransform || !this.count) return;
    const { m00, m01, m10, m11, tx, ty } = this;
    ctx.lineWidth = LINE_PX;
    ctx.lineCap = 'round';
    // One path per trail step, oldest faintest.
    for (let s = 0; s < TRAIL - 1; s++) {
      ctx.beginPath();
      for (let i = 0; i < this.count; i++) {
        if (this.length[i] < s + 2) continue;
        const k0 = (this.head[i] - s + TRAIL) % TRAIL;
        const k1 = (k0 - 1 + TRAIL) % TRAIL;
        const ax = this.trailX[i * TRAIL + k0];
        const ay = this.trailY[i * TRAIL + k0];
        const bx = this.trailX[i * TRAIL + k1];
        const by = this.trailY[i * TRAIL + k1];
        ctx.moveTo(m00 * ax + m01 * ay + tx, m10 * ax + m11 * ay + ty);
        ctx.lineTo(m00 * bx + m01 * by + tx, m10 * bx + m11 * by + ty);
      }
      const alpha = NEWEST_ALPHA - ((NEWEST_ALPHA - OLDEST_ALPHA) * s) / (TRAIL - 2);
      ctx.strokeStyle = `rgba(255,255,255,${alpha / 255})`;
      ctx.stroke();
    }
  }
}
