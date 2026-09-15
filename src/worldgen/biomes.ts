/**
 * Biome definitions and climate sampling.
 *
 * Biomes are selected from independent temperature / humidity / continental
 * noise fields so that they form large coherent regions with believable
 * transitions instead of alternating every few blocks.
 */

import { B } from '../world/blocks.js';

export interface TreeSpawn {
  type: 'oak' | 'birch' | 'spruce' | 'big_oak' | 'cactus' | 'dead';
  weight: number;
}

export interface BiomeDef {
  id: number;
  name: string;
  display: string;
  /** surface block */
  top: number;
  /** 2-4 blocks below the surface */
  filler: number;
  /** block used under water instead of `top` */
  underwater: number;
  /** subtle multiplier applied to grass-tinted blocks */
  grassTint: [number, number, number];
  /** subtle multiplier applied to foliage-tinted blocks */
  foliageTint: [number, number, number];
  trees: TreeSpawn[];
  /** average number of trees per chunk */
  treeDensity: number;
  grassDensity: number;
  flowerDensity: number;
  /** extra decorations */
  cactusDensity: number;
  deadBushDensity: number;
  mushroomDensity: number;
  reedDensity: number;
  snowy: boolean;
  /** villages are only placed in biomes with a positive weight */
  villageWeight: number;
  /** relative terrain flatness multiplier (1 = normal) */
  relief: number;
}

function biome(b: Partial<BiomeDef> & { id: number; name: string; display: string }): BiomeDef {
  return {
    top: B.grass_block,
    filler: B.dirt,
    underwater: B.dirt,
    grassTint: [1, 1, 1],
    foliageTint: [1, 1, 1],
    trees: [],
    treeDensity: 0,
    grassDensity: 0.06,
    flowerDensity: 0.008,
    cactusDensity: 0,
    deadBushDensity: 0,
    mushroomDensity: 0,
    reedDensity: 0,
    snowy: false,
    villageWeight: 0,
    relief: 1,
    ...b,
  };
}

export const BIOMES: BiomeDef[] = [];

function add(b: BiomeDef): BiomeDef {
  BIOMES[b.id] = b;
  return b;
}

export const B_OCEAN = add(biome({
  id: 0, name: 'ocean', display: 'Ocean',
  top: B.gravel, filler: B.stone, underwater: B.sand,
  grassTint: [0.86, 0.96, 0.9], foliageTint: [0.86, 0.96, 0.9],
  grassDensity: 0, relief: 0.5,
}));

export const B_DEEP_OCEAN = add(biome({
  id: 1, name: 'deep_ocean', display: 'Deep Ocean',
  top: B.gravel, filler: B.stone, underwater: B.gravel,
  grassDensity: 0, relief: 0.4,
}));

export const B_BEACH = add(biome({
  id: 2, name: 'beach', display: 'Beach',
  top: B.sand, filler: B.sand, underwater: B.sand,
  grassTint: [1.02, 1, 0.86], foliageTint: [1.0, 0.98, 0.85],
  grassDensity: 0.005, relief: 0.45, treeDensity: 0,
}));

export const B_PLAINS = add(biome({
  id: 3, name: 'plains', display: 'Plains',
  grassTint: [0.98, 1.03, 0.88], foliageTint: [0.98, 1.02, 0.9],
  trees: [{ type: 'oak', weight: 1 }],
  treeDensity: 0.55, grassDensity: 0.14, flowerDensity: 0.02,
  villageWeight: 1.0, relief: 0.45,
}));

export const B_FOREST = add(biome({
  id: 4, name: 'forest', display: 'Forest',
  grassTint: [0.86, 1.0, 0.8], foliageTint: [0.85, 1.0, 0.82],
  trees: [{ type: 'oak', weight: 6 }, { type: 'birch', weight: 3 }, { type: 'big_oak', weight: 1 }],
  treeDensity: 4.6, grassDensity: 0.12, flowerDensity: 0.04,
  mushroomDensity: 0.01, villageWeight: 0.5, relief: 0.8,
}));

export const B_BIRCH_FOREST = add(biome({
  id: 5, name: 'birch_forest', display: 'Birch Forest',
  grassTint: [0.95, 1.03, 0.86], foliageTint: [0.96, 1.04, 0.88],
  trees: [{ type: 'birch', weight: 9 }, { type: 'oak', weight: 1 }],
  treeDensity: 4.2, grassDensity: 0.12, flowerDensity: 0.03,
  villageWeight: 0.35, relief: 0.7,
}));

export const B_TAIGA = add(biome({
  id: 6, name: 'taiga', display: 'Taiga',
  grassTint: [0.78, 0.96, 0.86], foliageTint: [0.8, 0.98, 0.9],
  trees: [{ type: 'spruce', weight: 8 }, { type: 'oak', weight: 1 }],
  treeDensity: 4.0, grassDensity: 0.08, flowerDensity: 0.008,
  villageWeight: 0.25, relief: 0.9,
}));

export const B_SNOWY_PLAINS = add(biome({
  id: 7, name: 'snowy_plains', display: 'Snowy Plains',
  top: B.snowy_grass_block,
  grassTint: [0.86, 0.96, 0.96], foliageTint: [0.86, 0.96, 0.96],
  trees: [{ type: 'spruce', weight: 1 }],
  treeDensity: 0.4, grassDensity: 0.02, flowerDensity: 0,
  snowy: true, villageWeight: 0.15, relief: 0.5,
}));

export const B_SNOWY_TAIGA = add(biome({
  id: 8, name: 'snowy_taiga', display: 'Snowy Taiga',
  top: B.snowy_grass_block,
  grassTint: [0.8, 0.92, 0.94], foliageTint: [0.82, 0.94, 0.96],
  trees: [{ type: 'spruce', weight: 9 }],
  treeDensity: 3.8, grassDensity: 0.02, flowerDensity: 0,
  snowy: true, villageWeight: 0.1, relief: 0.9,
}));

export const B_DESERT = add(biome({
  id: 9, name: 'desert', display: 'Desert',
  top: B.sand, filler: B.sandstone, underwater: B.sand,
  grassTint: [1.06, 1.0, 0.72], foliageTint: [1.04, 0.98, 0.72],
  // No trees: a desert in this game is sand, sandstone, dead bush and the
  // occasional cactus. Cacti used to come from *two* paths at once - this tree
  // list (treeDensity 0.5) and cactusDensity 0.9 below - which carpeted the sand
  // with them. Only the dedicated path places them now, at a seventh the rate.
  trees: [],
  treeDensity: 0, grassDensity: 0, flowerDensity: 0,
  cactusDensity: 0.13, deadBushDensity: 0.35,
  villageWeight: 0.6, relief: 0.4,
}));

export const B_SAVANNA = add(biome({
  id: 10, name: 'savanna', display: 'Savanna',
  grassTint: [1.04, 1.0, 0.72], foliageTint: [1.02, 0.99, 0.74],
  trees: [{ type: 'oak', weight: 1 }],
  treeDensity: 0.7, grassDensity: 0.22, flowerDensity: 0.006,
  villageWeight: 0.7, relief: 0.5,
}));

export const B_SWAMP = add(biome({
  id: 11, name: 'swamp', display: 'Swamp',
  grassTint: [0.74, 0.9, 0.66], foliageTint: [0.76, 0.9, 0.68],
  trees: [{ type: 'oak', weight: 1 }],
  treeDensity: 1.2, grassDensity: 0.18, flowerDensity: 0.006,
  mushroomDensity: 0.05, reedDensity: 1.4,
  villageWeight: 0.05, relief: 0.18,
}));

export const B_MOUNTAINS = add(biome({
  id: 12, name: 'mountains', display: 'Mountains',
  top: B.grass_block, filler: B.dirt, underwater: B.gravel,
  grassTint: [0.9, 0.98, 0.86], foliageTint: [0.9, 0.98, 0.88],
  trees: [{ type: 'spruce', weight: 3 }, { type: 'oak', weight: 1 }],
  treeDensity: 1.2, grassDensity: 0.05, flowerDensity: 0.004,
  villageWeight: 0.05, relief: 1.45,
}));

export const B_SNOWY_MOUNTAINS = add(biome({
  id: 13, name: 'snowy_mountains', display: 'Snowy Mountains',
  top: B.snow_block, filler: B.stone, underwater: B.gravel,
  grassTint: [0.86, 0.94, 0.96], foliageTint: [0.86, 0.94, 0.96],
  trees: [{ type: 'spruce', weight: 1 }],
  treeDensity: 0.25, grassDensity: 0, flowerDensity: 0,
  snowy: true, villageWeight: 0, relief: 1.6,
}));

export const B_STONE_SHORE = add(biome({
  id: 14, name: 'stone_shore', display: 'Stone Shore',
  top: B.stone, filler: B.stone, underwater: B.gravel,
  grassDensity: 0, relief: 1.1,
}));

export const B_RIVER = add(biome({
  id: 15, name: 'river', display: 'River',
  top: B.sand, filler: B.sand, underwater: B.sand,
  grassTint: [0.95, 1.02, 0.88], foliageTint: [0.95, 1.0, 0.9],
  grassDensity: 0.04, reedDensity: 1.1, relief: 0.2,
}));

export const BIOME_COUNT = BIOMES.length;

export function biomeById(id: number): BiomeDef {
  return BIOMES[id] ?? BIOMES[3];
}
