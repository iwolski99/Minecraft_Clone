/**
 * Incremental voxel light propagation.
 *
 * Two independent light channels are maintained per chunk:
 *   - skyLight:  seeded from the open sky, attenuated by translucent blocks
 *   - blockLight: emitted by torches, lava, glowstone, ...
 *
 * Block edits use the classic add/remove breadth-first passes so that placing or
 * breaking a single block is O(affected volume) instead of re-lighting a whole
 * region - which is what keeps mining from stuttering.
 *
 * The hot loops read and write chunk typed arrays directly (with a one-entry
 * chunk cache) instead of going through World's Map lookups, which roughly halves
 * the cost of generating a chunk.
 */

import { CHUNK_Y, Chunk, blockIndex, chunkKey } from './chunk.js';
import type { World } from './world.js';
import { BLOCKS } from './blocks.js';

const SKY = 0;
const BLOCK = 1;

/** The four horizontal neighbours, as (dx, dz). */
const NEIGHBOUR_DIRS: readonly [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
type Channel = 0 | 1;

/** +X, -X, +Y, -Y, +Z, -Z  (index 3 is straight down) */
const DIRS: readonly [number, number, number][] = [
  [1, 0, 0],
  [-1, 0, 0],
  [0, 1, 0],
  [0, -1, 0],
  [0, 0, 1],
  [0, 0, -1],
];

/** Flat property tables - see render/mesher.ts for the same technique. */
const ATTEN = new Uint8Array(256);
const EMISSION = new Uint8Array(256);
let tablesReady = false;
function buildTables(): void {
  for (const def of BLOCKS) {
    if (def.id >= 256) continue;
    ATTEN[def.id] = def.lightAttenuation !== undefined ? def.lightAttenuation : def.opaque ? 15 : 0;
    EMISSION[def.id] = def.light ?? 0;
  }
  tablesReady = true;
}

export class LightEngine {
  private world: World;
  private addQ: number[][] = [[], []];
  private remQ: number[][] = [[], []];
  /** one-entry chunk cache: BFS visits are strongly local */
  private cacheKey = 0x7fffffff;
  private cacheChunk: Chunk | undefined;

  constructor(world: World) {
    this.world = world;
    if (!tablesReady) buildTables();
  }

  private chunkAt(x: number, z: number): Chunk | undefined {
    const k = chunkKey(x >> 4, z >> 4);
    if (k === this.cacheKey) return this.cacheChunk;
    this.cacheKey = k;
    this.cacheChunk = this.world.chunks.get(k);
    return this.cacheChunk;
  }

  /* -------------------------------------------------------------- */
  /* Public entry points                                            */
  /* -------------------------------------------------------------- */

  /** Full light initialisation for a freshly generated chunk. */
  initialLight(chunk: Chunk): void {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) this.updateColumnSky(chunk, x, z, false);
    }

    const blocks = chunk.blocks;
    const bl = chunk.blockLight;
    const wx0 = chunk.cx * 16;
    const wz0 = chunk.cz * 16;
    const addBlock = this.addQ[BLOCK];
    for (let y = 0; y < CHUNK_Y; y++) {
      const row = y << 8;
      for (let z = 0; z < 16; z++) {
        const off = row | (z << 4);
        for (let x = 0; x < 16; x++) {
          const e = EMISSION[blocks[off + x]];
          if (e > 0) {
            bl[off + x] = e;
            addBlock.push(wx0 + x, y, wz0 + z, e);
          }
        }
      }
    }
    this.seedFromNeighbours(chunk);
    this.flush();
    /*
     * Light crosses a chunk border in both directions, but only one of them was
     * being computed.
     *
     * A chunk lit now pulls light from its neighbours, so it ends up correct.
     * The neighbours do not: they were lit earlier, when this chunk was still
     * empty, and their border cells keep the darkness they were given then.
     * The result is a hard seam at the chunk edge - sky light and torch light
     * both stopping dead along a line - which persists until some unrelated
     * block change happens to force a local recompute nearby. That is why
     * breaking a single plant made the whole seam disappear.
     *
     * `seedFromNeighbours` only queues cells that are genuinely brighter than
     * the cell they light, so running it back over already-lit neighbours is
     * idempotent and cheap.
     */
    for (const [dx, dz] of NEIGHBOUR_DIRS) {
      const n = this.world.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz));
      if (n) this.seedFromNeighbours(n);
    }
    this.flush();
  }

  flush(): void {
    this.spread(SKY);
    this.spread(BLOCK);
  }

  /** Handle a block replacement at world coordinates. */
  onBlockChanged(x: number, y: number, z: number, oldId: number, newId: number): void {
    const oldAtt = ATTEN[oldId];
    const newAtt = ATTEN[newId];
    const oldEmit = EMISSION[oldId];
    const newEmit = EMISSION[newId];

    /* ---- block light channel ---- */
    if (oldEmit > 0) this.removeAt(BLOCK, x, y, z);
    if (newEmit > 0) {
      this.setLight(BLOCK, x, y, z, newEmit);
      this.addQ[BLOCK].push(x, y, z, newEmit);
    }
    if (newAtt > oldAtt) {
      if (this.getLight(BLOCK, x, y, z) > 0) this.removeAt(BLOCK, x, y, z);
      this.pushNeighbours(BLOCK, x, y, z);
    } else if (newAtt < oldAtt) {
      this.pushNeighbours(BLOCK, x, y, z);
    }

    /* ---- sky channel ---- */
    const chunk = this.chunkAt(x, z);
    if (chunk) this.updateColumnSky(chunk, x - chunk.cx * 16, z - chunk.cz * 16, true);
    if (newAtt > oldAtt) {
      if (this.getLight(SKY, x, y, z) > 0) this.removeAt(SKY, x, y, z);
      this.pushNeighbours(SKY, x, y, z);
    } else if (newAtt < oldAtt) {
      this.pushNeighbours(SKY, x, y, z);
    }
    this.flush();
  }

  /* -------------------------------------------------------------- */
  /* Typed accessors                                                */
  /* -------------------------------------------------------------- */

  private getLight(channel: Channel, x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_Y) return 0;
    const c = this.chunkAt(x, z);
    if (!c) return 0;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    return channel === SKY ? c.skyLight[i] : c.blockLight[i];
  }

  private setLight(channel: Channel, x: number, y: number, z: number, level: number): void {
    if (y < 0 || y >= CHUNK_Y) return;
    const c = this.chunkAt(x, z);
    if (!c) return;
    const i = (y << 8) | ((z & 15) << 4) | (x & 15);
    if (channel === SKY) c.skyLight[i] = level;
    else c.blockLight[i] = level;
  }

  private getBlock(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_Y) return 0;
    const c = this.chunkAt(x, z);
    if (!c) return 0;
    return c.blocks[(y << 8) | ((z & 15) << 4) | (x & 15)];
  }

  private isLoaded(x: number, z: number): boolean {
    if (chunkKey(x >> 4, z >> 4) === this.cacheKey) return this.cacheChunk !== undefined;
    return this.world.chunks.has(chunkKey(x >> 4, z >> 4));
  }

  /* -------------------------------------------------------------- */
  /* Column sky pass                                                */
  /* -------------------------------------------------------------- */

  private updateColumnSky(chunk: Chunk, lx: number, lz: number, incremental: boolean): void {
    const wx = chunk.worldX(lx);
    const wz = chunk.worldZ(lz);
    const blocks = chunk.blocks;
    const skyLight = chunk.skyLight;
    const addSky = this.addQ[SKY];
    let direct = 15;
    for (let y = CHUNK_Y - 1; y >= 0; y--) {
      const i = blockIndex(lx, y, lz);
      const att = ATTEN[blocks[i]];
      if (att >= 15) direct = 0;
      else if (att > 0) direct = Math.max(0, direct - att);

      const cur = skyLight[i];
      if (direct > cur) {
        skyLight[i] = direct;
        addSky.push(wx, y, wz, direct);
      } else if (incremental && direct < cur) {
        this.removeAt(SKY, wx, y, wz);
        if (direct > 0) {
          skyLight[i] = direct;
          addSky.push(wx, y, wz, direct);
        }
      }
    }
  }

  /* -------------------------------------------------------------- */
  /* Propagation                                                    */
  /* -------------------------------------------------------------- */

  private spread(channel: Channel): void {
    const q = this.addQ[channel];
    const world = this.world;
    let head = 0;
    while (head < q.length) {
      const x = q[head];
      const y = q[head + 1];
      const z = q[head + 2];
      const level = q[head + 3];
      head += 4;
      if (level <= 1) continue;

      for (let d = 0; d < 6; d++) {
        const nx = x + DIRS[d][0];
        const ny = y + DIRS[d][1];
        const nz = z + DIRS[d][2];
        if (ny < 0 || ny >= CHUNK_Y) continue;
        // Never propagate into an unloaded chunk: the write would be discarded
        // and the queue would grow without bound.
        const c = this.chunkAt(nx, nz);
        if (!c) continue;
        const ni = (ny << 8) | ((nz & 15) << 4) | (nx & 15);
        const att = ATTEN[c.blocks[ni]];
        if (att >= 15) continue;

        let nl: number;
        if (channel === SKY && d === 3 && level === 15 && att === 0) nl = 15;
        else nl = level - 1 - att;
        if (nl <= 0) continue;
        const arr = channel === SKY ? c.skyLight : c.blockLight;
        if (nl > arr[ni]) {
          arr[ni] = nl;
          q.push(nx, ny, nz, nl);
        }
      }
    }
    q.length = 0;
    void world;
  }

  private removeAt(channel: Channel, x: number, y: number, z: number): void {
    const q = this.remQ[channel];
    const level = this.getLight(channel, x, y, z);
    if (level === 0) return;
    this.setLight(channel, x, y, z, 0);
    q.push(x, y, z, level);
    let head = 0;
    while (head < q.length) {
      const cx = q[head];
      const cy = q[head + 1];
      const cz = q[head + 2];
      const cl = q[head + 3];
      head += 4;
      for (let d = 0; d < 6; d++) {
        const nx = cx + DIRS[d][0];
        const ny = cy + DIRS[d][1];
        const nz = cz + DIRS[d][2];
        if (ny < 0 || ny >= CHUNK_Y) continue;
        const c = this.chunkAt(nx, nz);
        if (!c) continue;
        const ni = (ny << 8) | ((nz & 15) << 4) | (nx & 15);
        const arr = channel === SKY ? c.skyLight : c.blockLight;
        const nl = arr[ni];
        if (nl === 0) continue;
        if (nl < cl) {
          arr[ni] = 0;
          q.push(nx, ny, nz, nl);
        } else {
          this.addQ[channel].push(nx, ny, nz, nl);
        }
      }
    }
    q.length = 0;
  }

  private pushNeighbours(channel: Channel, x: number, y: number, z: number): void {
    const add = this.addQ[channel];
    const lv = this.getLight(channel, x, y, z);
    if (lv > 0) add.push(x, y, z, lv);
    for (let d = 0; d < 6; d++) {
      const nx = x + DIRS[d][0];
      const ny = y + DIRS[d][1];
      const nz = z + DIRS[d][2];
      if (ny < 0 || ny >= CHUNK_Y) continue;
      const nl = this.getLight(channel, nx, ny, nz);
      if (nl > 1) add.push(nx, ny, nz, nl);
    }
  }

  /**
   * Seed from the bordering columns of already-lit neighbours.
   *
   * Only cells that are actually brighter than the cell they would light are
   * queued; in open sky that removes almost all of the work.
   */
  private seedFromNeighbours(chunk: Chunk): void {
    const world = this.world;
    const dirs: [number, number][] = [[1, 0], [-1, 0], [0, 1], [0, -1]];
    const addSky = this.addQ[SKY];
    const addBlock = this.addQ[BLOCK];

    for (const [dx, dz] of dirs) {
      const n = world.chunks.get(chunkKey(chunk.cx + dx, chunk.cz + dz));
      if (!n) continue;
      // The neighbour's border column facing us, plus the step that goes from
      // that column into this chunk. A neighbour at cx+1 exposes its local x=0.
      const lx = dx > 0 ? 0 : dx < 0 ? 15 : -1;
      const lz = dz > 0 ? 0 : dz < 0 ? 15 : -1;
      const stepX = dx === 0 ? 1 : -dx;
      const stepZ = dz === 0 ? 1 : -dz;
      for (let k = 0; k < 16; k++) {
        const px = lx >= 0 ? lx : k;
        const pz = lz >= 0 ? lz : k;
        const wx = n.worldX(px);
        const wz = n.worldZ(pz);
        // the adjacent cell inside the new chunk
        const ax = wx + stepX;
        const az = wz + stepZ;
        const target = this.chunkAt(ax, az);
        if (!target) continue;
        const tix = ax & 15;
        const tiz = az & 15;
        const six = px;
        const siz = pz;
        for (let y = 1; y < CHUNK_Y; y++) {
          const si = (y << 8) | (siz << 4) | six;
          const ti = (y << 8) | (tiz << 4) | tix;
          const s = n.skyLight[si];
          if (s > 1 && s - 1 - ATTEN[target.blocks[ti]] > target.skyLight[ti]) addSky.push(wx, y, wz, s);
          const b = n.blockLight[si];
          if (b > 1 && b - 1 - ATTEN[target.blocks[ti]] > target.blockLight[ti]) addBlock.push(wx, y, wz, b);
        }
      }
    }
  }
}
