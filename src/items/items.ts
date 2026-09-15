/**
 * Item registry.
 *
 * Every placeable block automatically gets a matching item, and standalone
 * items (tools, food, materials) are declared in one table. This keeps item
 * behaviour data-driven instead of scattered through the UI.
 */

import { BLOCKS, B, ToolClass, TIER_NONE, TIER_WOOD, TIER_STONE, TIER_IRON, TIER_DIAMOND } from '../world/blocks.js';
import { itemPainter } from '../render/itemTextures.js';

export interface FoodValue {
  hunger: number;
  saturation: number;
}

export interface ItemDef {
  name: string;
  display: string;
  /** non-zero when the item places a block */
  blockId: number;
  stackSize: number;
  toolClass: ToolClass;
  tier: number;
  /** mining speed multiplier when used on a matching block */
  speed: number;
  /** melee damage */
  attack: number;
  durability: number;
  food?: FoodValue;
  /** furnace burn time in seconds */
  fuel?: number;
  /** override the auto-derived icon */
  sprite?: string;
  /** item is only obtainable in creative */
  creativeOnly?: boolean;
}

export interface ItemStack {
  item: string;
  count: number;
  /** remaining durability for tools */
  damage?: number;
}

const registry = new Map<string, ItemDef>();
const order: ItemDef[] = [];

function register(def: ItemDef): ItemDef {
  registry.set(def.name, def);
  order.push(def);
  return def;
}

/* ------------------------------------------------------------------ */
/* Block items                                                         */
/* ------------------------------------------------------------------ */

/** Blocks that never appear as an inventory item. */
const NO_ITEM = new Set(['air', 'water', 'lava', 'portal', 'furnace_lit', 'wheat_crop', 'farmland', 'bedrock', 'snowy_grass_block']);

for (const b of BLOCKS) {
  if (NO_ITEM.has(b.name)) continue;
  register({
    name: b.name,
    display: b.display,
    blockId: b.id,
    stackSize: 64,
    toolClass: 'none',
    tier: TIER_NONE,
    speed: 1,
    attack: 1,
    durability: 0,
  });
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

interface ToolSpec {
  material: string;
  tier: number;
  speed: number;
  attack: number;
  durability: number;
  display: string;
}

const TOOL_MATERIALS: ToolSpec[] = [
  { material: 'wooden', tier: TIER_WOOD, speed: 2, attack: 0, durability: 60, display: 'Wooden' },
  { material: 'stone', tier: TIER_STONE, speed: 4, attack: 1, durability: 132, display: 'Stone' },
  { material: 'iron', tier: TIER_IRON, speed: 6, attack: 2, durability: 251, display: 'Iron' },
  { material: 'golden', tier: TIER_WOOD, speed: 12, attack: 0, durability: 33, display: 'Golden' },
  { material: 'diamond', tier: TIER_DIAMOND, speed: 8, attack: 3, durability: 1562, display: 'Diamond' },
];

const TOOL_KINDS: { kind: string; display: string; toolClass: ToolClass; attack: number }[] = [
  { kind: 'pickaxe', display: 'Pickaxe', toolClass: 'pickaxe', attack: 2 },
  { kind: 'axe', display: 'Axe', toolClass: 'axe', attack: 3 },
  { kind: 'shovel', display: 'Shovel', toolClass: 'shovel', attack: 1 },
  { kind: 'sword', display: 'Sword', toolClass: 'sword', attack: 4 },
  { kind: 'hoe', display: 'Hoe', toolClass: 'hoe' as ToolClass, attack: 1 },
];

for (const m of TOOL_MATERIALS) {
  for (const t of TOOL_KINDS) {
    register({
      name: `${m.material}_${t.kind}`,
      display: `${m.display} ${t.display}`,
      blockId: 0,
      stackSize: 1,
      toolClass: t.toolClass,
      tier: m.tier,
      speed: m.speed,
      attack: t.attack + m.attack,
      durability: m.durability,
    });
  }
}

register({
  name: 'shears', display: 'Shears', blockId: 0, stackSize: 1,
  toolClass: 'shears', tier: TIER_IRON, speed: 15, attack: 1, durability: 238,
});
register({
  name: 'bow', display: 'Bow', blockId: 0, stackSize: 1,
  toolClass: 'none', tier: TIER_NONE, speed: 1, attack: 1, durability: 384,
});

/* ------------------------------------------------------------------ */
/* Materials, food, misc                                               */
/* ------------------------------------------------------------------ */

function mat(name: string, display: string, extra: Partial<ItemDef> = {}): ItemDef {
  return register({
    name, display, blockId: 0, stackSize: 64,
    toolClass: 'none', tier: TIER_NONE, speed: 1, attack: 1, durability: 0,
    ...extra,
  });
}

mat('stick', 'Stick', { fuel: 5 });
mat('coal', 'Coal', { fuel: 80 });
mat('charcoal', 'Charcoal', { fuel: 80 });
mat('iron_ingot', 'Iron Ingot');
mat('gold_ingot', 'Gold Ingot');
mat('diamond', 'Diamond');
mat('redstone_dust', 'Redstone');
mat('lapis_lazuli', 'Lapis Lazuli');
mat('clay_ball', 'Clay Ball');
mat('flint', 'Flint');
mat('bone', 'Bone');
mat('string', 'String');
mat('gunpowder', 'Gunpowder');
mat('feather', 'Feather');
mat('leather', 'Leather');
mat('paper', 'Paper');
mat('book', 'Book');
mat('ember_shard', 'Ember Shard');
mat('arrow', 'Arrow');
mat('wheat', 'Wheat');
mat('wheat_seeds', 'Wheat Seeds');
mat('bucket', 'Bucket', { stackSize: 16 });
mat('water_bucket', 'Water Bucket', { stackSize: 1 });

mat('bowl', 'Bowl', { stackSize: 16 });
mat('mushroom_stew', 'Mushroom Stew', { food: { hunger: 6, saturation: 7.2 }, stackSize: 1 });

mat('apple', 'Apple', { food: { hunger: 4, saturation: 2.4 } });
mat('bread', 'Bread', { food: { hunger: 5, saturation: 6 } });
mat('porkchop', 'Raw Porkchop', { food: { hunger: 3, saturation: 1.8 } });
mat('cooked_porkchop', 'Cooked Porkchop', { food: { hunger: 8, saturation: 12.8 } });
mat('beef', 'Raw Beef', { food: { hunger: 3, saturation: 1.8 } });
mat('cooked_beef', 'Steak', { food: { hunger: 8, saturation: 12.8 } });
mat('chicken', 'Raw Chicken', { food: { hunger: 2, saturation: 1.2 } });
mat('cooked_chicken', 'Cooked Chicken', { food: { hunger: 6, saturation: 7.2 } });
mat('mutton', 'Raw Mutton', { food: { hunger: 2, saturation: 1.2 } });
mat('cooked_mutton', 'Cooked Mutton', { food: { hunger: 6, saturation: 9.6 } });
mat('rotten_flesh', 'Rotten Flesh', { food: { hunger: 4, saturation: 0.8 } });

register({ name: 'emerald_shard', display: 'Emerald Shard', blockId: 0, stackSize: 64, toolClass: 'none', tier: TIER_NONE, speed: 1, attack: 1, durability: 0 });
register({ name: 'shears_blade', display: 'Blade', blockId: 0, stackSize: 64, toolClass: 'none', tier: TIER_NONE, speed: 1, attack: 1, durability: 0 });

/* ------------------------------------------------------------------ */
/* Fuel values for blocks                                              */
/* ------------------------------------------------------------------ */

const BLOCK_FUEL: Record<string, number> = {
  oak_planks: 15,
  birch_planks: 15,
  spruce_planks: 15,
  oak_log: 15,
  birch_log: 15,
  spruce_log: 15,
  oak_sapling: 5,
  birch_sapling: 5,
  spruce_sapling: 5,
  bookshelf: 15,
  crafting_table: 15,
  chest: 15,
  coal_block: 800,
  oak_door: 10,
  oak_fence: 10,
  hay_block: 20,
};
for (const [name, time] of Object.entries(BLOCK_FUEL)) {
  const d = registry.get(name);
  if (d) d.fuel = time;
}

/* ------------------------------------------------------------------ */

export function itemDef(name: string): ItemDef | undefined {
  return registry.get(name);
}

export function allItems(): readonly ItemDef[] {
  return order;
}

export function itemDisplay(name: string): string {
  return registry.get(name)?.display ?? name;
}

export function isBlockItem(name: string): boolean {
  const d = registry.get(name);
  return !!d && d.blockId > 0;
}

export function blockIdOf(name: string): number {
  return registry.get(name)?.blockId ?? 0;
}

export function maxStack(name: string): number {
  return registry.get(name)?.stackSize ?? 64;
}

export function fuelValue(name: string): number {
  return registry.get(name)?.fuel ?? 0;
}

/** A representative block for a "block" item name, or 0. */
export function itemBlockId(name: string): number {
  return registry.get(name)?.blockId ?? 0;
}

export function makeStack(item: string, count = 1): ItemStack {
  const def = registry.get(item);
  const stack: ItemStack = { item, count: Math.min(count, def?.stackSize ?? 64) };
  if (def && def.durability > 0) stack.damage = 0;
  return stack;
}

/** True when the item has an icon painter (standalone sprite) rather than a block. */
export function hasSprite(name: string): boolean {
  return itemPainter(name) !== undefined;
}

/** Everything the creative palette offers, in a sensible order. */
export function creativePalette(): string[] {
  const blocks = BLOCKS.filter((b) => !NO_ITEM.has(b.name)).map((b) => b.name);
  const extras = [
    'wooden_pickaxe', 'stone_pickaxe', 'iron_pickaxe', 'diamond_pickaxe',
    'wooden_axe', 'stone_axe', 'iron_axe', 'diamond_axe',
    'wooden_shovel', 'stone_shovel', 'iron_shovel', 'diamond_shovel',
    'wooden_sword', 'stone_sword', 'iron_sword', 'diamond_sword',
    'wooden_hoe', 'stone_hoe', 'iron_hoe', 'diamond_hoe',
    'shears', 'bow', 'arrow', 'stick', 'coal', 'charcoal', 'iron_ingot', 'gold_ingot',
    'diamond', 'redstone_dust', 'lapis_lazuli', 'clay_ball', 'flint', 'bone', 'string',
    'gunpowder', 'feather', 'leather', 'paper', 'book', 'ember_shard',
    'apple', 'bread', 'wheat', 'wheat_seeds', 'bucket',
  ];
  return [...extras, ...blocks].filter((n, i, a) => registry.has(n) && a.indexOf(n) === i);
}

export { B };
