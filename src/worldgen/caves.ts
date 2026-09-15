/**
 * Cave carving.
 *
 * Two complementary fields are combined:
 *   - "spaghetti": the intersection of two independent 3D noise fields near
 *     zero, which produces long winding tunnels with occasional intersections
 *   - "cheese": large low-frequency blobs that open into caverns
 *
 * Everything is a pure function of (seed, world position) so carving is
 * identical no matter which order chunks are generated in.
 */

import { Noise3D } from '../util/noise.js';

export class CaveGenerator {
  private a: Noise3D;
  private b: Noise3D;
  private cheese: Noise3D;
  private region: Noise3D;

  constructor(seed: number) {
    this.a = new Noise3D(seed ^ 0x1a2b3c);
    this.b = new Noise3D(seed ^ 0x5d6e7f);
    this.cheese = new Noise3D(seed ^ 0x9f10ab);
    this.region = new Noise3D(seed ^ 0x33cc55);
  }

  /** Cheap per-column gate; computed once and reused for the whole column. */
  regionAt(x: number, z: number): number {
    return this.region.fbm(x / 340, 0.5, z / 340, 2) * 0.5 + 0.5;
  }

  /**
   * @param surfaceY terrain height at this column (caves never break the surface crust)
   * @param region   precomputed value from `regionAt`
   */
  isCarved(x: number, y: number, z: number, surfaceY: number, region: number): boolean {
    if (y < 2 || y > 96) return false;
    // keep a solid crust so the surface is not riddled with holes
    if (y > surfaceY - 4) return false;
    // regional gating makes some areas far more cavey than others
    if (region < 0.34) return false;

    // ---- spaghetti tunnels -------------------------------------------------
    const w = 0.05 + region * 0.032;
    const n1 = this.a.noise(x / 76, y / 42, z / 76);
    if (n1 > -w && n1 < w) {
      const n2 = this.b.noise(x / 76, y / 42, z / 76);
      if (n2 > -w && n2 < w) return true;
    }
    // a second wider, rarer tunnel network for variety
    const n3 = this.a.noise(x / 148 + 11, y / 74, z / 148 - 7);
    if (n3 > -0.048 && n3 < 0.048) {
      const n4 = this.b.noise(x / 148 + 11, y / 74, z / 148 - 7);
      if (n4 > -0.048 && n4 < 0.048) return true;
    }

    // ---- cheese caverns ---------------------------------------------------
    if (y < 58) {
      const c = this.cheese.fbm(x / 88, y / 44, z / 88, 2);
      const threshold = 0.22 - (58 - y) * 0.0016;
      if (c > threshold + (1 - region) * 0.16) return true;
    }
    return false;
  }
}
