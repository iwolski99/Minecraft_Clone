// Held-item view-model QA.
//
//   node scripts/qa.mjs viewmodel
//
// Browsers cannot launch here, so this command does three things without a GPU:
//
//   1. it builds the *real* extruded-sprite geometry for every item in the game
//      and audits it: the slab must have real depth on all three axes (it used
//      to be a flat quad), every vertex UV must land on a painted atlas texel of
//      that item's own sprite, the front face must be brighter than the side and
//      back faces, and nothing may be degenerate, non-finite or out of range,
//   2. it rasterises the real view-model scene - the real pose, the real swing
//      curve, the real atlas and the real fragment maths - into
//      `.qa/view-held-items.png`, `.qa/view-held-swing.png` and
//      `.qa/view-held-cave.png`, and checks from those pixels that the item
//      actually lands low and right of frame and that its side faces are
//      visible (a flat quad has no side faces at all),
//   3. it draws the *real* hotbar icon for every item through src/ui/icons.ts
//      against a small canvas shim and asserts each one is painted, so the
//      higher-quality sprites provably reach the HUD as well.
//
// It also dumps `.qa/sheet-items.png`, a 6x contact sheet of every item sprite,
// which is the artefact to actually look at when judging the pixel art.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './compile.mjs';
import { writePng, makeCanvas } from './png.mjs';

const OUT = path.join(ROOT, '.qa');
fs.mkdirSync(OUT, { recursive: true });

/* ================================================================== */
/* Minimal canvas 2D + DOM shim (only what src/ui/icons.ts touches)    */
/* ================================================================== */

function parseColor(css) {
  if (typeof css !== 'string') return null;
  const s = css.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return [r, g, b, 1];
  }
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 1];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const p = m[1].split(',').map((v) => Number(v.trim()));
    return [p[0], p[1], p[2], p.length > 3 ? p[3] : 1];
  }
  return null;
}

function blend(dst, o, r, g, b, a) {
  if (a <= 0) return;
  const da = dst[o + 3] / 255;
  const oa = a + da * (1 - a);
  if (oa <= 0) {
    dst[o] = dst[o + 1] = dst[o + 2] = dst[o + 3] = 0;
    return;
  }
  dst[o] = (r * a + dst[o] * da * (1 - a)) / oa;
  dst[o + 1] = (g * a + dst[o + 1] * da * (1 - a)) / oa;
  dst[o + 2] = (b * a + dst[o + 2] * da * (1 - a)) / oa;
  dst[o + 3] = oa * 255;
}

function pointInPoly(poly, x, y) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

class Ctx2D {
  constructor(canvas) {
    this.canvas = canvas;
    this.fillStyle = '#000';
    this.strokeStyle = '#000';
    this.imageSmoothingEnabled = false;
    this.globalAlpha = 1;
    this.globalCompositeOperation = 'source-over';
    this.t = [1, 0, 0, 1, 0, 0];
    this.stack = [];
    this.path = [];
    this.clipPoly = null;
  }
  save() {
    this.stack.push({ t: this.t.slice(), clip: this.clipPoly, fill: this.fillStyle });
  }
  restore() {
    const s = this.stack.pop();
    if (!s) return;
    this.t = s.t;
    this.clipPoly = s.clip;
    this.fillStyle = s.fill;
  }
  setTransform(a, b, c, d, e, f) {
    this.t = [a, b, c, d, e, f];
  }
  resetTransform() {
    this.t = [1, 0, 0, 1, 0, 0];
  }
  translate(x, y) {
    this.t[4] += this.t[0] * x + this.t[2] * y;
    this.t[5] += this.t[1] * x + this.t[3] * y;
  }
  scale(x, y) {
    this.t[0] *= x;
    this.t[1] *= x;
    this.t[2] *= y;
    this.t[3] *= y;
  }
  rotate() {
    /* the icon path never rotates */
  }
  beginPath() {
    this.path = [];
  }
  closePath() {}
  moveTo(x, y) {
    this.path.push(this.#dev(x, y));
  }
  lineTo(x, y) {
    this.path.push(this.#dev(x, y));
  }
  rect(x, y, w, h) {
    this.path = [this.#dev(x, y), this.#dev(x + w, y), this.#dev(x + w, y + h), this.#dev(x, y + h)];
  }
  arc() {}
  setLineDash() {}
  stroke() {}
  clip() {
    this.clipPoly = this.path.slice();
  }
  #dev(x, y) {
    const [a, b, c, d, e, f] = this.t;
    return [a * x + c * y + e, b * x + d * y + f];
  }
  #inside(px, py) {
    if (this.clipPoly && !pointInPoly(this.clipPoly, px, py)) return false;
    return true;
  }
  clearRect(x, y, w, h) {
    const buf = this.canvas._buf;
    const W = this.canvas._w;
    const H = this.canvas._h;
    for (let py = Math.max(0, y | 0); py < Math.min(H, (y + h) | 0); py++) {
      for (let px = Math.max(0, x | 0); px < Math.min(W, (x + w) | 0); px++) {
        const o = (py * W + px) * 4;
        buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0;
      }
    }
  }
  fillRect(x, y, w, h) {
    const col = parseColor(this.fillStyle);
    if (!col) return;
    const buf = this.canvas._buf;
    for (let py = Math.max(0, y | 0); py < Math.min(this.canvas._h, (y + h) | 0); py++) {
      for (let px = Math.max(0, x | 0); px < Math.min(this.canvas._w, (x + w) | 0); px++) {
        blend(buf, (py * this.canvas._w + px) * 4, col[0], col[1], col[2], col[3] * this.globalAlpha);
      }
    }
  }
  /** Fill the current path (the shading overlay drawBlockIcon paints over a face). */
  fill() {
    const col = parseColor(this.fillStyle);
    if (!col || this.path.length < 3) return;
    const xs = this.path.map((p) => p[0]);
    const ys = this.path.map((p) => p[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(this.canvas._w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(this.canvas._h - 1, Math.ceil(Math.max(...ys)));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        if (!pointInPoly(this.path, px + 0.5, py + 0.5)) continue;
        blend(this.canvas._buf, (py * this.canvas._w + px) * 4, col[0], col[1], col[2], col[3] * this.globalAlpha);
      }
    }
  }
  fillText() {}
  strokeRect() {}
  strokeText() {}
  measureText(t) {
    return { width: String(t).length * 6 };
  }
  createLinearGradient() {
    return { addColorStop() {} };
  }
  createRadialGradient() {
    return { addColorStop() {} };
  }
  createPattern() {
    return null;
  }
  createImageData(w, h) {
    return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h };
  }
  putImageData(img, dx, dy) {
    const buf = this.canvas._buf;
    const W = this.canvas._w;
    const H = this.canvas._h;
    for (let y = 0; y < img.height; y++) {
      for (let x = 0; x < img.width; x++) {
        const px = dx + x;
        const py = dy + y;
        if (px < 0 || py < 0 || px >= W || py >= H) continue;
        const s = (y * img.width + x) * 4;
        const o = (py * W + px) * 4;
        buf[o] = img.data[s];
        buf[o + 1] = img.data[s + 1];
        buf[o + 2] = img.data[s + 2];
        buf[o + 3] = img.data[s + 3];
      }
    }
  }
  getImageData(x, y, w, h) {
    const out = this.createImageData(w, h);
    for (let py = 0; py < h; py++) {
      for (let px = 0; px < w; px++) {
        const s = ((y + py) * this.canvas._w + (x + px)) * 4;
        const o = (py * w + px) * 4;
        out.data[o] = this.canvas._buf[s];
        out.data[o + 1] = this.canvas._buf[s + 1];
        out.data[o + 2] = this.canvas._buf[s + 2];
        out.data[o + 3] = this.canvas._buf[s + 3];
      }
    }
    return out;
  }
  /**
   * Nearest-neighbour blit through the current affine transform, which is what
   * `drawBlockIcon` relies on to project a 16x16 tile onto an isometric face.
   */
  drawImage(src, ...a) {
    const px = src && src.__isCanvas ? { data: src._buf, w: src._w, h: src._h } : src && src.data ? { data: src.data, w: src.width, h: src.height } : null;
    if (!px) return;
    let sx = 0;
    let sy = 0;
    let sw = px.w;
    let sh = px.h;
    let dx = 0;
    let dy = 0;
    let dw = sw;
    let dh = sh;
    if (a.length === 2) {
      dx = a[0];
      dy = a[1];
    } else if (a.length === 4) {
      dx = a[0];
      dy = a[1];
      dw = a[2];
      dh = a[3];
    } else if (a.length === 8) {
      sx = a[0];
      sy = a[1];
      sw = a[2];
      sh = a[3];
      dx = a[4];
      dy = a[5];
      dw = a[6];
      dh = a[7];
    } else {
      return;
    }
    if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;

    const [ta, tb, tc, td, te, tf] = this.t;
    const det = ta * td - tb * tc;
    if (Math.abs(det) < 1e-12) return;
    const corners = [[dx, dy], [dx + dw, dy], [dx + dw, dy + dh], [dx, dy + dh]].map(([x, y]) => this.#dev(x, y));
    const xs = corners.map((c) => c[0]);
    const ys = corners.map((c) => c[1]);
    const x0 = Math.max(0, Math.floor(Math.min(...xs)));
    const x1 = Math.min(this.canvas._w - 1, Math.ceil(Math.max(...xs)));
    const y0 = Math.max(0, Math.floor(Math.min(...ys)));
    const y1 = Math.min(this.canvas._h - 1, Math.ceil(Math.max(...ys)));

    for (let py = y0; py <= y1; py++) {
      for (let pxi = x0; pxi <= x1; pxi++) {
        const cx = pxi + 0.5;
        const cy = py + 0.5;
        if (!this.#inside(cx, cy)) continue;
        // device -> user space
        const ux = (td * (cx - te) - tc * (cy - tf)) / det;
        const uy = (-tb * (cx - te) + ta * (cy - tf)) / det;
        if (ux < dx || uy < dy || ux >= dx + dw || uy >= dy + dh) continue;
        const sxi = Math.min(px.w - 1, sx + Math.floor(((ux - dx) / dw) * sw));
        const syi = Math.min(px.h - 1, sy + Math.floor(((uy - dy) / dh) * sh));
        const s = (syi * px.w + sxi) * 4;
        blend(this.canvas._buf, (py * this.canvas._w + pxi) * 4, px.data[s], px.data[s + 1], px.data[s + 2], (px.data[s + 3] / 255) * this.globalAlpha);
      }
    }
  }
}

class ShimCanvas {
  constructor() {
    this.__isCanvas = true;
    this.className = '';
    this.style = {};
    this._w = 0;
    this._h = 0;
    this._buf = new Uint8ClampedArray(0);
    this._ctx2 = null;
  }
  get width() {
    return this._w;
  }
  set width(v) {
    this._w = Math.max(0, v | 0);
    this._buf = new Uint8ClampedArray(this._w * this._h * 4);
  }
  get height() {
    return this._h;
  }
  set height(v) {
    this._h = Math.max(0, v | 0);
    this._buf = new Uint8ClampedArray(this._w * this._h * 4);
  }
  getContext(kind) {
    if (kind !== '2d') return null;
    if (!this._ctx2) this._ctx2 = new Ctx2D(this);
    return this._ctx2;
  }
  addEventListener() {}
  removeEventListener() {}
  appendChild() {}
  toDataURL() {
    return 'data:,';
  }
}

/** Count pixels the icon actually painted (alpha > 0). */
function paintedPixels(canvas) {
  const buf = canvas._buf;
  let n = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) n++;
  return n;
}

/** True when the magenta "no painter for this item" marker is on screen. */
function hasMissingMarker(canvas) {
  const buf = canvas._buf;
  for (let i = 0; i < buf.length; i += 4) {
    if (buf[i] > 170 && buf[i + 1] < 90 && buf[i + 2] > 170) return true;
  }
  return false;
}

function installDom() {
  const g = globalThis;
  g.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  if (!g.document) {
    const root = { children: [], appendChild() {}, addEventListener() {} };
    g.document = {
      createElement: (tag) => (String(tag).toLowerCase() === 'canvas' ? new ShimCanvas() : { style: {}, appendChild() {}, addEventListener() {} }),
      createElementNS: () => new ShimCanvas(),
      getElementById: () => null,
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
      body: root,
      documentElement: root,
    };
  }
  if (!g.window) g.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener() {}, removeEventListener() {} };
  if (!g.navigator) Object.defineProperty(g, 'navigator', { value: { userAgent: 'node-qa' }, configurable: true });
}

/* ================================================================== */
/* Software rasteriser for the view-model scene                        */
/* ================================================================== */

/**
 * Rasterise `viewModel.scene` with the view-model camera.
 *
 * This mirrors VIEW_FRAG exactly: texture2D -> alpha test -> texel rgb times
 * `aColor` times `uLight`. The atlas is sampled in canvas order
 * (`row = (1 - v) * height`), which is what the flipped GPU upload makes the
 * shader resolve to, and the same convention `Atlas.uvSlot()` authors against.
 */
function rasteriseScene(THREE, atlasOf, viewModel, W, H, light, bg) {
  const pixels = makeCanvas(W, H, bg);
  const depth = new Float32Array(W * H).fill(Infinity);
  const camera = viewModel.camera;
  const vp = new THREE.Matrix4().multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
  const mvp = new THREE.Matrix4();

  let tris = 0;
  viewModel.scene.traverse((o) => {
    if (!o.isMesh || !o.geometry) return;
    const map = o.material.uniforms.uMap.value;
    const atlas = atlasOf(map);
    const alphaTest = o.material.uniforms.uAlphaTest.value;
    const geo = o.geometry;
    const pos = geo.getAttribute('position');
    const uv = geo.getAttribute('uv');
    const col = geo.getAttribute('aColor');
    const idx = geo.getIndex();
    mvp.multiplyMatrices(vp, o.matrixWorld);
    const n = idx ? idx.count : pos.count;
    for (let i = 0; i < n; i += 3) {
      const vi = [0, 1, 2].map((k) => (idx ? idx.getX(i + k) : i + k));
      const sx = [];
      const sy = [];
      const sz = [];
      const uu = [];
      const vv = [];
      const cr = [];
      const cg = [];
      const cb = [];
      let behind = false;
      for (let k = 0; k < 3; k++) {
        const j = vi[k];
        const v = new THREE.Vector4(pos.getX(j), pos.getY(j), pos.getZ(j), 1).applyMatrix4(mvp);
        if (v.w <= 0.001) behind = true;
        const nx = v.x / v.w;
        const ny = v.y / v.w;
        sx.push((nx * 0.5 + 0.5) * W);
        sy.push((1 - (ny * 0.5 + 0.5)) * H);
        sz.push(v.w);
        uu.push(uv.getX(j));
        vv.push(uv.getY(j));
        cr.push(col.getX(j));
        cg.push(col.getY(j));
        cb.push(col.getZ(j));
      }
      if (behind) continue;
      const area = (sx[1] - sx[0]) * (sy[2] - sy[0]) - (sx[2] - sx[0]) * (sy[1] - sy[0]);
      if (Math.abs(area) < 1e-9) continue;
      tris++;
      const minX = Math.max(0, Math.floor(Math.min(...sx)));
      const maxX = Math.min(W - 1, Math.ceil(Math.max(...sx)));
      const minY = Math.max(0, Math.floor(Math.min(...sy)));
      const maxY = Math.min(H - 1, Math.ceil(Math.max(...sy)));
      const inv = 1 / area;
      for (let py = minY; py <= maxY; py++) {
        const fy = py + 0.5;
        for (let pxi = minX; pxi <= maxX; pxi++) {
          const fx = pxi + 0.5;
          let w0 = ((sx[1] - fx) * (sy[2] - fy) - (sx[2] - fx) * (sy[1] - fy)) * inv;
          let w1 = ((sx[2] - fx) * (sy[0] - fy) - (sx[0] - fx) * (sy[2] - fy)) * inv;
          let w2 = 1 - w0 - w1;
          if (w0 < -1e-6 || w1 < -1e-6 || w2 < -1e-6) continue;
          w0 = Math.max(0, w0);
          w1 = Math.max(0, w1);
          w2 = Math.max(0, w2);
          const iw = w0 / sz[0] + w1 / sz[1] + w2 / sz[2];
          const z = 1 / iw;
          const o = py * W + pxi;
          if (z >= depth[o]) continue;
          const bu = (w0 * (uu[0] / sz[0]) + w1 * (uu[1] / sz[1]) + w2 * (uu[2] / sz[2])) / iw;
          const bv = (w0 * (vv[0] / sz[0]) + w1 * (vv[1] / sz[1]) + w2 * (vv[2] / sz[2])) / iw;
          const br = (w0 * (cr[0] / sz[0]) + w1 * (cr[1] / sz[1]) + w2 * (cr[2] / sz[2])) / iw;
          const bgc = (w0 * (cg[0] / sz[0]) + w1 * (cg[1] / sz[1]) + w2 * (cg[2] / sz[2])) / iw;
          const bb = (w0 * (cb[0] / sz[0]) + w1 * (cb[1] / sz[1]) + w2 * (cb[2] / sz[2])) / iw;
          const tx = Math.max(0, Math.min(atlas.width - 1, Math.floor(bu * atlas.width)));
          const ty = Math.max(0, Math.min(atlas.height - 1, Math.floor((1 - bv) * atlas.height)));
          const to = (ty * atlas.width + tx) * 4;
          const ta = atlas.data[to + 3] / 255;
          if (ta < alphaTest) continue;
          const po = o * 4;
          pixels[po] = (atlas.data[to] / 255) * br * light[0] * 255;
          pixels[po + 1] = (atlas.data[to + 1] / 255) * bgc * light[1] * 255;
          pixels[po + 2] = (atlas.data[to + 2] / 255) * bb * light[2] * 255;
          pixels[po + 3] = 255;
          depth[o] = z;
        }
      }
    }
  });
  return { pixels, tris };
}

/* ================================================================== */
/* Tiny check runner                                                   */
/* ================================================================== */

const results = [];
const section = (t) => results.push({ section: t });
const check = (name, pass, detail = '') => {
  results.push({ name, pass: !!pass, detail: detail ? String(detail) : '' });
  return !!pass;
};

/* ================================================================== */
/* Main                                                                */
/* ================================================================== */

export async function run(load) {
  installDom();
  const THREE = await import('three');

  const { buildBlockAtlas, buildItemAtlas } = await load('render/atlas.js');
  const { paintItem, itemNames, itemPainter, ITEM_TILE } = await load('render/itemTextures.js');
  const { allItems, blockIdOf } = await load('items/items.js');
  const { buildItemViewGeometry, ViewModel, ITEM_FACE_SHADE, swingCurve } = await load('render/viewmodel.js');
  const { createAtlasTexture } = await load('render/materials.js');
  const { makeIcon } = await load('ui/icons.js');

  const blockAtlas = buildBlockAtlas();
  const itemAtlas = buildItemAtlas();
  const blockTexture = createAtlasTexture(blockAtlas);
  const itemTexture = createAtlasTexture(itemAtlas);
  const atlasByTexture = new Map([
    [blockTexture, blockAtlas],
    [itemTexture, itemAtlas],
  ]);
  const atlasOf = (tex) => atlasByTexture.get(tex) ?? blockAtlas;

  const sprites = [...itemNames()].sort();
  const registry = [...allItems()];
  const spriteItems = registry.filter((d) => d.blockId === 0);
  const blockItems = registry.filter((d) => d.blockId > 0);

  /* ---------------------------------------------------------------- */
  section('item art (16x16, painted, finished)');
  {
    const sizes = new Set();
    const blank = [];
    const magenta = [];
    const unpainted = [];
    let minCoverage = 1e9;
    let maxCoverage = 0;
    for (const name of sprites) {
      const buf = paintItem(name);
      sizes.add(`${buf.w}x${buf.h}`);
      let opaque = 0;
      let isMagenta = true;
      for (let i = 0; i < buf.w * buf.h; i++) {
        if (buf.data[i * 4 + 3] >= 128) opaque++;
        if (!(buf.data[i * 4] === 255 && buf.data[i * 4 + 1] === 0 && buf.data[i * 4 + 2] === 255)) isMagenta = false;
      }
      if (opaque === 0) blank.push(name);
      if (isMagenta) magenta.push(name);
      const cov = opaque / (buf.w * buf.h);
      minCoverage = Math.min(minCoverage, cov);
      maxCoverage = Math.max(maxCoverage, cov);
    }
    for (const d of spriteItems) if (!itemPainter(d.name)) unpainted.push(d.name);

    check('every sprite is 16x16 (the established art scale)', sizes.size === 1 && sizes.has('16x16'), [...sizes].join(', '));
    check('no sprite is blank', blank.length === 0, blank.join(', '));
    check('no sprite is the magenta missing-painter marker', magenta.length === 0, magenta.join(', '));
    check('every non-block item in the registry has a painter', unpainted.length === 0, unpainted.join(', '));
    check(
      'every sprite fills a sensible fraction of its cell (outline included)',
      minCoverage > 0.15 && maxCoverage < 0.98,
      `coverage ${(minCoverage * 100).toFixed(0)}%..${(maxCoverage * 100).toFixed(0)}%`,
    );

    // A dark outline is the single biggest readability win, so assert it exists:
    // for every sprite, at least one transparent-adjacent rim texel must be dark.
    const noOutline = [];
    for (const name of sprites) {
      const buf = paintItem(name);
      let rim = 0;
      let darkRim = 0;
      for (let y = 0; y < buf.h; y++) {
        for (let x = 0; x < buf.w; x++) {
          const a = (xx, yy) => (xx < 0 || yy < 0 || xx >= buf.w || yy >= buf.h ? 0 : buf.data[(yy * buf.w + xx) * 4 + 3]);
          if (a(x, y) >= 128) continue;
          if (a(x - 1, y) < 128 && a(x + 1, y) < 128 && a(x, y - 1) < 128 && a(x, y + 1) < 128) continue;
          rim++;
          const i = (y * buf.w + x) * 4;
          const lum = 0.2126 * buf.data[i] + 0.7152 * buf.data[i + 1] + 0.0722 * buf.data[i + 2];
          if (lum < 70) darkRim++;
        }
      }
      if (rim === 0 || darkRim < rim) noOutline.push(`${name} (${darkRim}/${rim})`);
    }
    check('every sprite carries a dark one-texel outline', noOutline.length === 0, noOutline.slice(0, 5).join(', '));
    console.log(`  . painted ${sprites.length} item sprites, coverage ${(minCoverage * 100).toFixed(0)}%..${(maxCoverage * 100).toFixed(0)}%`);
  }

  /* ---------------------------------------------------------------- */
  section('extruded-sprite geometry (real depth, atlas-backed faces)');
  {
    const sample = 'iron_pickaxe';
    const geo = buildItemViewGeometry(itemAtlas, sample);
    geo.computeBoundingBox();
    const bb = geo.boundingBox;
    const ext = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
    const texel = 0.42 / ITEM_TILE;
    check(
      'the item slab is thicker than a plane on Z',
      ext[2] > texel * 1.5,
      `depth ${ext[2].toFixed(4)} = ${(ext[2] / texel).toFixed(1)} texels (a flat quad would be 0)`,
    );
    check(
      'the item slab has real width and height too',
      ext[0] > texel * 4 && ext[1] > texel * 8,
      `${ext[0].toFixed(3)} x ${ext[1].toFixed(3)} x ${ext[2].toFixed(3)}`,
    );
    const verts = geo.getAttribute('position').count;
    check('the slab is real geometry, not a rewritten quad', verts >= 100, `${verts} vertices, ${geo.getIndex().count / 3} triangles`);

    // Every vertex UV must land on an opaque texel of this item's own sprite.
    const slot = itemAtlas.slot(sample);
    const ax = (slot % itemAtlas.cols) * itemAtlas.tile;
    const ay = Math.floor(slot / itemAtlas.cols) * itemAtlas.tile;
    const uv = geo.getAttribute('uv');
    let offSprite = 0;
    let transparent = 0;
    for (let i = 0; i < uv.count; i++) {
      const tx = Math.max(0, Math.min(itemAtlas.width - 1, Math.floor(uv.getX(i) * itemAtlas.width)));
      const ty = Math.max(0, Math.min(itemAtlas.height - 1, Math.floor((1 - uv.getY(i)) * itemAtlas.height)));
      if (tx < ax || tx >= ax + ITEM_TILE || ty < ay || ty >= ay + ITEM_TILE) offSprite++;
      else if (itemAtlas.data[(ty * itemAtlas.width + tx) * 4 + 3] < 128) transparent++;
    }
    check('every face samples inside this item\'s own atlas cell', offSprite === 0, `${offSprite} UVs outside the cell`);
    check('every face samples a painted (opaque) texel', transparent === 0, `${transparent} UVs on transparent texels`);

    // Front vs side: classify each triangle by the dominant axis of its normal.
    const idx = geo.getIndex();
    const pos = geo.getAttribute('position');
    const col = geo.getAttribute('aColor');
    let front = 0;
    let side = 0;
    let back = 0;
    let frontShade = 0;
    let sideShade = 0;
    let frontN = 0;
    let sideN = 0;
    const a = new THREE.Vector3();
    const b = new THREE.Vector3();
    const c = new THREE.Vector3();
    const ab = new THREE.Vector3();
    const ac = new THREE.Vector3();
    const nrm = new THREE.Vector3();
    for (let i = 0; i < idx.count; i += 3) {
      const [i0, i1, i2] = [idx.getX(i), idx.getX(i + 1), idx.getX(i + 2)];
      a.fromBufferAttribute(pos, i0);
      b.fromBufferAttribute(pos, i1);
      c.fromBufferAttribute(pos, i2);
      ab.subVectors(b, a);
      ac.subVectors(c, a);
      nrm.crossVectors(ab, ac);
      if (nrm.length() < 1e-9) continue;
      nrm.normalize();
      // Front and back plates are exactly axis-aligned; the 45-degree chamfer
      // lands at z = 0.707 and must count as a *side*, so the threshold is 0.9.
      if (nrm.z > 0.9) {
        front++;
        frontShade += col.getX(i0);
        frontN++;
      } else if (nrm.z < -0.9) {
        back++;
      } else if (Math.abs(nrm.x) > 0.3 || Math.abs(nrm.y) > 0.3) {
        side++;
        sideShade += col.getX(i0);
        sideN++;
      }
    }
    check('the silhouette has real side faces', side > 10, `${side} side triangles`);
    check('the slab is closed (it has a back plate)', back > 10, `${back} back triangles`);
    check('the front plate is present on every silhouette texel', front > 50, `${front} front triangles`);
    const fAvg = frontShade / Math.max(1, frontN);
    const sAvg = sideShade / Math.max(1, sideN);
    check(
      'the front face is at full sprite brightness and the sides are darkened',
      Math.abs(fAvg - ITEM_FACE_SHADE[4]) < 1e-6 && sAvg < fAvg * 0.95,
      `front aColor ${fAvg.toFixed(3)}, side aColor ${sAvg.toFixed(3)}`,
    );
  }

  /* ---------------------------------------------------------------- */
  section('every item in the game builds usable geometry');
  {
    const viewModel = new ViewModel(blockAtlas, itemAtlas, blockTexture, itemTexture);
    viewModel.camera.aspect = 16 / 9;
    viewModel.camera.updateProjectionMatrix();

    const bad = [];
    let itemChecked = 0;
    let blockChecked = 0;
    let minTris = Infinity;
    let minDepth = Infinity;
    for (const def of registry) {
      const blockId = blockIdOf(def.name);
      viewModel.setHeld(blockId, blockId > 0 ? null : def.name);
      const geo = viewModel.currentGeometry();
      if (!geo) {
        bad.push(`${def.name}: no geometry`);
        continue;
      }
      geo.computeBoundingBox();
      const bb = geo.boundingBox;
      const ext = [bb.max.x - bb.min.x, bb.max.y - bb.min.y, bb.max.z - bb.min.z];
      const pos = geo.getAttribute('position');
      const uvA = geo.getAttribute('uv');
      const colA = geo.getAttribute('aColor');
      const lgtA = geo.getAttribute('aLight');
      const ind = geo.getIndex();
      if (!pos || !uvA || !colA || !lgtA || !ind) {
        bad.push(`${def.name}: missing an attribute`);
        continue;
      }
      if (!ext.every((v) => v > 1e-4)) bad.push(`${def.name}: degenerate bbox ${ext.map((v) => v.toFixed(4)).join(',')}`);
      if (!ind.count || ind.count % 3 !== 0) bad.push(`${def.name}: ${ind.count} indices`);
      for (let i = 0; i < pos.count; i++) {
        if (!Number.isFinite(pos.getX(i)) || !Number.isFinite(pos.getY(i)) || !Number.isFinite(pos.getZ(i))) {
          bad.push(`${def.name}: non-finite position`);
          break;
        }
        if (uvA.getX(i) < 0 || uvA.getX(i) > 1 || uvA.getY(i) < 0 || uvA.getY(i) > 1) {
          bad.push(`${def.name}: uv out of range`);
          break;
        }
        if (colA.getX(i) <= 0 || colA.getX(i) > 1) {
          bad.push(`${def.name}: aColor ${colA.getX(i)}`);
          break;
        }
      }
      for (let i = 0; i < ind.count; i++) {
        if (ind.getX(i) >= pos.count) {
          bad.push(`${def.name}: index out of range`);
          break;
        }
      }
      if (blockId > 0) blockChecked++;
      else {
        itemChecked++;
        minDepth = Math.min(minDepth, ext[2]);
      }
      minTris = Math.min(minTris, ind.count / 3);
    }
    check('every item in the registry produced geometry', bad.length === 0, bad.slice(0, 6).join(' | '));
    check('the whole registry was walked', itemChecked === spriteItems.length && blockChecked === blockItems.length, `${itemChecked} items + ${blockChecked} blocks of ${registry.length}`);
    check('no item geometry is degenerate', minTris > 0, `smallest mesh ${minTris} triangles`);
    check(
      'every held item is a slab with depth, not a plane',
      minDepth > (0.42 / ITEM_TILE) * 1.5,
      `thinnest item ${(minDepth / (0.42 / ITEM_TILE)).toFixed(1)} texels thick`,
    );
    console.log(`  . ${itemChecked} extruded item meshes + ${blockChecked} held block cubes audited`);
  }

  /* ---------------------------------------------------------------- */
  section('pose and swing');
  {
    const viewModel = new ViewModel(blockAtlas, itemAtlas, blockTexture, itemTexture);
    const aspect = 16 / 9;
    viewModel.camera.aspect = aspect;
    viewModel.camera.updateProjectionMatrix();
    viewModel.setHeld(0, 'iron_pickaxe');

    const centroid = (swing, active) => {
      viewModel.update(0, swing, active, 0, 0, new THREE.Color(1, 1, 1), aspect);
      viewModel.scene.updateMatrixWorld(true);
      const img = rasteriseScene(THREE, atlasOf, viewModel, 320, 180, [1, 1, 1], [0, 0, 0, 255]);
      let sx = 0;
      let sy = 0;
      let n = 0;
      for (let y = 0; y < 180; y++) {
        for (let x = 0; x < 320; x++) {
          if (img.pixels[(y * 320 + x) * 4 + 3] === 0) continue;
          const lum = img.pixels[(y * 320 + x) * 4] + img.pixels[(y * 320 + x) * 4 + 1] + img.pixels[(y * 320 + x) * 4 + 2];
          if (lum < 12) continue;
          sx += x;
          sy += y;
          n++;
        }
      }
      return { x: sx / Math.max(1, n), y: sy / Math.max(1, n), n };
    };

    const rest = centroid(0, false);
    check('the held item renders at rest', rest.n > 200, `${rest.n} lit pixels`);
    check('the item sits right of frame centre', rest.x > 320 * 0.5, `centroid x ${rest.x.toFixed(0)} of 320`);
    check('the item sits below frame centre', rest.y > 180 * 0.5, `centroid y ${rest.y.toFixed(0)} of 180`);

    const mid = centroid(0.4, true);
    check('the swing moves the item', Math.abs(mid.x - rest.x) + Math.abs(mid.y - rest.y) > 4, `moved ${(Math.abs(mid.x - rest.x) + Math.abs(mid.y - rest.y)).toFixed(1)} px`);
    check('the item stays on screen through the strike', mid.n > 200 && mid.x < rest.x + 60, `centroid ${mid.x.toFixed(0)},${mid.y.toFixed(0)}, ${mid.n} px`);

    check('swingCurve(0) is neutral', Math.abs(swingCurve(0)) < 1e-9);
    check('swingCurve winds up backwards', swingCurve(0.09) < -0.05, swingCurve(0.09).toFixed(3));
    check('swingCurve peaks hard in the strike', swingCurve(0.45) > 0.9, swingCurve(0.45).toFixed(3));
    check('swingCurve returns to neutral', Math.abs(swingCurve(1)) < 1e-9);
  }

  /* ---------------------------------------------------------------- */
  section('hotbar icons (src/ui/icons.ts, real code path)');
  {
    const blank = [];
    const missing = [];
    let painted = 0;
    let minPainted = Infinity;
    for (const def of registry) {
      const icon = makeIcon(blockAtlas, itemAtlas, def.name, 34);
      const n = paintedPixels(icon);
      painted++;
      minPainted = Math.min(minPainted, n);
      if (n === 0) blank.push(def.name);
      // Block items legitimately have no sprite; only sprite items must avoid
      // the magenta marker.
      if (def.blockId === 0 && hasMissingMarker(icon)) missing.push(def.name);
    }
    check('an icon was drawn for every item in the registry', painted === registry.length, `${painted}/${registry.length}`);
    check('no icon is blank', blank.length === 0, blank.join(', '));
    check('no sprite icon fell back to the magenta missing painter', missing.length === 0, missing.join(', '));
    check('icons are solidly painted', minPainted > 20, `smallest icon ${minPainted} painted pixels of 34x34`);
  }

  /* ---------------------------------------------------------------- */
  section('images (look at these)');
  {
    // 1. contact sheet of every item sprite at 6x
    const scale = 6;
    const cell = ITEM_TILE * scale;
    const pad = 6;
    const cols = 8;
    const rows = Math.ceil(sprites.length / cols);
    const cw = cols * (cell + pad) + pad;
    const ch = rows * (cell + pad) + pad;
    const sheet = makeCanvas(cw, ch, [22, 22, 28, 255]);
    for (let i = 0; i < sprites.length; i++) {
      const slot = itemAtlas.slot(sprites[i]);
      const sx = (slot % itemAtlas.cols) * ITEM_TILE;
      const sy = Math.floor(slot / itemAtlas.cols) * ITEM_TILE;
      const cx = pad + (i % cols) * (cell + pad);
      const cy = pad + Math.floor(i / cols) * (cell + pad);
      for (let y = 0; y < cell; y++) {
        for (let x = 0; x < cell; x++) {
          const px = sx + ((x / scale) | 0);
          const py = sy + ((y / scale) | 0);
          const so = (py * itemAtlas.width + px) * 4;
          const a = itemAtlas.data[so + 3] / 255;
          const d = ((cy + y) * cw + cx + x) * 4;
          sheet[d] = itemAtlas.data[so] * a + sheet[d] * (1 - a);
          sheet[d + 1] = itemAtlas.data[so + 1] * a + sheet[d + 1] * (1 - a);
          sheet[d + 2] = itemAtlas.data[so + 2] * a + sheet[d + 2] * (1 - a);
          sheet[d + 3] = 255;
        }
      }
    }
    writePng(path.join(OUT, 'sheet-items.png'), cw, ch, sheet);

    // 2. the real held-item pass, software-rasterised, in daylight and in a cave
    const viewModel = new ViewModel(blockAtlas, itemAtlas, blockTexture, itemTexture);
    const CW = 260;
    const CH = 220;
    const aspect = CW / CH;
    viewModel.camera.aspect = aspect;
    viewModel.camera.updateProjectionMatrix();

    const shots = [
      'iron_pickaxe', 'diamond_sword', 'stone_axe', 'golden_shovel',
      'stick', 'apple', 'bread', 'bucket',
      'wooden_hoe', 'bow', 'redstone_dust', 'book',
      'diamond', 'shears', 'bone', 'cooked_beef',
    ];
    const gridCols = 4;
    const gridRows = Math.ceil(shots.length / gridCols);
    const sheetW = gridCols * CW;
    const sheetH = gridRows * CH;
    const out = makeCanvas(sheetW, sheetH, [70, 90, 120, 255]);
    const light = [1.0, 0.99, 0.95];
    let drawnCell = 0;
    for (let i = 0; i < shots.length; i++) {
      viewModel.setHeld(0, shots[i]);
      viewModel.update(0, 0, false, 0, 0, new THREE.Color(light[0], light[1], light[2]), aspect);
      viewModel.scene.updateMatrixWorld(true);
      const img = rasteriseScene(THREE, atlasOf, viewModel, CW, CH, light, [70, 90, 120, 255]);
      if (img.tris > 0) drawnCell++;
      const dx = (i % gridCols) * CW;
      const dy = Math.floor(i / gridCols) * CH;
      for (let y = 0; y < CH; y++) {
        for (let x = 0; x < CW; x++) {
          const s = (y * CW + x) * 4;
          const d = ((dy + y) * sheetW + dx + x) * 4;
          out[d] = img.pixels[s];
          out[d + 1] = img.pixels[s + 1];
          out[d + 2] = img.pixels[s + 2];
          out[d + 3] = 255;
        }
      }
    }
    writePng(path.join(OUT, 'view-held-items.png'), sheetW, sheetH, out);
    check('every held-item shot rasterised geometry', drawnCell === shots.length, `${drawnCell}/${shots.length} cells`);

    // 3. a swing strip: the same tool through the whole animation
    const SW = 200;
    const SH = 190;
    const phases = [0, 0.2, 0.35, 0.5, 0.7, 0.9];
    const strip = makeCanvas(SW * phases.length, SH, [70, 90, 120, 255]);
    viewModel.camera.aspect = SW / SH;
    viewModel.camera.updateProjectionMatrix();
    for (let i = 0; i < phases.length; i++) {
      viewModel.setHeld(0, 'iron_pickaxe');
      viewModel.update(0, phases[i], i > 0, 0, 0, new THREE.Color(light[0], light[1], light[2]), SW / SH);
      viewModel.scene.updateMatrixWorld(true);
      const img = rasteriseScene(THREE, atlasOf, viewModel, SW, SH, light, [70, 90, 120, 255]);
      for (let y = 0; y < SH; y++) {
        for (let x = 0; x < SW; x++) {
          const s = (y * SW + x) * 4;
          const d = (y * SW * phases.length + i * SW + x) * 4;
          strip[d] = img.pixels[s];
          strip[d + 1] = img.pixels[s + 1];
          strip[d + 2] = img.pixels[s + 2];
          strip[d + 3] = 255;
        }
      }
    }
    writePng(path.join(OUT, 'view-held-swing.png'), SW * phases.length, SH, strip);

    // 4. the same item lit only by a torch in a cave
    const caveLight = [0.34, 0.27, 0.19];
    const cave = makeCanvas(CW * 2, CH, [18, 16, 16, 255]);
    for (let k = 0; k < 2; k++) {
      viewModel.setHeld(k === 0 ? 0 : 1, k === 0 ? 'iron_pickaxe' : null);
      viewModel.camera.aspect = CW / CH;
      viewModel.camera.updateProjectionMatrix();
      viewModel.update(0, 0, false, 0, 0, new THREE.Color(caveLight[0], caveLight[1], caveLight[2]), CW / CH);
      viewModel.scene.updateMatrixWorld(true);
      const img = rasteriseScene(THREE, atlasOf, viewModel, CW, CH, caveLight, [18, 16, 16, 255]);
      for (let y = 0; y < CH; y++) {
        for (let x = 0; x < CW; x++) {
          const s = (y * CW + x) * 4;
          const d = (y * CW * 2 + k * CW + x) * 4;
          cave[d] = img.pixels[s];
          cave[d + 1] = img.pixels[s + 1];
          cave[d + 2] = img.pixels[s + 2];
          cave[d + 3] = 255;
        }
      }
    }
    writePng(path.join(OUT, 'view-held-cave.png'), CW * 2, CH, cave);

    // A held block must still be a lit cube, not a black silhouette.
    {
      viewModel.setHeld(1, null);
      viewModel.camera.aspect = CW / CH;
      viewModel.camera.updateProjectionMatrix();
      viewModel.update(0, 0, false, 0, 0, new THREE.Color(1, 1, 1), CW / CH);
      viewModel.scene.updateMatrixWorld(true);
      const img = rasteriseScene(THREE, atlasOf, viewModel, CW, CH, [1, 1, 1], [70, 90, 120, 255]);
      let lum = 0;
      let n = 0;
      for (let i = 0; i < CW * CH; i++) {
        if (img.pixels[i * 4 + 3] === 0) continue;
        lum += img.pixels[i * 4] + img.pixels[i * 4 + 1] + img.pixels[i * 4 + 2];
        n++;
      }
      check('the held block cube still draws', img.tris > 0 && n > 500, `${img.tris} tris, ${n} px`);
      check('the held block is not black', n > 0 && lum / n / 3 > 30, `mean channel ${(lum / Math.max(1, n) / 3).toFixed(1)}`);
    }

    console.log('  . wrote .qa/sheet-items.png, .qa/view-held-items.png, .qa/view-held-swing.png, .qa/view-held-cave.png');
  }

  /* ---------------------------------------------------------------- */

  let passed = 0;
  let failed = 0;
  const lines = [];
  for (const r of results) {
    if (r.section) {
      lines.push('');
      lines.push(`-- ${r.section} ${'-'.repeat(Math.max(0, 56 - r.section.length))}`);
      continue;
    }
    if (r.pass) {
      passed++;
      lines.push(`  ok    ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    } else {
      failed++;
      lines.push(`  FAIL  ${r.name}${r.detail ? `  -> ${r.detail}` : ''}`);
    }
  }
  console.log(lines.join('\n'));
  console.log('');
  console.log(`viewmodel: ${passed} passed, ${failed} failed`);
  if (failed) {
    console.log('viewmodel: FAILED');
    process.exit(1);
  }
  console.log('viewmodel: all held-item checks passed.');
  return { passed, failed };
}
