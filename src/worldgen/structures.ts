/**
 * Deterministic structure generation (villages, underground dungeons, desert
 * wells).
 *
 * Placement is driven by a coarse region grid so that a structure is a pure
 * function of (seed, region). Each structure is baked once into per-chunk stamp
 * lists; a chunk then only has to look up its own list, which keeps generation
 * order irrelevant and chunk borders seamless.
 */

import { B } from '../world/blocks.js';
import { Rng, hash2, hashFloat2 } from '../util/rng.js';

export interface Stamp {
  x: number;
  y: number;
  z: number;
  id: number;
}

export interface StructureInfo {
  kind: 'village' | 'dungeon' | 'well';
  x: number;
  y: number;
  z: number;
}

interface VillageSite {
  x: number;
  z: number;
  y: number;
}

type HeightFn = (x: number, z: number) => number;
type BiomeFn = (x: number, z: number) => number;

const CHUNK = 16;

function chunkKeyOf(cx: number, cz: number): number {
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

/* ------------------------------------------------------------------ */

class StampBuilder {
  stamps: Stamp[] = [];

  set(x: number, y: number, z: number, id: number): void {
    this.stamps.push({ x, y, z, id });
  }

  box(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = y0; y <= y1; y++)
      for (let z = z0; z <= z1; z++) for (let x = x0; x <= x1; x++) this.set(x, y, z, id);
  }

  /** Four walls, no floor/ceiling. */
  walls(x0: number, y0: number, z0: number, x1: number, y1: number, z1: number, id: number): void {
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        this.set(x, y, z0, id);
        this.set(x, y, z1, id);
      }
      for (let z = z0; z <= z1; z++) {
        this.set(x0, y, z, id);
        this.set(x1, y, z, id);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Village pieces                                                      */
/* ------------------------------------------------------------------ */

function well(s: StampBuilder, cx: number, y: number, cz: number): void {
  s.box(cx - 2, y - 4, cz - 2, cx + 2, y, cz + 2, B.cobblestone);
  s.box(cx - 1, y - 4, cz - 1, cx + 1, y - 1, cz + 1, B.water);
  s.box(cx - 2, y + 1, cz - 2, cx + 2, y + 1, cz + 2, 0);
  // corner posts + roof
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as [number, number][]) {
    for (let k = 1; k <= 3; k++) s.set(cx + dx, y + k, cz + dz, B.oak_fence);
  }
  s.box(cx - 3, y + 4, cz - 3, cx + 3, y + 4, cz + 3, B.oak_planks);
  s.walls(cx - 2, y + 4, cz - 2, cx + 2, y + 5, cz + 2, B.oak_planks);
  s.box(cx - 2, y + 6, cz - 2, cx + 2, y + 6, cz + 2, B.oak_planks);
}

function lampPost(s: StampBuilder, x: number, y: number, z: number): void {
  s.set(x, y, z, B.cobblestone);
  s.set(x, y + 1, z, B.oak_fence);
  s.set(x, y + 2, z, B.oak_fence);
  s.set(x, y + 3, z, B.torch);
}

function path(s: StampBuilder, x0: number, z0: number, x1: number, z1: number, y: number, width = 2): void {
  const dx = Math.sign(x1 - x0);
  const dz = Math.sign(z1 - z0);
  let x = x0;
  let z = z0;
  let guard = 0;
  while ((x !== x1 || z !== z1) && guard++ < 200) {
    for (let ox = 0; ox < width; ox++) {
      for (let oz = 0; oz < width; oz++) s.set(x + ox, y, z + oz, B.dirt);
    }
    if (x !== x1) x += dx;
    if (z !== z1) z += dz;
  }
  for (let ox = 0; ox < width; ox++) for (let oz = 0; oz < width; oz++) s.set(x1 + ox, y, z1 + oz, B.dirt);
}

function house(
  s: StampBuilder,
  x0: number,
  y: number,
  z0: number,
  w: number,
  d: number,
  h: number,
  rng: Rng,
  doorSide: 'north' | 'south' | 'east' | 'west',
  height: HeightFn,
): void {
  const x1 = x0 + w - 1;
  const z1 = z0 + d - 1;

  // level the ground: fill foundation down, clear headroom up
  for (let z = z0 - 1; z <= z1 + 1; z++) {
    for (let x = x0 - 1; x <= x1 + 1; x++) {
      const ground = height(x, z);
      for (let y2 = Math.min(ground, y) - 1; y2 < y; y2++) s.set(x, y2, z, B.cobblestone);
      for (let y2 = y; y2 <= y + h + 3; y2++) s.set(x, y2, z, 0);
    }
  }
  // floor
  s.box(x0, y - 1, z0, x1, y - 1, z1, B.oak_planks);
  // walls with cobble corners
  s.walls(x0, y, z0, x1, y + h - 1, z1, B.oak_planks);
  for (const [cx, cz] of [[x0, z0], [x1, z0], [x0, z1], [x1, z1]] as [number, number][]) {
    for (let y2 = y; y2 <= y + h - 1; y2++) s.set(cx, y2, cz, B.cobblestone);
  }
  // windows
  for (let x = x0 + 1; x <= x1 - 1; x++) {
    s.set(x, y + 2, z0, B.glass);
    s.set(x, y + 2, z1, B.glass);
  }
  for (let z = z0 + 1; z <= z1 - 1; z++) {
    s.set(x0, y + 2, z, B.glass);
    s.set(x1, y + 2, z, B.glass);
  }
  // door
  const dx = Math.floor((x0 + x1) / 2);
  const dz = Math.floor((z0 + z1) / 2);
  if (doorSide === 'north') {
    s.set(dx, y, z0, B.oak_door);
    s.set(dx, y + 1, z0, 0);
  } else if (doorSide === 'south') {
    s.set(dx, y, z1, B.oak_door);
    s.set(dx, y + 1, z1, 0);
  } else if (doorSide === 'west') {
    s.set(x0, y, dz, B.oak_door);
    s.set(x0, y + 1, dz, 0);
  } else {
    s.set(x1, y, dz, B.oak_door);
    s.set(x1, y + 1, dz, 0);
  }
  // gable roof: full-length slabs that shrink toward a ridge, plus closed ends.
  // A darker wood reads as a separate roof material against the plank walls.
  const roofBlock = B.spruce_planks;
  const alongX = w >= d;
  const shortLen = (alongX ? d : w) + 2;
  const layers = Math.max(1, Math.round(shortLen / 2));
  const long0 = (alongX ? x0 : z0) - 1;
  const long1 = (alongX ? x1 : z1) + 1;
  for (let layer = 0; layer < layers; layer++) {
    const s0 = layer;
    const s1 = shortLen - 1 - layer;
    if (s0 > s1) break;
    const yy = y + h + layer;
    if (alongX) {
      s.box(long0, yy, z0 - 1 + s0, long1, yy, z0 - 1 + s1, roofBlock);
    } else {
      s.box(x0 - 1 + s0, yy, long0, x0 - 1 + s1, yy, long1, roofBlock);
    }
  }
  // close the triangular gable ends so the roof is not see-through
  for (let layer = 0; layer < layers; layer++) {
    const s0 = layer;
    const s1 = shortLen - 1 - layer;
    if (s0 > s1) break;
    const yy = y + h + layer;
    if (alongX) {
      s.box(x0, yy, z0 - 1 + s0, x0, yy, z0 - 1 + s1, B.oak_planks);
      s.box(x1, yy, z0 - 1 + s0, x1, yy, z0 - 1 + s1, B.oak_planks);
    } else {
      s.box(x0 - 1 + s0, yy, z0, x0 - 1 + s1, yy, z0, B.oak_planks);
      s.box(x0 - 1 + s0, yy, z1, x0 - 1 + s1, yy, z1, B.oak_planks);
    }
  }
  // interior light + furniture
  s.set(dx, y + h - 1, dz, B.torch);
  if (rng.chance(0.6)) s.set(x0 + 1, y, z0 + 1, B.crafting_table);
  if (rng.chance(0.4)) s.set(x1 - 1, y, z0 + 1, B.furnace);
  if (rng.chance(0.4)) s.set(x0 + 1, y, z1 - 1, B.chest);
  if (rng.chance(0.5)) {
    // a small bookshelf nook
    s.set(x1 - 1, y + 1, z1 - 1, B.bookshelf);
  }
}

function farmPlot(s: StampBuilder, x0: number, y: number, z0: number, w: number, d: number, rng: Rng): void {
  for (let z = z0; z < z0 + d; z++) {
    for (let x = x0; x < x0 + w; x++) {
      const edge = x === x0 || x === x0 + w - 1 || z === z0 || z === z0 + d - 1;
      if (edge) {
        s.set(x, y, z, B.oak_fence);
        continue;
      }
      const channel = (x - x0) % 4 === 2;
      if (channel) {
        s.set(x, y - 1, z, B.water);
        s.set(x, y, z, 0);
      } else {
        s.set(x, y - 1, z, B.farmland);
        s.set(x, y, z, rng.chance(0.75) ? B.wheat_crop : 0);
      }
    }
  }
}

/* ------------------------------------------------------------------ */
/* Village layout                                                      */
/* ------------------------------------------------------------------ */

function buildVillage(centerX: number, centerZ: number, baseY: number, seed: number, height: HeightFn, biome: BiomeFn): Stamp[] {
  const rng = new Rng(seed);
  const s = new StampBuilder();
  const groundY = (x: number, z: number) => Math.max(height(x, z), baseY - 3);

  well(s, centerX, baseY, centerZ);

  const placed: { x: number; z: number; w: number; d: number }[] = [];
  const slots: [number, number][] = [];
  // deterministic ring of candidate plots, deliberately well spaced so houses
  // never fuse into one another
  for (const radius of [11, 19, 27]) {
    const count = radius < 12 ? 4 : radius < 20 ? 6 : 8;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + radius * 0.7;
      slots.push([Math.round(centerX + Math.cos(a) * radius), Math.round(centerZ + Math.sin(a) * radius)]);
    }
  }
  // shuffle deterministically
  for (let i = slots.length - 1; i > 0; i--) {
    const j = rng.int(0, i);
    const t = slots[i];
    slots[i] = slots[j];
    slots[j] = t;
  }

  const buildingCount = rng.int(6, 9);
  let built = 0;
  for (const [sx, sz] of slots) {
    if (built >= buildingCount) break;
    const big = rng.chance(0.28);
    const w = big ? rng.int(7, 9) : rng.int(5, 7);
    const d = big ? rng.int(6, 8) : rng.int(5, 7);
    const x0 = sx - Math.floor(w / 2);
    const z0 = sz - Math.floor(d / 2);
    // reject overlapping plots
    let ok = true;
    for (const p of placed) {
      if (Math.abs(p.x - x0) < Math.max(p.w, w) + 5 && Math.abs(p.z - z0) < Math.max(p.d, d) + 5) {
        ok = false;
        break;
      }
    }
    if (Math.abs(sx - centerX) < 5 && Math.abs(sz - centerZ) < 5) ok = false;
    if (!ok) continue;
    // slope test
    let minH = 999;
    let maxH = -999;
    for (const [ox, oz] of [[0, 0], [w - 1, 0], [0, d - 1], [w - 1, d - 1]] as [number, number][]) {
      const hh = height(x0 + ox, z0 + oz);
      minH = Math.min(minH, hh);
      maxH = Math.max(maxH, hh);
    }
    if (maxH - minH > 6) continue;

    const y = Math.round((minH + maxH) / 2);
    // door faces the village centre
    const ddx = centerX - sx;
    const ddz = centerZ - sz;
    const doorSide = Math.abs(ddx) > Math.abs(ddz) ? (ddx > 0 ? 'east' : 'west') : ddz > 0 ? 'south' : 'north';
    house(s, x0, y, z0, w, d, big ? 4 : 3, rng, doorSide, groundY);
    placed.push({ x: x0, z: z0, w, d });
    built++;

    // connect the plot to the centre with a path
    const doorX = doorSide === 'east' ? x0 + w : doorSide === 'west' ? x0 - 3 : sx;
    const doorZ = doorSide === 'south' ? z0 + d : doorSide === 'north' ? z0 - 3 : sz;
    path(s, doorX, doorZ, centerX + 3, centerZ + 3, baseY, 2);
    if (rng.chance(0.5)) lampPost(s, doorX + 1, baseY + 1, doorZ + 1);
  }

  // farms
  const farmCount = rng.int(1, 3);
  for (let i = 0; i < farmCount; i++) {
    const a = rng.range(0, Math.PI * 2);
    const r = rng.range(9, 26);
    const fx = Math.round(centerX + Math.cos(a) * r);
    const fz = Math.round(centerZ + Math.sin(a) * r);
    let clash = false;
    for (const p of placed) {
      if (Math.abs(p.x - fx) < p.w + 4 && Math.abs(p.z - fz) < p.d + 4) clash = true;
    }
    if (clash) continue;
    let minH = 999;
    let maxH = -999;
    for (const [ox, oz] of [[0, 0], [7, 0], [0, 9], [7, 9]] as [number, number][]) {
      const hh = height(fx + ox, fz + oz);
      minH = Math.min(minH, hh);
      maxH = Math.max(maxH, hh);
    }
    if (maxH - minH > 4) continue;
    const y = Math.max(minH, maxH);
    const w = 9;
    const d = 11;
    for (let z = fz - 1; z <= fz + d; z++)
      for (let x = fx - 1; x <= fx + w; x++) {
        const g = height(x, z);
        for (let y2 = Math.min(g, y) - 1; y2 < y; y2++) s.set(x, y2, z, B.dirt);
        for (let y2 = y; y2 <= y + 3; y2++) s.set(x, y2, z, 0);
      }
    farmPlot(s, fx, y, fz, w, d, rng);
  }

  // outer lamps along the plaza
  for (let i = 0; i < 4; i++) {
    const a = (i / 4) * Math.PI * 2 + 0.4;
    lampPost(s, Math.round(centerX + Math.cos(a) * 6), baseY + 1, Math.round(centerZ + Math.sin(a) * 6));
  }

  // scatter a few bushes for life
  for (let i = 0; i < 14; i++) {
    const x = centerX + rng.int(-26, 26);
    const z = centerZ + rng.int(-26, 26);
    const h = height(x, z);
    if (h <= baseY - 4) continue;
    s.set(x, h + 1, z, rng.chance(0.5) ? B.tall_grass : rng.chance(0.5) ? B.yellow_flower : B.red_flower);
  }

  void biome;
  return s.stamps;
}

/* ------------------------------------------------------------------ */
/* Dungeon                                                             */
/* ------------------------------------------------------------------ */

function buildDungeon(x: number, y: number, z: number, seed: number): Stamp[] {
  const rng = new Rng(seed);
  const s = new StampBuilder();
  const w = rng.int(7, 11);
  const d = rng.int(7, 11);
  const x0 = x - Math.floor(w / 2);
  const z0 = z - Math.floor(d / 2);
  s.box(x0 - 1, y - 1, z0 - 1, x0 + w, y + 4, z0 + d, B.cobblestone);
  s.box(x0, y, z0, x0 + w - 1, y + 3, z0 + d - 1, 0);
  // mossy patches on the walls
  for (let i = 0; i < w * 4; i++) {
    const px = x0 + rng.int(0, w - 1);
    const pz = z0 + rng.int(0, d - 1);
    s.set(px, y + rng.int(0, 2), rng.chance(0.5) ? z0 - 1 : z0 + d, B.mossy_cobblestone);
    s.set(rng.chance(0.5) ? x0 - 1 : x0 + w, y + rng.int(0, 2), pz, B.mossy_cobblestone);
  }
  // loot chests + spawner-ish glowstone accent
  s.set(x0 + 1, y, z0 + 1, B.chest);
  if (rng.chance(0.6)) s.set(x0 + w - 2, y, z0 + d - 2, B.chest);
  s.set(x0 + Math.floor(w / 2), y + 3, z0 + Math.floor(d / 2), B.glowstone);
  // a short corridor so it does not read as a sealed box
  const dir = rng.int(0, 3);
  const len = rng.int(4, 9);
  for (let k = 1; k <= len; k++) {
    const cx = x0 + Math.floor(w / 2) + (dir === 0 ? k : dir === 1 ? -k : 0);
    const cz = z0 + Math.floor(d / 2) + (dir === 2 ? k : dir === 3 ? -k : 0);
    s.box(cx - 1, y - 1, cz - 1, cx + 1, y + 3, cz + 1, B.cobblestone);
    s.box(cx, y, cz, cx, y + 2, cz, 0);
  }
  return s.stamps;
}

function buildDesertWell(x: number, y: number, z: number): Stamp[] {
  const s = new StampBuilder();
  s.box(x - 2, y - 2, z - 2, x + 2, y, z + 2, B.sandstone);
  s.box(x - 1, y - 1, z - 1, x + 1, y - 1, z + 1, B.water);
  for (const [dx, dz] of [[-2, -2], [2, -2], [-2, 2], [2, 2]] as [number, number][]) {
    for (let k = 1; k <= 2; k++) s.set(x + dx, y + k, z + dz, B.sandstone);
  }
  s.box(x - 3, y + 3, z - 3, x + 3, y + 3, z + 3, B.sandstone);
  return s.stamps;
}

/* ------------------------------------------------------------------ */

const REGION_CHUNKS = 8; // 128 blocks
const DUNGEON_REGION = 16;
/** columns within this distance of a village centre are not decorated */
const VILLAGE_RADIUS = 42;

export class StructureGenerator {
  private height: HeightFn;
  private biome: BiomeFn;
  private seed: number;

  /** regionKey -> chunkKey -> stamps (bounded cache) */
  private cache = new Map<number, Map<number, Stamp[]> | null>();
  private cacheOrder: number[] = [];
  private static MAX_CACHE = 96;
  /** regionKey -> village centre (or null), cached separately because it is
   *  cheap to compute and is queried during decoration too. */
  private sites = new Map<number, VillageSite | null>();

  /** Structures discovered so far, used by the "locate" debug command. */
  readonly discovered: StructureInfo[] = [];

  constructor(seed: number, height: HeightFn, biome: BiomeFn) {
    this.seed = seed;
    this.height = height;
    this.biome = biome;
  }

  private remember(info: StructureInfo): void {
    if (this.discovered.length < 512) this.discovered.push(info);
  }

  /**
   * Cheap, cached test for "is there a village in this region, and where".
   * Split out from the full layout so decoration can ask about a column without
   * baking an entire village.
   */
  villageSite(rx: number, rz: number): { x: number; z: number; y: number } | null {
    const key = ((rx & 0xffff) << 16) | (rz & 0xffff);
    const cached = this.sites.get(key);
    if (cached !== undefined) return cached;

    let result: { x: number; z: number; y: number } | null = null;
    const r = hashFloat2(this.seed ^ 0x51de, rx, rz);
    const weightBoost = r < 0.15 ? 1 : 0.7;
    if (r < 0.58 * weightBoost) {
      const regionBlocks = REGION_CHUNKS * CHUNK;
      const ox = hash2(this.seed ^ 0x9911, rx, rz) % (regionBlocks - 48);
      const oz = hash2(this.seed ^ 0x2277, rx, rz) % (regionBlocks - 48);
      const cx = rx * regionBlocks + 24 + ox;
      const cz = rz * regionBlocks + 24 + oz;
      if (this.villageAllowed(cx, cz) && this.biome(cx, cz) !== 9) {
        let minH = 999;
        let maxH = -999;
        for (let i = 0; i < 9; i++) {
          const sx = cx + ((i % 3) - 1) * 22;
          const sz = cz + ((Math.floor(i / 3) - 1) * 22);
          const h = this.height(sx, sz);
          minH = Math.min(minH, h);
          maxH = Math.max(maxH, h);
        }
        if (minH > 63 && maxH - minH <= 11) result = { x: cx, z: cz, y: Math.round((minH + maxH) / 2) };
      }
    } else if (r > 0.955) {
      const regionBlocks = REGION_CHUNKS * CHUNK;
      const cx = rx * regionBlocks + 32 + (hash2(this.seed ^ 0x31, rx, rz) % (regionBlocks - 64));
      const cz = rz * regionBlocks + 32 + (hash2(this.seed ^ 0x73, rx, rz) % (regionBlocks - 64));
      if (this.biome(cx, cz) === 9) result = { x: cx, z: cz, y: this.height(cx, cz) + 1 };
    }
    if (this.sites.size > 4096) this.sites.clear();
    this.sites.set(key, result);
    return result;
  }

  /** True when a village occupies this column (decoration must not grow here). */
  isVillageArea(x: number, z: number): boolean {
    const rx = x >> 7;
    const rz = z >> 7;
    for (let drx = -1; drx <= 1; drx++) {
      for (let drz = -1; drz <= 1; drz++) {
        const site = this.villageSite(rx + drx, rz + drz);
        if (!site) continue;
        const dx = site.x - x;
        const dz = site.z - z;
        if (dx * dx + dz * dz <= VILLAGE_RADIUS * VILLAGE_RADIUS) return true;
      }
    }
    return false;
  }

  /** Village attempt for one region; null when the region has none. */
  private villageRegion(rx: number, rz: number): Map<number, Stamp[]> | null {
    const key = ((rx & 0xffff) << 16) | (rz & 0xffff);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let result: Map<number, Stamp[]> | null = null;
    const site = this.villageSite(rx, rz);
    if (site) {
      const isWell = this.biome(site.x, site.z) === 9;
      if (isWell) {
        result = this.group(buildDesertWell(site.x, site.y, site.z));
        this.remember({ kind: 'well', x: site.x, y: site.y, z: site.z });
      } else {
        const stamps = buildVillage(site.x, site.z, site.y, (this.seed ^ (rx * 73856093) ^ (rz * 19349663)) >>> 0, this.height, this.biome);
        result = this.group(stamps);
        this.remember({ kind: 'village', x: site.x, y: site.y, z: site.z });
      }
    }

    this.cache.set(key, result);
    this.cacheOrder.push(key);
    if (this.cacheOrder.length > StructureGenerator.MAX_CACHE) {
      const old = this.cacheOrder.shift()!;
      this.cache.delete(old);
    }
    return result;
  }

  private villageAllowed(x: number, z: number): boolean {
    const id = this.biome(x, z);
    if (id === 0 || id === 1 || id === 2 || id === 14 || id === 15) return false;
    // never build in water
    return this.height(x, z) > 63;
  }

  private dungeonRegion(rx: number, rz: number): Map<number, Stamp[]> | null {
    const key = 0x40000000 | (((rx & 0x7fff) << 16) | (rz & 0x7fff));
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached;

    let result: Map<number, Stamp[]> | null = null;
    const r = hashFloat2(this.seed ^ 0x0d06e0, rx, rz);
    if (r < 0.42) {
      const regionBlocks = DUNGEON_REGION * CHUNK;
      const cx = rx * regionBlocks + (hash2(this.seed ^ 0x18, rx, rz) % (regionBlocks - 32)) + 16;
      const cz = rz * regionBlocks + (hash2(this.seed ^ 0x29, rx, rz) % (regionBlocks - 32)) + 16;
      const surface = this.height(cx, cz);
      const y = Math.min(surface - 8, 26 + (hash2(this.seed ^ 0x3a, rx, rz) % 14));
      if (y > 6) {
        result = this.group(buildDungeon(cx, y, cz, (this.seed ^ (rx * 0x9e3779b1) ^ (rz * 0x85ebca6b)) >>> 0));
        this.remember({ kind: 'dungeon', x: cx, y, z: cz });
      }
    }
    this.cache.set(key, result);
    return result;
  }

  private group(stamps: Stamp[]): Map<number, Stamp[]> {
    const out = new Map<number, Stamp[]>();
    for (const st of stamps) {
      const k = chunkKeyOf(st.x >> 4, st.z >> 4);
      let arr = out.get(k);
      if (!arr) {
        arr = [];
        out.set(k, arr);
      }
      arr.push(st);
    }
    return out;
  }

  /** Every structure stamp that falls inside the given chunk. */
  stampsForChunk(cx: number, cz: number): Stamp[] | null {
    let out: Stamp[] | null = null;
    const push = (map: Map<number, Stamp[]> | null): void => {
      if (!map) return;
      const arr = map.get(chunkKeyOf(cx, cz));
      if (!arr) return;
      if (!out) out = [];
      for (const s of arr) out.push(s);
    };

    // villages can span up to 3x3 regions of 8 chunks => scan a small halo
    for (let drx = -1; drx <= 0; drx++) {
      for (let drz = -1; drz <= 0; drz++) {
        push(this.villageRegion((cx >> 3) + drx + 1, (cz >> 3) + drz + 1));
      }
    }
    for (let drx = -1; drx <= 1; drx++) {
      for (let drz = -1; drz <= 1; drz++) {
        push(this.dungeonRegion((cx >> 4) + drx, (cz >> 4) + drz));
      }
    }
    return out;
  }
}
