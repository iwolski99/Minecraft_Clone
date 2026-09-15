/**
 * Crafting and smelting data.
 *
 * Recipes are stored as structured data and matched by a generic pattern
 * matcher, so adding a recipe never means touching UI code.
 */

import { CraftingGrid, SmeltRecipe } from './inventory.js';

export interface RecipeOutput {
  item: string;
  count: number;
}

export interface ShapedRecipe {
  kind: 'shaped';
  pattern: string[];
  key: Record<string, string>;
  output: RecipeOutput;
}

export interface ShapelessRecipe {
  kind: 'shapeless';
  ingredients: string[];
  output: RecipeOutput;
}

export type Recipe = ShapedRecipe | ShapelessRecipe;

const recipes: Recipe[] = [];

function shaped(pattern: string[], key: Record<string, string>, item: string, count = 1): void {
  recipes.push({ kind: 'shaped', pattern, key, output: { item, count } });
}

function shapeless(ingredients: string[], item: string, count = 1): void {
  recipes.push({ kind: 'shapeless', ingredients, output: { item, count } });
}

/* ------------------------------------------------------------------ */
/* Wood                                                                */
/* ------------------------------------------------------------------ */

const WOODS: [string, string][] = [
  ['oak_log', 'oak_planks'],
  ['birch_log', 'birch_planks'],
  ['spruce_log', 'spruce_planks'],
];

for (const [log, planks] of WOODS) {
  shapeless([log], planks, 4);
}

for (const [, planks] of WOODS) {
  shaped(['X', 'X'], { X: planks }, 'stick', 4);
  shaped(['XX', 'XX'], { X: planks }, 'crafting_table', 1);
  shaped(['XXX', 'X X', 'XXX'], { X: planks }, 'chest', 1);
  shaped(['XXX', 'XXX'], { X: planks }, 'oak_door', 3);
  shaped(['XYX', 'XYX'], { X: planks, Y: 'stick' }, 'oak_fence', 3);
  shaped(['XXX', 'XXX', 'XXX'], { X: planks }, 'bookshelf', 1);
  // the classic bowl: a plank in each corner and one in the middle
  shaped(['X X', ' X '], { X: planks }, 'bowl', 4);
}

// Mushroom stew: a bowl and one of each mushroom, in any arrangement.
shapeless(['bowl', 'red_mushroom', 'brown_mushroom'], 'mushroom_stew', 1);

/* ------------------------------------------------------------------ */
/* Stone & building                                                    */
/* ------------------------------------------------------------------ */

shaped(['XXX', 'X X', 'XXX'], { X: 'cobblestone' }, 'furnace', 1);
shaped(['XX', 'XX'], { X: 'stone' }, 'stone_bricks', 4);
shaped(['XX', 'XX'], { X: 'sand' }, 'sandstone', 1);
shaped(['XX', 'XX'], { X: 'clay_ball' }, 'bricks', 1);
shaped(['XX', 'XX'], { X: 'string' }, 'white_wool', 1);
shaped(['XXX', 'XXX', 'XXX'], { X: 'wheat' }, 'hay_block', 1);

/* ------------------------------------------------------------------ */
/* Storage blocks                                                      */
/* ------------------------------------------------------------------ */

const COMPRESS: [string, string][] = [
  ['iron_ingot', 'iron_block'],
  ['gold_ingot', 'gold_block'],
  ['diamond', 'diamond_block'],
  ['coal', 'coal_block'],
  ['lapis_lazuli', 'lapis_block'],
  ['redstone_dust', 'redstone_block'],
];
for (const [item, block] of COMPRESS) {
  shaped(['XXX', 'XXX', 'XXX'], { X: item }, block, 1);
  shapeless([block], item, 9);
}

/* ------------------------------------------------------------------ */
/* Tools                                                               */
/* ------------------------------------------------------------------ */

const TOOL_MATS: [string, string][] = [
  // Every plank type makes wooden tools. Only oak was listed, so a sword or
  // shovel laid out correctly in birch or spruce simply did not match.
  ['oak_planks', 'wooden'],
  ['birch_planks', 'wooden'],
  ['spruce_planks', 'wooden'],
  ['cobblestone', 'stone'],
  ['iron_ingot', 'iron'],
  ['gold_ingot', 'golden'],
  ['diamond', 'diamond'],
];

for (const [mat, prefix] of TOOL_MATS) {
  shapeless([mat, mat, 'stick'], `${prefix}_sword`, 1);
  // shaped versions take priority for the classic layouts
  shaped(['X', 'X', '#'], { X: mat, '#': 'stick' }, `${prefix}_sword`, 1);
  shaped(['XXX', ' # ', ' # '], { X: mat, '#': 'stick' }, `${prefix}_pickaxe`, 1);
  shaped(['XX ', 'X# ', ' # '], { X: mat, '#': 'stick' }, `${prefix}_axe`, 1);
  shaped(['X', '#', '#'], { X: mat, '#': 'stick' }, `${prefix}_shovel`, 1);
  shaped(['XX', ' #', ' #'], { X: mat, '#': 'stick' }, `${prefix}_hoe`, 1);
}

shaped(['X ', ' X'], { X: 'iron_ingot' }, 'shears', 1);
shaped([' #X', '# X', ' #X'], { '#': 'stick', X: 'string' }, 'bow', 1);
shaped(['X', '#', 'Y'], { X: 'flint', '#': 'stick', Y: 'feather' }, 'arrow', 4);
shaped(['X X', ' X '], { X: 'iron_ingot' }, 'bucket', 1);

/* ------------------------------------------------------------------ */
/* Misc                                                                */
/* ------------------------------------------------------------------ */

shaped(['C', '#'], { C: 'coal', '#': 'stick' }, 'torch', 4);
shaped(['C', '#'], { C: 'charcoal', '#': 'stick' }, 'torch', 4);
shaped(['XXX'], { X: 'wheat' }, 'bread', 1);
shaped(['XX', 'XX'], { X: 'reeds' }, 'paper', 3);
shapeless(['paper', 'paper', 'paper', 'leather'], 'book', 1);

/* ------------------------------------------------------------------ */
/* Smelting                                                            */
/* ------------------------------------------------------------------ */

export const SMELT_RECIPES: SmeltRecipe[] = [
  { input: 'iron_ore', output: 'iron_ingot', time: 10, count: 1 },
  { input: 'gold_ore', output: 'gold_ingot', time: 10, count: 1 },
  { input: 'sand', output: 'glass', time: 10, count: 1 },
  { input: 'cobblestone', output: 'stone', time: 10, count: 1 },
  { input: 'oak_log', output: 'charcoal', time: 10, count: 1 },
  { input: 'birch_log', output: 'charcoal', time: 10, count: 1 },
  { input: 'spruce_log', output: 'charcoal', time: 10, count: 1 },
  { input: 'porkchop', output: 'cooked_porkchop', time: 10, count: 1 },
  { input: 'beef', output: 'cooked_beef', time: 10, count: 1 },
  { input: 'chicken', output: 'cooked_chicken', time: 10, count: 1 },
  { input: 'mutton', output: 'cooked_mutton', time: 10, count: 1 },
  { input: 'clay_ball', output: 'bricks', time: 10, count: 1 },
  { input: 'bloodrock', output: 'ember_shard', time: 14, count: 1 },
];

export function smeltFor(item: string): SmeltRecipe | undefined {
  return SMELT_RECIPES.find((r) => r.input === item);
}

/* ------------------------------------------------------------------ */
/* Matching                                                            */
/* ------------------------------------------------------------------ */

function gridNames(grid: CraftingGrid, ox: number, oy: number, w: number, h: number): (string | null)[] {
  const out: (string | null)[] = [];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = grid.at(ox + x, oy + y);
      out.push(s ? s.item : null);
    }
  }
  return out;
}

function matchShaped(grid: CraftingGrid, recipe: ShapedRecipe): boolean {
  const h = recipe.pattern.length;
  const w = Math.max(...recipe.pattern.map((p) => p.length));
  const size = grid.size;
  for (let oy = 0; oy + h <= size; oy++) {
    for (let ox = 0; ox + w <= size; ox++) {
      let ok = true;
      for (let y = 0; y < h && ok; y++) {
        const row = recipe.pattern[y].padEnd(w, ' ');
        for (let x = 0; x < w; x++) {
          const sym = row[x];
          const expected = sym === ' ' ? null : recipe.key[sym];
          const actual = grid.at(ox + x, oy + y);
          const actualName = actual ? actual.item : null;
          if (expected === null) {
            if (actualName !== null) {
              ok = false;
              break;
            }
          } else if (actualName !== expected) {
            ok = false;
            break;
          }
        }
      }
      if (ok) {
        // the pattern must cover every occupied slot
        const flat = grid.slots.filter((s) => s);
        const expectedCells = recipe.pattern.join('').replace(/ /g, '').length;
        if (flat.length !== expectedCells) continue;
        return true;
      }
    }
  }
  return false;
}

function matchShapeless(grid: CraftingGrid, recipe: ShapelessRecipe): boolean {
  const present = grid.slots.filter((s) => s).map((s) => s!.item);
  if (present.length !== recipe.ingredients.length) return false;
  const pool = [...present];
  for (const need of recipe.ingredients) {
    const i = pool.indexOf(need);
    if (i < 0) return false;
    pool.splice(i, 1);
  }
  return true;
}

/** Find the recipe matching the current contents of a crafting grid. */
export function findRecipe(grid: CraftingGrid): Recipe | null {
  if (grid.isEmpty()) return null;
  for (const r of recipes) {
    if (r.kind === 'shaped') {
      if (matchShaped(grid, r)) return r;
    } else if (matchShapeless(grid, r)) {
      return r;
    }
  }
  return null;
}

/** True when any recipe can consume exactly these items (for the recipe book UI). */
export function allRecipes(): readonly Recipe[] {
  return recipes;
}

export { gridNames };
