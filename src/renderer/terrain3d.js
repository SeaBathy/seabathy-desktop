// 3D terrain view of a depth GeoTIFF.
//
// Rendering is on demand: a frame is drawn only when something changed
// (camera movement, an animation, a setting), and the shadow map is redrawn
// only when the terrain, sun or vertical scale changes. Idle, the view costs
// nothing -- a continuous 60-120 fps loop is what made phones run hot.
//
// World space: metres, x = east, z = south, y = up. The mesh holds raw depth
// values in y; vertical exaggeration is mesh.scale.y about a reference level
// in the middle of the data (world y = (depth - ref) * exaggeration), so the
// slider is instant and high exaggeration never pushes the terrain off-screen. Colours and contour lines are computed per-pixel in the shader from
// the raw depth, so palette / range / contour changes never rebuild geometry.

import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { CSS2DRenderer, CSS2DObject } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { sampleGrid } from './tif.js';

const BG = 0x07111c;
/** Minimum time between frames: caps drawing at 60 fps on high-refresh screens. */
const MIN_FRAME_MS = 1000 / 60 - 2;
/** How long the camera must be still before a sharper map is fetched for the view. */
const VIEW_SETTLE_MS = 450;

export class Terrain3D {
  constructor(container, callbacks = {}) {
    this.container = container;
    this.callbacks = callbacks;
    this.model = null;
    this.exaggeration = 3;
    this.active = false;
    this.waypointObjects = [];
    this.pendingHover = null;

    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio);
    renderer.setClearColor(BG);
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    // The light and terrain don't move while the camera does, so the shadow
    // map is drawn once and reused; see #invalidateShadows.
    renderer.shadowMap.autoUpdate = false;
    container.appendChild(renderer.domElement);
    this.renderer = renderer;

    const labels = new CSS2DRenderer();
    labels.domElement.style.position = 'absolute';
    labels.domElement.style.inset = '0';
    labels.domElement.style.pointerEvents = 'none';
    container.appendChild(labels.domElement);
    this.labelRenderer = labels;

    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 1, 1e6);

    this.controls = new OrbitControls(this.camera, renderer.domElement);
    this.controls.enableDamping = true;
    this.controls.dampingFactor = 0.08;
    this.controls.screenSpacePanning = false;
    this.controls.zoomToCursor = true;
    this.controls.maxPolarAngle = Math.PI / 2 - 0.03;
    this.controls.autoRotateSpeed = 0.6;

    this.hemi = new THREE.HemisphereLight(0xcfe6ff, 0x1a2a3a, 1.1);
    this.scene.add(this.hemi);
    this.sun = new THREE.DirectionalLight(0xffffff, 2.4);
    this.sun.castShadow = true;
    this.sun.shadow.mapSize.set(4096, 4096);
    this.sun.shadow.bias = -0.0004;
    this.scene.add(this.sun, this.sun.target);
    this.sunAz = 315;
    this.sunEl = 35;

    this.uniforms = {
      uPalette: { value: null },
      uMin: { value: -100 },
      uMax: { value: 0 },
      uContour: { value: 5 },
      uClipMin: { value: -1e9 },
      uClipMax: { value: 1e9 },
      uDrape: { value: null },
      uDrapeMix: { value: 0 },
      // A sharper drape for the part in view, over [uDetailRect] (u0, v0, u1, v1 of the main drape).
      uDetail: { value: null },
      uDetailRect: { value: new THREE.Vector4(0, 0, 1, 1) },
      uDetailOn: { value: 0 },
      // 0 = colour by depth, 1 = colour by slope (degrees, up to uSlopeMax).
      uColorMode: { value: 0 },
      uSlopeMax: { value: 20 }
    };
    this.ref = 0;
    this.contourLabels = [];
    this.needsRender = true;
    this.loopRunning = false;
    this.lastRenderAt = 0;
    this.renderCount = 0;
    this.#wrapForRendering();
    this.boat = null;
    this.followBoat = false;

    this.profileLine = null;
    this.compass = document.createElement('div');
    this.compass.className = 'compass';
    this.compass.innerHTML = '<svg viewBox="0 0 40 40" width="44" height="44"><circle cx="20" cy="20" r="18" fill="rgba(0,0,0,.45)" stroke="#567"/><path d="M20 8 L24.5 20 L15.5 20 Z" fill="#e5484d"/><path d="M20 32 L24.5 20 L15.5 20 Z" fill="#ccd"/><text x="20" y="7.5" fill="#fff" font-size="7" font-family="sans-serif" text-anchor="middle">N</text></svg>';
    Object.assign(this.compass.style, { position: 'absolute', left: '12px', top: '12px', width: '44px', height: '44px', pointerEvents: 'none' });
    container.appendChild(this.compass);

    this.#bindEvents();
    new ResizeObserver(() => { this.#resize(); this.requestRender(); }).observe(container);
    // Camera changes from touch/mouse (OrbitControls updates the camera in its
    // own input handlers) and the damping glide afterwards.
    this.controls.addEventListener('change', () => {
      this.requestRender();
      // The camera has come to rest: time to fetch a sharper map for what's in view.
      clearTimeout(this.settleTimer);
      this.settleTimer = setTimeout(() => this.callbacks.onViewSettled?.(), VIEW_SETTLE_MS);
    });
  }

  // ---------------------------------------------------------------- geometry

  setModel(model) {
    this.#disposeTerrain();
    this.model = model;
    const { cols, rows, values, cellX, cellY, min } = model;
    const count = cols * rows;
    const positions = new Float32Array(count * 3);
    const halfX = ((cols - 1) * cellX) / 2;
    const halfZ = ((rows - 1) * cellY) / 2;
    this.halfX = halfX;
    this.halfZ = halfZ;
    this.ref = (model.min + model.max) / 2;
    const uvs = new Float32Array(count * 2);

    for (let r = 0, i = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++, i++) {
        const v = values[i];
        positions[i * 3] = c * cellX - halfX;
        positions[i * 3 + 1] = Number.isNaN(v) ? min : v;
        positions[i * 3 + 2] = r * cellY - halfZ;
        uvs[i * 2] = c / (cols - 1);
        uvs[i * 2 + 1] = 1 - r / (rows - 1);
      }
    }

    // Skip any quad that touches a no-data cell so gaps stay open.
    const index = new Uint32Array((cols - 1) * (rows - 1) * 6);
    let n = 0;
    for (let r = 0; r < rows - 1; r++) {
      for (let c = 0; c < cols - 1; c++) {
        const a = r * cols + c;
        const b = a + cols;
        const cc = a + 1;
        const d = b + 1;
        const na = Number.isNaN(values[a]);
        const nb = Number.isNaN(values[b]);
        const nc = Number.isNaN(values[cc]);
        const nd = Number.isNaN(values[d]);
        if (!na && !nb && !nc) { index[n++] = a; index[n++] = b; index[n++] = cc; }
        if (!nc && !nb && !nd) { index[n++] = cc; index[n++] = b; index[n++] = d; }
      }
    }

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new THREE.BufferAttribute(Terrain3D.#gridNormals(model), 3));
    geometry.setAttribute('drapeUv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(new THREE.BufferAttribute(index.subarray(0, n), 1));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();

    const material = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 0.92, metalness: 0 });
    material.onBeforeCompile = (shader) => {
      Object.assign(shader.uniforms, this.uniforms);
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nattribute vec2 drapeUv;\nvarying float vElev;\nvarying vec2 vDrapeUv;\nvarying vec3 vObjNormal;')
        .replace('#include <beginnormal_vertex>', '#include <beginnormal_vertex>\nvObjNormal = objectNormal;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = position.y;\nvDrapeUv = drapeUv;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', `#include <common>
uniform sampler2D uPalette;
uniform sampler2D uDrape;
uniform float uDrapeMix;
uniform sampler2D uDetail;
uniform vec4 uDetailRect;
uniform float uDetailOn;
uniform float uMin;
uniform float uMax;
uniform float uContour;
uniform float uClipMin;
uniform float uClipMax;
uniform float uColorMode;
uniform float uSlopeMax;
varying float vElev;
varying vec2 vDrapeUv;
varying vec3 vObjNormal;

// Flat (blue) through moderate (yellow) to steep (red).
vec3 slopeColour(float t) {
  vec3 c0 = vec3(0.09, 0.22, 0.50);
  vec3 c1 = vec3(0.08, 0.62, 0.62);
  vec3 c2 = vec3(0.96, 0.84, 0.26);
  vec3 c3 = vec3(0.95, 0.45, 0.13);
  vec3 c4 = vec3(0.78, 0.08, 0.10);
  if (t < 0.25) return mix(c0, c1, t / 0.25);
  if (t < 0.5) return mix(c1, c2, (t - 0.25) / 0.25);
  if (t < 0.75) return mix(c2, c3, (t - 0.5) / 0.25);
  return mix(c3, c4, (t - 0.75) / 0.25);
}`)
        .replace('#include <color_fragment>', `#include <color_fragment>
if (vElev < uClipMin || vElev > uClipMax) discard;
float tDepth = clamp((vElev - uMin) / max(uMax - uMin, 1e-6), 0.0, 1.0);
diffuseColor.rgb = texture2D(uPalette, vec2(tDepth, 0.5)).rgb;
if (uColorMode > 0.5) {
  // Object-space normal of the true-scale mesh, so the angle is the real
  // one whatever the vertical exaggeration.
  float slopeDeg = degrees(acos(clamp(abs(normalize(vObjNormal).y), 0.0, 1.0)));
  diffuseColor.rgb = slopeColour(clamp(slopeDeg / uSlopeMax, 0.0, 1.0));
}
if (uDrapeMix > 0.0) {
  vec4 drape = texture2D(uDrape, vDrapeUv);
  if (uDetailOn > 0.5) {
    vec2 d = (vDrapeUv - uDetailRect.xy) / (uDetailRect.zw - uDetailRect.xy);
    if (d.x >= 0.0 && d.y >= 0.0 && d.x <= 1.0 && d.y <= 1.0) {
      vec4 detail = texture2D(uDetail, d);
      drape = vec4(mix(drape.rgb, detail.rgb, detail.a), max(drape.a, detail.a));
    }
  }
  diffuseColor.rgb = mix(diffuseColor.rgb, drape.rgb, drape.a * uDrapeMix);
}
if (uContour > 0.0) {
  float cl = vElev / uContour;
  float w = max(fwidth(cl), 1e-5);
  float minor = 1.0 - min(abs(fract(cl - 0.5) - 0.5) / w, 1.0);
  float cm = cl / 5.0;
  float wm = max(fwidth(cm), 1e-5);
  float major = 1.0 - min(abs(fract(cm - 0.5) - 0.5) / (wm * 1.6), 1.0);
  diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.02, 0.05, 0.09), max(minor * 0.35, major * 0.75));
}`);
    };

    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    // Clipped-away depths must not cast shadows either.
    mesh.customDepthMaterial = new THREE.MeshDepthMaterial({ depthPacking: THREE.RGBADepthPacking });
    mesh.customDepthMaterial.onBeforeCompile = (shader) => {
      shader.uniforms.uClipMin = this.uniforms.uClipMin;
      shader.uniforms.uClipMax = this.uniforms.uClipMax;
      shader.vertexShader = shader.vertexShader
        .replace('#include <common>', '#include <common>\nvarying float vElev;')
        .replace('#include <begin_vertex>', '#include <begin_vertex>\nvElev = position.y;');
      shader.fragmentShader = shader.fragmentShader
        .replace('#include <common>', '#include <common>\nuniform float uClipMin;\nuniform float uClipMax;\nvarying float vElev;')
        .replace('void main() {', 'void main() {\n  if (vElev < uClipMin || vElev > uClipMax) discard;');
    };
    this.mesh = mesh;
    this.scene.add(mesh);

    this.skirt = this.#buildSkirt(positions);
    this.scene.add(this.skirt);

    // Sea surface at 0 m, only meaningful when the data crosses it.
    const sea = new THREE.Mesh(
      new THREE.PlaneGeometry(halfX * 2.2, halfZ * 2.2),
      new THREE.MeshStandardMaterial({ color: 0x3a9fd0, transparent: true, opacity: 0.28, roughness: 0.2, depthWrite: false, side: THREE.DoubleSide })
    );
    sea.rotation.x = -Math.PI / 2;
    sea.visible = this.seaVisible ?? false;
    this.sea = sea;
    this.scene.add(sea);
    this.#applyVerticalScale();

    this.size = Math.max(halfX, halfZ) * 2;
    this.camera.near = this.size / 2000;
    this.camera.far = this.size * 20;
    this.camera.updateProjectionMatrix();
    this.controls.minDistance = Math.min(cellX, cellY) * 3;
    this.controls.maxDistance = this.size * 6;

    this.#updateSun();
    this.cameraPreset('reset', false);
  }

  /** Dark side walls down to a base below the deepest point, so the model reads as a solid block. */
  #buildSkirt(positions) {
    const { cols, rows, values, min, max } = this.model;
    const base = min - Math.max(0.5, (max - min) * 0.06);
    const edges = [
      Array.from({ length: cols }, (_, c) => c),
      Array.from({ length: rows }, (_, r) => r * cols + cols - 1),
      Array.from({ length: cols }, (_, c) => (rows - 1) * cols + (cols - 1 - c)),
      Array.from({ length: rows }, (_, r) => (rows - 1 - r) * cols)
    ];
    const verts = [];
    const colours = [];
    // Each wall quad is top, bottom, top, top, bottom, bottom.
    const TOP = [0.35, 0.47, 0.58, 1];
    const BOTTOM = [0.35, 0.47, 0.58, 0];
    for (const edge of edges) {
      for (let k = 1; k < edge.length; k++) {
        const a = edge[k - 1];
        const b = edge[k];
        if (Number.isNaN(values[a]) || Number.isNaN(values[b])) continue;
        const ax = positions[a * 3], ay = positions[a * 3 + 1], az = positions[a * 3 + 2];
        const bx = positions[b * 3], by = positions[b * 3 + 1], bz = positions[b * 3 + 2];
        verts.push(ax, ay, az, ax, base, az, bx, by, bz, bx, by, bz, ax, base, az, bx, base, bz);
        colours.push(...TOP, ...BOTTOM, ...TOP, ...TOP, ...BOTTOM, ...BOTTOM);
      }
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colours, 4));
    geometry.computeVertexNormals();
    // The walls fade out downwards: at high exaggeration a solid wall down to
    // the deepest point turned into tall dark slabs that hid the view.
    return new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
      vertexColors: true, transparent: true, depthWrite: false, roughness: 1, side: THREE.DoubleSide
    }));
  }

  /**
   * Surface normals straight from the grid's slopes (central differences,
   * one-sided at edges and next to no-data). Exact for a height grid and far
   * cheaper than the generic per-triangle computeVertexNormals, which made
   * opening a 2048-cell view stall for seconds.
   */
  static #gridNormals({ cols, rows, values, cellX, cellY }) {
    const normals = new Float32Array(cols * rows * 3);
    const at = (c, r, fallback) => {
      const v = values[r * cols + c];
      return Number.isNaN(v) ? fallback : v;
    };
    for (let r = 0; r < rows; r++) {
      for (let c = 0; c < cols; c++) {
        const i = r * cols + c;
        const v = values[i];
        let nx = 0;
        let nz = 0;
        if (!Number.isNaN(v)) {
          const c0 = Math.max(0, c - 1);
          const c1 = Math.min(cols - 1, c + 1);
          const r0 = Math.max(0, r - 1);
          const r1 = Math.min(rows - 1, r + 1);
          nx = -(at(c1, r, v) - at(c0, r, v)) / (Math.max(1, c1 - c0) * cellX);
          nz = -(at(c, r1, v) - at(c, r0, v)) / (Math.max(1, r1 - r0) * cellY);
        }
        const len = Math.hypot(nx, 1, nz);
        normals[i * 3] = nx / len;
        normals[i * 3 + 1] = 1 / len;
        normals[i * 3 + 2] = nz / len;
      }
    }
    return normals;
  }

  #disposeTerrain() {
    for (const obj of [this.mesh, this.sea, this.skirt]) {
      if (!obj) continue;
      this.scene.remove(obj);
      obj.geometry.dispose();
      obj.material.dispose();
    }
    this.mesh?.customDepthMaterial?.dispose();
    // A sharper drape belongs to the old grid.
    this.uniforms.uDetail.value?.dispose();
    this.uniforms.uDetail.value = null;
    this.uniforms.uDetailOn.value = 0;
    this.mesh = null;
    this.sea = null;
    this.skirt = null;
    this.setContourLabels([]);
    this.clearProfile();
  }

  // ---------------------------------------------------------------- styling

  setPalette(lut, rampMin, rampMax) {
    const data = new Uint8Array(256 * 4);
    for (let i = 0; i < 256; i++) {
      data[i * 4] = lut[i * 3];
      data[i * 4 + 1] = lut[i * 3 + 1];
      data[i * 4 + 2] = lut[i * 3 + 2];
      data[i * 4 + 3] = 255;
    }
    const texture = new THREE.DataTexture(data, 256, 1, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.needsUpdate = true;
    this.uniforms.uPalette.value?.dispose();
    this.uniforms.uPalette.value = texture;
    this.uniforms.uMin.value = rampMin;
    this.uniforms.uMax.value = rampMax;
  }

  /** 'depth' or 'slope'; [slopeMax] is the angle (degrees) drawn fully red. */
  setColorMode(mode, slopeMax = 20) {
    this.uniforms.uColorMode.value = mode === 'slope' ? 1 : 0;
    this.uniforms.uSlopeMax.value = slopeMax;
  }

  /** True seabed slope in degrees at a grid position, from the surrounding cells. */
  slopeAt(col, row) {
    if (!this.model) return null;
    const { cellX, cellY } = this.model;
    const h = (c, r) => sampleGrid(this.model, c, r);
    const left = h(col - 1, row);
    const right = h(col + 1, row);
    const up = h(col, row - 1);
    const down = h(col, row + 1);
    if ([left, right, up, down].some((v) => v === null)) return null;
    const gx = (right - left) / (2 * cellX);
    const gz = (down - up) / (2 * cellY);
    return (Math.atan(Math.hypot(gx, gz)) * 180) / Math.PI;
  }

  setContourInterval(metres) {
    this.uniforms.uContour.value = metres;
  }

  setExaggeration(value) {
    const ratio = value / this.exaggeration;
    this.exaggeration = value;
    if (!this.mesh) return;
    // Keep the camera looking at the same spot on the terrain.
    const newTargetY = this.controls.target.y * ratio;
    this.camera.position.y += newTargetY - this.controls.target.y;
    this.controls.target.y = newTargetY;
    this.#applyVerticalScale();
    this.#updateSun();
    this.#placeWaypoints();
    this.#placeContourLabels();
    this.#placeBoat();
    if (this.profile) this.#drawProfileLine();
  }

  /** Exaggeration that makes the relief about a fifth of the area's width. */
  autoExaggeration() {
    if (!this.model) return 3;
    const relief = Math.max(0.5, this.model.max - this.model.min);
    return Math.max(1, Math.min(100, (this.size * 0.2) / relief));
  }

  #y(depth) {
    return (depth - this.ref) * this.exaggeration;
  }

  #applyVerticalScale() {
    for (const obj of [this.mesh, this.skirt]) {
      if (!obj) continue;
      obj.scale.y = this.exaggeration;
      obj.position.y = -this.ref * this.exaggeration;
    }
    if (this.sea) this.sea.position.y = this.#y(0);
  }

  /** Hides everything shallower than `shallow` or deeper than `deep` (metres, negative down). */
  setClip(deep, shallow) {
    this.uniforms.uClipMin.value = deep ?? -1e9;
    this.uniforms.uClipMax.value = shallow ?? 1e9;
  }

  /** The largest texture this GPU takes, which caps the drape's size. */
  maxTextureSize() {
    return this.renderer.capabilities.maxTextureSize;
  }

  /** canvas: drape image aligned with the grid, or null for depth colours only. */
  setDrape(canvas, mix) {
    if (canvas !== undefined && canvas !== this.drapeCanvas) {
      this.uniforms.uDrape.value?.dispose();
      this.drapeCanvas = canvas;
      if (canvas) {
        const texture = new THREE.CanvasTexture(canvas);
        texture.colorSpace = THREE.SRGBColorSpace;
        texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
        this.uniforms.uDrape.value = texture;
      } else {
        this.uniforms.uDrape.value = null;
      }
    }
    this.uniforms.uDrapeMix.value = this.uniforms.uDrape.value ? mix : 0;
  }

  /**
   * canvas: a sharper drape covering [rect] of the grid ({ c0, r0, c1, r1 },
   * cell-edge units, as from viewGridRect), drawn over the main one; null
   * clears it.
   */
  setDetailDrape(canvas, rect) {
    this.uniforms.uDetail.value?.dispose();
    this.uniforms.uDetail.value = null;
    this.uniforms.uDetailOn.value = 0;
    if (!canvas || !this.model) return;
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.anisotropy = this.renderer.capabilities.getMaxAnisotropy();
    this.uniforms.uDetail.value = texture;
    // The mesh's drape coordinates run between the first and last cell centres.
    const { cols, rows } = this.model;
    this.uniforms.uDetailRect.value.set(
      (rect.c0 - 0.5) / (cols - 1), 1 - (rect.r1 - 0.5) / (rows - 1),
      (rect.c1 - 0.5) / (cols - 1), 1 - (rect.r0 - 0.5) / (rows - 1)
    );
    this.uniforms.uDetailOn.value = 1;
  }

  /**
   * The part of the grid in view, in cell-edge units { c0, r0, c1, r1 }, or
   * null when the terrain is out of sight. Found where a grid of screen rays
   * meets the level of the orbit centre, kept within a few camera distances
   * of it, so a view towards the horizon doesn't take in the whole survey.
   */
  viewGridRect() {
    if (!this.model) return null;
    const target = this.controls.target;
    const plane = new THREE.Plane(new THREE.Vector3(0, 1, 0), -target.y);
    const ray = new THREE.Raycaster();
    const hit = new THREE.Vector3();
    const reach = this.camera.position.distanceTo(target) * 1.6;
    let minX = Infinity;
    let maxX = -Infinity;
    let minZ = Infinity;
    let maxZ = -Infinity;
    for (let j = 0; j <= 4; j++) {
      for (let i = 0; i <= 4; i++) {
        ray.setFromCamera(new THREE.Vector2(i / 2 - 1, j / 2 - 1), this.camera);
        if (!ray.ray.intersectPlane(plane, hit)) continue;
        const dx = hit.x - target.x;
        const dz = hit.z - target.z;
        const d = Math.hypot(dx, dz);
        if (d > reach) {
          hit.x = target.x + (dx * reach) / d;
          hit.z = target.z + (dz * reach) / d;
        }
        minX = Math.min(minX, hit.x);
        maxX = Math.max(maxX, hit.x);
        minZ = Math.min(minZ, hit.z);
        maxZ = Math.max(maxZ, hit.z);
      }
    }
    if (minX === Infinity) return null;
    const { cols, rows, cellX, cellY } = this.model;
    const c0 = Math.max(0, (minX + this.halfX) / cellX + 0.5);
    const c1 = Math.min(cols, (maxX + this.halfX) / cellX + 0.5);
    const r0 = Math.max(0, (minZ + this.halfZ) / cellY + 0.5);
    const r1 = Math.min(rows, (maxZ + this.halfZ) / cellY + 0.5);
    return c1 - c0 >= 2 && r1 - r0 >= 2 ? { c0, r0, c1, r1 } : null;
  }

  /** points: [{ col, row, level }] from contours.js. */
  setContourLabels(points) {
    for (const label of this.contourLabels) {
      this.scene.remove(label);
      label.element.remove();
    }
    this.contourLabels = points.map((p) => {
      const div = document.createElement('div');
      div.className = 'contour-label';
      div.textContent = p.level <= 0 ? `${Math.round(-p.level * 10) / 10} m` : `+${Math.round(p.level * 10) / 10} m`;
      const label = new CSS2DObject(div);
      label.userData = p;
      this.scene.add(label);
      return label;
    });
    this.#placeContourLabels();
  }

  #placeContourLabels() {
    if (!this.model) return;
    for (const label of this.contourLabels) {
      const { col, row, level } = label.userData;
      label.position.set(col * this.model.cellX - this.halfX, this.#y(level), row * this.model.cellY - this.halfZ);
      const clipped = level < this.uniforms.uClipMin.value || level > this.uniforms.uClipMax.value;
      label.visible = !clipped;
    }
  }

  refreshContourLabelVisibility() {
    this.#placeContourLabels();
  }

  setSun(azimuth, elevation) {
    this.sunAz = azimuth;
    this.sunEl = elevation;
    this.#updateSun();
  }

  setShadows(enabled) {
    this.sun.castShadow = enabled;
  }

  setSeaSurface(visible) {
    this.seaVisible = visible;
    if (this.sea) this.sea.visible = visible;
  }

  setAutoRotate(enabled) {
    this.controls.autoRotate = enabled;
  }

  #updateSun() {
    if (!this.mesh) return;
    const az = THREE.MathUtils.degToRad(this.sunAz);
    const el = THREE.MathUtils.degToRad(this.sunEl);
    const dist = this.size * 1.5;
    // Azimuth is compass bearing: 0 = from north (-z), 90 = from east (+x).
    this.sun.position.set(Math.sin(az) * Math.cos(el) * dist, Math.sin(el) * dist, -Math.cos(az) * Math.cos(el) * dist);
    this.sun.target.position.set(0, 0, 0);
    const cam = this.sun.shadow.camera;
    const half = this.size * 0.75;
    cam.left = -half;
    cam.right = half;
    cam.top = half;
    cam.bottom = -half;
    cam.near = 1;
    cam.far = dist * 3;
    cam.updateProjectionMatrix();
    this.sun.shadow.normalBias = Math.min(this.model.cellX, this.model.cellY) * 0.6;
  }

  // ---------------------------------------------------------------- camera

  /** 'reset' frames the whole area at 45°; '45' / 'low' / 'top' only change the tilt. */
  cameraPreset(kind, animate = true) {
    if (!this.mesh) return;
    const POLAR = { reset: Math.PI / 4, '45': Math.PI / 4, low: THREE.MathUtils.degToRad(72), top: 0.001 };
    const polar = POLAR[kind] ?? Math.PI / 4;
    let target = this.controls.target.clone();
    let distance = this.camera.position.distanceTo(this.controls.target);
    let azimuth = this.controls.getAzimuthalAngle();
    if (kind === 'reset') {
      target = new THREE.Vector3(0, this.#centerHeight(), 0);
      // Fit the whole area in whichever field of view is tighter: on a
      // portrait phone that is the horizontal one, not the vertical.
      const halfFov = Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2));
      distance = (this.size * 0.55) / (halfFov * Math.min(1, this.camera.aspect || 1));
      // At high exaggeration the terrain can be taller than it is wide; back
      // off far enough to take in its full height too.
      const tall = (this.model.max - this.model.min) * this.exaggeration;
      distance = Math.max(distance, (tall * 0.7) / halfFov);
      azimuth = 0;
    }
    if (kind === 'top') azimuth = 0;
    if (!animate) {
      this.controls.target.copy(target);
      this.camera.position.setFromSpherical(new THREE.Spherical(distance, polar, azimuth)).add(target);
      this.camera.lookAt(target);
      return;
    }
    this.#animateTo(target, polar, azimuth, distance);
  }

  /** Rotates to look toward a compass bearing (0 = north) keeping tilt. */
  face(bearingDeg) {
    if (!this.mesh) return;
    // Camera azimuth θ puts the camera at (sinθ, cosθ) in x/z; looking north
    // means sitting south of the target, i.e. θ = 0.
    const azimuth = -THREE.MathUtils.degToRad(bearingDeg);
    const distance = this.camera.position.distanceTo(this.controls.target);
    this.#animateTo(this.controls.target.clone(), this.controls.getPolarAngle(), azimuth, distance);
  }

  #centerHeight() {
    const h = this.#heightAtWorld(0, 0);
    return this.#y(h ?? (this.model.min + this.model.max) / 2);
  }

  #animateTo(target, polar, azimuth, distance, duration = 700) {
    const startTarget = this.controls.target.clone();
    const startOffset = this.camera.position.clone().sub(startTarget);
    const start = new THREE.Spherical().setFromVector3(startOffset);
    const end = new THREE.Spherical(distance, polar, azimuth);
    // Take the short way round.
    let dTheta = end.theta - start.theta;
    dTheta = Math.atan2(Math.sin(dTheta), Math.cos(dTheta));
    const t0 = performance.now();
    this.animation = (now) => {
      const k = Math.min(1, (now - t0) / duration);
      const e = k < 0.5 ? 2 * k * k : 1 - (-2 * k + 2) ** 2 / 2;
      const s = new THREE.Spherical(
        start.radius + (end.radius - start.radius) * e,
        start.phi + (end.phi - start.phi) * e,
        start.theta + dTheta * e
      );
      this.controls.target.lerpVectors(startTarget, target, e);
      this.camera.position.setFromSpherical(s).add(this.controls.target);
      this.camera.lookAt(this.controls.target);
      if (k >= 1) this.animation = null;
    };
  }

  focusOn(point, closer = true) {
    const distance = this.camera.position.distanceTo(this.controls.target) * (closer ? 0.45 : 1);
    this.#animateTo(point, Math.min(this.controls.getPolarAngle(), Math.PI / 3), this.controls.getAzimuthalAngle(), Math.max(distance, this.controls.minDistance * 4));
  }

  /** Centres the view on a grid position (col,row). */
  focusGrid(col, row) {
    const p = this.#gridToWorld(col, row);
    if (p) this.focusOn(p, false);
  }

  // ---------------------------------------------------------------- picking

  #worldToGrid(x, z) {
    return { col: (x + this.halfX) / this.model.cellX, row: (z + this.halfZ) / this.model.cellY };
  }

  #gridToWorld(col, row) {
    const h = sampleGrid(this.model, col, row);
    if (h === null) return null;
    return new THREE.Vector3(col * this.model.cellX - this.halfX, this.#y(h), row * this.model.cellY - this.halfZ);
  }

  /** Depth at a world position, or null where there is no data or it is clipped away. */
  #heightAtWorld(x, z) {
    const g = this.#worldToGrid(x, z);
    const h = sampleGrid(this.model, g.col, g.row);
    if (h === null || h < this.uniforms.uClipMin.value || h > this.uniforms.uClipMax.value) return null;
    return h;
  }

  /** Ray-marches the heightfield; far cheaper than raycasting millions of triangles. */
  pick(clientX, clientY) {
    if (!this.mesh) return null;
    const rect = this.renderer.domElement.getBoundingClientRect();
    const ndc = new THREE.Vector2(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
    const ray = new THREE.Raycaster();
    ray.setFromCamera(ndc, this.camera);
    const { origin, direction } = ray.ray;

    const box = new THREE.Box3(
      new THREE.Vector3(-this.halfX, this.#y(this.model.min) - 1, -this.halfZ),
      new THREE.Vector3(this.halfX, this.#y(this.model.max) + 1, this.halfZ)
    );
    const entry = ray.ray.intersectBox(box, new THREE.Vector3());
    if (!entry) return null;
    let t = box.containsPoint(origin) ? 0 : origin.distanceTo(entry);
    // Exit distance: march until we leave the box.
    const far = t + box.getSize(new THREE.Vector3()).length() * 1.01;
    const horizontal = Math.hypot(direction.x, direction.z) || 1e-6;
    const cell = Math.min(this.model.cellX, this.model.cellY);
    let step = (cell * 0.5) / horizontal;
    step = Math.max(step, (far - t) / 6000);

    const p = new THREE.Vector3();
    let prevT = t;
    for (; t <= far; t += step) {
      p.copy(direction).multiplyScalar(t).add(origin);
      const h = this.#heightAtWorld(p.x, p.z);
      if (h !== null && p.y <= this.#y(h)) {
        // Refine between the last point above and this one below.
        let lo = prevT;
        let hi = t;
        for (let i = 0; i < 16; i++) {
          const mid = (lo + hi) / 2;
          p.copy(direction).multiplyScalar(mid).add(origin);
          const hm = this.#heightAtWorld(p.x, p.z);
          if (hm !== null && p.y <= this.#y(hm)) hi = mid;
          else lo = mid;
        }
        p.copy(direction).multiplyScalar(hi).add(origin);
        const g = this.#worldToGrid(p.x, p.z);
        const depth = sampleGrid(this.model, g.col, g.row);
        if (depth === null) return null;
        return { world: p.clone(), col: g.col, row: g.row, depth };
      }
      prevT = t;
    }
    return null;
  }

  #bindEvents() {
    const el = this.renderer.domElement;
    el.addEventListener('pointermove', (e) => {
      this.pendingHover = { x: e.clientX, y: e.clientY };
      if (this.callbacks.onHover) this.requestRender();
      if (this.profileDrag) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) {
          this.profile = { start: this.profileDrag.start, end: hit };
          this.#drawProfileLine();
          this.requestRender();
        }
      }
    });
    el.addEventListener('pointerleave', () => this.callbacks.onHover?.(null));
    el.addEventListener('dblclick', (e) => {
      const hit = this.pick(e.clientX, e.clientY);
      if (hit) this.focusOn(hit.world);
    });
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      this.downAt = { x: e.clientX, y: e.clientY };
      if (e.altKey) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) {
          this.controls.enabled = false;
          this.profileDrag = { start: hit };
          el.setPointerCapture(e.pointerId);
        }
      }
    }, { capture: true });
    el.addEventListener('pointerup', (e) => {
      if (this.profileDrag) {
        this.profileDrag = null;
        this.controls.enabled = true;
        if (this.profile) this.callbacks.onProfile?.(this.#profileSamples());
        return;
      }
      const slop = e.pointerType === 'touch' ? 16 : 4;
      const moved = this.downAt && Math.hypot(e.clientX - this.downAt.x, e.clientY - this.downAt.y) > slop;
      if (e.button === 0 && e.shiftKey && !moved) {
        const hit = this.pick(e.clientX, e.clientY);
        if (hit) this.callbacks.onPick?.(hit);
      }
    });
    this.controls.addEventListener('start', () => { this.animation = null; });
  }

  // ---------------------------------------------------------------- profile

  #profileSamples(count = 400) {
    const { start, end } = this.profile;
    const samples = [];
    const lengthM = Math.hypot((end.col - start.col) * this.model.cellX, (end.row - start.row) * this.model.cellY);
    for (let i = 0; i <= count; i++) {
      const k = i / count;
      const col = start.col + (end.col - start.col) * k;
      const row = start.row + (end.row - start.row) * k;
      samples.push({ distance: lengthM * k, depth: sampleGrid(this.model, col, row), col, row });
    }
    return { samples, lengthM, start, end };
  }

  #drawProfileLine() {
    if (this.profileLine) {
      this.scene.remove(this.profileLine);
      this.profileLine.geometry.dispose();
    }
    const { samples } = this.#profileSamples(200);
    const lift = this.size * 0.002;
    const pts = samples.filter((s) => s.depth !== null).map((s) =>
      new THREE.Vector3(s.col * this.model.cellX - this.halfX, this.#y(s.depth) + lift, s.row * this.model.cellY - this.halfZ));
    if (pts.length < 2) return;
    this.profileLine = new THREE.Line(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.LineBasicMaterial({ color: 0xffd23f, depthTest: false })
    );
    this.profileLine.renderOrder = 10;
    this.scene.add(this.profileLine);
  }

  clearProfile() {
    this.profile = null;
    if (this.profileLine) {
      this.scene.remove(this.profileLine);
      this.profileLine.geometry.dispose();
      this.profileLine = null;
    }
  }

  // ---------------------------------------------------------------- waypoints

  /**
   * items: [{ id, name, color, col, row }] already converted to grid space.
   * Each is a flag pin drawn on screen (dot on the seabed, stem, name), so it
   * stays the same size at any zoom -- pins built in the 3D scene grew into
   * huge blobs up close and their names drifted off screen.
   */
  setWaypoints(items, visible = true) {
    for (const { label } of this.waypointObjects) {
      this.scene.remove(label);
      label.element.remove();
    }
    this.waypointObjects = [];
    if (!this.mesh || !visible) return;
    for (const item of items) {
      if (sampleGrid(this.model, item.col, item.row) === null) continue;
      const pin = document.createElement('div');
      pin.className = 'wpt-pin';
      pin.style.setProperty('--c', item.color);
      pin.innerHTML = '<div class="wpt-flag"><span class="wpt-name"></span><span class="wpt-stem"></span><span class="wpt-dot"></span></div>';
      pin.querySelector('.wpt-name').textContent = item.name;
      pin.firstChild.addEventListener('click', () => this.callbacks.onWaypointClick?.(item.id));
      const label = new CSS2DObject(pin);
      this.scene.add(label);
      this.waypointObjects.push({ item, label });
    }
    this.#placeWaypoints();
  }

  #placeWaypoints() {
    for (const { item, label } of this.waypointObjects) {
      const base = this.#gridToWorld(item.col, item.row);
      if (base) label.position.copy(base);
    }
  }

  // ---------------------------------------------------------------- boat

  /**
   * Live position marker at sea level (0 m): an arrow along the course, a
   * ring so it can be found from far out, and a line down to the seabed.
   * fix: { col, row, heading (degrees true or null), label } or null to hide.
   */
  setBoat(fix) {
    if (!fix || !this.model) {
      if (this.boat) this.boat.group.visible = false;
      return;
    }
    if (!this.boat) {
      const group = new THREE.Group();
      const shape = new THREE.Shape();
      // Tip at +y: after the -90 degree tilt below, +y becomes north (-z).
      shape.moveTo(0, 1);
      shape.lineTo(0.55, -0.7);
      shape.lineTo(0, -0.35);
      shape.lineTo(-0.55, -0.7);
      shape.closePath();
      const hull = new THREE.Mesh(
        new THREE.ExtrudeGeometry(shape, { depth: 0.25, bevelEnabled: false }),
        new THREE.MeshBasicMaterial({ color: 0xff8a00 })
      );
      // Lie flat on the water, pointing north (-z) before the heading turn.
      hull.rotation.x = -Math.PI / 2;
      const ring = new THREE.Mesh(
        new THREE.RingGeometry(1.5, 1.8, 48),
        new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.8, side: THREE.DoubleSide, depthTest: false })
      );
      ring.rotation.x = -Math.PI / 2;
      ring.renderOrder = 5;
      const marker = new THREE.Group();
      marker.add(hull, ring);
      const drop = new THREE.Line(
        new THREE.BufferGeometry(),
        new THREE.LineDashedMaterial({ color: 0xffd23f, dashSize: 1, gapSize: 1 })
      );
      const div = document.createElement('div');
      div.className = 'label-3d boat-label';
      const label = new CSS2DObject(div);
      group.add(marker, drop, label);
      this.scene.add(group);
      this.boat = { group, marker, drop, label, div, fix: null };
    }
    this.boat.fix = fix;
    this.boat.group.visible = true;
    this.boat.div.textContent = fix.label;
    this.#placeBoat();
    if (this.followBoat) this.#followToBoat();
  }

  setFollowBoat(enabled) {
    this.followBoat = enabled;
    if (enabled) this.#followToBoat();
  }

  #placeBoat() {
    const boat = this.boat;
    if (!boat?.fix || !this.model) return;
    const { col, row, heading } = boat.fix;
    const x = col * this.model.cellX - this.halfX;
    const z = row * this.model.cellY - this.halfZ;
    const seaY = this.#boatY();
    const scale = this.size * 0.012;
    boat.marker.position.set(x, seaY, z);
    boat.marker.scale.setScalar(scale);
    boat.marker.children[0].visible = heading !== null && heading !== undefined;
    boat.marker.rotation.y = heading === null || heading === undefined ? 0 : -THREE.MathUtils.degToRad(heading);
    const floor = sampleGrid(this.model, col, row);
    const bottom = floor === null ? seaY : this.#y(floor);
    boat.drop.geometry.setFromPoints([new THREE.Vector3(x, seaY, z), new THREE.Vector3(x, bottom, z)]);
    boat.drop.computeLineDistances();
    boat.drop.material.dashSize = boat.drop.material.gapSize = Math.max(1, Math.abs(seaY - bottom) / 40);
    boat.label.position.set(x, seaY + scale * 2.5, z);
  }

  /**
   * Height the boat is drawn at: sea level (0 m), unless that is far above
   * the terrain -- deep water at high exaggeration puts it kilometres up and
   * off-screen -- in which case it rides a fixed distance above the
   * shallowest seabed in view. Its label always gives the true depth below.
   */
  #boatY() {
    return Math.min(this.#y(0), this.#y(this.model.max) + this.size * 0.04);
  }

  /** Recentres on the boat, keeping the current angle and distance. */
  #followToBoat() {
    const fix = this.boat?.fix;
    if (!fix || !this.model) return;
    const target = new THREE.Vector3(
      fix.col * this.model.cellX - this.halfX,
      this.#boatY(),
      fix.row * this.model.cellY - this.halfZ
    );
    const delta = target.clone().sub(this.controls.target);
    this.controls.target.add(delta);
    this.camera.position.add(delta);
  }

  // ---------------------------------------------------------------- loop

  /**
   * Starts drawing. Safe to call repeatedly: there is only ever one loop
   * (calling it on every reload used to stack a new 60 fps loop each time).
   */
  activate() {
    this.active = true;
    this.#resize();
    this.requestRender();
  }

  deactivate() {
    this.active = false;
  }

  /** Asks for one more frame; the loop runs only while there is something to draw. */
  requestRender() {
    this.needsRender = true;
    if (!this.active || this.loopRunning) return;
    this.loopRunning = true;
    requestAnimationFrame(this.#loop);
  }

  #loop = (now) => {
    if (!this.active) {
      this.loopRunning = false;
      return;
    }
    if (this.animation) {
      this.animation(now);
      this.needsRender = true;
    }
    // True while damping is still gliding the camera, and while auto-rotating.
    if (this.controls.update()) this.needsRender = true;
    if (this.pendingHover && this.callbacks.onHover) {
      const { x, y } = this.pendingHover;
      this.pendingHover = null;
      this.callbacks.onHover(this.pick(x, y));
    }
    // 60 fps is plenty for a chart; on 120 Hz screens drawing every refresh
    // doubled the GPU work for no visible gain.
    if (this.needsRender && now - this.lastRenderAt >= MIN_FRAME_MS) {
      this.needsRender = false;
      this.lastRenderAt = now;
      this.renderCount++;
      this.renderer.render(this.scene, this.camera);
      this.labelRenderer.render(this.scene, this.camera);
      this.compass.style.transform = `rotate(${THREE.MathUtils.radToDeg(this.controls.getAzimuthalAngle())}deg)`;
    }
    if (this.needsRender || this.animation || this.controls.autoRotate) {
      requestAnimationFrame(this.#loop);
    } else {
      this.loopRunning = false;
    }
  };

  /** Next frame redraws the shadow map too (terrain, sun or scale changed). */
  #invalidateShadows() {
    this.renderer.shadowMap.needsUpdate = true;
  }

  /**
   * Every public method that changes what is on screen asks for a frame, and
   * those that change shadow casters or the light also refresh the shadow
   * map -- done here once rather than at the end of each method.
   */
  #wrapForRendering() {
    const shadowChanging = new Set(['setModel', 'setExaggeration', 'setSun', 'setShadows', 'setClip']);
    const redrawing = ['setModel', 'setPalette', 'setContourInterval', 'setExaggeration', 'setSun', 'setShadows',
      'setSeaSurface', 'setAutoRotate', 'setClip', 'setDrape', 'setDetailDrape', 'setContourLabels', 'refreshContourLabelVisibility',
      'setColorMode', 'setWaypoints', 'setBoat', 'setFollowBoat', 'cameraPreset', 'face', 'focusOn', 'focusGrid',
      'setProfile', 'clearProfile'];
    for (const name of redrawing) {
      const original = this[name];
      if (typeof original !== 'function') continue;
      this[name] = (...args) => {
        const result = original.apply(this, args);
        if (shadowChanging.has(name)) this.#invalidateShadows();
        this.requestRender();
        return result;
      };
    }
  }

  #resize() {
    const { clientWidth: w, clientHeight: h } = this.container;
    if (!w || !h) return;
    this.renderer.setSize(w, h);
    this.labelRenderer.setSize(w, h);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  screenshot() {
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.render(this.scene, this.camera);
    return this.renderer.domElement.toDataURL('image/png');
  }
}
