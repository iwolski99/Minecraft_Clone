// Scan real generated terrain for block ids and prove every id that appears in
// the world maps to a defined block with a painted texture.
//
// The per-block mesher test only covers blocks reached through BLOCKS; if
// worldgen stamped an id that has no definition (a gap, a typo in the `B`
// namespace, or an off-by-one), that block would never be meshed and the test
// would not notice.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { BLOCKS, getBlock } = await load('world/blocks.js');
  const { B } = await load('world/blocks.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { tileNames } = await load('render/blockTextures.js');

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const info = (m) => console.log(`  . ${m}`);

  const byId = new Map();
  for (const d of BLOCKS) byId.set(d.id, d);

  info(`BLOCKS defines ${BLOCKS.length} entries, ids ${Math.min(...byId.keys())}..${Math.max(...byId.keys())}`);
  info(`B.cactus = ${B.cactus}, B.cactus block name = ${byId.get(B.cactus)?.name ?? 'UNDEFINED'}`);

  // every id in the declared range must resolve
  const gaps = [];
  const maxId = Math.max(...byId.keys());
  for (let i = 1; i <= maxId; i++) if (!byId.has(i)) gaps.push(i);
  info(`gaps in the id space below ${maxId}: ${gaps.length ? gaps.join(',') : 'none'}`);
  check('block id space has no gaps', gaps.length === 0, gaps.join(','));

  // generate a lot of terrain and collect which ids actually occur
  const atlas = buildBlockAtlas();
  const painted = new Set(tileNames());
  const present = (n) => painted.has(n) || atlas.index.has(n) || atlas.slot(n) !== 0;

  const seen = new Map(); // id -> count
  const deserts = new Set();
  for (let seed = 0; seed < 12; seed++) {
    const gen = new TerrainGenerator(1000 + seed * 7919);
    const world = new World(1000 + seed * 7919, gen);
    for (let cz = 0; cz < 4; cz++) {
      for (let cx = 0; cx < 4; cx++) {
        const chunk = world.createChunk(cx, cz);
        gen.generateChunk(chunk);
        deserts.add(chunk.biome);
        for (let y = 1; y < 128; y++) {
          for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
              const id = world.getBlockAt(cx * 16 + x, y, cz * 16 + z);
              if (id === 0) continue;
              seen.set(id, (seen.get(id) ?? 0) + 1);
              // also count decorations stamped into this chunk
            }
          }
        }
      }
    }
  }

  info(`generated ${12 * 16} chunks; ${seen.size} distinct block ids occur in the world`);

  const unknown = [];
  const untextured = [];
  for (const id of seen.keys()) {
    const def = byId.get(id);
    if (!def) {
      unknown.push(String(id));
      continue;
    }
    const t = def.tex ?? {};
    const list = [t.east, t.west, t.top, t.bottom, t.south, t.north, t.side, t.all, t.sprite].filter(Boolean);
    for (const n of list) {
      if (!present(n)) untextured.push(`${def.name}: ${n}`);
    }
  }

  if (unknown.length) info(`ids present in the world with NO block definition: ${unknown.join(', ')}`);
  if (untextured.length) info(`blocks whose texture is missing from the atlas: ${untextured.join(', ')}`);

  check('every id generated in the world is a defined block', unknown.length === 0, unknown.join(', '));
  check('every generated block has a painted texture', untextured.length === 0, untextured.join(', '));

  // and the cactus specifically, in a desert
  let cactusSeen = 0;
  for (let seed = 0; seed < 40 && cactusSeen === 0; seed++) {
    const gen = new TerrainGenerator(2000 + seed * 104729);
    const world = new World(2000 + seed * 104729, gen);
    for (let cz = 0; cz < 3; cz++) {
      for (let cx = 0; cx < 3; cx++) {
        const chunk = world.createChunk(cx, cz);
        gen.generateChunk(chunk);
        for (let y = 60; y < 90; y++) {
          for (let z = 0; z < 16; z++) {
            for (let x = 0; x < 16; x++) {
              if (world.getBlockAt(cx * 16 + x, y, cz * 16 + z) === B.cactus) cactusSeen++;
            }
          }
        }
      }
    }
  }
  info(`cactus blocks found across 40 seeds of generated desert: ${cactusSeen}`);
  check('worldgen actually places cactus', cactusSeen > 0, String(cactusSeen));

  console.log(`worldids: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
