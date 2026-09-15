/**
 * The voxel world: chunk storage, block access, lighting integration and the
 * small amount of simulation (falling blocks) the game needs.
 */

import { CHUNK_X, CHUNK_Y, CHUNK_Z, Chunk, chunkKey } from './chunk.js';
import { LightEngine } from './lighting.js';
import { getBlock as def, isSolid, isLiquid, lightAttenuation, lightEmission, BLOCKS, B } from './blocks.js';

/** Log and leaf block ids, resolved once from the registry. */
const LOG_IDS = new Set(BLOCKS.filter((b) => b.name.endsWith('_log')).map((b) => b.id));
const LEAF_IDS = new Set(BLOCKS.filter((b) => b.name.endsWith('_leaves')).map((b) => b.id));

/** The six axis neighbours, for the support flood. */
const NEIGHBOURS: [number, number, number][] = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];
import type { TerrainGenerator } from '../worldgen/terrain.js';

export interface BlockChange {
  x: number;
  y: number;
  z: number;
  oldId: number;
  newId: number;
}

export class World {
  readonly seed: number;
  readonly generator: TerrainGenerator;
  readonly chunks = new Map<number, Chunk>();
  readonly light: LightEngine;

  /** dimension id - 0 overworld, 1 the ember dimension */
  dimension = 0;

  private pendingFall: number[] = [];
  private fallQueued = new Set<number>();
  /** player-made deviations from procedural generation, keyed by chunk then block index */
  readonly edits = new Map<number, Map<number, number>>();
  onBlockChanged: ((c: BlockChange) => void) | null = null;
  /** invoked once a chunk has been generated, before lighting */
  onChunkGenerated: ((chunk: Chunk) => void) | null = null;

  constructor(seed: number, generator: TerrainGenerator) {
    this.seed = seed;
    this.generator = generator;
    this.light = new LightEngine(this);
  }

  /* ---------------------------------------------------------------- */
  /* Chunk management                                                  */
  /* ---------------------------------------------------------------- */

  getChunk(cx: number, cz: number): Chunk | undefined {
    return this.chunks.get(chunkKey(cx, cz));
  }

  getChunkAt(x: number, z: number): Chunk | undefined {
    return this.chunks.get(chunkKey(x >> 4, z >> 4));
  }

  /** True when the chunk covering this column exists (light must not leak past). */
  isLoadedAt(x: number, z: number): boolean {
    return this.chunks.has(chunkKey(x >> 4, z >> 4));
  }

  createChunk(cx: number, cz: number): Chunk {
    const c = new Chunk(cx, cz);
    this.chunks.set(chunkKey(cx, cz), c);
    return c;
  }

  removeChunk(cx: number, cz: number): void {
    this.chunks.delete(chunkKey(cx, cz));
  }

  get loadedCount(): number {
    return this.chunks.size;
  }

  /* ---------------------------------------------------------------- */
  /* Block access                                                      */
  /* ---------------------------------------------------------------- */

  getBlockAt(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return 0;
    return c.blocks[((y << 8) | ((z & 15) << 4) | (x & 15)) as number];
  }

  /** Like getBlockAt but reports whether the chunk was actually loaded. */
  getBlockLoaded(x: number, y: number, z: number): number | null {
    if (y < 0 || y >= CHUNK_Y) return y < 0 ? B.bedrock : 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return null;
    return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  setBlockRaw(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CHUNK_Y) return;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return;
    c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)] = id;
  }

  /**
   * Place or remove a block, updating lighting, chunk dirty flags and
   * neighbour chunk geometry at borders.
   */
  setBlock(x: number, y: number, z: number, id: number, silent = false): boolean {
    if (y < 0 || y >= CHUNK_Y) return false;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return false;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    const old = c.blocks[i];
    if (old === id) return false;
    c.blocks[i] = id;
    c.modified = true;
    // remember the deviation so the world can be saved without storing every block
    let chunkEdits = this.edits.get(chunkKey(x >> 4, z >> 4));
    if (!chunkEdits) {
      chunkEdits = new Map();
      this.edits.set(chunkKey(x >> 4, z >> 4), chunkEdits);
    }
    chunkEdits.set(i, id);
    // Does this edit change how light behaves here? If so its effect reaches
    // across chunk borders and the neighbours' baked light has to be rebuilt.
    const lightChanged =
      lightEmission(old) !== lightEmission(id) || lightAttenuation(old) !== lightAttenuation(id);
    this.markDirtyAround(x, y, z, c, lightChanged);
    this.light.onBlockChanged(x, y, z, old, id);
    if (!silent && this.onBlockChanged) this.onBlockChanged({ x, y, z, oldId: old, newId: id });
    // schedule gravity blocks
    this.scheduleFall(x, y, z);
    this.scheduleFall(x, y + 1, z);
    /*
     * Leaf decay.
     *
     * Only when a log is genuinely removed. Terrain generation places logs by
     * writing into air, so the old block is never a log there and this cannot
     * fire mid-generation - which matters because a generation-time scan would
     * be both wasted and wrong, since the tree's own leaves are not all placed
     * yet when its trunk is.
     */
    if (LOG_IDS.has(old) && !LOG_IDS.has(id)) this.decayLeaves(x, y, z);
    return true;
  }

  /**
   * Remove leaves left with no log to hold them up.
   *
   * The original decays a leaf that is more than four steps from a log, where
   * the distance is walked through the tree rather than measured as a straight
   * line. That distinction matters: a leaf at the tip of a broad canopy can be
   * further than four blocks from the trunk through the air and still be held
   * up, so a radius test alone would strip canopies that should stand. This is
   * therefore a breadth-first flood that starts at every log near the break,
   * spreads only through leaf blocks, and carries a budget of four steps.
   *
   * The scan is bounded to a box around the removed log and runs only when a log
   * is actually broken, so nothing here is on a hot path.
   *
   * One divergence worth knowing: a player-placed leaf is indistinguishable from
   * a grown one, because the world stores only an id per cell and no per-block
   * flags. Placed leaves therefore decay like natural ones, where the original
   * marks them persistent.
   */
  private decayLeaves(lx: number, ly: number, lz: number): void {
    const R = 5;
    const inside = (x: number, y: number, z: number) =>
      Math.abs(x - lx) <= R && Math.abs(y - ly) <= R && Math.abs(z - lz) <= R;

    const leaves: number[] = [];
    for (let y = ly - R; y <= ly + R; y++) {
      for (let z = lz - R; z <= lz + R; z++) {
        for (let x = lx - R; x <= lx + R; x++) {
          if (LEAF_IDS.has(this.getBlockAt(x, y, z))) leaves.push(x, y, z);
        }
      }
    }
    if (leaves.length === 0) return;

    /*
     * Flood support out from every log in range, through leaves, four steps.
     * The queue carries the steps remaining, so support fades with distance
     * exactly as it does in the original rather than spreading without limit.
     */
    const supported = new Set<number>();
    const key = (x: number, y: number, z: number) => ((x + 512) << 22) | ((y + 512) << 11) | (z + 512);
    const queue: number[] = [];
    for (let y = ly - R; y <= ly + R; y++) {
      for (let z = lz - R; z <= lz + R; z++) {
        for (let x = lx - R; x <= lx + R; x++) {
          if (!LOG_IDS.has(this.getBlockAt(x, y, z))) continue;
          for (const [dx, dy, dz] of NEIGHBOURS) queue.push(x + dx, y + dy, z + dz, 3);
        }
      }
    }

    while (queue.length > 0) {
      const steps = queue.pop()!;
      const z = queue.pop()!;
      const y = queue.pop()!;
      const x = queue.pop()!;
      const id = this.getBlockAt(x, y, z);
      /*
       * The walk passes through air and leaves, and stops at everything else -
       * including logs, which are the sources rather than conduits.
       *
       * Note it cannot test solidity: a leaf block is solid, because you can
       * stand on it, so a solidity test stops the flood at the first leaf and
       * supports nothing at all, which decayed every canopy in the world the
       * moment any one log was broken.
       */
      if (id !== 0 && !LEAF_IDS.has(id)) continue;
      if (id !== 0) {
        const k = key(x, y, z);
        if (supported.has(k)) continue;
        supported.add(k);
      }
      if (steps <= 0) continue;
      for (const [dx, dy, dz] of NEIGHBOURS) queue.push(x + dx, y + dy, z + dz, steps - 1);
    }

    /*
     * Anything unsupported falls. Removing one leaf can orphan its neighbours -
     * a chain running out from the trunk loses its hold from the inside - so the
     * sweep repeats until a pass removes nothing.
     */
    for (let pass = 0; pass < R; pass++) {
      let removed = 0;
      for (let i = 0; i < leaves.length; i += 3) {
        const x = leaves[i];
        const y = leaves[i + 1];
        const z = leaves[i + 2];
        if (!inside(x, y, z)) continue;
        if (!LEAF_IDS.has(this.getBlockAt(x, y, z))) continue;
        if (supported.has(key(x, y, z))) continue;
        this.setBlock(x, y, z, 0, true);
        removed++;
      }
      if (removed === 0) break;
    }
  }

  /** Light-only update path used while generating terrain (no dirty flags). */
  setBlockGen(c: Chunk, x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CHUNK_Y) return;
    c.blocks[(y << 8) | (z << 4) | x] = id;
  }

  /**
   * Mark the chunks whose baked vertex light a change at (x,y,z) can invalidate.
   *
   * `wide` must be set whenever the block's light emission or attenuation
   * changed, because light carries up to 14 blocks - nearly a full chunk - in
   * every direction. A torch placed in the middle of a chunk lights the
   * neighbouring chunk, and marking only the containing chunk left that
   * neighbour showing its old baked light: a hard seam along the chunk border,
   * with torch light and shadow both stopping dead at the line. Only the chunks
   * the light can actually reach are marked, so ordinary edits stay cheap.
   */
  markDirtyAround(x: number, y: number, z: number, c?: Chunk, wide = false): void {
    const chunk = c ?? this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (chunk) chunk.dirty = true;
    const lx = x & 15;
    const lz = z & 15;
    if (wide) {
      const cx = x >> 4;
      const cz = z >> 4;
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) this.markChunkDirty(cx + dx, cz + dz);
      }
      return;
    }
    if (lx === 0) this.markChunkDirty((x >> 4) - 1, z >> 4);
    if (lx === 15) this.markChunkDirty((x >> 4) + 1, z >> 4);
    if (lz === 0) this.markChunkDirty(x >> 4, (z >> 4) - 1);
    if (lz === 15) this.markChunkDirty(x >> 4, (z >> 4) + 1);
    if (lx === 0 && lz === 0) this.markChunkDirty((x >> 4) - 1, (z >> 4) - 1);
    if (lx === 15 && lz === 0) this.markChunkDirty((x >> 4) + 1, (z >> 4) - 1);
    if (lx === 0 && lz === 15) this.markChunkDirty((x >> 4) - 1, (z >> 4) + 1);
    if (lx === 15 && lz === 15) this.markChunkDirty((x >> 4) + 1, (z >> 4) + 1);
  }

  private markChunkDirty(cx: number, cz: number): void {
    const c = this.chunks.get(chunkKey(cx, cz));
    if (c) c.dirty = true;
  }

  /* ---------------------------------------------------------------- */
  /* Lighting accessors                                                */
  /* ---------------------------------------------------------------- */

  getLightAt(channel: number, x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_Y) return 0;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return 0;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    return channel === 0 ? c.skyLight[i] : c.blockLight[i];
  }

  setLightAt(channel: number, x: number, y: number, z: number, level: number): void {
    if (y < 0 || y >= CHUNK_Y) return;
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    if (channel === 0) c.skyLight[i] = level;
    else c.blockLight[i] = level;
  }

  getSkyLightAt(x: number, y: number, z: number): number {
    return this.getLightAt(0, x, y, z);
  }

  getBlockLightAt(x: number, y: number, z: number): number {
    return this.getLightAt(1, x, y, z);
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  isSolidAt(x: number, y: number, z: number): boolean {
    return isSolid(this.getBlockAt(x, y, z));
  }

  isOpaqueAt(x: number, y: number, z: number): boolean {
    return lightAttenuation(this.getBlockAt(x, y, z)) >= 15;
  }

  isLiquidAt(x: number, y: number, z: number): boolean {
    return isLiquid(this.getBlockAt(x, y, z));
  }

  /** Highest y with a solid block at this column, or -1. */
  heightAt(x: number, z: number): number {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return -1;
    return c.heightMap[(z & 15) * 16 + (x & 15)];
  }

  /** First non-air y at or above `from`, searching upward. */
  findSurfaceY(x: number, z: number, from = 0): number {
    for (let y = Math.max(0, from); y < CHUNK_Y; y++) {
      const id = this.getBlockAt(x, y, z);
      if (id !== 0 && isSolid(id)) return y;
    }
    return -1;
  }

  /* ---------------------------------------------------------------- */
  /* Gravity-affected blocks (sand, gravel)                            */
  /* ---------------------------------------------------------------- */

  private scheduleFall(x: number, y: number, z: number): void {
    if (y < 0 || y >= CHUNK_Y) return;
    const id = this.getBlockAt(x, y, z);
    if (!def(id).gravity) return;
    const key = (((x + 0x1000000) & 0xffffff) * 4096 + ((z + 0x1000000) & 0xffffff)) * 128 + y;
    if (this.fallQueued.has(key)) return;
    this.fallQueued.add(key);
    this.pendingFall.push(x, y, z, key);
  }

  /** Called on a timer by the game loop. Returns true when something moved. */
  tickFallingBlocks(maxOps = 64): boolean {
    let ops = 0;
    let moved = false;
    while (this.pendingFall.length >= 4 && ops < maxOps) {
      const key = this.pendingFall.pop()!;
      const z = this.pendingFall.pop()!;
      const y = this.pendingFall.pop()!;
      const x = this.pendingFall.pop()!;
      this.fallQueued.delete(key);
      const id = this.getBlockAt(x, y, z);
      if (id === 0 || !def(id).gravity) continue;
      const below = this.getBlockAt(x, y - 1, z);
      if (y > 0 && (below === 0 || isLiquid(below))) {
        this.setBlock(x, y, z, 0, true);
        this.setBlock(x, y - 1, z, id, true);
        moved = true;
        ops++;
        this.scheduleFall(x, y + 1, z);
      }
    }
    return moved;
  }

  /* ---------------------------------------------------------------- */
  /* Bulk helpers                                                      */
  /* ---------------------------------------------------------------- */

  /** Fill a cuboid with a block, used by structure generators. */
  fill(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++)
        for (let x = x0; x <= x1; x++) this.setBlockRaw(x, y, z, id);
  }

  /** Biome id at world column. */
  biomeAt(x: number, z: number): number {
    const c = this.chunks.get(chunkKey(x >> 4, z >> 4));
    if (!c) return 0;
    return c.biome[(z & 15) * 16 + (x & 15)];
  }

  get maxY(): number {
    return CHUNK_Y;
  }
}

export { CHUNK_X, CHUNK_Y, CHUNK_Z };
