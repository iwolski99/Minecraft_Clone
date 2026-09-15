/**
 * Tree shapes. Each function returns a compact list of (dx, dy, dz, blockId)
 * offsets relative to the trunk base so the caller can clip them to whichever
 * chunk it is currently filling - this is what keeps trees that straddle a
 * chunk border from being sliced in half.
 *
 * Three rules keep the silhouettes readable. Rules 1 and 2 are what the
 * reported "not enough leaves / wood comes out of the top" bug broke:
 *   1. the trunk never pokes out of the canopy - the topmost log always has a
 *      leaf directly above it AND leaves on its sides, so no wood is visible
 *      from above or from the side,
 *   2. the canopy is a solid mass of layers (a blob for broadleaf trees, tiers
 *      for spruce), not a thin spire over a trimmed skirt,
 *   3. nothing reaches further than `MAX_TREE_RADIUS` blocks from the trunk
 *      column, well inside the one-chunk halo `terrain.ts` decorates from.
 */

import { B } from '../world/blocks.js';
import { Rng } from '../util/rng.js';

export type BlockOffset = [number, number, number, number];

export interface TreeShape {
  blocks: BlockOffset[];
  /** vertical extent above the base, used for light/decoration bookkeeping */
  height: number;
}

/**
 * Largest horizontal reach of any shape below (a big oak's branch blobs are the
 * widest case). `terrain.ts` decorates from a one-chunk halo, i.e. it sees every
 * trunk within 16 blocks, so anything up to 16 cannot be clipped at a chunk
 * border - this is the value the shapes actually use, pinned so a runaway
 * canopy is caught here rather than as a hole in the world.
 */
export const MAX_TREE_RADIUS = 4;

function push(map: Map<number, number>, x: number, y: number, z: number, id: number, force = false): void {
  const key = ((x + 64) << 16) | ((y + 64) << 8) | (z + 64);
  if (force || !map.has(key)) map.set(key, id);
}

function toList(map: Map<number, number>): BlockOffset[] {
  const out: BlockOffset[] = [];
  for (const [k, id] of map) {
    const x = ((k >> 16) & 0xff) - 64;
    const y = ((k >> 8) & 0xff) - 64;
    const z = (k & 0xff) - 64;
    out.push([x, y, z, id]);
  }
  return out;
}

/** Packs the map back up, deriving the vertical extent from the blocks themselves. */
function shape(map: Map<number, number>): TreeShape {
  let top = 0;
  for (const k of map.keys()) {
    const y = ((k >> 8) & 0xff) - 64;
    if (y > top) top = y;
  }
  return { blocks: toList(map), height: top };
}

/**
 * One horizontal leaf layer centred on (cx, cz). `r` is the radius: 0 is the
 * trunk column alone, 1 a 3x3, 2 a 5x5, 3 a 7x7. `corner` is the chance that a
 * corner of the square is dropped - trimming a few corners is what stops the
 * layers from reading as stacked cubes, but the layers stay solid otherwise so
 * the canopy is opaque from below.
 *
 * Never overwrites the trunk: logs are inserted first and `push` keeps them.
 */
function leafLayer(
  map: Map<number, number>,
  rng: Rng,
  id: number,
  cx: number,
  y: number,
  cz: number,
  r: number,
  corner = 0.35,
): void {
  for (let dx = -r; dx <= r; dx++) {
    for (let dz = -r; dz <= r; dz++) {
      if (r > 0 && Math.abs(dx) === r && Math.abs(dz) === r && rng.next() < corner) continue;
      push(map, cx + dx, y, cz + dz, id);
    }
  }
}

/**
 * Broadleaf canopy: the classic blob. `wide` full layers straddle the top of
 * the trunk (so the trunk top is buried in leaves), then a narrower dome caps
 * it. The final dome layer always covers the trunk column, and every layer of
 * the trunk inside the canopy has leaves beside it, so no wood shows anywhere.
 */
function blobCanopy(
  map: Map<number, number>,
  rng: Rng,
  id: number,
  cx: number,
  trunkTop: number,
  cz: number,
  r = 2,
  wide = 2,
): void {
  for (let i = 0; i < wide; i++) {
    leafLayer(map, rng, id, cx, trunkTop - (wide - 1) + i, cz, r, 0.45);
  }
  const dome = Math.max(1, r - 1);
  leafLayer(map, rng, id, cx, trunkTop + 1, cz, dome, 0.3);
  leafLayer(map, rng, id, cx, trunkTop + 2, cz, dome, 0.3);
}

/* ------------------------------------------------------------------ */

export function oakTree(rng: Rng): TreeShape {
  const logs = rng.int(4, 6);
  const top = logs - 1;
  const map = new Map<number, number>();
  for (let y = 0; y <= top; y++) push(map, 0, y, 0, B.oak_log, true);
  blobCanopy(map, rng, B.oak_leaves, 0, top, 0);
  return shape(map);
}

export function bigOakTree(rng: Rng): TreeShape {
  const logs = rng.int(7, 10);
  const top = logs - 1;
  const map = new Map<number, number>();
  for (let y = 0; y <= top; y++) push(map, 0, y, 0, B.oak_log, true);

  // the main canopy first, so branches get to poke out of it
  blobCanopy(map, rng, B.oak_leaves, 0, top, 0, 3, 3);

  // a couple of branches, each ending in its own smaller blob
  const branches = rng.int(2, 3);
  for (let i = 0; i < branches; i++) {
    const by = top - rng.int(1, 3);
    const dir = rng.int(0, 3);
    const dx = dir === 0 ? 1 : dir === 1 ? -1 : 0;
    const dz = dir === 2 ? 1 : dir === 3 ? -1 : 0;
    const bl = rng.int(1, 2);
    for (let k = 1; k <= bl; k++) push(map, dx * k, by + k, dz * k, B.oak_log, true);
    blobCanopy(map, rng, B.oak_leaves, dx * bl, by + bl, dz * bl, 2, 1);
  }
  return shape(map);
}

export function birchTree(rng: Rng): TreeShape {
  const logs = rng.int(4, 6);
  const top = logs - 1;
  const map = new Map<number, number>();
  for (let y = 0; y <= top; y++) push(map, 0, y, 0, B.birch_log, true);
  // same blob as the oak: birch canopies are oak-shaped, just paler and a
  // touch airier at the corners
  blobCanopy(map, rng, B.birch_leaves, 0, top, 0, 2, 2);
  return shape(map);
}

export function spruceTree(rng: Rng): TreeShape {
  const logs = rng.int(7, 11);
  const top = logs - 1;
  const map = new Map<number, number>();
  for (let y = 0; y <= top; y++) push(map, 0, y, 0, B.spruce_log, true);

  // Cap the tip before anything else: a spruce whose topmost log had no leaf
  // over it was the "wood comes out of the top of the tree" bug.
  push(map, 0, top + 1, 0, B.spruce_leaves);

  // Tiers: start narrow at the tip and widen by one ring every two layers, so
  // the silhouette cones outward toward the ground. Layers stay solid so the
  // tree still blocks the sky, and the corners are trimmed to keep the stepped
  // spruce edge.
  let r = 1;
  let left = 2;
  for (let y = top; y >= 2; y--) {
    leafLayer(map, rng, B.spruce_leaves, 0, y, 0, r, 0.4);
    if (--left <= 0 && r < 2) {
      r++;
      left = 2;
    }
  }
  return shape(map);
}

export function cactusTree(rng: Rng): TreeShape {
  const h = rng.int(1, 3);
  const map = new Map<number, number>();
  for (let y = 0; y <= h; y++) push(map, 0, y, 0, B.cactus, true);
  return { blocks: toList(map), height: h };
}

export function deadBushShape(rng: Rng): TreeShape {
  const map = new Map<number, number>();
  push(map, 0, 0, 0, B.dead_bush, true);
  return { blocks: toList(map), height: 0 };
}
