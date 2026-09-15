/**
 * Deterministic hashing + PRNG helpers.
 *
 * Everything in world generation must be a pure function of (seed, coordinates)
 * so that chunk borders match regardless of the order chunks are generated in.
 */

/** 32-bit integer hash (Wang / murmur-style avalanche). */
export function hashInt(x: number): number {
  x = x | 0;
  x = (x ^ 61) ^ (x >>> 16);
  x = (x + (x << 3)) | 0;
  x = x ^ (x >>> 4);
  x = Math.imul(x, 0x27d4eb2d);
  x = x ^ (x >>> 15);
  return x >>> 0;
}

/** Hash three coordinates + seed into a 32-bit unsigned integer. */
export function hash3(seed: number, x: number, y: number, z: number): number {
  let h = seed | 0;
  h = (Math.imul(h ^ (x | 0), 0x27d4eb2d) + 0x9e3779b9) | 0;
  h = (Math.imul(h ^ (y | 0), 0x85ebca6b) + 0x9e3779b9) | 0;
  h = (Math.imul(h ^ (z | 0), 0xc2b2ae35) + 0x9e3779b9) | 0;
  h ^= h >>> 15;
  h = Math.imul(h, 0x2545f491);
  h ^= h >>> 13;
  return h >>> 0;
}

export function hash2(seed: number, x: number, z: number): number {
  return hash3(seed, x, 0, z);
}

/** Deterministic float in [0,1) from coordinates. */
export function hashFloat3(seed: number, x: number, y: number, z: number): number {
  return hash3(seed, x, y, z) / 4294967296;
}

export function hashFloat2(seed: number, x: number, z: number): number {
  return hash2(seed, x, z) / 4294967296;
}

/** mulberry32 - small, fast, well-distributed 32-bit PRNG. */
export class Rng {
  private s: number;

  constructor(seed: number) {
    this.s = (seed >>> 0) || 1;
  }

  /** float in [0,1) */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) | 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** float in [min,max) */
  range(min: number, max: number): number {
    return min + this.next() * (max - min);
  }

  /** integer in [min,max] inclusive */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length) % arr.length];
  }

  /** Gaussian-ish via sum of uniforms; cheap and seed-stable. */
  gauss(): number {
    return (this.next() + this.next() + this.next() - 1.5) * 1.1547;
  }
}

/** Convert an arbitrary string seed into a 32-bit int (like Java's String.hashCode). */
export function seedFromString(str: string): number {
  const trimmed = str.trim();
  if (trimmed === '') return (Math.random() * 0xffffffff) >>> 0;
  if (/^-?\d+$/.test(trimmed)) {
    const n = Number(trimmed);
    if (Number.isFinite(n)) return (n | 0) >>> 0;
  }
  let h = 0;
  for (let i = 0; i < trimmed.length; i++) {
    h = (Math.imul(31, h) + trimmed.charCodeAt(i)) | 0;
  }
  return h >>> 0;
}
