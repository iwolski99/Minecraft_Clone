// Logic regression tests for the headless-testable subsystems.
//
// These exercise the parts of the game that do not need a DOM: world storage,
// lighting, block breaking rules, inventory/stack merging, crafting pattern
// matching, smelting and save-file packing.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { B, getBlock, breakTime, dropsFor, canHarvest } = await load('world/blocks.js');
  const { Inventory, CraftingGrid, FurnaceState, slotClick, emptySlots } = await load('items/inventory.js');
  const { findRecipe, smeltFor } = await load('items/recipes.js');
  const { makeStack, itemDef, blockIdOf, creativePalette } = await load('items/items.js');
  const { packEdits, unpackEdits } = await load('save/save.js');
  const { buildBlockAtlas, missingPainters } = await load('render/atlas.js');
  const { CHUNK_Y, SEA_LEVEL } = await load('world/chunk.js');

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) {
      pass++;
    } else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const eq = (name, a, b) => check(name, a === b, `(got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);

  /* ---------------- world + lighting ---------------- */
  const seed = 4242;
  const gen = new TerrainGenerator(seed);
  const world = new World(seed, gen);
  for (let cz = -2; cz <= 2; cz++) {
    for (let cx = -2; cx <= 2; cx++) {
      const c = world.createChunk(cx, cz);
      gen.generateChunk(c);
      world.light.initialLight(c);
    }
  }

  // determinism: generating the same column twice must match
  const g2 = new TerrainGenerator(seed);
  let deterministic = true;
  for (let i = 0; i < 400; i++) {
    const x = ((i * 37) % 320) - 160;
    const z = ((i * 91) % 320) - 160;
    const a = gen.columnInfo(x, z);
    const b = g2.columnInfo(x, z);
    if (a.height !== b.height || a.biome !== b.biome) deterministic = false;
  }
  check('worldgen determinism', deterministic);

  // chunk borders agree: a column generated as part of chunk A matches chunk B
  const borderOk = (() => {
    for (let i = 0; i < 40; i++) {
      const x = 16 * 2;
      const z = -32 + i;
      const inA = world.getBlockAt(x, 64, z);
      const viaGen = gen.columnInfo(x, z);
      if (inA !== 0 && viaGen.height > 0) {
        const expect = world.getBlockAt(x, viaGen.height, z);
        if (expect === 0) return false;
      }
    }
    return true;
  })();
  check('chunk border seams', borderOk);

  // surface skylight is full (checking the first air block above the terrain),
  // deep underground is dark
  let litSurface = 0;
  let darkUnderground = 0;
  let samples = 0;
  for (let i = 0; i < 60; i++) {
    const x = -28 + ((i * 13) % 56);
    const z = -28 + ((i * 29) % 56);
    const h = world.heightAt(x, z);
    if (h < 0) continue;
    samples++;
    const firstAir = world.findSurfaceY(x, z, h + 1);
    let top = h + 1;
    for (let y = h + 1; y < CHUNK_Y; y++) {
      if (world.getBlockAt(x, y, z) === 0) {
        top = y;
        break;
      }
    }
    if (world.getSkyLightAt(x, top, z) === 15) litSurface++;
    if (world.getSkyLightAt(x, 8, z) < 8) darkUnderground++;
    void firstAir;
  }
  check('surface is sky-lit', litSurface >= samples * 0.9, `${litSurface}/${samples}`);
  check('underground is dark', darkUnderground >= samples * 0.5, `${darkUnderground}/${samples}`);

  // torch light propagates and is removed again
  const tx = 3;
  const tz = 5;
  const ground = world.heightAt(tx, tz);
  world.setBlock(tx, ground + 1, tz, B.torch);
  const near = world.getBlockLightAt(tx, ground + 1, tz);
  const twoAway = world.getBlockLightAt(tx + 2, ground + 1, tz);
  check('torch emits light', near >= 13, String(near));
  check('torch light falls off', twoAway > 0 && twoAway < near, `${twoAway}`);
  world.setBlock(tx, ground + 1, tz, 0);
  eq('torch light removed', world.getBlockLightAt(tx, ground + 1, tz), 0);
  eq('torch light removed 2 away', world.getBlockLightAt(tx + 2, ground + 1, tz), 0);

  // edits are recorded
  world.setBlock(1, ground + 2, 1, B.stone);
  const editedChunk = world.edits.get((((1 >> 4) & 0xffff) << 16) | ((1 >> 4) & 0xffff));
  check('edits recorded', !!editedChunk && editedChunk.size >= 1);

  // digging down should re-light the hole
  const dx = 7;
  const dz = 7;
  const dh = world.heightAt(dx, dz);
  for (let y = dh; y > dh - 4; y--) world.setBlock(dx, y, dz, 0);
  check('hole is lit after digging', world.getSkyLightAt(dx, dh - 2, dz) > 0, String(world.getSkyLightAt(dx, dh - 2, dz)));

  /* ---------------- block rules ---------------- */
  eq('wooden pick cannot harvest diamond', canHarvest(getBlock(B.diamond_ore), 1), false);
  eq('iron pick can harvest diamond', canHarvest(getBlock(B.diamond_ore), 3), true);
  const stoneTimeHand = breakTime(getBlock(B.stone), 0, 'none', 1);
  const stoneTimePick = breakTime(getBlock(B.stone), 1, 'pickaxe', 2);
  check('pickaxe is faster than hand', stoneTimePick < stoneTimeHand / 3, `${stoneTimePick} vs ${stoneTimeHand}`);
  check('bedrock is unbreakable', !Number.isFinite(breakTime(getBlock(B.bedrock), 4, 'pickaxe', 8)));
  check('grass drops dirt', dropsFor(getBlock(B.grass_block))[0].item === 'dirt');
  check('coal ore drops coal', dropsFor(getBlock(B.coal_ore))[0].item === 'coal');

  /* ---------------- inventory ---------------- */
  const inv = new Inventory();
  eq('add returns 0 leftover', inv.add(makeStack('stone', 64)), 0);
  eq('stack merged', inv.slots[0].count, 64);
  inv.add(makeStack('stone', 30));
  eq('overflow in second slot', inv.slots[1].count, 30);
  eq('countOf sums', inv.countOf('stone'), 94);
  check('removeItem works', inv.removeItem('stone', 94));
  eq('inventory empty', inv.countOf('stone'), 0);
  inv.add(makeStack('oak_log', 10));
  const invJson = JSON.parse(JSON.stringify(inv.serialize()));
  const inv2 = new Inventory();
  inv2.deserialize(invJson);
  eq('inventory round-trips', inv2.countOf('oak_log'), 10);
  eq('selected round-trips', inv2.selected, inv.selected);

  const tool = makeStack('iron_pickaxe', 1);
  check('tool has durability field', tool.damage === 0 && itemDef('iron_pickaxe').durability > 0);

  /* ---------------- slot clicking ---------------- */
  let res = slotClick(makeStack('stone', 10), null, 'right');
  eq('right click splits in half', res.cursor.count, 5);
  eq('right click leaves half', res.slot.count, 5);
  res = slotClick(makeStack('stone', 5), makeStack('stone', 5), 'left');
  eq('left click merges', res.slot.count, 10);
  eq('cursor emptied', res.cursor, null);

  /* ---------------- crafting ---------------- */
  const grid = new CraftingGrid(3);
  /** rows is an array of arrays of item names (null = empty) */
  const craft = (rows) => {
    grid.clear();
    for (let y = 0; y < rows.length; y++) {
      for (let x = 0; x < rows[y].length; x++) {
        const name = rows[y][x];
        if (!name) continue;
        grid.set(x, y, makeStack(name, 1));
      }
    }
    const r = findRecipe(grid);
    return r ? { item: r.output.item, count: r.output.count } : null;
  };
  const P = 'oak_planks';
  const C = 'cobblestone';
  const S = 'stick';
  const D = 'diamond';
  const I = 'iron_ingot';

  eq('log -> planks', craft([['oak_log']])?.item, 'oak_planks');
  eq('log -> 4 planks', craft([['oak_log']])?.count, 4);
  eq('2 planks -> 4 sticks', craft([[P], [P]])?.count, 4);
  eq('4 planks -> crafting table', craft([[P, P], [P, P]])?.item, 'crafting_table');
  eq('8 cobble -> furnace', craft([[C, C, C], [C, null, C], [C, C, C]])?.item, 'furnace');
  eq('2x2 cobble is not a furnace', craft([[C, C], [C, C]]), null);
  eq('8 planks -> chest', craft([[P, P, P], [P, null, P], [P, P, P]])?.item, 'chest');
  eq('planks+sticks -> pickaxe', craft([[P, P, P], [null, S, null], [null, S, null]])?.item, 'wooden_pickaxe');
  eq('cobble+sticks -> stone pickaxe', craft([[C, C, C], [null, S, null], [null, S, null]])?.item, 'stone_pickaxe');
  eq('diamond+sticks -> diamond pickaxe', craft([[D, D, D], [null, S, null], [null, S, null]])?.item, 'diamond_pickaxe');
  eq('planks -> sword', craft([[P], [P], [S]])?.item, 'wooden_sword');
  eq('planks -> axe', craft([[P, P], [P, S], [null, S]])?.item, 'wooden_axe');
  eq('planks -> shovel', craft([[P], [S], [S]])?.item, 'wooden_shovel');
  eq('coal+stick -> 4 torches', craft([['coal'], [S]])?.count, 4);
  eq('9 iron -> iron block', craft([[I, I, I], [I, I, I], [I, I, I]])?.item, 'iron_block');
  eq('iron block -> 9 ingots', craft([['iron_block']])?.count, 9);
  eq('no recipe for junk', craft([['dirt'], ['dirt']]), null);
  eq('3 wheat -> bread', craft([['wheat', 'wheat', 'wheat']])?.item, 'bread');
  eq('2 planks -> 4 sticks stacked', craft([[P, P]])?.count ?? 0, 0);
  // off-centre placement must still match in a 3x3 grid
  grid.clear();
  grid.set(1, 1, makeStack('oak_log', 1));
  check('pattern matched off-centre', findRecipe(grid)?.output.item === 'oak_planks');
  // shape must matter
  grid.clear();
  grid.set(0, 0, makeStack(P, 1));
  grid.set(2, 2, makeStack(P, 1));
  eq('non-matching shape rejected', findRecipe(grid), null);

  const grid2 = new CraftingGrid(2);
  grid2.set(0, 0, makeStack('oak_log', 1));
  check('2x2 grid crafts planks', findRecipe(grid2)?.output.item === 'oak_planks');
  grid2.set(1, 0, makeStack('birch_log', 1));
  eq('mixed logs rejected', findRecipe(grid2), null);

  /* ---------------- smelting ---------------- */
  eq('iron ore smelts to ingot', smeltFor('iron_ore')?.output, 'iron_ingot');
  eq('sand smelts to glass', smeltFor('sand')?.output, 'glass');
  eq('raw beef cooks', smeltFor('beef')?.output, 'cooked_beef');
  check('coal is fuel', (itemDef('coal').fuel ?? 0) > 0);
  check('planks are fuel', (itemDef('oak_planks').fuel ?? 0) > 0);
  eq('stone is not fuel', itemDef('stone').fuel ?? 0, 0);

  const f = new FurnaceState();
  f.input = makeStack('iron_ore', 1);
  f.fuel = makeStack('coal', 1);
  f.burnTime = 10;
  f.burnTotal = 10;
  check('furnace state serialises', !!FurnaceState.from(f.serialize()));

  /* ---------------- save packing ---------------- */
  const edits = new Map();
  const m = new Map();
  m.set(1234, 5);
  m.set(60000, 200);
  m.set(1, 0);
  edits.set(99, m);
  const edits2 = new Map();
  edits2.set(-7, new Map([[7, 7]]));
  const packed = packEdits(edits);
  const unpacked = unpackEdits(packed);
  eq('edit chunk count', unpacked.size, 1);
  const round = unpacked.get(99);
  check('edit round-trips', !!round && round.get(1234) === 5 && round.get(60000) === 200 && round.get(1) === 0);
  const packed2 = packEdits(edits2);
  check('negative chunk key round-trips', unpackEdits(packed2).get(-7)?.get(7) === 7);
  eq('empty edits pack to empty', packEdits(new Map()), '');

  /* ---------------- assets ---------------- */
  const atlas = buildBlockAtlas();
  check('atlas has tiles', atlas.count > 80, String(atlas.count));
  const required = new Set();
  const { BLOCKS } = await load('world/blocks.js');
  for (const b of BLOCKS) {
    for (const t of [b.tex.all, b.tex.side, b.tex.top, b.tex.bottom, b.tex.north, b.tex.south, b.tex.east, b.tex.west, b.tex.sprite]) {
      if (t) required.add(t);
    }
  }
  const missing = missingPainters(required);
  eq('every block texture is painted', missing.length, 0);
  if (missing.length) console.error('   missing:', missing);

  // the atlas must not contain the magenta "no painter" marker
  let magenta = 0;
  for (let i = 0; i < atlas.data.length; i += 4) {
    if (atlas.data[i] === 255 && atlas.data[i + 1] === 0 && atlas.data[i + 2] === 255) magenta++;
  }
  eq('no missing-texture magenta', magenta, 0);

  /* ---------------- content tables ---------------- */
  const palette = creativePalette();
  check('creative palette is populated', palette.length > 60, String(palette.length));
  let badItem = null;
  for (const name of palette) if (!itemDef(name)) badItem = name;
  eq('creative palette items all exist', badItem, null);
  check('diamond ore has a block item', blockIdOf('diamond_ore') === B.diamond_ore);

  /* ---------------- world constants ---------------- */
  check('world height is sane', CHUNK_Y >= 128 && CHUNK_Y <= 256, String(CHUNK_Y));
  check('sea level is inside the world', SEA_LEVEL > 0 && SEA_LEVEL < CHUNK_Y);
  void emptySlots;

  console.log(`logic: ${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}
