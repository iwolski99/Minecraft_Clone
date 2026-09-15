/**
 * Block registry.
 *
 * Every block is a plain data record so that adding a block means adding one
 * entry here (plus a texture painter in `render/textures.ts`).
 */

export type ToolClass = 'pickaxe' | 'axe' | 'shovel' | 'sword' | 'shears' | 'none';
export type RenderKind = 'none' | 'cube' | 'cross' | 'liquid' | 'box' | 'fence';
export type SoundClass = 'stone' | 'dirt' | 'grass' | 'wood' | 'sand' | 'gravel' | 'glass' | 'cloth' | 'plant' | 'liquid';

/** Tool tiers: 0 = hand, 1 = wood/gold, 2 = stone, 3 = iron, 4 = diamond */
export const TIER_NONE = 0;
export const TIER_WOOD = 1;
export const TIER_STONE = 2;
export const TIER_IRON = 3;
export const TIER_DIAMOND = 4;

export interface FaceTex {
  all?: string;
  side?: string;
  top?: string;
  bottom?: string;
  north?: string;
  south?: string;
  east?: string;
  west?: string;
  /** used by cross/box render kinds */
  sprite?: string;
}

export interface DropSpec {
  item: string;
  min?: number;
  max?: number;
  /** only drops when mined with at least this tier of the right tool */
  minTier?: number;
  /** extra independent drop chance */
  chance?: number;
  /** item dropped when the harvest tier requirement is not met */
  elseItem?: string;
}

export interface BlockDef {
  id: number;
  name: string;
  display: string;
  /** blocks movement */
  solid: boolean;
  /** occludes neighbouring faces + blocks skylight fully */
  opaque: boolean;
  /** reduces skylight but does not occlude faces (leaves, water) */
  translucent?: boolean;
  liquid?: boolean;
  /** seconds to break bare-handed at tier 0 */
  hardness: number;
  tool: ToolClass;
  /** minimum tool tier required to get the drop */
  harvestTier?: number;
  /** mining speed multiplier when the correct tool class is used */
  toolSpeed?: number;
  /** light emission 0..15 */
  light?: number;
  /** how much skylight is absorbed per block (0..15) */
  lightAttenuation?: number;
  render: RenderKind;
  tex: FaceTex;
  drops?: DropSpec | DropSpec[];
  /** biome tint applied per-vertex */
  tint?: 'grass' | 'foliage' | 'water' | null;
  sound: SoundClass;
  /** custom AABB for render kind 'box' (0..1 units) */
  box?: [number, number, number, number, number, number];
  /** collision AABB override (0..1 units); null = no collision */
  collision?: [number, number, number, number, number, number] | null;
  gravity?: boolean;
  flammable?: boolean;
  replaceable?: boolean;
  /** item this block turns into when picked (defaults to itself) */
  itemName?: string;
}

const defs: BlockDef[] = [];

function def(d: Partial<BlockDef> & { name: string; display: string }): BlockDef {
  const full: BlockDef = {
    id: defs.length,
    solid: true,
    opaque: true,
    hardness: 1,
    tool: 'none',
    render: 'cube',
    tex: { all: d.name },
    sound: 'stone',
    ...d,
  } as BlockDef;
  full.id = defs.length;
  defs.push(full);
  return full;
}

/* ------------------------------------------------------------------ */
/* Natural                                                             */
/* ------------------------------------------------------------------ */

def({ name: 'air', display: 'Air', solid: false, opaque: false, render: 'none', hardness: 0, tex: {}, replaceable: true });

def({ name: 'stone', display: 'Stone', hardness: 1.5, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'stone' }, drops: { item: 'cobblestone' }, sound: 'stone' });

def({
  name: 'grass_block', display: 'Grass Block', hardness: 0.6, tool: 'shovel', toolSpeed: 4,
  tex: { top: 'grass_top', side: 'grass_side', bottom: 'dirt' }, drops: { item: 'dirt' }, sound: 'grass', tint: 'grass',
});

def({ name: 'dirt', display: 'Dirt', hardness: 0.5, tool: 'shovel', toolSpeed: 4, tex: { all: 'dirt' }, sound: 'dirt' });

def({ name: 'cobblestone', display: 'Cobblestone', hardness: 2.0, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'cobblestone' }, sound: 'stone' });

def({ name: 'oak_planks', display: 'Oak Planks', hardness: 2.0, tool: 'axe', toolSpeed: 4, tex: { all: 'oak_planks' }, sound: 'wood', flammable: true });

def({
  name: 'oak_log', display: 'Oak Log', hardness: 2.0, tool: 'axe', toolSpeed: 4,
  tex: { top: 'oak_log_top', bottom: 'oak_log_top', side: 'oak_log_side' }, sound: 'wood', flammable: true,
});

def({
  name: 'oak_leaves', display: 'Oak Leaves', hardness: 0.2, tool: 'shears', toolSpeed: 15,
  tex: { all: 'oak_leaves' }, sound: 'plant', opaque: false, translucent: true, lightAttenuation: 1,
  tint: 'foliage', flammable: true,
  drops: [{ item: 'oak_sapling', chance: 0.06 }, { item: 'stick', chance: 0.08 }],
});

def({ name: 'sand', display: 'Sand', hardness: 0.5, tool: 'shovel', toolSpeed: 4, tex: { all: 'sand' }, sound: 'sand', gravity: true });

def({ name: 'sandstone', display: 'Sandstone', hardness: 0.8, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { top: 'sandstone_top', bottom: 'sandstone_bottom', side: 'sandstone_side' }, sound: 'stone' });

def({ name: 'gravel', display: 'Gravel', hardness: 0.6, tool: 'shovel', toolSpeed: 4, tex: { all: 'gravel' }, sound: 'gravel', gravity: true, drops: [{ item: 'gravel' }, { item: 'flint', chance: 0.14 }] });

def({
  name: 'water', display: 'Water', solid: false, opaque: false, translucent: true, liquid: true,
  hardness: 100, render: 'liquid', tex: { all: 'water_still' }, sound: 'liquid',
  lightAttenuation: 2, tint: 'water', replaceable: true, collision: null,
});

def({
  name: 'lava', display: 'Lava', solid: false, opaque: false, liquid: true,
  hardness: 100, render: 'liquid', tex: { all: 'lava_still' }, sound: 'liquid',
  light: 15, lightAttenuation: 1, replaceable: true, collision: null,
});

def({ name: 'bedrock', display: 'Bedrock', hardness: -1, tool: 'pickaxe', tex: { all: 'bedrock' }, sound: 'stone' });

def({ name: 'snow_block', display: 'Snow Block', hardness: 0.2, tool: 'shovel', toolSpeed: 10, tex: { all: 'snow' }, sound: 'cloth' });

def({
  name: 'snowy_grass_block', display: 'Snowy Grass Block', hardness: 0.6, tool: 'shovel', toolSpeed: 4,
  tex: { top: 'snow', side: 'snow_side', bottom: 'dirt' }, drops: { item: 'dirt' }, sound: 'grass', tint: 'grass',
});

def({ name: 'clay', display: 'Clay', hardness: 0.6, tool: 'shovel', toolSpeed: 4, tex: { all: 'clay' }, sound: 'dirt', drops: { item: 'clay_ball', min: 4, max: 4 } });

def({ name: 'ice', display: 'Ice', hardness: 0.5, tool: 'pickaxe', toolSpeed: 4, tex: { all: 'ice' }, sound: 'glass', opaque: false, translucent: true, lightAttenuation: 1, drops: [] });

def({ name: 'obsidian', display: 'Obsidian', hardness: 25, tool: 'pickaxe', harvestTier: 4, toolSpeed: 4, tex: { all: 'obsidian' }, sound: 'stone' });

def({ name: 'mossy_cobblestone', display: 'Mossy Cobblestone', hardness: 2.0, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'mossy_cobblestone' }, sound: 'stone' });

/* ------------------------------------------------------------------ */
/* Ores                                                                */
/* ------------------------------------------------------------------ */

def({ name: 'coal_ore', display: 'Coal Ore', hardness: 3.0, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'coal_ore' }, sound: 'stone', drops: { item: 'coal' } });
def({ name: 'iron_ore', display: 'Iron Ore', hardness: 3.0, tool: 'pickaxe', harvestTier: 2, toolSpeed: 4, tex: { all: 'iron_ore' }, sound: 'stone' });
def({ name: 'gold_ore', display: 'Gold Ore', hardness: 3.0, tool: 'pickaxe', harvestTier: 3, toolSpeed: 4, tex: { all: 'gold_ore' }, sound: 'stone' });
def({ name: 'diamond_ore', display: 'Diamond Ore', hardness: 3.0, tool: 'pickaxe', harvestTier: 3, toolSpeed: 4, tex: { all: 'diamond_ore' }, sound: 'stone', drops: { item: 'diamond' } });
def({ name: 'redstone_ore', display: 'Redstone Ore', hardness: 3.0, tool: 'pickaxe', harvestTier: 3, toolSpeed: 4, tex: { all: 'redstone_ore' }, sound: 'stone', drops: { item: 'redstone_dust', min: 4, max: 5 } });
def({ name: 'lapis_ore', display: 'Lapis Lazuli Ore', hardness: 3.0, tool: 'pickaxe', harvestTier: 2, toolSpeed: 4, tex: { all: 'lapis_ore' }, sound: 'stone', drops: { item: 'lapis_lazuli', min: 4, max: 8 } });

/* ------------------------------------------------------------------ */
/* Wood set                                                            */
/* ------------------------------------------------------------------ */

def({ name: 'birch_planks', display: 'Birch Planks', hardness: 2.0, tool: 'axe', toolSpeed: 4, tex: { all: 'birch_planks' }, sound: 'wood', flammable: true });
def({ name: 'birch_log', display: 'Birch Log', hardness: 2.0, tool: 'axe', toolSpeed: 4, tex: { top: 'birch_log_top', bottom: 'birch_log_top', side: 'birch_log_side' }, sound: 'wood', flammable: true });
def({ name: 'birch_leaves', display: 'Birch Leaves', hardness: 0.2, tool: 'shears', toolSpeed: 15, tex: { all: 'birch_leaves' }, sound: 'plant', opaque: false, translucent: true, lightAttenuation: 1, tint: 'foliage', flammable: true, drops: [{ item: 'birch_sapling', chance: 0.06 }, { item: 'stick', chance: 0.08 }] });
def({ name: 'spruce_planks', display: 'Spruce Planks', hardness: 2.0, tool: 'axe', toolSpeed: 4, tex: { all: 'spruce_planks' }, sound: 'wood', flammable: true });
def({ name: 'spruce_log', display: 'Spruce Log', hardness: 2.0, tool: 'axe', toolSpeed: 4, tex: { top: 'spruce_log_top', bottom: 'spruce_log_top', side: 'spruce_log_side' }, sound: 'wood', flammable: true });
def({ name: 'spruce_leaves', display: 'Spruce Leaves', hardness: 0.2, tool: 'shears', toolSpeed: 15, tex: { all: 'spruce_leaves' }, sound: 'plant', opaque: false, translucent: true, lightAttenuation: 1, tint: 'foliage', flammable: true, drops: [{ item: 'spruce_sapling', chance: 0.06 }, { item: 'stick', chance: 0.08 }] });

/* ------------------------------------------------------------------ */
/* Building / utility                                                  */
/* ------------------------------------------------------------------ */

def({ name: 'glass', display: 'Glass', hardness: 0.3, tool: 'pickaxe', toolSpeed: 4, tex: { all: 'glass' }, sound: 'glass', opaque: false, translucent: true, lightAttenuation: 0, drops: [] });
def({
  name: 'torch', display: 'Torch', solid: false, opaque: false, hardness: 0, render: 'box', light: 14,
  // `torch_side` fills its tile so the 2-texel-wide faces read as a solid post
  // with a flame cap; `torch` is the billboard sprite and would leave them
  // almost entirely transparent.
  tex: { side: 'torch_side', top: 'torch_top', bottom: 'torch_side' }, sound: 'wood',
  box: [0.4375, 0, 0.4375, 0.5625, 0.6875, 0.5625], collision: null, replaceable: false,
});
def({ name: 'crafting_table', display: 'Crafting Table', hardness: 2.5, tool: 'axe', toolSpeed: 4, tex: { top: 'crafting_table_top', bottom: 'oak_planks', side: 'crafting_table_side', north: 'crafting_table_front' }, sound: 'wood', flammable: true });
def({ name: 'furnace', display: 'Furnace', hardness: 3.5, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', north: 'furnace_front' }, sound: 'stone' });
def({ name: 'furnace_lit', display: 'Furnace', hardness: 3.5, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { top: 'furnace_top', bottom: 'furnace_top', side: 'furnace_side', north: 'furnace_front_lit' }, sound: 'stone', light: 13, itemName: 'furnace' });
def({ name: 'chest', display: 'Chest', hardness: 2.5, tool: 'axe', toolSpeed: 4, tex: { top: 'chest_top', bottom: 'chest_top', side: 'chest_side', north: 'chest_front' }, sound: 'wood', opaque: false, translucent: true, lightAttenuation: 0, flammable: true });
def({ name: 'bricks', display: 'Bricks', hardness: 2.0, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'bricks' }, sound: 'stone' });
def({ name: 'stone_bricks', display: 'Stone Bricks', hardness: 1.5, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'stone_bricks' }, sound: 'stone' });
def({ name: 'bookshelf', display: 'Bookshelf', hardness: 1.5, tool: 'axe', toolSpeed: 4, tex: { top: 'oak_planks', bottom: 'oak_planks', side: 'bookshelf' }, sound: 'wood', flammable: true, drops: { item: 'book', min: 3, max: 3 } });
def({ name: 'farmland', display: 'Farmland', hardness: 0.6, tool: 'shovel', toolSpeed: 4, tex: { top: 'farmland', bottom: 'dirt', side: 'dirt' }, sound: 'dirt', drops: { item: 'dirt' } });
def({ name: 'wheat_crop', display: 'Wheat', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'wheat_stage7' }, sound: 'plant', collision: null, replaceable: false, drops: [{ item: 'wheat' }, { item: 'wheat_seeds', min: 1, max: 3 }] });

def({ name: 'iron_block', display: 'Block of Iron', hardness: 5, tool: 'pickaxe', harvestTier: 2, toolSpeed: 4, tex: { all: 'iron_block' }, sound: 'stone' });
def({ name: 'gold_block', display: 'Block of Gold', hardness: 3, tool: 'pickaxe', harvestTier: 3, toolSpeed: 4, tex: { all: 'gold_block' }, sound: 'stone' });
def({ name: 'diamond_block', display: 'Block of Diamond', hardness: 5, tool: 'pickaxe', harvestTier: 3, toolSpeed: 4, tex: { all: 'diamond_block' }, sound: 'stone' });
def({ name: 'coal_block', display: 'Block of Coal', hardness: 5, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'coal_block' }, sound: 'stone' });
def({ name: 'lapis_block', display: 'Block of Lapis Lazuli', hardness: 3, tool: 'pickaxe', harvestTier: 2, toolSpeed: 4, tex: { all: 'lapis_block' }, sound: 'stone' });
def({ name: 'redstone_block', display: 'Block of Redstone', hardness: 5, tool: 'pickaxe', harvestTier: 2, toolSpeed: 4, tex: { all: 'redstone_block' }, sound: 'stone' });
def({ name: 'glowstone', display: 'Glowstone', hardness: 0.3, light: 15, tex: { all: 'glowstone' }, sound: 'glass' });

def({ name: 'white_wool', display: 'White Wool', hardness: 0.8, tex: { all: 'white_wool' }, sound: 'cloth', flammable: true });
def({ name: 'red_wool', display: 'Red Wool', hardness: 0.8, tex: { all: 'red_wool' }, sound: 'cloth', flammable: true });
def({ name: 'blue_wool', display: 'Blue Wool', hardness: 0.8, tex: { all: 'blue_wool' }, sound: 'cloth', flammable: true });
def({ name: 'yellow_wool', display: 'Yellow Wool', hardness: 0.8, tex: { all: 'yellow_wool' }, sound: 'cloth', flammable: true });
def({ name: 'green_wool', display: 'Green Wool', hardness: 0.8, tex: { all: 'green_wool' }, sound: 'cloth', flammable: true });
def({ name: 'black_wool', display: 'Black Wool', hardness: 0.8, tex: { all: 'black_wool' }, sound: 'cloth', flammable: true });
def({ name: 'brown_wool', display: 'Brown Wool', hardness: 0.8, tex: { all: 'brown_wool' }, sound: 'cloth', flammable: true });
def({ name: 'orange_wool', display: 'Orange Wool', hardness: 0.8, tex: { all: 'orange_wool' }, sound: 'cloth', flammable: true });
def({ name: 'purple_wool', display: 'Purple Wool', hardness: 0.8, tex: { all: 'purple_wool' }, sound: 'cloth', flammable: true });
def({ name: 'lime_wool', display: 'Lime Wool', hardness: 0.8, tex: { all: 'lime_wool' }, sound: 'cloth', flammable: true });
def({ name: 'cyan_wool', display: 'Cyan Wool', hardness: 0.8, tex: { all: 'cyan_wool' }, sound: 'cloth', flammable: true });
def({ name: 'gray_wool', display: 'Gray Wool', hardness: 0.8, tex: { all: 'gray_wool' }, sound: 'cloth', flammable: true });

/*
 * Doors.
 *
 * Two blocks tall, with an open and a closed state. The world stores nothing but
 * a block id per cell, so the state and the half are carried by four ids rather
 * than by metadata: that keeps saving, lighting and meshing untouched.
 *
 * A closed door is a thin slab across the cell; the open one is the same slab
 * turned a quarter turn, which is what the original does. Orientation is fixed
 * rather than following the player's facing, which is the one simplification.
 */
const DOOR_TEX = { side: 'oak_door', top: 'oak_planks', bottom: 'oak_planks' };
def({ name: 'oak_door', display: 'Oak Door', hardness: 3.0, tool: 'axe', toolSpeed: 4, render: 'box', tex: DOOR_TEX, box: [0, 0, 0, 1, 1, 0.1875], sound: 'wood', opaque: false, translucent: true, lightAttenuation: 0, flammable: true });
def({ name: 'oak_door_top', display: 'Oak Door', hardness: 3.0, tool: 'axe', toolSpeed: 4, render: 'box', tex: DOOR_TEX, box: [0, 0, 0, 1, 1, 0.1875], sound: 'wood', opaque: false, translucent: true, lightAttenuation: 0, flammable: true });
def({ name: 'oak_door_open', display: 'Oak Door', hardness: 3.0, tool: 'axe', toolSpeed: 4, render: 'box', tex: DOOR_TEX, box: [0, 0, 0, 0.1875, 1, 1], sound: 'wood', opaque: false, translucent: true, lightAttenuation: 0, flammable: true });
def({ name: 'oak_door_open_top', display: 'Oak Door', hardness: 3.0, tool: 'axe', toolSpeed: 4, render: 'box', tex: DOOR_TEX, box: [0, 0, 0, 0.1875, 1, 1], sound: 'wood', opaque: false, translucent: true, lightAttenuation: 0, flammable: true });
def({ name: 'oak_fence', display: 'Oak Fence', hardness: 2.0, tool: 'axe', toolSpeed: 4, render: 'fence', tex: { side: 'oak_planks', top: 'oak_planks', bottom: 'oak_planks' }, box: [0.375, 0, 0.375, 0.625, 1.5, 0.625], sound: 'wood', opaque: false, translucent: true, lightAttenuation: 0, flammable: true, collision: [0.375, 0, 0.375, 0.625, 1.5, 0.625] });

/* ------------------------------------------------------------------ */
/* Plants                                                              */
/* ------------------------------------------------------------------ */

def({ name: 'tall_grass', display: 'Grass', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'tall_grass' }, sound: 'plant', tint: 'grass', collision: null, replaceable: true, drops: [{ item: 'wheat_seeds', chance: 0.125 }] });
def({ name: 'red_flower', display: 'Poppy', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'red_flower' }, sound: 'plant', collision: null, replaceable: true });
def({ name: 'yellow_flower', display: 'Dandelion', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'yellow_flower' }, sound: 'plant', collision: null, replaceable: true });
def({ name: 'blue_flower', display: 'Cornflower', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'blue_flower' }, sound: 'plant', collision: null, replaceable: true });
def({
  name: 'cactus', display: 'Cactus', hardness: 0.4, render: 'cube', opaque: true,
  tex: { top: 'cactus_top', bottom: 'cactus_top', side: 'cactus_side' }, sound: 'plant',
});
def({ name: 'reeds', display: 'Sugar Cane', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'reeds' }, sound: 'plant', tint: 'foliage', collision: null, replaceable: true });
def({ name: 'dead_bush', display: 'Dead Bush', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'dead_bush' }, sound: 'plant', collision: null, replaceable: true, drops: [{ item: 'stick', chance: 0.5, min: 0, max: 2 }] });
def({ name: 'red_mushroom', display: 'Red Mushroom', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'red_mushroom' }, sound: 'plant', collision: null, replaceable: true });
def({ name: 'brown_mushroom', display: 'Brown Mushroom', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'brown_mushroom' }, sound: 'plant', collision: null, replaceable: true });
def({ name: 'pumpkin', display: 'Pumpkin', hardness: 1.0, tool: 'axe', toolSpeed: 4, tex: { top: 'pumpkin_top', bottom: 'pumpkin_top', side: 'pumpkin_side', north: 'pumpkin_face' }, sound: 'wood' });
def({ name: 'melon', display: 'Melon', hardness: 1.0, tool: 'axe', toolSpeed: 4, tex: { top: 'melon_top', bottom: 'melon_top', side: 'melon_side' }, sound: 'wood' });
def({ name: 'hay_block', display: 'Hay Bale', hardness: 0.5, tex: { top: 'hay_top', bottom: 'hay_top', side: 'hay_side' }, sound: 'plant', flammable: true });

def({ name: 'oak_sapling', display: 'Oak Sapling', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'oak_sapling' }, sound: 'plant', collision: null, replaceable: true });
def({ name: 'birch_sapling', display: 'Birch Sapling', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'birch_sapling' }, sound: 'plant', collision: null, replaceable: true });
def({ name: 'spruce_sapling', display: 'Spruce Sapling', solid: false, opaque: false, hardness: 0, render: 'cross', tex: { sprite: 'spruce_sapling' }, sound: 'plant', collision: null, replaceable: true });

/* ------------------------------------------------------------------ */
/* Nether-like dimension blocks                                        */
/* ------------------------------------------------------------------ */

def({ name: 'bloodrock', display: 'Bloodrock', hardness: 0.4, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'bloodrock' }, sound: 'stone' });
def({ name: 'ember_ore', display: 'Ember Ore', hardness: 3.0, tool: 'pickaxe', harvestTier: 1, toolSpeed: 4, tex: { all: 'ember_ore' }, sound: 'stone', drops: { item: 'ember_shard' }, light: 4 });
def({ name: 'molten_rock', display: 'Molten Rock', hardness: 0.6, tex: { all: 'molten_rock' }, light: 12, sound: 'stone' });
def({ name: 'portal_frame', display: 'Portal Frame', hardness: -1, tex: { all: 'portal_frame' }, sound: 'stone' });
def({ name: 'portal', display: 'Portal', solid: false, opaque: false, render: 'box', tex: { side: 'portal', top: 'portal', bottom: 'portal' }, box: [0, 0, 0, 1, 1, 0.05], collision: null, light: 11, sound: 'glass' });

/* ------------------------------------------------------------------ */

/** Convenience numeric IDs, resolved by name so the table order can change. */
export const B: Record<string, number> = {};
for (const d of defs) B[d.name] = d.id;

export const BLOCKS: readonly BlockDef[] = defs;

const byName = new Map<string, BlockDef>();
for (const d of defs) byName.set(d.name, d);

export function getBlock(id: number): BlockDef {
  return defs[id] ?? defs[0];
}

export function blockByName(name: string): BlockDef | undefined {
  return byName.get(name);
}

/** Drops ignore this flag; used to keep grass from spamming the inventory. */
export function dropsFor(d: BlockDef): DropSpec[] {
  if (d.drops === undefined) return [{ item: d.itemName ?? d.name }];
  if (Array.isArray(d.drops)) return d.drops;
  if (Object.keys(d.drops as object).length === 0) return [];
  return [d.drops as DropSpec];
}

export function isOpaque(id: number): boolean {
  return defs[id] !== undefined && defs[id].opaque;
}

export function isSolid(id: number): boolean {
  const d = defs[id];
  return d !== undefined && d.solid;
}

export function isLiquid(id: number): boolean {
  const d = defs[id];
  return d !== undefined && !!d.liquid;
}

export function lightEmission(id: number): number {
  const d = defs[id];
  return d ? (d.light ?? 0) : 0;
}

export function lightAttenuation(id: number): number {
  const d = defs[id];
  if (!d) return 0;
  if (d.lightAttenuation !== undefined) return d.lightAttenuation;
  return d.opaque ? 15 : 0;
}

/** Mining time in seconds, approximating the classic formula. */
export function breakTime(block: BlockDef, heldTier: number, heldClass: ToolClass, heldSpeed: number): number {
  if (block.hardness < 0) return Infinity;
  if (block.hardness === 0) return 0;
  const correctClass = block.tool !== 'none' && heldClass === block.tool;
  const canHarvest = block.harvestTier === undefined || heldTier >= block.harvestTier;
  const speed = correctClass ? heldSpeed : 1;
  const penalty = canHarvest ? 1.5 : 5;
  return (block.hardness * penalty) / speed;
}

export function canHarvest(block: BlockDef, heldTier: number): boolean {
  return block.harvestTier === undefined || heldTier >= block.harvestTier;
}
