/**
 * Procedurally painted 16x16 block textures.
 *
 * Art direction: low pixel density, small harmonised palettes, clustered rather
 * than per-pixel variation, strong silhouette readability, and a thin darkened
 * border so that every block face stays legible at distance.
 *
 * Nothing here is copied from any existing texture pack - every tile is
 * described as code and painted deterministically from its own name hash.
 */

import { PixBuf, RGBA, rgb, tileNoise, noiseFill, speckle, blobs, edgeDarken } from './pixel.js';
import { hashInt } from '../util/rng.js';

export const TILE = 16;

type Painter = (b: PixBuf) => void;
const painters: Record<string, Painter> = {};
function p(name: string, fn: Painter): void {
  painters[name] = fn;
}
export function tilePainter(name: string): Painter | undefined {
  return painters[name];
}
export function tileNames(): string[] {
  return Object.keys(painters);
}

/* ------------------------------------------------------------------ */
/* Shared palettes                                                     */
/* ------------------------------------------------------------------ */

const STONE = [rgb(0x6a6a6a), rgb(0x747474), rgb(0x7d7d7d), rgb(0x868686), rgb(0x8e8e8e)];
const STONE_DARK = [rgb(0x5c5c5c), rgb(0x646464), rgb(0x6d6d6d), rgb(0x757575)];
const DIRT = [rgb(0x6b4a30), rgb(0x7a5537), rgb(0x855e3d), rgb(0x916846), rgb(0x9c7450)];
const GRASS = [rgb(0x4c8a30), rgb(0x559636), rgb(0x5ea03d), rgb(0x68aa45), rgb(0x73b64f)];
const GRASS_DARK = [rgb(0x3d7226), rgb(0x447c2b), rgb(0x4c8631)];
const SAND = [rgb(0xcfc395), rgb(0xd6cb9e), rgb(0xdcd2a7), rgb(0xe2d9b1), rgb(0xe8e0bb)];
const SNOW = [rgb(0xe9eff6), rgb(0xeff5fb), rgb(0xf5f9fd), rgb(0xfbfdff), rgb(0xffffff)];
const GRAVEL = [rgb(0x5e574f), rgb(0x7a736a), rgb(0x8d857b), rgb(0x9e968b), rgb(0x6d6559)];
const FOLIAGE = [rgb(0x2f5c1e), rgb(0x38702a), rgb(0x417c30), rgb(0x4b8a37), rgb(0x568f3c)];
const ICE = [rgb(0x9fc8e8), rgb(0xaed4ef), rgb(0xbcdff6), rgb(0xc9e7fa)];
const LAVA = [rgb(0xb02a05), rgb(0xd8480a), rgb(0xef6a10), rgb(0xff9a1c), rgb(0xffd24a)];

/* ------------------------------------------------------------------ */
/* Material helpers                                                    */
/* ------------------------------------------------------------------ */

/** Tileable Voronoi cell fill - the backbone of cobblestone and gravel. */
function voronoi(buf: PixBuf, count: number, palette: readonly RGBA[], mortar: RGBA | null, jitter = 0): void {
  const pts: { x: number; y: number; c: RGBA }[] = [];
  const size = buf.w;
  for (let i = 0; i < count; i++) {
    pts.push({
      x: buf.rng.range(0, size),
      y: buf.rng.range(0, size),
      c: buf.pick(palette),
    });
  }
  const mortarW = mortar ? 1.35 : 0;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let d1 = 1e9;
      let d2 = 1e9;
      let best: RGBA = palette[0];
      for (const pt of pts) {
        // wrap across the tile so the result is seamless
        let dx = Math.abs(x + 0.5 - pt.x);
        let dy = Math.abs(y + 0.5 - pt.y);
        if (dx > size / 2) dx = size - dx;
        if (dy > size / 2) dy = size - dy;
        const d = Math.sqrt(dx * dx + dy * dy);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          best = pt.c;
        } else if (d < d2) {
          d2 = d;
        }
      }
      if (mortar && d2 - d1 < mortarW) {
        buf.set(x, y, mortar);
      } else {
        const t = Math.max(0, Math.min(1, (d1 - 0.6) / 4));
        const f = 1 - t * 0.22 + buf.rng.range(-jitter, jitter);
        buf.set(x, y, [best[0] * f, best[1] * f, best[2] * f, 255]);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Natural blocks                                                      */
/* ------------------------------------------------------------------ */

p('stone', (b) => {
  noiseFill(b, STONE, 0x51a3, 5, 4, 1.25);
  speckle(b, rgb(0x5f5f5f), 0.035);
  speckle(b, rgb(0x949494), 0.03);
  edgeDarken(b, 0.9);
});

p('dirt', (b) => {
  noiseFill(b, DIRT, 0x9e21, 4, 3, 1.1);
  speckle(b, rgb(0x5d4029), 0.05);
  speckle(b, rgb(0xa87d58), 0.045);
  speckle(b, rgb(0x6f4d31), 0.03);
  edgeDarken(b, 0.92);
});

p('grass_top', (b) => {
  noiseFill(b, GRASS, 0x77c1, 3, 3, 1.15);
  speckle(b, GRASS_DARK[0], 0.09);
  speckle(b, rgb(0x7cc154), 0.07);
  // short blade strokes to break up the field
  for (let i = 0; i < 14; i++) {
    const x = b.rng.int(0, 15);
    const y = b.rng.int(0, 15);
    const c = b.rng.chance(0.5) ? GRASS_DARK[1] : rgb(0x7ec455);
    b.set(x, y, c);
    b.set(x, (y + 1) % 16, c);
  }
  edgeDarken(b, 0.9);
});

p('grass_side', (b) => {
  // dirt base first
  noiseFill(b, DIRT, 0x9e21, 4, 3, 1.1);
  speckle(b, rgb(0x5d4029), 0.05);
  speckle(b, rgb(0xa87d58), 0.04);
  const n = tileNoise(16, 16, 0x3311, 4, 2);
  for (let x = 0; x < 16; x++) {
    // ragged grass overhang depth, 3..6 px
    const jitter = n[(3 * 16 + x)] * 3;
    const depth = 3 + Math.round(jitter);
    for (let y = 0; y <= depth; y++) {
      const shadeIdx = Math.min(GRASS.length - 1, Math.max(0, Math.round((1 - y / (depth + 1)) * 3) + (b.rng.chance(0.25) ? 1 : 0)));
      b.set(x, y, GRASS[shadeIdx]);
    }
    b.set(x, depth + 1, GRASS_DARK[0]);
  }
  edgeDarken(b, 0.9);
});

p('snowy_grass_side', (b) => {
  noiseFill(b, DIRT, 0x9e21, 4, 3, 1.1);
  speckle(b, rgb(0x5d4029), 0.05);
  const n = tileNoise(16, 16, 0x3311, 4, 2);
  for (let x = 0; x < 16; x++) {
    const depth = 3 + Math.round(n[3 * 16 + x] * 3);
    for (let y = 0; y <= depth; y++) b.set(x, y, SNOW[Math.min(4, 1 + Math.round((depth - y) / 2))]);
    b.set(x, depth + 1, rgb(0xc8d2dc));
  }
  edgeDarken(b, 0.92);
});

p('sand', (b) => {
  noiseFill(b, SAND, 0x4c1d, 6, 3, 0.85);
  speckle(b, rgb(0xc4b787), 0.05);
  speckle(b, rgb(0xeee7c6), 0.06);
  edgeDarken(b, 0.95);
});

p('sandstone_top', (b) => {
  noiseFill(b, SAND, 0x5a2f, 5, 3, 0.8);
  speckle(b, rgb(0xc6b98a), 0.05);
  edgeDarken(b, 0.93);
});

p('sandstone_side', (b) => {
  noiseFill(b, SAND, 0x5a2f, 5, 3, 0.7);
  // horizontal sedimentary banding with a darker cap
  b.rect(0, 0, 16, 2, rgb(0xe4dbb4));
  b.hline(0, 15, 2, rgb(0xc2b587));
  b.hline(0, 15, 3, rgb(0xd2c79c));
  b.hline(0, 15, 8, rgb(0xc8bc90));
  b.hline(0, 15, 9, rgb(0xb9ad82));
  b.hline(0, 15, 13, rgb(0xc6ba8e));
  b.hline(0, 15, 14, rgb(0xb6aa80));
  speckle(b, rgb(0xbfb287), 0.04);
  edgeDarken(b, 0.93);
});

p('sandstone_bottom', (b) => {
  noiseFill(b, SAND, 0x5a2f, 5, 3, 0.7);
  speckle(b, rgb(0xb9ac81), 0.08);
  edgeDarken(b, 0.9);
});

p('gravel', (b) => {
  voronoi(b, 13, GRAVEL, rgb(0x453f39), 0.16);
  speckle(b, rgb(0x4c463f), 0.05);
  speckle(b, rgb(0xbab2a6), 0.05);
  edgeDarken(b, 0.88);
});

p('cobblestone', (b) => {
  voronoi(b, 9, [rgb(0x767676), rgb(0x848484), rgb(0x909090), rgb(0x9c9c9c), rgb(0x6a6a6a)], rgb(0x3f3f3f), 0.2);
  // chiselled highlights on the upper-left of each stone
  speckle(b, rgb(0xadadad), 0.035);
  speckle(b, rgb(0x4c4c4c), 0.05);
  edgeDarken(b, 0.85);
});

p('mossy_cobblestone', (b) => {
  voronoi(b, 9, [rgb(0x767676), rgb(0x848484), rgb(0x909090), rgb(0x9c9c9c), rgb(0x6a6a6a)], rgb(0x3f3f3f), 0.2);
  edgeDarken(b, 0.85);
  blobs(b, rgb(0x4a7a2e), 4, 2.2, 3.4, rgb(0x5d9139), rgb(0x3c6524));
  speckle(b, rgb(0x68a03f), 0.05);
});

p('clay', (b) => {
  noiseFill(b, [rgb(0x9aa1ad), rgb(0xa2a9b4), rgb(0xabb1bc), rgb(0xb3b9c3)], 0x2e77, 4, 3, 0.9);
  speckle(b, rgb(0x8e95a1), 0.04);
  edgeDarken(b, 0.94);
});

p('snow', (b) => {
  noiseFill(b, SNOW, 0x6d13, 5, 3, 0.6);
  speckle(b, rgb(0xdfe8f2), 0.06);
  speckle(b, rgb(0xffffff), 0.08);
  edgeDarken(b, 0.97);
});

p('ice', (b) => {
  noiseFill(b, ICE, 0x3f9a, 4, 3, 0.8);
  for (let i = 0; i < 5; i++) {
    const x = b.rng.int(1, 13);
    const y = b.rng.int(1, 12);
    const len = b.rng.int(2, 5);
    for (let k = 0; k < len; k++) b.set(x + k, y + Math.floor(k / 2), rgb(0xdff2ff));
  }
  edgeDarken(b, 0.9);
});

p('bedrock', (b) => {
  voronoi(b, 16, [rgb(0x3a3a3a), rgb(0x4a4a4a), rgb(0x565656), rgb(0x2e2e2e), rgb(0x626262)], rgb(0x1e1e1e), 0.25);
  speckle(b, rgb(0x6e6e6e), 0.05);
  edgeDarken(b, 0.9);
});

p('obsidian', (b) => {
  b.fill(rgb(0x120e1c));
  noiseFill(b, [rgb(0x0e0a16), rgb(0x161022), rgb(0x1d1630), rgb(0x241b3c)], 0x71bb, 3, 3, 1.1);
  speckle(b, rgb(0x3b2c5e), 0.07);
  speckle(b, rgb(0x5b4a86), 0.025);
  edgeDarken(b, 0.9);
});

p('glowstone', (b) => {
  noiseFill(b, [rgb(0x8a6a2a), rgb(0xa8802f), rgb(0xc39a3c)], 0x2ac1, 3, 3, 0.9);
  blobs(b, rgb(0xffe694), 9, 1.4, 2.4, rgb(0xfff6c8), rgb(0xd8a94a));
  speckle(b, rgb(0xffd86a), 0.09);
  edgeDarken(b, 0.95);
});

/* ------------------------------------------------------------------ */
/* Wood                                                                */
/* ------------------------------------------------------------------ */

function barkSide(b: PixBuf, base: readonly RGBA[], dark: RGBA, light: RGBA, seed: number, dashes = 0): void {
  noiseFill(b, base, seed, 5, 3, 1);
  // vertical grain streaks
  for (let x = 0; x < 16; x++) {
    if (((x * 7 + (seed & 15)) % 5) === 0) {
      for (let y = 0; y < 16; y++) {
        const f = 0.9 + ((y * 13 + x * 5) % 7) * 0.03;
        const c = b.get(x, y);
        b.set(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
      }
    }
  }
  for (let i = 0; i < 22; i++) {
    const x = b.rng.int(0, 15);
    const y = b.rng.int(0, 15);
    const len = b.rng.int(2, 6);
    for (let k = 0; k < len; k++) b.set(x, (y + k) % 16, dark);
  }
  for (let i = 0; i < 12; i++) {
    const x = b.rng.int(0, 15);
    const y = b.rng.int(0, 15);
    b.set(x, y, light);
    b.set(x, (y + 1) % 16, light);
  }
  if (dashes) {
    for (let i = 0; i < dashes; i++) {
      const x = b.rng.int(0, 11);
      const y = b.rng.int(0, 15);
      const len = b.rng.int(2, 5);
      for (let k = 0; k < len; k++) b.set(x + k, y, rgb(0x3d352c));
    }
  }
  edgeDarken(b, 0.9);
}

function logTop(b: PixBuf, bark: readonly RGBA[], rings: readonly RGBA[], seed: number): void {
  noiseFill(b, bark, seed, 4, 3, 0.9);
  const cx = 7.5;
  const cy = 7.5;
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const dx = x - cx;
      const dy = y - cy;
      // square-ish rings read better at 16px than true circles
      const d = Math.max(Math.abs(dx), Math.abs(dy)) * 0.72 + Math.sqrt(dx * dx + dy * dy) * 0.42;
      if (d > 6.4) continue;
      const band = Math.floor(d * 1.35) % rings.length;
      const wob = ((x * 31 + y * 17 + seed) % 3) * 0.08;
      const c = rings[(band + (wob > 0.14 ? 1 : 0)) % rings.length];
      b.set(x, y, c);
    }
  }
  b.set(7, 7, rings[0]);
  b.set(8, 8, rings[0]);
  edgeDarken(b, 0.88);
}

p('oak_log_side', (b) => barkSide(b, [rgb(0x6a5230), rgb(0x745a35), rgb(0x7e6239), rgb(0x87693e)], rgb(0x4f3c22), rgb(0x93744a), 0x11a1));
p('oak_log_top', (b) => logTop(b, [rgb(0x6a5230), rgb(0x745a35), rgb(0x7e6239)], [rgb(0xc4a271), rgb(0xa8874f), rgb(0xb8975c), rgb(0x9a7a46)], 0x11a1));
p('birch_log_side', (b) => barkSide(b, [rgb(0xd8d2c4), rgb(0xe0dacd), rgb(0xe6e1d5)], rgb(0x8f8878), rgb(0xf2eee3), 0x22b2, 7));
p('birch_log_top', (b) => logTop(b, [rgb(0xd8d2c4), rgb(0xe0dacd), rgb(0xe6e1d5)], [rgb(0xd9c79c), rgb(0xc3ae7e), rgb(0xcdb98b), rgb(0xb8a273)], 0x22b2));
p('spruce_log_side', (b) => barkSide(b, [rgb(0x3f2f1c), rgb(0x473624), rgb(0x503d29)], rgb(0x2c2013), rgb(0x5d472e), 0x33c3));
p('spruce_log_top', (b) => logTop(b, [rgb(0x3f2f1c), rgb(0x473624), rgb(0x503d29)], [rgb(0xa37f4e), rgb(0x8b6a3d), rgb(0x97744a), rgb(0x7d5e35)], 0x33c3));

function planks(b: PixBuf, palette: readonly RGBA[], seam: RGBA, knot: RGBA, seed: number, rows = 4): void {
  const h = 16 / rows;
  noiseFill(b, palette, seed, 6, 3, 0.75);
  // long horizontal grain
  for (let y = 0; y < 16; y++) {
    if (y % 3 === 0) {
      for (let x = 0; x < 16; x++) {
        const c = b.get(x, y);
        const f = 0.95 + ((x * 7 + y * 3) % 5) * 0.02;
        b.set(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
      }
    }
  }
  for (let r = 0; r < rows; r++) {
    const y0 = r * h;
    b.hline(0, 15, y0, seam);
    // staggered vertical seams
    const xSeam = (r % 2 === 0 ? 11 : 4);
    b.vline(xSeam, y0, Math.min(15, y0 + h - 1), seam);
  }
  for (let i = 0; i < 3; i++) {
    const x = b.rng.int(1, 14);
    const y = b.rng.int(1, 13);
    b.set(x, y, knot);
    b.set(x + 1, y, knot);
  }
  edgeDarken(b, 0.92);
}

p('oak_planks', (b) => planks(b, [rgb(0xa8813f), rgb(0xb08a45), rgb(0xb9924d), rgb(0xc19a55)], rgb(0x6f5222), rgb(0x86642c), 0x44d4));
p('birch_planks', (b) => planks(b, [rgb(0xc4ae74), rgb(0xccb77e), rgb(0xd4c089), rgb(0xdcc894)], rgb(0x8f7a48), rgb(0xa38d59), 0x55e5));
p('spruce_planks', (b) => planks(b, [rgb(0x6a4c26), rgb(0x73542c), rgb(0x7c5b32), rgb(0x856338)], rgb(0x452f14), rgb(0x543a1b), 0x66f6));

p('bookshelf', (b) => {
  planks(b, [rgb(0xa8813f), rgb(0xb08a45), rgb(0xb9924d), rgb(0xc19a55)], rgb(0x6f5222), rgb(0x86642c), 0x44d4);
  b.rect(0, 2, 16, 5, rgb(0x5b3d1c));
  b.rect(0, 9, 16, 5, rgb(0x5b3d1c));
  const spines = [rgb(0x9c3b32), rgb(0x2f5a92), rgb(0x35764a), rgb(0xc9a13c), rgb(0x7a4a8c), rgb(0xb5642e)];
  for (const y0 of [2, 9]) {
    let x = 0;
    while (x < 16) {
      const w = b.rng.int(1, 3);
      const c = b.pick(spines);
      for (let k = 0; k < w && x + k < 16; k++) {
        b.rect(x + k, y0, 1, 5, c);
        b.set(x + k, y0, [c[0] * 0.7, c[1] * 0.7, c[2] * 0.7, 255]);
        b.set(x + k, y0 + 4, [c[0] * 0.75, c[1] * 0.75, c[2] * 0.75, 255]);
      }
      x += w + (b.rng.chance(0.25) ? 1 : 0);
    }
  }
  edgeDarken(b, 0.9);
});

/* ------------------------------------------------------------------ */
/* Leaves                                                              */
/* ------------------------------------------------------------------ */

/**
 * Whether leaves are drawn with see-through gaps.
 *
 * "Fancy" gives the clustered cut-outs that make a canopy read as foliage you
 * can see through; "fast" fills them in for a solid, cheaper block.
 *
 * Note this only has an effect if it is set *before* the atlas is built - the
 * tiles are baked once. Setting it from the options screen therefore cannot work
 * without a rebuild, which is why it was reported as having no effect on fancy:
 * the atlas had already been painted with whatever mode was active at startup.
 * It defaults to on, and the mesh-cost saving for fast mode is handled
 * separately by `VoxelMesher.fastLeaves`, which *is* live.
 */
let leafHoles = true;
export function setLeafHoles(on: boolean): void {
  leafHoles = on;
}

function leaves(b: PixBuf, pal: readonly RGBA[], seed: number, holeRate: number): void {
  const n = tileNoise(16, 16, seed, 3, 3);
  const n2 = tileNoise(16, 16, seed ^ 0x9e37, 6, 2);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const v = n[y * 16 + x] * 0.72 + n2[y * 16 + x] * 0.28;
      const idx = Math.min(pal.length - 1, Math.floor(v * pal.length));
      b.set(x, y, pal[idx]);
    }
  }
  // Texture detail first, so it cannot be painted back over the gaps below.
  speckle(b, [pal[0][0] * 0.8, pal[0][1] * 0.8, pal[0][2] * 0.8, 255], 0.06);
  if (!leafHoles) return;
  /*
   * Cut-outs, matched to the original's leaf blocks.
   *
   * The reference is a dense, bright, evenly speckled mass with small gaps -
   * single texels and the odd pair - not the handful of large round blobs this
   * drew first. Big soft holes read as damage rather than foliage, and they let
   * so much through that the canopy stops looking solid at all.
   */
  const cells: [number, number][] = [];
  for (let i = 0; i < Math.round(16 * 16 * holeRate * 0.55); i++) {
    cells.push([b.rng.int(0, 15), b.rng.int(0, 15)]);
  }
  // a few two-cell gaps so the pattern is not uniformly single pixels
  for (let i = 0; i < 3; i++) {
    const x = b.rng.int(0, 15);
    const y = b.rng.int(0, 15);
    cells.push([x, y], [(x + 1) % 16, y]);
  }
  for (const [x, y] of cells) b.set(x, y, [0, 0, 0, 0]);
}

/*
 * Leaf palettes, matched to the original's blocks: bright and fairly saturated,
 * with a narrow tonal range. The old ramps started almost at black-green, which
 * made a canopy look like a shadowed mass rather than lit foliage - the single
 * biggest difference from the reference.
 */
p('oak_leaves', (b) => leaves(b, [rgb(0x3d7a24), rgb(0x488a2c), rgb(0x549a34), rgb(0x60aa3d), rgb(0x6dba47)], 0x81c3, 0.2));
p('birch_leaves', (b) => leaves(b, [rgb(0x4f9130), rgb(0x5ba238), rgb(0x68b341), rgb(0x75c34a), rgb(0x83d154)], 0x92d4, 0.22));
p('spruce_leaves', (b) => leaves(b, [rgb(0x2b5a20), rgb(0x336a27), rgb(0x3c7a2e), rgb(0x458a36), rgb(0x4f9a3e)], 0xa3e5, 0.17));

/* ------------------------------------------------------------------ */
/* Ores                                                                */
/* ------------------------------------------------------------------ */

function oreTile(b: PixBuf, mineral: RGBA, light: RGBA, dark: RGBA, count: number, seed: number, glow = false): void {
  noiseFill(b, STONE, seed, 5, 4, 1.25);
  speckle(b, rgb(0x5f5f5f), 0.03);
  blobs(b, mineral, count, 1.5, 2.6, light, dark);
  if (glow) speckle(b, light, 0.03);
  edgeDarken(b, 0.9);
}

p('coal_ore', (b) => oreTile(b, rgb(0x1d1d1d), rgb(0x333333), rgb(0x0e0e0e), 5, 0xc101));
p('iron_ore', (b) => oreTile(b, rgb(0xc08a63), rgb(0xdba985), rgb(0x8d5f3f), 5, 0xc202));
p('gold_ore', (b) => oreTile(b, rgb(0xe8c235), rgb(0xffee7a), rgb(0xa8841c), 5, 0xc303));
p('diamond_ore', (b) => oreTile(b, rgb(0x40d8d0), rgb(0x9df6f2), rgb(0x229a99), 5, 0xc404, true));
p('redstone_ore', (b) => oreTile(b, rgb(0xab1c1c), rgb(0xe04141), rgb(0x6d0f0f), 6, 0xc505));
p('lapis_ore', (b) => oreTile(b, rgb(0x2a4bab), rgb(0x4f76dd), rgb(0x18306e), 5, 0xc606));
p('ember_ore', (b) => {
  noiseFill(b, [rgb(0x5e1c1c), rgb(0x6c2323), rgb(0x7a2a2a)], 0xc707, 5, 3, 1.1);
  blobs(b, rgb(0xd8560f), 6, 1.5, 2.4, rgb(0xffb03a), rgb(0x8c2f06));
  edgeDarken(b, 0.9);
});

p('bloodrock', (b) => {
  noiseFill(b, [rgb(0x5c1d1d), rgb(0x662222), rgb(0x722828), rgb(0x7d2e2e)], 0xd808, 4, 4, 1.2);
  speckle(b, rgb(0x4a1616), 0.06);
  speckle(b, rgb(0x8d3a3a), 0.05);
  edgeDarken(b, 0.88);
});

p('molten_rock', (b) => {
  noiseFill(b, [rgb(0x54180f), rgb(0x65200f), rgb(0x772812)], 0xe909, 4, 3, 1.2);
  const n = tileNoise(16, 16, 0xbaad, 4, 3);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const v = n[y * 16 + x];
      if (v > 0.62) b.set(x, y, v > 0.72 ? rgb(0xffc247) : rgb(0xf07a12));
      else if (v < 0.34) b.set(x, y, rgb(0x3a0f08));
    }
  edgeDarken(b, 0.9);
});

p('portal_frame', (b) => {
  noiseFill(b, [rgb(0x24202e), rgb(0x2c2738), rgb(0x342e42)], 0xf00a, 4, 3, 1.1);
  speckle(b, rgb(0x6a5a8e), 0.07);
  speckle(b, rgb(0x8f7ab8), 0.03);
  edgeDarken(b, 0.9);
});

p('portal', (b) => {
  const n = tileNoise(16, 16, 0x1234, 3, 3);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const v = n[y * 16 + x];
      const c: RGBA = v > 0.66 ? rgb(0xb478ff, 220) : v > 0.42 ? rgb(0x8b46e0, 210) : rgb(0x5f2aa8, 200);
      b.set(x, y, c);
    }
});

/* ------------------------------------------------------------------ */
/* Utility blocks                                                      */
/* ------------------------------------------------------------------ */

p('glass', (b) => {
  b.fill([0, 0, 0, 0]);
  const frame: RGBA = rgb(0xcfe4ef, 205);
  for (let x = 0; x < 16; x++) {
    b.set(x, 0, frame);
    b.set(x, 15, frame);
  }
  for (let y = 0; y < 16; y++) {
    b.set(0, y, frame);
    b.set(15, y, frame);
  }
  // corner notches for a beveled pane look
  b.set(0, 0, [0, 0, 0, 0]);
  b.set(15, 0, [0, 0, 0, 0]);
  b.set(0, 15, [0, 0, 0, 0]);
  b.set(15, 15, [0, 0, 0, 0]);
  const hi: RGBA = rgb(0xffffff, 90);
  for (let k = 0; k < 6; k++) {
    b.set(3 + k, 9 - k, hi);
    b.set(4 + k, 9 - k, hi);
  }
  for (let k = 0; k < 4; k++) b.set(9 + k, 5 - k, hi);
  b.set(2, 2, rgb(0xffffff, 140));
});

p('torch', (b) => {
  b.fill([0, 0, 0, 0]);
  // wooden stem
  for (let y = 6; y < 16; y++) {
    b.set(7, y, rgb(0x8a6a42));
    b.set(8, y, rgb(0x6f5432));
  }
  b.set(7, 15, rgb(0x5c4526));
  b.set(8, 15, rgb(0x5c4526));
  // flame head
  const flame: [number, number, RGBA][] = [
    [7, 2, rgb(0xfff0a0)], [8, 2, rgb(0xffe07a)],
    [6, 3, rgb(0xffc63c)], [7, 3, rgb(0xffd95e)], [8, 3, rgb(0xffc63c)], [9, 3, rgb(0xf0a828)],
    [6, 4, rgb(0xf09a1c)], [7, 4, rgb(0xffb02e)], [8, 4, rgb(0xffa826)], [9, 4, rgb(0xe0851a)],
    [7, 5, rgb(0xd8701a)], [8, 5, rgb(0xc85f14)],
  ];
  for (const [x, y, c] of flame) b.set(x, y, c);
});

p('torch_top', (b) => {
  b.fill([0, 0, 0, 0]);
  b.rect(7, 7, 2, 2, rgb(0xffe07a));
  b.set(7, 7, rgb(0xfff6c0));
});

/*
 * The four side faces of a torch.
 *
 * `torch` above is a *billboard* sprite: a two-texel stem at x = 7..8 with the
 * flame above it, and everything else transparent. Mapped onto the 2x11-texel
 * side faces of the torch's box it produced mostly-empty faces, so a placed
 * torch read as a flat, ghostly sliver rather than a post.
 *
 * This texture fills the whole tile instead, and is deliberately uniform across
 * x: the faces are two screen pixels wide, so only one or two texel columns are
 * ever sampled and any horizontal detail would alias in and out as you move.
 * All the shape is in the rows - post, ember line, flame cap - which survive
 * minification intact.
 */
p('torch_side', (b) => {
  for (let y = 0; y < 16; y++) {
    let c: RGBA;
    // The face is 11 texels tall but the texture is 16 rows, so a flame drawn a
    // couple of rows deep lands under a pixel high and disappears. The cap is
    // deliberately thick - five rows - so it survives the downscale.
    if (y === 0) c = rgb(0xfffbe0);
    else if (y === 1) c = rgb(0xffe98a);
    else if (y === 2) c = rgb(0xffc63c);
    else if (y === 3) c = rgb(0xf5a021);
    else if (y === 4) c = rgb(0xd8701a);
    else if (y === 5) c = rgb(0x6b4f2c);
    else if (y === 14) c = rgb(0x7d5f39);
    else if (y === 15) c = rgb(0x5c4526);
    else c = rgb(0x8a6a42);
    for (let x = 0; x < 16; x++) b.set(x, y, c);
  }
});

p('crafting_table_top', (b) => {
  planks(b, [rgb(0xa8813f), rgb(0xb08a45), rgb(0xb9924d), rgb(0xc19a55)], rgb(0x6f5222), rgb(0x86642c), 0x44d4);
  const line = rgb(0x5a401c);
  b.hline(1, 14, 1, line);
  b.hline(1, 14, 8, line);
  b.hline(1, 14, 14, line);
  b.vline(1, 1, 14, line);
  b.vline(8, 1, 14, line);
  b.vline(14, 1, 14, line);
  b.rect(3, 3, 3, 3, rgb(0x8a6a34));
  b.rect(10, 4, 3, 3, rgb(0xc9a45e));
  b.rect(4, 10, 2, 2, rgb(0x7d5f2c));
  b.rect(10, 10, 4, 3, rgb(0x9c7a3e));
  edgeDarken(b, 0.92);
});

p('crafting_table_side', (b) => {
  planks(b, [rgb(0x9c7a3e), rgb(0xa4823f), rgb(0xad8a4a), rgb(0xb59255)], rgb(0x6f5222), rgb(0x86642c), 0x44d4);
  b.hline(0, 15, 0, rgb(0xc9a45e));
  b.rect(2, 3, 5, 4, rgb(0x7d5f2c));
  b.rect(9, 8, 5, 4, rgb(0x7d5f2c));
  b.hline(2, 6, 3, rgb(0x604718));
  b.hline(9, 13, 8, rgb(0x604718));
  edgeDarken(b, 0.9);
});

p('crafting_table_front', (b) => {
  planks(b, [rgb(0x9c7a3e), rgb(0xa4823f), rgb(0xad8a4a), rgb(0xb59255)], rgb(0x6f5222), rgb(0x86642c), 0x44d4);
  // saw + hammer motif
  b.rect(1, 4, 8, 2, rgb(0xc9b070));
  for (let x = 1; x < 9; x++) b.set(x, 3, rgb(0xe0c98a));
  b.rect(9, 3, 2, 6, rgb(0x6f5432));
  b.rect(11, 3, 5, 4, rgb(0x707070));
  b.hline(11, 15, 3, rgb(0x8c8c8c));
  b.rect(13, 7, 2, 6, rgb(0x7d5f2c));
  edgeDarken(b, 0.9);
});

function furnaceBase(b: PixBuf, front: boolean, lit: boolean): void {
  noiseFill(b, [rgb(0x6e6e6e), rgb(0x787878), rgb(0x828282), rgb(0x8a8a8a)], lit ? 0x7a11 : 0x7a10, 5, 3, 1.15);
  speckle(b, rgb(0x606060), 0.05);
  // stone brick-ish framing
  const edge = rgb(0x565656);
  b.hline(0, 15, 0, edge);
  b.hline(0, 15, 15, edge);
  if (front) {
    b.rect(3, 4, 10, 9, rgb(0x2e2e2e));
    b.hline(3, 12, 4, rgb(0x1c1c1c));
    b.hline(3, 12, 12, rgb(0x1c1c1c));
    b.vline(3, 4, 12, rgb(0x1c1c1c));
    b.vline(12, 4, 12, rgb(0x1c1c1c));
    if (lit) {
      b.rect(4, 9, 8, 3, rgb(0xff8a1a));
      b.rect(4, 8, 8, 1, rgb(0xffc247));
      for (let x = 4; x < 12; x += 2) {
        b.set(x, 7, rgb(0xffd76a));
        b.set(x + 1, 10, rgb(0xd85a10));
      }
    } else {
      b.rect(4, 9, 8, 3, rgb(0x181818));
      for (let x = 4; x < 12; x += 2) b.set(x, 9, rgb(0x4a4a4a));
    }
    b.hline(2, 13, 3, rgb(0x9a9a9a));
  } else {
    b.rect(2, 2, 12, 2, rgb(0x7a7a7a));
    b.hline(2, 13, 4, rgb(0x626262));
  }
  edgeDarken(b, 0.9);
}

p('furnace_side', (b) => furnaceBase(b, false, false));
p('furnace_top', (b) => {
  noiseFill(b, [rgb(0x6e6e6e), rgb(0x787878), rgb(0x828282)], 0x7a12, 5, 3, 1.1);
  b.rect(5, 5, 6, 6, rgb(0x5a5a5a));
  b.hline(5, 10, 5, rgb(0x4a4a4a));
  edgeDarken(b, 0.9);
});
p('furnace_front', (b) => furnaceBase(b, true, false));
p('furnace_front_lit', (b) => furnaceBase(b, true, true));

p('chest_top', (b) => {
  planks(b, [rgb(0x8a6a34), rgb(0x927140), rgb(0x9a7848), rgb(0xa28050)], rgb(0x5e4426), rgb(0x6f5432), 0x1234, 3);
  b.rect(6, 0, 4, 3, rgb(0xd8c070));
  b.hline(6, 9, 0, rgb(0xb09850));
  edgeDarken(b, 0.85);
});
p('chest_side', (b) => {
  planks(b, [rgb(0x8a6a34), rgb(0x927140), rgb(0x9a7848), rgb(0xa28050)], rgb(0x5e4426), rgb(0x6f5432), 0x1234, 3);
  b.hline(0, 15, 5, rgb(0x5e4426));
  b.hline(0, 15, 6, rgb(0x4a3419));
  edgeDarken(b, 0.85);
});
p('chest_front', (b) => {
  planks(b, [rgb(0x8a6a34), rgb(0x927140), rgb(0x9a7848), rgb(0xa28050)], rgb(0x5e4426), rgb(0x6f5432), 0x1234, 3);
  b.hline(0, 15, 5, rgb(0x5e4426));
  b.hline(0, 15, 6, rgb(0x4a3419));
  b.rect(6, 4, 4, 5, rgb(0xd8c070));
  b.rect(7, 6, 2, 2, rgb(0x5e4426));
  edgeDarken(b, 0.85);
});

p('bricks', (b) => {
  const mortar = rgb(0xa9a49b);
  const pal = [rgb(0x8d4a38), rgb(0x97533f), rgb(0xa05b46), rgb(0x82412f)];
  b.fill(mortar);
  const bh = 4;
  for (let row = 0; row < 4; row++) {
    const y0 = row * bh;
    const off = row % 2 === 0 ? 0 : 4;
    for (let i = -1; i < 3; i++) {
      const x0 = i * 8 + off;
      const c = b.pick(pal);
      for (let y = y0; y < y0 + 3 && y < 16; y++)
        for (let x = x0; x < x0 + 7; x++) {
          if (x < 0 || x > 15) continue;
          const f = 0.94 + ((x * 5 + y * 3) % 4) * 0.03;
          b.set(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
        }
    }
  }
  speckle(b, rgb(0x6f3427), 0.03);
  edgeDarken(b, 0.93);
});

p('stone_bricks', (b) => {
  const mortar = rgb(0x5a5a5a);
  const pal = [rgb(0x7c7c7c), rgb(0x858585), rgb(0x8e8e8e), rgb(0x747474)];
  b.fill(mortar);
  const bh = 8;
  for (let row = 0; row < 2; row++) {
    const y0 = row * bh;
    const off = row % 2 === 0 ? 0 : 4;
    for (let i = -1; i < 3; i++) {
      const x0 = i * 8 + off;
      const c = b.pick(pal);
      for (let y = y0; y < y0 + 7; y++)
        for (let x = x0; x < x0 + 7; x++) {
          if (x < 0 || x > 15) continue;
          const f = 0.95 + ((x * 7 + y * 3) % 4) * 0.025;
          b.set(x, y, [c[0] * f, c[1] * f, c[2] * f, 255]);
        }
    }
  }
  speckle(b, rgb(0x666666), 0.04);
  edgeDarken(b, 0.92);
});

p('farmland', (b) => {
  noiseFill(b, [rgb(0x5c3f26), rgb(0x66472c), rgb(0x704e31)], 0x9911, 4, 3, 1.1);
  const furrow = rgb(0x452f1c);
  b.hline(0, 15, 2, furrow);
  b.hline(0, 15, 6, furrow);
  b.hline(0, 15, 10, furrow);
  b.hline(0, 15, 14, furrow);
  speckle(b, rgb(0x7d5738), 0.05);
  edgeDarken(b, 0.9);
});

p('cactus_top', (b) => {
  noiseFill(b, [rgb(0x3f7a30), rgb(0x478437), rgb(0x4f8e3e)], 0x7711, 4, 3, 0.9);
  b.rect(5, 5, 6, 6, rgb(0x35682a));
  speckle(b, rgb(0xdbe8c4), 0.06);
  edgeDarken(b, 0.86);
});
p('cactus_side', (b) => {
  noiseFill(b, [rgb(0x3f7a30), rgb(0x478437), rgb(0x4f8e3e)], 0x7722, 4, 3, 0.9);
  b.vline(1, 0, 15, rgb(0x2f5c22));
  b.vline(14, 0, 15, rgb(0x2f5c22));
  b.vline(4, 0, 15, rgb(0x356a28));
  b.vline(11, 0, 15, rgb(0x356a28));
  for (let y = 1; y < 16; y += 3) {
    b.set(3, y, rgb(0xe0ecc8));
    b.set(12, y + 1 < 16 ? y + 1 : y, rgb(0xe0ecc8));
    b.set(7, y + 2 < 16 ? y + 2 : y, rgb(0xc8d8a8));
  }
  edgeDarken(b, 0.88);
});

p('hay_side', (b) => {
  noiseFill(b, [rgb(0xb08a26), rgb(0xbc952c), rgb(0xc8a033), rgb(0xd4ab3b)], 0x6611, 3, 3, 1);
  const band = rgb(0x7d6020);
  b.hline(0, 15, 1, band);
  b.hline(0, 15, 2, band);
  b.hline(0, 15, 13, band);
  b.hline(0, 15, 14, band);
  edgeDarken(b, 0.9);
});
p('hay_top', (b) => {
  noiseFill(b, [rgb(0xb08a26), rgb(0xbc952c), rgb(0xc8a033)], 0x6622, 3, 3, 1);
  b.rect(3, 3, 10, 10, rgb(0x8a6a1c));
  b.rect(5, 5, 6, 6, rgb(0xc8a033));
  edgeDarken(b, 0.9);
});

p('pumpkin_side', (b) => {
  noiseFill(b, [rgb(0xb85f16), rgb(0xc4681b), rgb(0xd07220), rgb(0xdc7c26)], 0x5511, 3, 3, 1);
  for (const x of [1, 5, 10, 14]) b.vline(x, 0, 15, rgb(0x8f4710));
  b.hline(0, 15, 0, rgb(0x8f4710));
  b.hline(0, 15, 15, rgb(0x8f4710));
  edgeDarken(b, 0.9);
});
p('pumpkin_top', (b) => {
  noiseFill(b, [rgb(0xb85f16), rgb(0xc4681b), rgb(0xd07220)], 0x5522, 3, 3, 1);
  b.rect(6, 6, 4, 4, rgb(0x7d6320));
  b.rect(7, 7, 2, 2, rgb(0x5c4715));
  edgeDarken(b, 0.9);
});
p('pumpkin_face', (b) => {
  noiseFill(b, [rgb(0xb85f16), rgb(0xc4681b), rgb(0xd07220), rgb(0xdc7c26)], 0x5511, 3, 3, 1);
  for (const x of [1, 5, 10, 14]) b.vline(x, 0, 15, rgb(0x8f4710));
  const dark = rgb(0x2a1204);
  // triangular eyes
  for (const ex of [3, 10]) {
    for (let k = 0; k < 3; k++) b.hline(ex + k, ex + 2 - k, 4 + k, dark);
  }
  b.rect(6, 9, 4, 2, dark);
  b.set(5, 11, dark);
  b.set(10, 11, dark);
  edgeDarken(b, 0.9);
});

p('melon_side', (b) => {
  noiseFill(b, [rgb(0x4c8a28), rgb(0x549632), rgb(0x5ca23b)], 0x4433, 3, 3, 1);
  for (let x = 0; x < 16; x++) {
    const stripe = Math.sin((x / 16) * Math.PI * 5);
    if (stripe > 0.55) for (let y = 0; y < 16; y++) b.set(x, y, rgb(0x74b055));
    else if (stripe < -0.7) for (let y = 0; y < 16; y++) b.set(x, y, rgb(0x33601a));
  }
  edgeDarken(b, 0.9);
});
p('melon_top', (b) => {
  noiseFill(b, [rgb(0x4c8a28), rgb(0x549632), rgb(0x5ca23b)], 0x4444, 3, 3, 1);
  b.rect(6, 6, 4, 4, rgb(0x8f9c4a));
  edgeDarken(b, 0.9);
});

/* ------------------------------------------------------------------ */
/* Wools                                                               */
/* ------------------------------------------------------------------ */

function wool(b: PixBuf, base: number, seed: number): void {
  const c = rgb(base);
  const darker: RGBA = [c[0] * 0.9, c[1] * 0.9, c[2] * 0.9, 255];
  const lighter: RGBA = [Math.min(255, c[0] * 1.09), Math.min(255, c[1] * 1.09), Math.min(255, c[2] * 1.09), 255];
  b.fill(c);
  const n = tileNoise(16, 16, seed, 4, 3);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const v = n[y * 16 + x];
      if (v < 0.4) b.set(x, y, darker);
      else if (v > 0.62) b.set(x, y, lighter);
    }
  for (let i = 0; i < 26; i++) {
    const x = b.rng.int(0, 15);
    const y = b.rng.int(0, 14);
    const cc = b.rng.chance(0.5) ? darker : lighter;
    b.set(x, y, cc);
    b.set(x, y + 1, cc);
  }
  edgeDarken(b, 0.93);
}

p('white_wool', (b) => wool(b, 0xe6e6e6, 0xaa01));
p('red_wool', (b) => wool(b, 0xb03a34, 0xaa02));
p('blue_wool', (b) => wool(b, 0x35509c, 0xaa03));
p('yellow_wool', (b) => wool(b, 0xd6c33c, 0xaa04));
p('green_wool', (b) => wool(b, 0x4a7a2e, 0xaa05));
p('black_wool', (b) => wool(b, 0x272727, 0xaa06));
p('brown_wool', (b) => wool(b, 0x6b4a2a, 0xaa07));
p('orange_wool', (b) => wool(b, 0xd0762a, 0xaa08));
p('purple_wool', (b) => wool(b, 0x7a3b9c, 0xaa09));
p('lime_wool', (b) => wool(b, 0x76bb32, 0xaa0a));
p('cyan_wool', (b) => wool(b, 0x2f8f96, 0xaa0b));
p('gray_wool', (b) => wool(b, 0x5c5c5c, 0xaa0c));

/* ------------------------------------------------------------------ */
/* Metal / gem blocks                                                  */
/* ------------------------------------------------------------------ */

function metalBlock(b: PixBuf, base: number, seed: number, banding = true): void {
  const c = rgb(base);
  const dark: RGBA = [c[0] * 0.86, c[1] * 0.86, c[2] * 0.86, 255];
  const light: RGBA = [Math.min(255, c[0] * 1.12 + 10), Math.min(255, c[1] * 1.12 + 10), Math.min(255, c[2] * 1.12 + 10), 255];
  b.fill(c);
  if (banding) {
    b.hline(0, 15, 0, light);
    b.hline(0, 15, 1, light);
    b.hline(0, 15, 14, dark);
    b.hline(0, 15, 15, dark);
    b.vline(0, 0, 15, dark);
    b.vline(15, 0, 15, dark);
  }
  const n = tileNoise(16, 16, seed, 4, 2);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      if (n[y * 16 + x] > 0.6) b.set(x, y, light);
      else if (n[y * 16 + x] < 0.38) b.set(x, y, dark);
    }
  edgeDarken(b, 0.9);
}

p('iron_block', (b) => metalBlock(b, 0xd6d6d6, 0xbb01));
p('gold_block', (b) => metalBlock(b, 0xf0cb3c, 0xbb02));
p('diamond_block', (b) => {
  noiseFill(b, [rgb(0x3fbfb8), rgb(0x4fd0c8), rgb(0x60e0d8)], 0xbb03, 4, 3, 1);
  const gem = rgb(0xa8f6f0);
  for (const [x, y] of [[3, 3], [10, 3], [6, 10], [11, 11], [2, 11]]) {
    b.set(x, y, gem);
    b.set(x + 1, y, gem);
    b.set(x, y + 1, gem);
    b.set(x + 1, y + 1, gem);
  }
  edgeDarken(b, 0.9);
});
p('coal_block', (b) => {
  noiseFill(b, [rgb(0x131313), rgb(0x1a1a1a), rgb(0x232323), rgb(0x2c2c2c)], 0xbb04, 4, 3, 1.2);
  speckle(b, rgb(0x3a3a3a), 0.05);
  edgeDarken(b, 0.85);
});
p('lapis_block', (b) => {
  noiseFill(b, [rgb(0x1c3a9c), rgb(0x2547b0), rgb(0x2f55c4)], 0xbb05, 4, 3, 1);
  blobs(b, rgb(0x6f92e8), 5, 1.4, 2.2, rgb(0xa8c0f8), rgb(0x14296e));
  edgeDarken(b, 0.9);
});
p('redstone_block', (b) => {
  noiseFill(b, [rgb(0x8f1414), rgb(0xa11a1a), rgb(0xb32222)], 0xbb06, 4, 3, 1.1);
  blobs(b, rgb(0xe03a3a), 6, 1.2, 2.2, rgb(0xff7a7a), rgb(0x5e0a0a));
  edgeDarken(b, 0.9);
});

/* ------------------------------------------------------------------ */
/* Doors & fences                                                      */
/* ------------------------------------------------------------------ */

p('oak_door', (b) => {
  planks(b, [rgb(0xa8813f), rgb(0xb08a45), rgb(0xb9924d), rgb(0xc19a55)], rgb(0x6f5222), rgb(0x86642c), 0x44d4, 8);
  b.rect(2, 2, 12, 5, rgb(0x9c7a3e));
  b.rect(2, 9, 12, 5, rgb(0x9c7a3e));
  b.hline(2, 13, 2, rgb(0x6f5222));
  b.hline(2, 13, 9, rgb(0x6f5222));
  b.rect(11, 7, 3, 2, rgb(0x6f5432));
  edgeDarken(b, 0.9);
});

/* ------------------------------------------------------------------ */
/* Plants (cross sprites)                                              */
/* ------------------------------------------------------------------ */

function crossBase(b: PixBuf): void {
  b.fill([0, 0, 0, 0]);
}

p('tall_grass', (b) => {
  crossBase(b);
  const greens = [rgb(0x3f7a26), rgb(0x4a8a2e), rgb(0x569a37), rgb(0x62aa40)];
  for (let i = 0; i < 13; i++) {
    const x = b.rng.int(1, 14);
    const h = b.rng.int(5, 11);
    const bend = b.rng.chance(0.5) ? 1 : -1;
    const c = b.pick(greens);
    for (let k = 0; k < h; k++) {
      const y = 15 - k;
      const xx = x + (k > h * 0.6 ? bend : 0);
      b.set(xx, y, c);
    }
    b.set(x + (h > 9 ? bend : 0), 15 - h, [c[0] * 1.15, c[1] * 1.15, c[2] * 1.15, 255]);
  }
});

function flower(b: PixBuf, petal: RGBA, petalDark: RGBA, center: RGBA): void {
  crossBase(b);
  const stem = rgb(0x3f7a26);
  for (let y = 7; y < 16; y++) b.set(7, y, stem);
  b.set(6, 11, stem);
  b.set(8, 13, rgb(0x4a8a2e));
  const petals: [number, number][] = [[6, 3], [7, 3], [8, 3], [6, 4], [7, 4], [8, 4], [6, 5], [7, 5], [8, 5], [5, 4], [9, 4], [7, 2]];
  for (const [x, y] of petals) b.set(x, y, petal);
  b.set(5, 3, petalDark);
  b.set(9, 5, petalDark);
  b.set(6, 6, petalDark);
  b.set(8, 6, petalDark);
  b.set(7, 4, center);
  b.set(7, 3, center);
}

p('red_flower', (b) => flower(b, rgb(0xd63a34), rgb(0x9e2420), rgb(0xf0d060)));
p('yellow_flower', (b) => flower(b, rgb(0xe8d24a), rgb(0xb09a24), rgb(0xf6ee9a)));
p('blue_flower', (b) => flower(b, rgb(0x4a6ad8), rgb(0x2e46a0), rgb(0xe0e8f8)));

p('dead_bush', (b) => {
  crossBase(b);
  const brown = [rgb(0x6b5228), rgb(0x7d6234), rgb(0x8f7040)];
  for (let i = 0; i < 10; i++) {
    const x = b.rng.int(2, 13);
    const y0 = b.rng.int(9, 15);
    const len = b.rng.int(2, 5);
    const c = b.pick(brown);
    for (let k = 0; k < len; k++) b.set(x + (k % 2 === 0 ? 0 : b.rng.chance(0.5) ? 1 : -1), y0 - k, c);
  }
  for (let y = 6; y < 16; y++) b.set(7, y, rgb(0x6b5228));
});

p('reeds', (b) => {
  crossBase(b);
  const greens = [rgb(0x4a8a4a), rgb(0x56a056), rgb(0x62b062)];
  for (let i = 0; i < 6; i++) {
    const x = 4 + i * 1.5 | 0;
    const c = greens[i % greens.length];
    for (let y = 2 + (i % 3); y < 16; y++) b.set(x, y, c);
    b.set(x, 2 + (i % 3), rgb(0x8fce8f));
  }
  for (let y = 5; y < 16; y += 4) {
    b.set(3, y, rgb(0x56a056));
    b.set(11, y + 1, rgb(0x56a056));
  }
});

p('oak_sapling', (b) => sapling(b, rgb(0x3f7a2a), rgb(0x54a038), rgb(0x6b5230)));
p('birch_sapling', (b) => sapling(b, rgb(0x4f8433), rgb(0x66a844), rgb(0x6b5230)));
p('spruce_sapling', (b) => sapling(b, rgb(0x2c5723), rgb(0x3d7331), rgb(0x4a3823)));

function sapling(b: PixBuf, dark: RGBA, light: RGBA, stem: RGBA): void {
  crossBase(b);
  for (let y = 10; y < 16; y++) b.set(7, y, stem);
  const shape: [number, number][] = [[6, 5], [7, 5], [8, 5], [5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [4, 7], [5, 7], [6, 7], [7, 7], [8, 7], [9, 7], [10, 7], [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [6, 9], [7, 9], [8, 9], [7, 4]];
  for (const [x, y] of shape) b.set(x, y, b.rng.chance(0.35) ? light : dark);
  b.set(7, 4, light);
}

p('red_mushroom', (b) => {
  crossBase(b);
  for (let y = 9; y < 16; y++) b.set(7, y, rgb(0xe0dcc8));
  for (let y = 9; y < 16; y++) b.set(8, y, rgb(0xc8c4b0));
  const cap = rgb(0xc03028);
  for (const [x, y] of [[5, 6], [6, 6], [7, 6], [8, 6], [9, 6], [4, 7], [5, 7], [6, 7], [7, 7], [8, 7], [9, 7], [10, 7], [5, 8], [6, 8], [7, 8], [8, 8], [9, 8]]) b.set(x, y, cap);
  for (const [x, y] of [[5, 7], [8, 6], [7, 8], [9, 7]]) b.set(x, y, rgb(0xf0e8e0));
  b.set(6, 6, rgb(0x8a1c16));
});

p('brown_mushroom', (b) => {
  crossBase(b);
  for (let y = 10; y < 16; y++) b.set(7, y, rgb(0xe0dcc8));
  const cap = rgb(0x9c7448);
  for (const [x, y] of [[6, 7], [7, 7], [8, 7], [5, 8], [6, 8], [7, 8], [8, 8], [9, 8], [5, 9], [6, 9], [7, 9], [8, 9], [9, 9]]) b.set(x, y, cap);
  b.set(7, 7, rgb(0x7d5a34));
  b.set(6, 8, rgb(0xb08a58));
});

p('wheat_stage7', (b) => {
  crossBase(b);
  const gold = [rgb(0xc4a02c), rgb(0xd4b038), rgb(0xe0c04a)];
  for (let i = 0; i < 5; i++) {
    const x = 3 + i * 2 + (i % 2);
    const h = 9 + (i % 3);
    for (let k = 0; k < h; k++) b.set(x, 15 - k, rgb(0x8f9c3a));
    const c = gold[i % 3];
    for (let k = 0; k < 5; k++) {
      const y = 15 - h + k;
      b.set(x, y, c);
      if (k % 2 === 0) b.set(x - 1, y, c);
      if (k % 2 === 1) b.set(x + 1, y, c);
    }
  }
});

/* ------------------------------------------------------------------ */
/* Fluids                                                              */
/* ------------------------------------------------------------------ */

p('water_still', (b) => {
  /*
   * Tuned against a reference screenshot of the original: that water is a light,
   * bright blue rather than a deep one, and clearly see-through. The palette
   * here is therefore shifted up in brightness and the tonal drift kept subtle -
   * dark tones make water read as a solid slab no matter how transparent it is,
   * because there is nothing bright left to see through to.
   */
  const base = [rgb(0x3a6bd8), rgb(0x3f76e4), rgb(0x447ff0), rgb(0x4a88f8)];
  noiseFill(b, base, 0x1f2e, 5, 3, 0.5);
  // two very shallow crossing waves, just enough to break up the flatness
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const w = Math.sin((x / 16) * Math.PI * 2 + (y / 16) * Math.PI * 1.2) * 0.5 + 0.5;
      const w2 = Math.sin((y / 16) * Math.PI * 2 - (x / 16) * Math.PI * 0.8) * 0.5 + 0.5;
      const v = w * 0.6 + w2 * 0.4;
      if (v > 0.84) b.set(x, y, rgb(0x6b9cf6));
      else if (v < 0.16) b.set(x, y, rgb(0x3263cf));
    }
  }
  // sparse brighter cells, the way light catches the surface
  for (let i = 0; i < 9; i++) b.set(b.rng.int(0, 15), b.rng.int(0, 15), rgb(0x7aa8fa));
  // and a few darker patches for depth
  for (let i = 0; i < 6; i++) b.set(b.rng.int(0, 15), b.rng.int(0, 15), rgb(0x2f5cc2));
});

p('lava_still', (b) => {
  noiseFill(b, LAVA, 0x2f3e, 4, 3, 1.3);
  const n = tileNoise(16, 16, 0x77aa, 4, 3);
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const v = n[y * 16 + x];
      if (v > 0.68) b.set(x, y, rgb(0xffe070));
      else if (v < 0.26) b.set(x, y, rgb(0x8a1e04));
    }
  blobs(b, rgb(0xffc247), 4, 1.5, 2.4, rgb(0xfff3b0), rgb(0xd8480a));
  edgeDarken(b, 0.95);
});

/* ------------------------------------------------------------------ */
/* Crack overlay stages                                                */
/* ------------------------------------------------------------------ */

for (let stage = 0; stage < 8; stage++) {
  p(`destroy_stage_${stage}`, (b) => {
    b.fill([0, 0, 0, 0]);
    const dark: RGBA = [0x10, 0x10, 0x10, 190];
    const mid: RGBA = [0x30, 0x30, 0x30, 120];
    const branches = 1 + stage;
    const len = 3 + stage * 1.6;
    for (let i = 0; i < branches; i++) {
      let x = 8 + Math.round(Math.cos(i * 2.1) * 3);
      let y = 8 + Math.round(Math.sin(i * 2.1) * 3);
      let dx = Math.cos(i * 0.9) * 0.8;
      let dy = Math.sin(i * 0.9) * 0.8;
      for (let k = 0; k < len; k++) {
        b.set(x, y, dark);
        if (k % 2 === 0) b.set(x + 1, y, mid);
        dx += (b.rng.next() - 0.5) * 0.7;
        dy += (b.rng.next() - 0.5) * 0.7;
        const m = Math.hypot(dx, dy) || 1;
        dx /= m;
        dy /= m;
        x = Math.max(0, Math.min(15, Math.round(x + dx * 1.3)));
        y = Math.max(0, Math.min(15, Math.round(y + dy * 1.3)));
      }
    }
    // a crack always starts at the centre
    b.set(8, 8, dark);
    b.set(7, 8, mid);
  });
}

/* ------------------------------------------------------------------ */

/** Paint a tile by name into a fresh buffer (deterministic). */
export function paintTile(name: string): PixBuf {
  const buf = new PixBuf(TILE, TILE, hashInt(name.length * 2654435761) ^ hashInt(name.split('').reduce((a, c) => a + c.charCodeAt(0) * 31, 7)));
  const fn = painters[name];
  if (!fn) {
    // loud magenta so a missing painter is impossible to miss in QA renders
    buf.fill(rgb(0xff00ff));
    return buf;
  }
  fn(buf);
  return buf;
}
