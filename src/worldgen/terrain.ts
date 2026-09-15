/**
 * Terrain generation.
 *
 * Pipeline per chunk:
 *   1. climate (temperature / humidity / continentalness)
 *   2. elevation from layered noise + ridged mountains + river carving
 *   3. stone base, surface & subsurface material, sea-level water
 *   4. cave carving
 *   5. ore veins and stone pockets
 *   6. structures (villages, dungeons, wells)
 *   7. decoration (trees, grass, flowers, cacti, reeds)
 *   8. height map + biome map
 *
 * Every step is a pure function of (seed, world coordinates) so borders match
 * regardless of generation order.
 */

import { CHUNK_Y, Chunk } from '../world/chunk.js';
import { SEA_LEVEL } from '../world/chunk.js';
import { B } from '../world/blocks.js';
import { Noise2D, clamp, smoothstep } from '../util/noise.js';
import { Rng, hashFloat2, hash2, hash3 } from '../util/rng.js';
import { CaveGenerator } from './caves.js';
import { StructureGenerator } from './structures.js';
import { BIOMES, biomeById } from './biomes.js';
import { oakTree, bigOakTree, birchTree, spruceTree, cactusTree, deadBushShape } from './trees.js';

export interface ColumnInfo {
  height: number;
  biome: number;
  temp: number;
  humidity: number;
  continent: number;
  river: number;
}

type MemoEntry = ColumnInfo & { mx: number; mz: number };

interface OreRule {
  block: number;
  veins: number;
  size: number;
  minY: number;
  maxY: number;
  /** only replace these blocks */
  target: number[];
}

const ORE_RULES: OreRule[] = [
  { block: B.coal_ore, veins: 14, size: 11, minY: 6, maxY: 96, target: [B.stone] },
  { block: B.iron_ore, veins: 11, size: 7, minY: 6, maxY: 68, target: [B.stone] },
  { block: B.gold_ore, veins: 3, size: 6, minY: 6, maxY: 34, target: [B.stone] },
  { block: B.redstone_ore, veins: 6, size: 7, minY: 5, maxY: 22, target: [B.stone] },
  { block: B.diamond_ore, veins: 2, size: 5, minY: 5, maxY: 17, target: [B.stone] },
  { block: B.lapis_ore, veins: 2, size: 6, minY: 6, maxY: 34, target: [B.stone] },
  { block: B.gravel, veins: 4, size: 22, minY: 24, maxY: 92, target: [B.stone] },
  { block: B.dirt, veins: 5, size: 24, minY: 24, maxY: 92, target: [B.stone] },
  { block: B.clay, veins: 3, size: 14, minY: 40, maxY: 60, target: [B.stone, B.dirt, B.sand] },
];

export class TerrainGenerator {
  readonly seed: number;
  private nCont: Noise2D;
  private nHill: Noise2D;
  private nDetail: Noise2D;
  private nMtn: Noise2D;
  private nFlat: Noise2D;
  private nTemp: Noise2D;
  private nHumid: Noise2D;
  private nRiver: Noise2D;
  private nBiomeJitter: Noise2D;
  readonly caves: CaveGenerator;
  readonly structures: StructureGenerator;

  /** small memo so decoration does not re-evaluate the same column */
  private memo = new Map<number, MemoEntry>();
  private static MEMO_LIMIT = 40000;

  constructor(seed: number) {
    this.seed = seed;
    this.nCont = new Noise2D(seed ^ 0x1001);
    this.nHill = new Noise2D(seed ^ 0x2002);
    this.nDetail = new Noise2D(seed ^ 0x3003);
    this.nMtn = new Noise2D(seed ^ 0x4004);
    this.nFlat = new Noise2D(seed ^ 0x5005);
    this.nTemp = new Noise2D(seed ^ 0x6006);
    this.nHumid = new Noise2D(seed ^ 0x7007);
    this.nRiver = new Noise2D(seed ^ 0x8008);
    this.nBiomeJitter = new Noise2D(seed ^ 0x9009);
    this.caves = new CaveGenerator(seed);
    this.structures = new StructureGenerator(seed, (x, z) => this.columnInfo(x, z).height, (x, z) => this.columnInfo(x, z).biome);
  }

  /* ---------------------------------------------------------------- */
  /* Climate + elevation                                               */
  /* ---------------------------------------------------------------- */

  private continentAt(x: number, z: number): number {
    // Raw value noise only spans about +-0.35 in practice, so it is amplified
    // before shaping - otherwise every column lands near sea level.
    const c = clamp(this.nCont.fbm(x / 900, z / 900, 4, 2, 0.5) * 2.4, -1, 1);
    // +0.06 bias keeps the land/ocean ratio closer to 45/55 than 30/70
    const cc = clamp(c * 0.5 + 0.5 + 0.06, 0, 1);
    // shape the curve: deep ocean floors, broad relatively flat land masses
    return cc < 0.5 ? 0.5 * Math.pow(cc * 2, 1.7) : 0.5 + 0.5 * Math.pow((cc - 0.5) * 2, 0.85);
  }

  columnInfo(x: number, z: number): ColumnInfo {
    const key = (((x & 0x3ffff) << 18) | (z & 0x3ffff)) >>> 0;
    const hit = this.memo.get(key);
    // verify the coordinates as well as the hash key: two columns can collide
    if (hit !== undefined && hit.mx === x && hit.mz === z) return hit;

    const shaped = this.continentAt(x, z);
    const hill = this.nHill.fbm(x / 230, z / 230, 4, 2, 0.5) * 2.2;
    const detail = this.nDetail.fbm(x / 58, z / 58, 2, 2, 0.5) * 2;
    const flatN = clamp(this.nFlat.fbm(x / 300, z / 300, 2, 2, 0.5) * 2 * 0.5 + 0.5, 0, 1);
    const mtnRaw = clamp(this.nMtn.ridged(x / 360, z / 360, 4, 2, 0.5) * 1.5, 0, 1);

    // Land rises faster than ocean floors descend, so continents read as
    // plateaus rather than as one continuous slope.
    const rel = shaped - 0.5;
    let h = SEA_LEVEL + rel * (rel < 0 ? 80 : 62);

    const landMask = smoothstep(0.44, 0.62, shaped);
    const hillAmp = (2.4 + 13 * flatN) * landMask;
    h += hill * hillAmp;
    h += detail * 1.9 * (0.4 + landMask);

    // dramatic but not ubiquitous mountains
    const mtnMask = smoothstep(0.55, 0.78, shaped) * smoothstep(0.42, 0.76, mtnRaw);
    h += mtnMask * 54;

    // rivers: long, widely spaced channels carved down towards sea level
    const riverField = Math.abs(this.nRiver.noise(x / 1400, z / 1400) * 1.7);
    const river = 1 - smoothstep(0.055, 0.15, riverField);
    if (river > 0) {
      const target = SEA_LEVEL - 3 - river * 2;
      h = h + (target - h) * river * 0.88;
    }

    let temp = clamp(this.nTemp.fbm(x / 620, z / 620, 3, 2, 0.5) * 2.9 * 0.5 + 0.5, 0, 1);
    let humidity = clamp(this.nHumid.fbm(x / 520, z / 520, 3, 2, 0.5) * 2.9 * 0.5 + 0.5, 0, 1);
    // biome jitter breaks up perfectly smooth climate bands
    const jitter = this.nBiomeJitter.noise(x / 190, z / 190) * 0.045;
    temp = clamp(temp + jitter, 0, 1);
    humidity = clamp(humidity - jitter * 0.7, 0, 1);
    // altitude cools the climate
    temp = clamp(temp - Math.max(0, h - (SEA_LEVEL + 22)) * 0.0042, 0, 1);

    const rounded = clamp(Math.round(h), 3, CHUNK_Y - 8);
    // mx/mz let the memo detect hash collisions between distant columns
    const info: MemoEntry = {
      height: rounded,
      biome: 0,
      temp,
      humidity,
      continent: shaped,
      river,
      mx: x,
      mz: z,
    };
    info.biome = this.pickBiome(info);
    if (this.memo.size > TerrainGenerator.MEMO_LIMIT) this.memo.clear();
    this.memo.set(key, info);
    return info;
  }

  heightAt(x: number, z: number): number {
    return this.columnInfo(x, z).height;
  }

  biomeAt(x: number, z: number): number {
    return this.columnInfo(x, z).biome;
  }

  private pickBiome(c: ColumnInfo): number {
    const h = c.height;
    const t = c.temp;
    const hum = c.humidity;

    if (h < SEA_LEVEL - 6) return c.continent < 0.16 ? 1 : 0; // deep ocean : ocean
    if (c.river > 0.45 && h <= SEA_LEVEL + 2) return 15; // river
    if (h <= SEA_LEVEL + 1) {
      if (t < 0.24) return 7; // frozen shore reads as snowy plains
      return 2; // beach
    }
    if (h > SEA_LEVEL + 44) {
      if (t < 0.38) return 13; // snowy mountains
      if (h > SEA_LEVEL + 58) return 14; // bare stone peaks
      return 12;
    }
    if (h > SEA_LEVEL + 30 && t < 0.42 && hum < 0.45) return 12;

    // low, wet, warm -> swamp
    if (hum > 0.70 && t > 0.42 && h < SEA_LEVEL + 6) return 11;
    if (t < 0.25) return hum > 0.46 ? 8 : 7; // snowy taiga : snowy plains
    if (t < 0.43) return hum > 0.44 ? 6 : 3; // taiga : plains
    if (t > 0.64 && hum < 0.42) return 9; // desert
    if (t > 0.58 && hum < 0.52) return 10; // savanna
    if (hum > 0.50) return t > 0.55 ? 4 : 5; // forest : birch forest
    return 3; // plains
  }

  /* ---------------------------------------------------------------- */
  /* Chunk generation                                                  */
  /* ---------------------------------------------------------------- */

  generateChunk(chunk: Chunk): void {
    const cx = chunk.cx;
    const cz = chunk.cz;
    const baseX = cx * 16;
    const baseZ = cz * 16;

    // local caches so decoration does not re-evaluate the climate
    const heights = new Int16Array(256);
    const biomeIds = new Uint8Array(256);
    const rng = new Rng(hash3(this.seed ^ 0xabcdef, cx, 0, cz));

    chunk.blocks.fill(0);

    /* ---- 1. base terrain ---- */
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = baseX + x;
        const wz = baseZ + z;
        const info = this.columnInfo(wx, wz);
        const h = info.height;
        const bi = biomeById(info.biome);
        heights[z * 16 + x] = h;
        biomeIds[z * 16 + x] = info.biome;

        const soil = info.biome === 9 ? 4 : info.biome === 2 || info.biome === 15 ? 2 : 3;

        for (let y = 0; y <= h; y++) {
          let id: number;
          if (y === 0) id = B.bedrock;
          else if (y <= 3 && hashFloat2(this.seed ^ 0xbed, wx * 3 + y, wz * 5) < 0.62) id = B.bedrock;
          else if (y === h) {
            id = h < SEA_LEVEL ? bi.underwater : bi.top;
          } else if (y > h - soil) id = bi.filler;
          else id = B.stone;
          chunk.blocks[(y << 8) | (z << 4) | x] = id;
        }
        // sea level fill
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          chunk.blocks[(y << 8) | (z << 4) | x] = B.water;
        }
        // frozen surface in cold biomes
        if (bi.snowy && h < SEA_LEVEL && chunk.blocks[(SEA_LEVEL << 8) | (z << 4) | x] === B.water) {
          chunk.blocks[(SEA_LEVEL << 8) | (z << 4) | x] = B.ice;
        }
      }
    }

    /* ---- 2. caves ---- */
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = baseX + x;
        const wz = baseZ + z;
        const surface = heights[z * 16 + x];
        const region = this.caves.regionAt(wx, wz);
        if (region < 0.34) continue;
        const yTop = Math.min(surface - 4, 96);
        for (let y = 4; y <= yTop; y++) {
          const i = (y << 8) | (z << 4) | x;
          const id = chunk.blocks[i];
          if (id === B.bedrock || id === B.water) continue;
          if (!this.caves.isCarved(wx, y, wz, surface, region)) continue;
          chunk.blocks[i] = y <= 10 ? B.lava : 0;
        }
      }
    }

    /* ---- 3. ores & pockets ---- */
    for (const rule of ORE_RULES) this.placeOre(chunk, rng, rule, heights);

    /* ---- 4. structures ---- */
    const stamps = this.structures.stampsForChunk(cx, cz);
    if (stamps) {
      for (const s of stamps) {
        const lx = s.x - baseX;
        const lz = s.z - baseZ;
        if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
        if (s.y < 0 || s.y >= CHUNK_Y) continue;
        chunk.blocks[(s.y << 8) | (lz << 4) | lx] = s.id;
      }
    }

    /* ---- 5. decoration ---- */
    this.decorate(chunk, heights, biomeIds);

    /* ---- 6. height map ---- */
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        let top = -1;
        for (let y = CHUNK_Y - 1; y >= 0; y--) {
          const id = chunk.blocks[(y << 8) | (z << 4) | x];
          if (id !== 0 && id !== B.water) {
            top = y;
            break;
          }
        }
        chunk.heightMap[z * 16 + x] = top;
        chunk.biome[z * 16 + x] = biomeIds[z * 16 + x];
      }
    }
  }

  /* ---------------------------------------------------------------- */
  /* Ores                                                              */
  /* ---------------------------------------------------------------- */

  private placeOre(chunk: Chunk, rng: Rng, rule: OreRule, heights: Int16Array): void {
    for (let v = 0; v < rule.veins; v++) {
      const ox = rng.int(0, 15);
      const oz = rng.int(0, 15);
      const oy = rng.int(rule.minY, Math.min(rule.maxY, CHUNK_Y - 2));
      const count = rng.int(Math.max(2, rule.size >> 1), rule.size);
      let x = ox;
      let y = oy;
      let z = oz;
      for (let k = 0; k < count; k++) {
        if (x >= 0 && x < 16 && z >= 0 && z < 16 && y > 0 && y < CHUNK_Y) {
          const i = (y << 8) | (z << 4) | x;
          const cur = chunk.blocks[i];
          if (rule.target.indexOf(cur) >= 0) chunk.blocks[i] = rule.block;
        }
        // biased random walk keeps veins roughly connected
        const dir = rng.int(0, 5);
        if (dir === 0) x++;
        else if (dir === 1) x--;
        else if (dir === 2) y++;
        else if (dir === 3) y--;
        else if (dir === 4) z++;
        else z--;
        if (y < rule.minY) y = rule.minY;
        if (y > rule.maxY) y = rule.maxY;
      }
    }
    void heights;
  }

  /* ---------------------------------------------------------------- */
  /* Decoration                                                        */
  /* ---------------------------------------------------------------- */

  /** True when the block at local (x,y,z) is a natural surface we may build on. */
  private isSoilBlock(chunk: Chunk, lx: number, ly: number, lz: number): boolean {
    if (ly < 0 || ly >= CHUNK_Y - 1) return false;
    const id = chunk.blocks[(ly << 8) | (lz << 4) | lx];
    return (
      id === B.grass_block ||
      id === B.dirt ||
      id === B.sand ||
      id === B.snowy_grass_block ||
      id === B.snow_block ||
      id === B.gravel ||
      id === B.clay
    );
  }

  private decorate(chunk: Chunk, heights: Int16Array, biomeIds: Uint8Array): void {
    const baseX = chunk.cx * 16;
    const baseZ = chunk.cz * 16;

    // ---- trees: scan a 3x3 chunk halo so cross-border canopies are complete
    for (let tcx = -1; tcx <= 1; tcx++) {
      for (let tcz = -1; tcz <= 1; tcz++) {
        this.decorateTreesInChunk(chunk, baseX + tcx * 16, baseZ + tcz * 16, tcx, tcz);
      }
    }

    // ---- ground cover inside this chunk only
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = baseX + x;
        const wz = baseZ + z;
        const h = heights[z * 16 + x];
        const bi = biomeById(biomeIds[z * 16 + x]);
        const above = h + 1;
        if (above >= CHUNK_Y - 1) continue;
        const i = (above << 8) | (z << 4) | x;
        if (chunk.blocks[i] !== 0) continue;
        const ground = chunk.blocks[(h << 8) | (z << 4) | x];
        if (ground === B.water || ground === B.ice) {
          // reeds on the shoreline
          if (bi.reedDensity > 0 && hashFloat2(this.seed ^ 0x8eed, wx, wz) < bi.reedDensity * 0.05) {
            const g = this.findGround(chunk, x, above, z);
            if (g >= 0 && g >= SEA_LEVEL - 2 && g <= SEA_LEVEL + 1) {
              for (let k = 1; k <= 2; k++) {
                if (g + k < CHUNK_Y) chunk.blocks[((g + k) << 8) | (z << 4) | x] = B.reeds;
              }
            }
          }
          continue;
        }
        const plantable = this.isSoilBlock(chunk, x, h, z);
        if (!plantable) continue;

        const r = hashFloat2(this.seed ^ 0x91a7, wx, wz);
        if (bi.snowy && ground === B.snowy_grass_block) {
          // sparse snowy ground cover only
          if (r < 0.02) chunk.blocks[i] = B.tall_grass;
          continue;
        }
        if (r < bi.cactusDensity * 0.06) {
          const shape = cactusTree(new Rng(hash2(this.seed ^ 0xca0, wx, wz)));
          this.stampShape(chunk, wx, above, wz, shape.blocks);
          continue;
        }
        if (r < bi.cactusDensity * 0.06 + bi.deadBushDensity * 0.05) {
          const shape = deadBushShape(new Rng(hash2(this.seed ^ 0xdea0, wx, wz)));
          this.stampShape(chunk, wx, above, wz, shape.blocks);
          continue;
        }
        const r2 = hashFloat2(this.seed ^ 0x5b21, wx, wz);
        if (r2 < bi.grassDensity) {
          chunk.blocks[i] = B.tall_grass;
          continue;
        }
        const r3 = hashFloat2(this.seed ^ 0x7c33, wx, wz);
        if (r3 < bi.flowerDensity) {
          const kind = hash2(this.seed ^ 0xf10e, wx, wz) % 3;
          chunk.blocks[i] = kind === 0 ? B.red_flower : kind === 1 ? B.yellow_flower : B.blue_flower;
          continue;
        }
        const r4 = hashFloat2(this.seed ^ 0x9d44, wx, wz);
        if (r4 < bi.mushroomDensity) {
          chunk.blocks[i] = hash2(this.seed ^ 0x3ee1, wx, wz) % 2 === 0 ? B.red_mushroom : B.brown_mushroom;
          continue;
        }
        const r5 = hashFloat2(this.seed ^ 0xab55, wx, wz);
        if (r5 < 0.0022) {
          chunk.blocks[i] = B.pumpkin;
        }
      }
    }

    void heights;
  }

  private findGround(chunk: Chunk, x: number, fromY: number, z: number): number {
    for (let y = Math.max(0, fromY - 5); y < fromY + 1; y++) {
      const id = chunk.blocks[(y << 8) | (z << 4) | x];
      if (id !== 0 && id !== B.water && id !== B.ice && id !== B.reeds) return y;
    }
    return -1;
  }

  private decorateTreesInChunk(chunk: Chunk, originX: number, originZ: number, tcx: number, tcz: number): void {
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        const wx = originX + x;
        const wz = originZ + z;
        // cheap gate before the expensive climate lookup
        const gate = hashFloat2(this.seed ^ 0x7ee5, wx, wz);
        if (gate > 11 / 256) continue;
        // never grow trees inside a village
        if (this.structures.isVillageArea(wx, wz)) continue;
        const info = this.columnInfo(wx, wz);
        const bi = biomeById(info.biome);
        if (bi.treeDensity <= 0 || bi.trees.length === 0) continue;
        if (gate > bi.treeDensity / 256) continue;
        if (info.height <= SEA_LEVEL) continue;

        // weighted tree choice
        let total = 0;
        for (const t of bi.trees) total += t.weight;
        const pick = hashFloat2(this.seed ^ 0x3311, wx, wz) * total;
        let acc = 0;
        let type = bi.trees[0].type;
        for (const t of bi.trees) {
          acc += t.weight;
          if (pick <= acc) {
            type = t.type;
            break;
          }
        }
        const treeRng = new Rng(hash2(this.seed ^ 0x7211, wx, wz));
        const shape =
          type === 'oak' ? oakTree(treeRng)
          : type === 'big_oak' ? bigOakTree(treeRng)
          : type === 'birch' ? birchTree(treeRng)
          : type === 'spruce' ? spruceTree(treeRng)
          : type === 'cactus' ? cactusTree(treeRng)
          : deadBushShape(treeRng);
        // never plant a tree whose canopy would cross the build limit: the
        // clip would leave bare trunk and floating leaves at the top
        if (info.height + 1 + shape.height >= CHUNK_Y) continue;
        this.stampShape(chunk, wx, info.height + 1, wz, shape.blocks, tcx, tcz);
      }
    }
  }

  /** Write a shape, keeping only the blocks that land inside `chunk`. */
  private stampShape(
    chunk: Chunk,
    baseX: number,
    baseY: number,
    baseZ: number,
    blocks: readonly [number, number, number, number][],
    _tcx = 0,
    _tcz = 0,
  ): void {
    const ox = chunk.cx * 16;
    const oz = chunk.cz * 16;
    for (const [dx, dy, dz, id] of blocks) {
      const wx = baseX + dx;
      const wy = baseY + dy;
      const wz = baseZ + dz;
      const lx = wx - ox;
      const lz = wz - oz;
      if (lx < 0 || lx > 15 || lz < 0 || lz > 15) continue;
      if (wy < 1 || wy >= CHUNK_Y) continue;
      const i = (wy << 8) | (lz << 4) | lx;
      const existing = chunk.blocks[i];
      // logs and leaves never overwrite solid terrain unless it is a plant
      if (existing !== 0 && existing !== B.tall_grass && existing !== B.red_flower && existing !== B.yellow_flower && existing !== B.blue_flower && existing !== B.oak_leaves && existing !== B.birch_leaves && existing !== B.spruce_leaves) {
        continue;
      }
      chunk.blocks[i] = id;
    }
  }
}

export { BIOMES };
