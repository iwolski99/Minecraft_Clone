/**
 * Item sprites (16x16) painted procedurally: tools, ingots, food, misc.
 * Blocks placeable in the world are drawn as isometric previews of their own
 * block textures instead of getting a separate sprite.
 *
 * ## How these are painted
 *
 * 16x16 is the established art scale (it is the block tile size too) and it
 * stays that way - quality here comes from better pixel art, not more pixels.
 * Every sprite is built from four things:
 *
 *   1. a **five-tone ramp** per material (`ramp()`), so wood, stone, iron, gold
 *      and gem each have their own shadow / base / light / specular steps
 *      instead of one flat colour,
 *   2. a **silhouette** authored either as an ASCII pattern (the five tool
 *      shapes, shared by all five tool materials) or as row spans,
 *   3. a **bevel** pass that lights every texel whose up or left neighbour is
 *      empty and darkens every texel whose down or right neighbour is empty, so
 *      the light comes from the upper left on *every* item with no per-item
 *      work,
 *   4. a **one-texel outline** in a near-black ink tinted towards the item's own
 *      average colour, which is what keeps a sprite readable against the sky,
 *      against stone, and in a 34px hotbar slot.
 *
 * All four run inside `paintItem()`, so a new item cannot be added without them.
 */

import { PixBuf, RGBA, rgb, tileNoise } from './pixel.js';
import { hashInt } from '../util/rng.js';

export const ITEM_TILE = 16;

type Painter = (b: PixBuf) => void;
const painters: Record<string, Painter> = {};
function p(name: string, fn: Painter): void {
  painters[name] = fn;
}
export function itemPainter(name: string): Painter | undefined {
  return painters[name];
}
export function itemNames(): string[] {
  return Object.keys(painters);
}

/* ------------------------------------------------------------------ */
/* Colour                                                              */
/* ------------------------------------------------------------------ */

type Pt = readonly [number, number];
type Rgb = readonly [number, number, number];

const BLACK: Rgb = [0, 0, 0];
const WHITE: Rgb = [255, 255, 255];

function mixTo(c: RGBA, t: Rgb, k: number): RGBA {
  return [c[0] + (t[0] - c[0]) * k, c[1] + (t[1] - c[1]) * k, c[2] + (t[2] - c[2]) * k, c[3]];
}
/** Pull a colour towards black (k = 0 keeps it, k = 1 is black). */
function darken(c: RGBA, k: number): RGBA {
  return mixTo(c, BLACK, k);
}
/** Pull a colour towards white. */
function lighten(c: RGBA, k: number): RGBA {
  return mixTo(c, WHITE, k);
}

/**
 * A five-tone material ramp.
 *
 * Two or three tones is the minimum for pixel art to read as a *material*; one
 * tone reads as a flat sticker, which is what made the old sprites look cheap.
 */
interface Ramp {
  deep: RGBA;
  shadow: RGBA;
  base: RGBA;
  light: RGBA;
  /** specular - metal edges and gem facets only */
  hi: RGBA;
}

function ramp(hex: number): Ramp {
  const base = rgb(hex);
  return {
    deep: darken(base, 0.58),
    shadow: darken(base, 0.3),
    base,
    light: lighten(base, 0.26),
    hi: lighten(base, 0.56),
  };
}

const WOOD = ramp(0x9a7442);
const STONE = ramp(0x8e8e8e);
const IRON = ramp(0xcfcfcf);
const GOLD = ramp(0xf0cb3c);
const DIAMOND = ramp(0x5ce0d8);
/** Every tool handle in the game shares one wood, as it does in the block atlas. */
const HANDLE = ramp(0x8a6a42);

/* ------------------------------------------------------------------ */
/* Painting helpers                                                    */
/* ------------------------------------------------------------------ */

/**
 * Paint a sprite from 16 rows of 16 characters.
 *
 * `.` is transparent and any other character is looked up in `legend`. Patterns
 * are used for the five tool shapes, which are shared by the wooden / stone /
 * iron / golden / diamond variants - the silhouette is authored once and the
 * material is swapped underneath it.
 */
function paintPattern(b: PixBuf, rows: readonly string[], legend: Record<string, RGBA>): void {
  for (let y = 0; y < rows.length && y < b.h; y++) {
    const row = rows[y];
    for (let x = 0; x < row.length && x < b.w; x++) {
      const c = legend[row[x]];
      if (c) b.set(x, y, c);
    }
  }
}

/** Legend for a tool: `D/s/b/l/h` is the head material, `d/k/w/u` the handle wood. */
function toolLegend(head: Ramp, handle: Ramp): Record<string, RGBA> {
  return {
    D: head.deep,
    s: head.shadow,
    b: head.base,
    l: head.light,
    h: head.hi,
    d: handle.deep,
    k: handle.shadow,
    w: handle.base,
    u: handle.light,
  };
}

/** Paint a shape as a list of `[row, firstColumn, lastColumn]` spans. */
function spans(b: PixBuf, rows: ReadonlyArray<readonly number[]>, c: RGBA): void {
  for (const [y, x0, x1] of rows) b.hline(x0, x1, y, c);
}

/** Bresenham points from (x0,y0) to (x1,y1), inclusive. */
function linePoints(x0: number, y0: number, x1: number, y1: number): Pt[] {
  const out: Pt[] = [];
  const dx = Math.abs(x1 - x0);
  const dy = Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1;
  const sy = y0 < y1 ? 1 : -1;
  let err = dx - dy;
  let x = x0;
  let y = y0;
  for (let guard = 0; guard < 256; guard++) {
    out.push([x, y]);
    if (x === x1 && y === y1) break;
    const e2 = 2 * err;
    if (e2 > -dy) {
      err -= dy;
      x += sx;
    }
    if (e2 < dx) {
      err += dx;
      y += sy;
    }
  }
  return out;
}

/**
 * A two-texel-thick diagonal shaft with wood grain.
 *
 * The upper-left texel of the pair takes the light and every third step the pair
 * drops a tone, which reads as grain bands running across the shaft rather than
 * as a flat stripe.
 */
function woodShaft(b: PixBuf, pts: readonly Pt[], r: Ramp): void {
  for (let i = 0; i < pts.length; i++) {
    const [x, y] = pts[i];
    const band = i % 3 === 2;
    b.set(x, y, band ? r.base : r.light);
    b.set(x + 1, y, band ? r.shadow : r.base);
  }
}

/* ------------------------------------------------------------------ */
/* The two finishing passes every item gets                            */
/* ------------------------------------------------------------------ */

function maskOf(b: PixBuf): Uint8Array {
  const mask = new Uint8Array(b.w * b.h);
  for (let i = 0; i < mask.length; i++) mask[i] = b.data[i * 4 + 3] >= 128 ? 1 : 0;
  return mask;
}

/**
 * Light from the upper left.
 *
 * A texel whose up or left neighbour is empty is on a lit rim and is lifted; a
 * texel whose down or right neighbour is empty is on a shadowed rim and is sunk.
 * One-texel features are lit *and* shadowed and are left exactly as painted,
 * which is what keeps a sword's crossguard and a wheat stalk crisp.
 */
function bevel(b: PixBuf, mask: Uint8Array): void {
  const solid = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= b.w || y >= b.h ? 0 : mask[y * b.w + x];
  const original = new Uint8ClampedArray(b.data);
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (!mask[y * b.w + x]) continue;
      const lit = !solid(x, y - 1) || !solid(x - 1, y);
      const shaded = !solid(x, y + 1) || !solid(x + 1, y);
      if (lit === shaded) continue; // interior texel, or a one-texel feature
      const i = (y * b.w + x) * 4;
      const c: RGBA = [original[i], original[i + 1], original[i + 2], 255];
      b.set(x, y, lit ? lighten(c, 0.2) : darken(c, 0.24));
    }
  }
}

/**
 * Grow a one-texel outline around the silhouette.
 *
 * Only the four edge neighbours count, so diagonal corners stay open - the
 * classic pixel-art outline. The ink is near-black but tinted towards the
 * sprite's own average colour, so a gold ingot's outline is a warm dark brown
 * and coal's is nearly invisible against the coal itself, which is correct.
 */
function outline(b: PixBuf): void {
  const before = new Uint8ClampedArray(b.data);
  const alphaAt = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= b.w || y >= b.h ? 0 : before[(y * b.w + x) * 4 + 3];

  let r = 0;
  let g = 0;
  let bl = 0;
  let n = 0;
  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (alphaAt(x, y) < 128) continue;
      const i = (y * b.w + x) * 4;
      r += before[i];
      g += before[i + 1];
      bl += before[i + 2];
      n++;
    }
  }
  if (!n) return;
  // Only a *hint* of the material colour goes into the ink. Tinting it harder
  // made the outline of a white item (bone, paper, iron) lighter than the
  // sprite's own shadows, which defeats the point of having an outline at all.
  const ink = mixTo(rgb(0x14101a), [r / n, g / n, bl / n], 0.16);

  for (let y = 0; y < b.h; y++) {
    for (let x = 0; x < b.w; x++) {
      if (alphaAt(x, y) >= 128) continue;
      if (alphaAt(x - 1, y) >= 128 || alphaAt(x + 1, y) >= 128 || alphaAt(x, y - 1) >= 128 || alphaAt(x, y + 1) >= 128) {
        b.set(x, y, ink);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Tool silhouettes                                                    */
/* ------------------------------------------------------------------ */

const PICKAXE = [
  '................',
  '.......bbb......',
  '.....bbllbbb....',
  '...bbllllbbbb...',
  '..bbllbbbbbbbs..',
  '.ssb.......bbbb.',
  '.s..........uw..',
  '...........uw...',
  '..........uw....',
  '.........uw.....',
  '........uw......',
  '.......uw.......',
  '......uw........',
  '.....wk.........',
  '....uw..........',
  '................',
];

const AXE = [
  '................',
  '.........bbb....',
  '.......bbllbb...',
  '......bbllllbbb.',
  '.....bbllllbbbb.',
  '.....bblllbbbb..',
  '.....bbllbb.....',
  '......bbbbuw....',
  '.........uw.....',
  '........uw......',
  '.......wk.......',
  '......uw........',
  '.....uw.........',
  '....wk..........',
  '...uw...........',
  '................',
];

const SHOVEL = [
  '................',
  '.........bbbbb..',
  '.........blllb..',
  '.........blllb..',
  '..........bllb..',
  '...........bb...',
  '..........uw....',
  '.........uw.....',
  '........uw......',
  '.......wk.......',
  '......uw........',
  '.....uw.........',
  '....wk..........',
  '...uw...........',
  '..uw............',
  '................',
];

const SWORD = [
  '............bs..',
  '...........lbs..',
  '..........lbs...',
  '.........lbs....',
  '........lbs.....',
  '.......lbs......',
  '......lbs.......',
  '.....lbs........',
  '....lbs.........',
  '...lbs..........',
  '.kkbbbl.........',
  '.kkbbbs.........',
  '...wb...........',
  '...wu...........',
  '...wk...........',
  '................',
];

const HOE = [
  '................',
  '.........bbbbb..',
  '.........blllb..',
  '.........bbbbb..',
  '..........bb....',
  '..........bb....',
  '.........uw.....',
  '........uw......',
  '.......uw.......',
  '......wk........',
  '.....uw.........',
  '....uw..........',
  '...wk...........',
  '..uw............',
  '.uw.............',
  '................',
];

function tool(rows: readonly string[], head: Ramp): Painter {
  return (b) => paintPattern(b, rows, toolLegend(head, HANDLE));
}

p('wooden_pickaxe', tool(PICKAXE, WOOD));
p('stone_pickaxe', tool(PICKAXE, STONE));
p('iron_pickaxe', tool(PICKAXE, IRON));
p('golden_pickaxe', tool(PICKAXE, GOLD));
p('diamond_pickaxe', tool(PICKAXE, DIAMOND));
p('wooden_axe', tool(AXE, WOOD));
p('stone_axe', tool(AXE, STONE));
p('iron_axe', tool(AXE, IRON));
p('golden_axe', tool(AXE, GOLD));
p('diamond_axe', tool(AXE, DIAMOND));
p('wooden_shovel', tool(SHOVEL, WOOD));
p('stone_shovel', tool(SHOVEL, STONE));
p('iron_shovel', tool(SHOVEL, IRON));
p('golden_shovel', tool(SHOVEL, GOLD));
p('diamond_shovel', tool(SHOVEL, DIAMOND));
p('wooden_sword', tool(SWORD, WOOD));
p('stone_sword', tool(SWORD, STONE));
p('iron_sword', tool(SWORD, IRON));
p('golden_sword', tool(SWORD, GOLD));
p('diamond_sword', tool(SWORD, DIAMOND));
p('wooden_hoe', tool(HOE, WOOD));
p('stone_hoe', tool(HOE, STONE));
p('iron_hoe', tool(HOE, IRON));
p('golden_hoe', tool(HOE, GOLD));
p('diamond_hoe', tool(HOE, DIAMOND));

/* ------------------------------------------------------------------ */
/* Tools that are not one of the five shapes                           */
/* ------------------------------------------------------------------ */

p('shears', (b) => {
  const steel = IRON;
  // two blades crossing at a pivot, opened like a pair of scissors
  const bladeA = linePoints(4, 13, 10, 4);
  const bladeB = linePoints(11, 13, 5, 4);
  for (const [x, y] of bladeA) {
    b.set(x, y, steel.shadow);
    b.set(x + 1, y, steel.light);
  }
  for (const [x, y] of bladeB) {
    b.set(x, y, steel.base);
    b.set(x - 1, y, steel.light);
  }
  // bright cutting edges along the inside of each blade
  for (const [x, y] of bladeA.slice(2, 9)) b.set(x, y - 1, steel.hi);
  for (const [x, y] of bladeB.slice(2, 9)) b.set(x, y + 1, steel.hi);
  // pivot
  b.rect(7, 8, 2, 2, steel.deep);
  b.set(7, 8, steel.base);
  // handles
  b.rect(3, 11, 2, 2, HANDLE.base);
  b.rect(11, 11, 2, 2, HANDLE.base);
  b.set(3, 11, HANDLE.light);
  b.set(11, 11, HANDLE.light);
  b.set(4, 12, HANDLE.shadow);
  b.set(12, 12, HANDLE.shadow);
});

p('bow', (b) => {
  // limb: a C-curve of wood, thicker at the grip
  const limb: Pt[] = [
    [11, 2], [12, 3], [12, 4], [12, 5], [12, 6], [12, 7], [12, 8],
    [12, 9], [11, 10], [11, 11], [10, 12], [9, 13],
  ];
  for (const [x, y] of limb) {
    b.set(x, y, HANDLE.base);
    b.set(x - 1, y, HANDLE.light);
  }
  for (const [x, y] of limb.slice(4, 8)) b.set(x, y, HANDLE.shadow);
  // nocks
  b.set(11, 1, HANDLE.light);
  b.set(8, 13, HANDLE.light);
  // string, a straight run between the nocks
  for (const [x, y] of linePoints(10, 3, 9, 12)) b.set(x, y, rgb(0xe6e6e6));
  b.set(9, 12, rgb(0xbfbfbf));
});

p('arrow', (b) => {
  const shaft = linePoints(4, 12, 11, 5);
  woodShaft(b, shaft, HANDLE);
  // flint head
  const head: Pt[] = [[13, 2], [12, 2], [11, 2], [12, 3], [11, 3], [12, 4], [13, 3], [13, 4], [11, 4], [10, 3]];
  for (const [x, y] of head) b.set(x, y, STONE.base);
  b.set(12, 2, STONE.light);
  b.set(13, 2, STONE.hi);
  b.set(13, 3, STONE.light);
  b.set(11, 4, STONE.shadow);
  // fletching
  b.set(2, 12, rgb(0xf2f2f2));
  b.set(3, 12, rgb(0xf2f2f2));
  b.set(2, 13, rgb(0xf2f2f2));
  b.set(3, 13, rgb(0xdcdcdc));
  b.set(4, 13, rgb(0xf2f2f2));
  b.set(3, 14, rgb(0xdcdcdc));
  b.set(4, 14, rgb(0xf2f2f2));
  b.set(5, 13, rgb(0xdcdcdc));
});

p('shears_blade', (b) => {
  b.rect(6, 3, 4, 10, IRON.base);
  b.rect(6, 3, 1, 10, IRON.light);
  b.rect(9, 3, 1, 10, IRON.shadow);
  b.hline(6, 9, 3, IRON.hi);
  for (let y = 5; y < 12; y += 3) b.hline(7, 8, y, IRON.deep);
});

/* ------------------------------------------------------------------ */
/* Materials                                                           */
/* ------------------------------------------------------------------ */

p('stick', (b) => {
  woodShaft(b, linePoints(4, 13, 11, 4), HANDLE);
  // two knots, and a darker end where the branch was cut
  b.set(9, 6, HANDLE.deep);
  b.set(6, 9, HANDLE.deep);
  b.set(11, 4, HANDLE.deep);
  b.set(4, 13, HANDLE.deep);
});

p('coal', (b) => {
  const r = ramp(0x2a2826);
  spans(b, [[4, 6, 10], [5, 5, 11], [6, 4, 11], [7, 4, 12], [8, 4, 12], [9, 5, 11], [10, 5, 10], [11, 6, 9]], r.base);
  // faceted highlights on the upper left, the way a broken lump catches light
  b.rect(5, 5, 3, 2, r.light);
  b.set(5, 5, r.hi);
  b.set(6, 5, r.hi);
  b.set(4, 7, r.light);
  b.set(4, 8, r.light);
  b.hline(6, 8, 4, r.light);
  b.set(9, 6, r.light);
  // and shadowed facets opposite
  spans(b, [[9, 9, 11], [10, 8, 10], [8, 11, 12]], r.deep);
  b.set(7, 7, r.deep);
});

p('charcoal', (b) => {
  const r = ramp(0x3a3229);
  spans(b, [[4, 6, 10], [5, 5, 11], [6, 4, 11], [7, 4, 12], [8, 4, 12], [9, 5, 11], [10, 5, 10], [11, 6, 9]], r.base);
  b.rect(5, 5, 3, 2, r.light);
  b.set(5, 5, r.hi);
  b.set(4, 7, r.light);
  spans(b, [[9, 9, 11], [10, 8, 10]], r.deep);
  // a couple of charred cracks
  b.set(7, 8, r.deep);
  b.set(8, 9, r.deep);
});

function ingot(b: PixBuf, r: Ramp): void {
  // isometric bar: a lit top face, a mid front face, a shaded base
  spans(b, [[5, 6, 10], [6, 4, 12]], r.light);
  spans(b, [[7, 3, 12], [8, 3, 12]], r.base);
  spans(b, [[9, 4, 11]], r.shadow);
  b.hline(6, 10, 5, r.hi);
  b.set(4, 6, r.hi);
  b.set(5, 6, r.hi);
  // crisp change of plane between top and front
  b.hline(4, 12, 7, r.shadow);
  b.set(12, 8, r.deep);
  b.set(12, 7, r.deep);
  b.set(3, 8, r.light);
  b.set(3, 7, r.light);
  // specular on the leading edge
  b.set(5, 7, r.hi);
  b.set(6, 7, r.hi);
}

p('iron_ingot', (b) => ingot(b, IRON));
p('gold_ingot', (b) => ingot(b, GOLD));

/** A cut gem: a rhombus with four facets meeting at a lit table. */
function gem(b: PixBuf, r: Ramp): void {
  spans(
    b,
    [
      [2, 7, 8],
      [3, 6, 9],
      [4, 5, 10],
      [5, 4, 11],
      [6, 4, 11],
      [7, 4, 11],
      [8, 5, 10],
      [9, 5, 10],
      [10, 6, 9],
      [11, 7, 8],
    ],
    r.base,
  );
  // upper facets catch the light
  spans(b, [[2, 7, 8], [3, 6, 8], [4, 5, 7], [5, 4, 6], [6, 4, 6]], r.light);
  b.set(7, 2, r.hi);
  b.set(8, 2, r.hi);
  b.set(6, 3, r.hi);
  b.set(7, 4, r.hi);
  b.set(5, 5, r.hi);
  // lower facets fall away
  spans(b, [[8, 9, 10], [9, 8, 10], [10, 8, 9], [11, 8, 8]], r.shadow);
  b.set(11, 7, r.shadow);
  b.set(11, 6, r.shadow);
  b.set(8, 11, r.deep);
  b.set(9, 10, r.deep);
  // girdle line
  b.hline(5, 10, 7, r.deep);
}

p('diamond', (b) => gem(b, DIAMOND));
p('emerald_shard', (b) => gem(b, ramp(0x2fbf5e)));
p('ember_shard', (b) => {
  const r = ramp(0xf07a12);
  gem(b, r);
  // a shard still holds its heat: the core glows brighter than the facets
  spans(b, [[4, 6, 8], [5, 5, 7], [6, 5, 7]], ramp(0xffc23a).light);
  b.set(7, 3, ramp(0xffd76a).hi);
});

/** A mound of dust with a few loose grains around it. */
function dustPile(b: PixBuf, r: Ramp): void {
  spans(
    b,
    [[5, 6, 9], [6, 5, 10], [7, 4, 11], [8, 4, 11], [9, 4, 11], [10, 5, 10], [11, 6, 9]],
    r.base,
  );
  // lit crest and shaded skirt
  spans(b, [[5, 6, 9], [6, 5, 7]], r.light);
  b.set(6, 5, r.hi);
  b.set(6, 6, r.hi);
  spans(b, [[10, 6, 10], [11, 7, 9]], r.shadow);
  b.set(4, 9, r.shadow);
  // loose grains scattered around the pile
  const grains: Pt[] = [[3, 6], [12, 7], [3, 11], [11, 12], [7, 3], [9, 12], [2, 8], [13, 9]];
  for (let i = 0; i < grains.length; i++) {
    const [x, y] = grains[i];
    b.set(x, y, i % 3 === 0 ? r.shadow : r.base);
  }
  // speckled surface so it reads as many small pieces, not one solid mass
  for (let i = 0; i < 14; i++) {
    const x = 5 + Math.floor(b.rng.next() * 6);
    const y = 6 + Math.floor(b.rng.next() * 5);
    b.set(x, y, b.rng.chance(0.5) ? r.deep : r.light);
  }
}

p('redstone_dust', (b) => dustPile(b, ramp(0xc41c1c)));
p('gunpowder', (b) => dustPile(b, ramp(0x6a6a6a)));
p('lapis_lazuli', (b) => dustPile(b, ramp(0x2f55c4)));

p('clay_ball', (b) => {
  const r = ramp(0xa8aeb8);
  spans(b, [[4, 6, 9], [5, 5, 10], [6, 4, 11], [7, 4, 11], [8, 4, 11], [9, 5, 10], [10, 5, 10], [11, 6, 9]], r.base);
  spans(b, [[4, 6, 9], [5, 5, 6], [6, 4, 5], [7, 4, 4]], r.light);
  b.set(6, 4, r.hi);
  b.set(5, 5, r.hi);
  spans(b, [[9, 9, 10], [10, 8, 10], [11, 8, 9]], r.shadow);
  b.set(11, 7, r.shadow);
  // thumb print: a soft dent that sells it as pressed clay
  b.set(7, 6, r.deep);
  b.set(8, 6, r.deep);
  b.set(7, 7, r.deep);
});

p('flint', (b) => {
  const r = ramp(0x3a3a46);
  spans(b, [[4, 7, 9], [5, 5, 10], [6, 4, 11], [7, 4, 11], [8, 5, 10], [9, 5, 8], [10, 6, 7]], r.base);
  // a shard has facets, not a smooth surface
  spans(b, [[5, 5, 6], [6, 4, 5], [4, 7, 8]], r.light);
  b.set(5, 5, r.hi);
  b.set(8, 4, r.hi);
  spans(b, [[8, 9, 10], [9, 8, 8]], r.shadow);
  b.set(11, 7, r.shadow);
  b.hline(7, 9, 7, r.deep);
  b.set(6, 9, r.deep);
});

p('bone', (b) => {
  const r = ramp(0xe8e4d4);
  // shaft
  spans(b, [[6, 5, 10], [7, 5, 10], [8, 5, 10]], r.base);
  // knuckles at both ends
  spans(b, [[4, 4, 5], [4, 10, 11], [5, 3, 6], [5, 9, 12], [9, 3, 6], [9, 9, 12], [10, 4, 5], [10, 10, 11]], r.base);
  spans(b, [[4, 4, 5], [4, 10, 11], [5, 3, 4], [5, 9, 10]], r.light);
  b.set(4, 4, r.hi);
  b.set(4, 10, r.hi);
  spans(b, [[9, 5, 6], [9, 11, 12], [10, 4, 5], [10, 10, 11]], r.shadow);
  spans(b, [[6, 8, 10], [7, 8, 10], [8, 9, 10]], r.shadow);
  b.hline(5, 10, 8, r.shadow);
  // a hairline crack through the shaft
  b.set(7, 6, r.deep);
  b.set(8, 7, r.deep);
});

p('string', (b) => {
  const r = ramp(0xdedede);
  // a slack coil: three strands looping over each other
  for (const [x, y] of linePoints(5, 3, 11, 7)) b.set(x, y, r.base);
  for (const [x, y] of linePoints(11, 7, 4, 10)) b.set(x, y, r.light);
  for (const [x, y] of linePoints(4, 10, 10, 13)) b.set(x, y, r.base);
  for (const [x, y] of linePoints(5, 4, 11, 8)) b.set(x, y, r.shadow);
  // loose ends
  b.set(4, 2, r.light);
  b.set(11, 12, r.light);
  b.set(5, 3, r.shadow);
  b.set(10, 13, r.shadow);
});

p('feather', (b) => {
  const r = ramp(0xf2f2f2);
  const shaft = linePoints(11, 3, 5, 12);
  // barbs: a vane that is widest in the middle and tapers at both ends
  spans(
    b,
    [
      [3, 9, 11],
      [4, 8, 12],
      [5, 7, 12],
      [6, 6, 11],
      [7, 5, 10],
      [8, 4, 9],
      [9, 4, 8],
      [10, 4, 7],
      [11, 5, 6],
    ],
    r.base,
  );
  spans(b, [[4, 8, 9], [5, 7, 8], [6, 6, 7], [7, 5, 6], [8, 4, 5]], r.light);
  b.set(8, 4, r.hi);
  b.set(9, 3, r.hi);
  spans(b, [[8, 8, 9], [9, 7, 8], [10, 6, 7]], r.shadow);
  for (const [x, y] of shaft) b.set(x, y, r.hi);
  for (const [x, y] of shaft) b.set(x + 1, y, r.shadow);
  b.set(5, 12, r.shadow);
});

p('leather', (b) => {
  const r = ramp(0x9a6b3c);
  // a tanned hide, cut with wavy edges rather than a plain rectangle
  spans(
    b,
    [
      [4, 5, 11],
      [5, 3, 12],
      [6, 3, 12],
      [7, 2, 13],
      [8, 2, 13],
      [9, 3, 12],
      [10, 3, 12],
      [11, 5, 11],
    ],
    r.base,
  );
  spans(b, [[4, 5, 11], [5, 3, 6], [6, 3, 5]], r.light);
  b.set(4, 6, r.hi);
  b.set(3, 5, r.hi);
  spans(b, [[9, 10, 12], [10, 9, 12], [11, 9, 11]], r.shadow);
  b.set(13, 8, r.shadow);
  b.set(13, 7, r.shadow);
  // grain
  for (let i = 0; i < 10; i++) {
    const x = 4 + Math.floor(b.rng.next() * 8);
    const y = 5 + Math.floor(b.rng.next() * 6);
    b.set(x, y, b.rng.chance(0.5) ? r.deep : r.light);
  }
});

p('paper', (b) => {
  const r = ramp(0xf0f0e8);
  b.rect(4, 3, 8, 10, r.base);
  // a folded corner
  b.set(11, 3, r.shadow);
  b.set(11, 4, r.shadow);
  b.set(10, 3, r.light);
  b.hline(4, 11, 3, r.light);
  b.set(4, 3, r.hi);
  b.vline(4, 4, 12, r.light);
  b.vline(11, 5, 12, r.shadow);
  b.hline(4, 11, 12, r.shadow);
  // ruled lines, the way a written page reads at a glance
  for (let y = 6; y <= 11; y += 2) b.hline(6, 10, y, r.shadow);
  b.hline(6, 8, 8, rgb(0x8a8a9a));
});

p('book', (b) => {
  const cover = ramp(0x8a3a2e);
  const page = ramp(0xf0ecdc);
  b.rect(3, 2, 11, 12, cover.base);
  b.rect(3, 2, 2, 12, cover.shadow);
  b.rect(12, 2, 2, 12, cover.shadow);
  b.hline(3, 13, 2, cover.light);
  b.hline(3, 13, 13, cover.deep);
  b.set(3, 2, cover.hi);
  b.set(4, 2, cover.hi);
  // page block standing proud of the cover
  b.rect(5, 3, 7, 10, page.base);
  b.vline(5, 3, 12, page.light);
  b.vline(11, 3, 12, page.shadow);
  b.hline(5, 11, 3, page.hi);
  b.hline(5, 11, 12, page.shadow);
  for (let y = 5; y <= 11; y += 2) b.hline(6, 10, y, page.shadow);
  // spine band
  b.rect(3, 6, 2, 3, cover.light);
  b.set(3, 6, cover.hi);
});

/* ------------------------------------------------------------------ */
/* Food                                                                */
/* ------------------------------------------------------------------ */

type MeatStyle = 'chop' | 'steak' | 'drumstick';

/** Fat seams painted through a steak, and through a chop or drumstick. */
const STEAK_SEAMS: Pt[] = [[6, 6], [7, 6], [6, 7], [9, 8], [10, 8], [5, 8], [8, 5]];
const CHOP_SEAMS: Pt[] = [[8, 5], [9, 5], [7, 7], [8, 7], [10, 6], [7, 8]];

/**
 * A cut of meat.
 *
 * Raw cuts are pink with pale fat marbling; cooked ones are browned with a
 * darker crust. `chop` and `drumstick` grow a bone, which is what makes them
 * read as meat rather than as a red blob.
 */
function meat(b: PixBuf, r: Ramp, style: MeatStyle, cooked: boolean): void {
  const fat: Ramp = cooked ? ramp(0xd8b070) : ramp(0xf2d8cc);
  const boneR: Ramp = ramp(0xefe9d6);
  const crust = darken(r.base, 0.42);

  if (style === 'chop') {
    spans(
      b,
      [[4, 7, 10], [5, 5, 11], [6, 4, 12], [7, 4, 12], [8, 4, 12], [9, 5, 11], [10, 7, 10]],
      r.base,
    );
    // bone sticking out of the lower left
    b.rect(2, 9, 3, 2, boneR.base);
    b.set(2, 9, boneR.light);
    b.set(2, 10, boneR.shadow);
    b.set(3, 10, boneR.shadow);
    b.set(4, 9, boneR.light);
    b.set(4, 10, boneR.base);
    spans(b, [[4, 7, 9], [5, 5, 7]], r.light);
    spans(b, [[8, 10, 12], [9, 9, 11], [10, 9, 10]], r.shadow);
    b.set(4, 7, r.deep);
    b.set(12, 6, crust);
    b.set(12, 7, crust);
  } else if (style === 'steak') {
    spans(
      b,
      [[4, 6, 10], [5, 4, 12], [6, 3, 12], [7, 3, 12], [8, 4, 12], [9, 4, 11], [10, 6, 10]],
      r.base,
    );
    spans(b, [[4, 6, 9], [5, 4, 7], [6, 3, 5]], r.light);
    b.set(4, 5, r.hi);
    spans(b, [[8, 10, 12], [9, 9, 11], [10, 9, 10]], r.shadow);
    b.set(12, 6, crust);
    b.set(12, 7, crust);
    b.set(11, 8, crust);
    b.set(3, 7, r.deep);
  } else {
    // drumstick: a rounded joint with the bone running down to the lower left
    spans(b, [[3, 8, 11], [4, 7, 12], [5, 6, 12], [6, 6, 12], [7, 7, 11], [8, 7, 10]], r.base);
    spans(b, [[3, 8, 10], [4, 7, 8], [5, 6, 7]], r.light);
    b.set(8, 4, r.hi);
    spans(b, [[7, 10, 11], [8, 9, 10]], r.shadow);
    b.set(12, 6, crust);
    b.set(12, 5, crust);
    // the bone has to touch the meat, or it renders as two floating blobs
    b.rect(6, 9, 2, 1, boneR.base);
    b.rect(5, 10, 2, 1, boneR.base);
    b.rect(4, 11, 2, 1, boneR.base);
    b.rect(3, 12, 2, 1, boneR.base);
    b.set(6, 9, boneR.light);
    b.set(5, 10, boneR.light);
    b.set(4, 11, boneR.shadow);
    b.set(3, 12, boneR.shadow);
  }

  // marbling: short fat seams through the cut
  const seams: Pt[] = style === 'steak' ? STEAK_SEAMS : CHOP_SEAMS;
  for (const [x, y] of seams) b.set(x, y, fat.base);
  b.set(seams[0][0], seams[0][1], fat.light);

  if (cooked) {
    // browned crust along the underside and a seared corner, kept inside the
    // silhouette of whichever cut this is
    if (style === 'drumstick') {
      b.set(9, 8, crust);
      b.set(10, 7, crust);
    } else {
      b.set(4, 8, crust);
      b.set(5, 9, crust);
      b.set(4, 6, crust);
    }
  }
}

p('porkchop', (b) => meat(b, ramp(0xe08a80), 'chop', false));
p('cooked_porkchop', (b) => meat(b, ramp(0xb8703c), 'chop', true));
p('beef', (b) => meat(b, ramp(0xc05a52), 'steak', false));
p('cooked_beef', (b) => meat(b, ramp(0xa05a2c), 'steak', true));
p('chicken', (b) => meat(b, ramp(0xf0c8b0), 'drumstick', false));
p('cooked_chicken', (b) => meat(b, ramp(0xc08850), 'drumstick', true));
p('mutton', (b) => meat(b, ramp(0xd06a60), 'chop', false));
p('cooked_mutton', (b) => meat(b, ramp(0xac6c34), 'chop', true));
p('rotten_flesh', (b) => {
  const r = ramp(0x7a5a3a);
  meat(b, r, 'steak', true);
  // rotten: torn edges and sickly patches instead of clean marbling
  const rot = ramp(0x5d6b3a);
  for (const [x, y] of [[5, 5], [6, 5], [9, 7], [10, 7], [7, 9], [8, 9], [4, 6]] as Pt[]) b.set(x, y, rot.base);
  b.set(5, 5, rot.light);
  b.set(9, 7, rot.shadow);
  // putrid pits rather than a clean cut (clearing texels here would just be
  // refilled by the outline pass, so the damage is painted, not punched)
  b.set(6, 9, r.deep);
  b.set(10, 6, r.deep);
  b.set(4, 5, r.deep);
});

/*
 * A bowl, and the same bowl full of stew.
 *
 * The mushrooms already existed as blocks with no way to turn them into
 * anything, so the bowl is what makes them worth gathering.
 */
p('bowl', (b) => {
  const w = ramp(0x9a6b3c);
  const inner = ramp(0x5f4023);
  spans(
    b,
    [[6, 3, 12], [7, 3, 12], [8, 4, 11], [9, 4, 11], [10, 5, 10], [11, 6, 9], [12, 7, 8]],
    w.base,
  );
  spans(b, [[6, 3, 12]], w.light);
  spans(b, [[7, 4, 11], [8, 5, 10]], inner.deep);
  spans(b, [[9, 5, 10], [10, 6, 9]], w.shadow);
  spans(b, [[12, 7, 8]], w.deep);
});

p('mushroom_stew', (b) => {
  const w = ramp(0x9a6b3c);
  const stew = ramp(0x9c5c33);
  spans(
    b,
    [[5, 3, 12], [6, 3, 12], [7, 3, 12], [8, 4, 11], [9, 4, 11], [10, 5, 10], [11, 6, 9], [12, 7, 8]],
    w.base,
  );
  spans(b, [[5, 3, 12]], w.light);
  // the stew surface, sitting just inside the rim
  spans(b, [[6, 4, 11], [7, 4, 11]], stew.base);
  b.set(5, 5, stew.light);
  b.set(9, 6, stew.shadow);
  b.set(6, 7, stew.shadow);
  // mushroom pieces floating in it
  const red = ramp(0xc0392b);
  const brown = ramp(0x8a6a42);
  b.set(5, 5, red.light);
  b.set(10, 5, red.base);
  b.set(7, 5, brown.light);
  b.set(8, 6, brown.base);
  b.set(9, 4, brown.shadow);
  spans(b, [[11, 6, 9], [12, 7, 8]], w.shadow);
  spans(b, [[12, 7, 8]], w.deep);
});

p('apple', (b) => {
  const r = ramp(0xc42a24);
  const leaf = ramp(0x5e9c34);
  spans(
    b,
    [[4, 7, 9], [5, 5, 11], [6, 4, 11], [7, 3, 12], [8, 3, 12], [9, 3, 12], [10, 4, 11], [11, 5, 10], [12, 7, 9]],
    r.base,
  );
  // lit quarter and a specular bloom, then the shaded side
  spans(b, [[4, 7, 9], [5, 5, 7], [6, 4, 6], [7, 3, 5], [8, 3, 4]], r.light);
  b.set(6, 5, r.hi);
  b.set(7, 5, r.hi);
  b.set(5, 6, r.hi);
  b.set(6, 6, r.hi);
  spans(b, [[9, 10, 12], [10, 9, 11], [11, 8, 10], [12, 8, 9]], r.shadow);
  b.set(12, 8, r.deep);
  b.set(12, 9, r.deep);
  b.set(3, 9, r.deep);
  // stem well and stem
  b.set(8, 4, r.deep);
  b.set(8, 3, rgb(0x6b5230));
  b.set(9, 3, rgb(0x5a4426));
  b.set(9, 2, rgb(0x6b5230));
  // leaf
  b.set(10, 2, leaf.base);
  b.set(11, 2, leaf.base);
  b.set(11, 1, leaf.light);
  b.set(12, 2, leaf.shadow);
  b.set(10, 3, leaf.shadow);
});

p('bread', (b) => {
  const r = ramp(0xc48a3c);
  const crust = ramp(0x8a5a26);
  spans(
    b,
    [[5, 6, 10], [6, 4, 12], [7, 3, 12], [8, 3, 12], [9, 4, 12], [10, 6, 10]],
    r.base,
  );
  // floured top: the upper-left is lighter than the crust below
  spans(b, [[5, 6, 10], [6, 4, 8], [7, 3, 6]], r.light);
  b.set(6, 5, r.hi);
  b.set(7, 5, r.hi);
  spans(b, [[9, 10, 12], [10, 9, 10]], crust.base);
  b.hline(4, 12, 9, crust.base);
  b.set(12, 7, crust.base);
  b.set(12, 6, crust.base);
  b.set(3, 8, crust.deep);
  // scored slashes across the crust
  b.set(6, 6, crust.deep);
  b.set(7, 6, crust.deep);
  b.set(9, 7, crust.deep);
  b.set(10, 7, crust.deep);
  b.set(5, 8, crust.deep);
  b.set(6, 8, crust.deep);
});

p('wheat', (b) => {
  const stalk = ramp(0x8f9c3a);
  const grain = ramp(0xd4b038);
  for (let i = 0; i < 4; i++) {
    const x = 4 + i * 3;
    for (const [sx, sy] of linePoints(x, 14, x, 5)) b.set(sx, sy, stalk.base);
    b.set(x, 14, stalk.deep);
    for (let k = 0; k < 4; k++) {
      const y = 4 + k * 2;
      b.set(x - 1, y, grain.base);
      b.set(x, y, grain.light);
      b.set(x + 1, y, grain.base);
      b.set(x - 1, y + 1, grain.shadow);
      b.set(x + 1, y + 1, grain.shadow);
    }
    b.set(x, 3, grain.hi);
  }
  // awns at the top of each head
  b.set(4, 2, stalk.light);
  b.set(7, 1, stalk.light);
  b.set(10, 2, stalk.light);
  b.set(13, 1, stalk.light);
});

p('wheat_seeds', (b) => {
  const r = ramp(0x9cb04a);
  const seeds: Pt[] = [[5, 5], [8, 4], [11, 6], [4, 8], [7, 9], [10, 10], [6, 12], [9, 12]];
  for (let i = 0; i < seeds.length; i++) {
    const [x, y] = seeds[i];
    // each seed is a two-texel grain with a lit edge and a shadow underneath
    b.set(x, y, r.light);
    b.set(x + 1, y, r.base);
    b.set(x, y + 1, r.shadow);
    b.set(x + 1, y + 1, r.shadow);
    b.set(x, y + 2, r.deep);
  }
});

/* ------------------------------------------------------------------ */
/* Buckets                                                             */
/* ------------------------------------------------------------------ */

p('bucket', (b) => {
  const r = ramp(0xb8bcc4);
  // pail: a lit rim, straight sides with a shaded right edge, and a base
  b.hline(4, 11, 5, r.hi);
  b.hline(4, 11, 6, r.light);
  for (let y = 7; y <= 10; y++) {
    b.set(4, y, r.light);
    b.set(11, y, r.shadow);
    for (let x = 5; x <= 10; x++) b.set(x, y, r.base);
  }
  b.hline(5, 10, 8, r.shadow); // hoop
  b.set(4, 8, r.base);
  b.hline(4, 11, 11, r.deep); // base
  // handle, arcing over the rim
  for (const [x, y] of linePoints(4, 5, 8, 1)) b.set(x, y, r.light);
  for (const [x, y] of linePoints(8, 1, 11, 5)) b.set(x, y, r.base);
  b.set(8, 1, r.hi);
  b.set(7, 1, r.hi);
  b.set(4, 5, r.deep);
  b.set(11, 5, r.deep);
});

p('water_bucket', (b) => {
  itemPainter('bucket')!(b);
  const water = ramp(0x3a63d8);
  // the pail is open: the surface sits just inside the rim
  b.rect(5, 6, 6, 3, water.base);
  b.hline(5, 10, 6, water.light);
  b.set(5, 6, water.hi);
  b.set(6, 6, water.hi);
  b.hline(5, 10, 8, water.shadow);
  b.set(10, 7, water.shadow);
});

/* ------------------------------------------------------------------ */

/**
 * Seed for a sprite's `PixBuf`, derived from its name.
 *
 * Kept identical to the original derivation so any item that uses `b.rng` for
 * speckle (leather grain, dust, powder) stays byte-for-byte reproducible between
 * runs - the QA render dumps depend on that.
 */
function seedFor(name: string): number {
  return hashInt(name.length * 40503) ^ hashInt(name.split('').reduce((a, c) => a + c.charCodeAt(0) * 131, 11));
}

export function paintItem(name: string): PixBuf {
  const buf = new PixBuf(ITEM_TILE, ITEM_TILE, seedFor(name));
  const fn = painters[name];
  if (!fn) {
    buf.fill(rgb(0xff00ff));
    return buf;
  }
  fn(buf);
  const mask = maskOf(buf);
  bevel(buf, mask);
  outline(buf);
  return buf;
}

/** Deterministic per-item noise used by the UI for subtle paper texture. */
export function uiNoise(seed: number, w: number, h: number): Float32Array {
  return tileNoise(w, h, seed, 4, 2);
}
