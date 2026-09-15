/**
 * Seeded 2D/3D gradient (Perlin-style) noise with fractal helpers.
 *
 * Written from scratch so worldgen has zero external dependencies and is
 * bit-for-bit reproducible for a given seed.
 */

import { Rng } from './rng.js';

const GRAD3 = new Int8Array([
  1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1, 0,
  1, 0, 1, -1, 0, 1, 1, 0, -1, -1, 0, -1,
  0, 1, 1, 0, -1, 1, 0, 1, -1, 0, -1, -1,
]);

function fade(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

function lerp(a: number, b: number, t: number): number {
  return a + t * (b - a);
}

export class Noise2D {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  /** Perlin noise in roughly [-1,1]. */
  noise(x: number, y: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const u = fade(xf);
    const v = fade(yf);

    const aa = this.perm[this.perm[X] + Y] % 12;
    const ab = this.perm[this.perm[X] + Y + 1] % 12;
    const ba = this.perm[this.perm[X + 1] + Y] % 12;
    const bb = this.perm[this.perm[X + 1] + Y + 1] % 12;

    const x1 = lerp(
      GRAD3[aa * 3] * xf + GRAD3[aa * 3 + 1] * yf,
      GRAD3[ba * 3] * (xf - 1) + GRAD3[ba * 3 + 1] * yf,
      u,
    );
    const x2 = lerp(
      GRAD3[ab * 3] * xf + GRAD3[ab * 3 + 1] * (yf - 1),
      GRAD3[bb * 3] * (xf - 1) + GRAD3[bb * 3 + 1] * (yf - 1),
      u,
    );
    return lerp(x1, x2, v);
  }

  /** Fractal Brownian motion. */
  fbm(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x * freq, y * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }

  /** Ridged multifractal - produces sharp mountain crests. */
  ridged(x: number, y: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      const n = 1 - Math.abs(this.noise(x * freq, y * freq));
      sum += n * n * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

export class Noise3D {
  private perm = new Uint8Array(512);

  constructor(seed: number) {
    const rng = new Rng(seed);
    const p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) {
      const j = rng.int(0, i);
      const t = p[i];
      p[i] = p[j];
      p[j] = t;
    }
    for (let i = 0; i < 512; i++) this.perm[i] = p[i & 255];
  }

  private grad(hash: number, x: number, y: number, z: number): number {
    const h = hash & 15;
    const u = h < 8 ? x : y;
    const v = h < 4 ? y : h === 12 || h === 14 ? x : z;
    return ((h & 1) === 0 ? u : -u) + ((h & 2) === 0 ? v : -v);
  }

  noise(x: number, y: number, z: number): number {
    const X = Math.floor(x) & 255;
    const Y = Math.floor(y) & 255;
    const Z = Math.floor(z) & 255;
    const xf = x - Math.floor(x);
    const yf = y - Math.floor(y);
    const zf = z - Math.floor(z);
    const u = fade(xf);
    const v = fade(yf);
    const w = fade(zf);

    const A = this.perm[X] + Y;
    const AA = this.perm[A] + Z;
    const AB = this.perm[A + 1] + Z;
    const B = this.perm[X + 1] + Y;
    const BA = this.perm[B] + Z;
    const BB = this.perm[B + 1] + Z;

    const x1 = lerp(
      lerp(this.grad(this.perm[AA], xf, yf, zf), this.grad(this.perm[BA], xf - 1, yf, zf), u),
      lerp(this.grad(this.perm[AB], xf, yf - 1, zf), this.grad(this.perm[BB], xf - 1, yf - 1, zf), u),
      v,
    );
    const x2 = lerp(
      lerp(this.grad(this.perm[AA + 1], xf, yf, zf - 1), this.grad(this.perm[BA + 1], xf - 1, yf, zf - 1), u),
      lerp(this.grad(this.perm[AB + 1], xf, yf - 1, zf - 1), this.grad(this.perm[BB + 1], xf - 1, yf - 1, zf - 1), u),
      v,
    );
    return lerp(x1, x2, w);
  }

  fbm(x: number, y: number, z: number, octaves: number, lacunarity = 2, gain = 0.5): number {
    let amp = 1;
    let freq = 1;
    let sum = 0;
    let norm = 0;
    for (let i = 0; i < octaves; i++) {
      sum += this.noise(x * freq, y * freq, z * freq) * amp;
      norm += amp;
      amp *= gain;
      freq *= lacunarity;
    }
    return sum / norm;
  }
}

export function smoothstep(edge0: number, edge1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - edge0) / (edge1 - edge0)));
  return t * t * (3 - 2 * t);
}

export function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function lerpNum(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
