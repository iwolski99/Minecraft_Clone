/**
 * Tiny deterministic RGBA pixel buffer used to author every texture in the game.
 *
 * Textures are painted procedurally (never loaded from disk) so the project
 * contains no third-party art. The same code runs in the browser (blitted to a
 * canvas) and in the Node QA renderer (written straight to a PNG).
 */

import { Rng, hashInt } from '../util/rng.js';

export type RGBA = readonly [number, number, number, number];

export function rgb(hex: number, a = 255): RGBA {
  return [(hex >> 16) & 255, (hex >> 8) & 255, hex & 255, a];
}

/**
 * Flip an RGBA image vertically, in place.
 *
 * Every texture here is painted with `PixBuf`, i.e. in *canvas* order: buffer
 * row 0 is the top row of the picture, which is why `Atlas.toCanvas()` can
 * `putImageData` it directly and why the QA PNG dumps look right.
 *
 * WebGL reads an `ArrayBufferView` upload bottom-up instead: the first row of
 * the buffer is `v = 0`. `THREE.DataTexture` hard-codes `flipY = false`, and
 * `UNPACK_FLIP_Y_WEBGL` has no effect on ArrayBufferView sources, so a UV built
 * with the canvas convention (`v = 1 - row / height`, what `Atlas.uvSlot()` and
 * `models.uvRect()` produce) resolves to the *vertically mirrored* band of the
 * texture. The atlas only paints its top rows, so those UVs land on empty texels.
 *
 * Flipping the copy that is handed to the GPU makes the sampler agree with the
 * UVs, and leaves the authoring buffer untouched for `Atlas.texel()`,
 * `averageColor()`, the PNG dumps and the software renderer.
 */
export function flipRowsInPlace(data: Uint8Array | Uint8ClampedArray, width: number, height: number): void {
  const stride = width * 4;
  const tmp = new Uint8Array(stride);
  for (let y = 0; y < (height >> 1); y++) {
    const a = y * stride;
    const b = (height - 1 - y) * stride;
    tmp.set(data.subarray(a, a + stride));
    data.set(data.subarray(b, b + stride), a);
    data.set(tmp, b);
  }
}

export class PixBuf {
  readonly w: number;
  readonly h: number;
  readonly data: Uint8ClampedArray;
  readonly rng: Rng;

  constructor(w: number, h: number, seed = 1) {
    this.w = w;
    this.h = h;
    this.data = new Uint8ClampedArray(w * h * 4);
    this.rng = new Rng(seed);
  }

  set(x: number, y: number, c: RGBA): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = c[0];
    this.data[i + 1] = c[1];
    this.data[i + 2] = c[2];
    this.data[i + 3] = c[3];
  }

  get(x: number, y: number): RGBA {
    const i = ((y % this.h + this.h) % this.h * this.w + ((x % this.w) + this.w) % this.w) * 4;
    return [this.data[i], this.data[i + 1], this.data[i + 2], this.data[i + 3]];
  }

  /** Blend a colour over an existing pixel. */
  blend(x: number, y: number, c: RGBA): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    const sa = c[3] / 255;
    const da = this.data[i + 3] / 255;
    const oa = sa + da * (1 - sa);
    if (oa <= 0) {
      this.data[i] = this.data[i + 1] = this.data[i + 2] = this.data[i + 3] = 0;
      return;
    }
    this.data[i] = (c[0] * sa + this.data[i] * da * (1 - sa)) / oa;
    this.data[i + 1] = (c[1] * sa + this.data[i + 1] * da * (1 - sa)) / oa;
    this.data[i + 2] = (c[2] * sa + this.data[i + 2] * da * (1 - sa)) / oa;
    this.data[i + 3] = oa * 255;
  }

  fill(c: RGBA): void {
    for (let y = 0; y < this.h; y++) for (let x = 0; x < this.w; x++) this.set(x, y, c);
  }

  rect(x0: number, y0: number, w: number, h: number, c: RGBA): void {
    for (let y = y0; y < y0 + h; y++) for (let x = x0; x < x0 + w; x++) this.set(x, y, c);
  }

  hline(x0: number, x1: number, y: number, c: RGBA): void {
    for (let x = x0; x <= x1; x++) this.set(x, y, c);
  }

  vline(x: number, y0: number, y1: number, c: RGBA): void {
    for (let y = y0; y <= y1; y++) this.set(x, y, c);
  }

  /** Multiply a pixel's colour (used for cheap shading). */
  shade(x: number, y: number, f: number): void {
    if (x < 0 || y < 0 || x >= this.w || y >= this.h) return;
    const i = (y * this.w + x) * 4;
    this.data[i] = this.data[i] * f;
    this.data[i + 1] = this.data[i + 1] * f;
    this.data[i + 2] = this.data[i + 2] * f;
  }

  /** Random pick from a palette. */
  pick(palette: readonly RGBA[]): RGBA {
    return palette[Math.floor(this.rng.next() * palette.length) % palette.length];
  }
}

/* ------------------------------------------------------------------ */
/* Tileable value noise                                               */
/* ------------------------------------------------------------------ */

/** Hash-based lattice value in [0,1). */
function lattice(x: number, y: number, seed: number): number {
  return hashInt(hashInt(x * 0x1f1f1f1f) ^ hashInt(y * 0x3b9aca07) ^ seed) / 4294967296;
}

/**
 * Seamlessly tiling fractal value noise. `period` is the lattice period in
 * pixels; the result wraps at the tile edge so textures tile across blocks.
 */
export function tileNoise(w: number, h: number, seed: number, period: number, octaves = 3): Float32Array {
  const out = new Float32Array(w * h);
  let amp = 1;
  let norm = 0;
  let p = Math.max(2, Math.round(period));
  for (let o = 0; o < octaves; o++) {
    for (let y = 0; y < h; y++) {
      const fy = (y / h) * p;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      const sy = ty * ty * (3 - 2 * ty);
      for (let x = 0; x < w; x++) {
        const fx = (x / w) * p;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const sx = tx * tx * (3 - 2 * tx);
        const a = lattice(x0 % p, y0 % p, seed + o * 7919);
        const b = lattice((x0 + 1) % p, y0 % p, seed + o * 7919);
        const c = lattice(x0 % p, (y0 + 1) % p, seed + o * 7919);
        const d = lattice((x0 + 1) % p, (y0 + 1) % p, seed + o * 7919);
        const top = a + (b - a) * sx;
        const bot = c + (d - c) * sx;
        out[y * w + x] += (top + (bot - top) * sy) * amp;
      }
    }
    norm += amp;
    amp *= 0.5;
    p *= 2;
  }
  for (let i = 0; i < out.length; i++) out[i] /= norm;
  return out;
}

/**
 * Paint a material by quantising tileable noise into a small ordered palette.
 * This is what keeps stone/dirt/sand reading as *material* rather than as
 * uncorrelated per-pixel static.
 */
export function noiseFill(
  buf: PixBuf,
  palette: readonly RGBA[],
  seed: number,
  period = 4,
  octaves = 3,
  /** blend towards a second weighting (0 = pure noise bands) */
  contrast = 1,
  y0 = 0,
  y1 = -1,
): void {
  const n = tileNoise(buf.w, buf.h, seed, period, octaves);
  const bottom = y1 < 0 ? buf.h - 1 : y1;
  for (let y = y0; y <= bottom; y++) {
    for (let x = 0; x < buf.w; x++) {
      let v = n[y * buf.w + x];
      v = Math.max(0, Math.min(0.999999, (v - 0.5) * contrast + 0.5));
      const idx = Math.min(palette.length - 1, Math.floor(v * palette.length));
      buf.set(x, y, palette[idx]);
    }
  }
}

/** Sprinkle individual pixels of a colour at a given density. */
export function speckle(buf: PixBuf, color: RGBA, density: number, y0 = 0, y1 = -1): void {
  const bottom = y1 < 0 ? buf.h - 1 : y1;
  for (let y = y0; y <= bottom; y++) {
    for (let x = 0; x < buf.w; x++) {
      if (buf.rng.next() < density) buf.set(x, y, color);
    }
  }
}

/** Draw soft round blobs - used for ore veins and moss. */
export function blobs(
  buf: PixBuf,
  color: RGBA,
  count: number,
  minR: number,
  maxR: number,
  highlight?: RGBA,
  outline?: RGBA,
): void {
  for (let i = 0; i < count; i++) {
    const cx = buf.rng.range(2, buf.w - 2);
    const cy = buf.rng.range(2, buf.h - 2);
    const r = buf.rng.range(minR, maxR);
    const r2 = r * r;
    for (let y = Math.floor(cy - r); y <= Math.ceil(cy + r); y++) {
      for (let x = Math.floor(cx - r); x <= Math.ceil(cx + r); x++) {
        const dx = x + 0.5 - cx;
        const dy = y + 0.5 - cy;
        const d2 = dx * dx + dy * dy;
        if (d2 > r2) continue;
        // Jagged edges so veins do not look like perfect circles.
        if (d2 > r2 * 0.55 && buf.rng.next() < 0.45) continue;
        if (outline && d2 > r2 * 0.62) {
          buf.set(x, y, outline);
        } else {
          buf.set(x, y, color);
        }
      }
    }
    if (highlight) {
      for (let k = 0; k < 2; k++) {
        const hx = Math.round(cx - r * 0.3 + buf.rng.range(-1, 1));
        const hy = Math.round(cy - r * 0.3 + buf.rng.range(-1, 1));
        buf.set(hx, hy, highlight);
        buf.set(hx + 1, hy, highlight);
      }
    }
  }
}

/** Darken a 1px border (keeps every block face readable at distance). */
export function edgeDarken(buf: PixBuf, f = 0.86): void {
  for (let x = 0; x < buf.w; x++) {
    buf.shade(x, 0, f);
    buf.shade(x, buf.h - 1, f);
  }
  for (let y = 0; y < buf.h; y++) {
    buf.shade(0, y, f);
    buf.shade(buf.w - 1, y, f);
  }
}
