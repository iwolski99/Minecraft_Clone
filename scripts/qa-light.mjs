// Lighting across a body of water.
//
// Reported from play: an ocean surface rendered as a black void in daylight,
// with the sand around it darkening toward the water, and the underwater overlay
// working normally. That combination says the geometry and the material are fine
// and the light the water is sampling is zero, so this asserts the sky-light
// column over water directly.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { blockByName } = await load('world/blocks.js');

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

  const idOf = (n) => blockByName(n)?.id ?? 0;
  const stone = idOf('stone');
  const water = idOf('water');
  const sand = idOf('sand');
  const air = 0;
  const SEA = 62;

  const gen = new TerrainGenerator(11);
  const world = new World(11, gen);
  const chunk = world.createChunk(0, 0);
  gen.generateChunk(chunk);
  world.light.initialLight(chunk);

  // A sea: stone floor at y=58, water from 59 to 62, air above, sand beach on
  // the east edge.
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      for (let y = 0; y < 128; y++) world.setBlock(x, y, z, air);
      world.setBlock(x, 58, z, stone);
      for (let y = 59; y <= SEA; y++) world.setBlock(x, y, z, water);
      if (x >= 13) {
        // beach rises to sea level + 1
        for (let y = 59; y <= SEA + 1; y++) world.setBlock(x, y, z, sand);
      }
    }
  }
  world.light.initialLight(chunk);

  const sky = (x, y, z) => world.getSkyLightAt(x, y, z);
  const blk = (x, y, z) => world.getBlockLightAt(x, y, z);

  info(`sea level ${SEA}; stone floor y=58, water 59..${SEA}, air above`);
  info(`sky light in air above water (x=6,y=${SEA + 1}) : ${sky(6, SEA + 1, 6)}`);
  info(`sky light in air above water (x=6,y=${SEA + 5}) : ${sky(6, SEA + 5, 6)}`);
  info(`sky light AT the water surface (x=6,y=${SEA})  : ${sky(6, SEA, 6)}`);
  info(`sky light under water     (x=6,y=${SEA - 2})    : ${sky(6, SEA - 2, 6)}`);
  info(`sky light on the sea floor(x=6,y=58)            : ${sky(6, 58, 6)}`);
  info(`sky light on beach sand   (x=14,y=${SEA + 1})   : ${sky(14, SEA + 1, 14)}`);
  info(`sky light on beach inland (x=15,y=${SEA + 1})   : ${sky(15, SEA + 1, 15)}`);
  // A solid block's own light is 0 by design: its faces are lit by the air they
  // face into. So the number that matters is the AIR above the surface.
  info(`AIR above beach sand      (x=14,y=${SEA + 2})   : ${sky(14, SEA + 2, 14)}`);
  info(`AIR above beach inland    (x=15,y=${SEA + 2})   : ${sky(15, SEA + 2, 15)}`);
  info(`AIR above the water       (x=6, y=${SEA + 1})   : ${sky(6, SEA + 1, 6)}`);
  for (let y = SEA + 6; y >= SEA - 3; y--) {
    const w = y <= SEA ? 'water' : 'air  ';
    console.log(`  .   y=${String(y).padStart(3)} (${w})  sky=${String(sky(6, y, 6)).padStart(2)}   beach(x=14) sky=${String(sky(14, y, 14)).padStart(2)}`);
  }

  check('air directly above water is fully sky-lit', sky(6, SEA + 1, 6) === 15, `got ${sky(6, SEA + 1, 6)}`);
  // A solid or liquid block's own light is not 15: the sky light it receives is
  // attenuated as it enters. What matters is the AIR it faces into, which must be
  // full daylight, and that light decays with depth rather than being zero.
  check('the water surface is well lit', sky(6, SEA, 6) >= 12, `got ${sky(6, SEA, 6)}`);
  check('air above the beach is fully sky-lit', sky(14, SEA + 2, 14) === 15, `got ${sky(14, SEA + 2, 14)}`);
  check('sky light attenuates under water', sky(6, 58, 6) < sky(6, SEA, 6), 'no attenuation with depth');
  check('no block light in open daylight', blk(6, SEA, 6) === 0, `got ${blk(6, SEA, 6)}`);

  // Now the meshed vertex light the water shader actually receives. A single
  // chunk has unloaded padding on every edge, so build a 3x3 ocean and mesh the
  // centre: anything still at zero light there is a real defect, not a border.
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { VoxelMesher } = await load('render/mesher.js');
  const mesher = new VoxelMesher(buildBlockAtlas());

  const bigGen = new TerrainGenerator(11);
  const bigWorld = new World(11, bigGen);
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const c = bigWorld.createChunk(cx, cz);
      bigGen.generateChunk(c);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const wx = cx * 16 + x;
          const wz = cz * 16 + z;
          for (let y = 0; y < 128; y++) bigWorld.setBlock(wx, y, wz, air);
          bigWorld.setBlock(wx, 58, wz, stone);
          for (let y = 59; y <= SEA; y++) bigWorld.setBlock(wx, y, wz, water);
        }
      }
    }
  }
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const c = bigWorld.getChunk(cx, cz);
      if (c) bigWorld.light.initialLight(c);
    }
  }
  const centre = bigWorld.getChunk(0, 0);
  const res = mesher.build(bigWorld, centre);
  const t = res.transparent;
  if (!t) {
    check('water emitted transparent geometry', false, 'no transparent buffer');
  } else {
    let zero = 0;
    let total = 0;
    let minShade = 255;
    for (let i = 0; i < t.light.length; i += 2) {
      const s = t.light[i];
      const c = t.colors[(i / 2) * 4];
      total++;
      if (s === 0) zero++;
      if (c < minShade) minShade = c;
    }
    const pct = ((zero / Math.max(1, total)) * 100).toFixed(1);
    info(`3x3 ocean, centre chunk: ${total} water vertices, ${zero} with sky light 0 (${pct}%)`);
    info(`min water vertex shade ${minShade}`);
    check('water emitted geometry', total > 0, String(total));
    check('no water vertex is unlit in a loaded ocean', zero === 0, `${zero}/${total} at sky light 0`);
    check('water vertices are not shaded to black', minShade > 100, `min ${minShade}`);
  }

  /*
   * Sky light must propagate UP as well as down.
   *
   * A world is generated solid and then carved: rivers, ocean basins, caves and
   * every block the player breaks remove material and *increase* the light in the
   * cells around them. If the incremental add pass does not chase that upward or
   * sideways, a naturally generated ocean ends up with the lighting of the rock
   * that used to be there - which renders as a black void in daylight.
   */
  {
    const gen2 = new TerrainGenerator(3);
    const w2 = new World(3, gen2);
    const c2 = w2.createChunk(0, 0);
    gen2.generateChunk(c2);
    // fill the whole chunk solid, then light it: skylight should end up 0
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 128; y++) w2.setBlock(x, y, z, stone);
      }
    }
    w2.light.initialLight(c2);
    const sealed = w2.getSkyLightAt(8, 40, 8);
    info(`solid rock, y=40, sky light after initialLight: ${sealed}`);
    check('sealed rock is unlit', sealed === 0, `got ${sealed}`);

    // now carve a shaft to the sky - this must light the shaft AND the area below
    for (let y = 40; y < 128; y++) w2.setBlock(8, y, 8, air);
    for (let y = 20; y < 40; y++) w2.setBlock(8, y, 8, air);
    const atTop = w2.getSkyLightAt(8, 100, 8);
    const mid = w2.getSkyLightAt(8, 60, 8);
    const deep = w2.getSkyLightAt(8, 30, 8);
    const deepFloor = w2.getSkyLightAt(8, 19, 8);
    info(`after carving a shaft: y=100 sky ${atTop}, y=60 sky ${mid}, y=30 sky ${deep}, y=19 sky ${deepFloor}`);
    check('a carved shaft is sky-lit at the top', atTop === 15, `got ${atTop}`);
    check('sky light flows down a carved shaft', mid === 15, `got ${mid}`);
    check('sky light reaches the bottom of the shaft', deep === 15, `got ${deep}`);

    // and sideways: carve a room off the shaft, its ceiling should light up
    for (let x = 9; x <= 12; x++) for (let y = 30; y <= 33; y++) w2.setBlock(x, y, 8, air);
    const roomTop = w2.getSkyLightAt(11, 33, 8);
    info(`room carved beside the shaft at y=33: sky ${roomTop}`);
    check('sky light flows sideways into a carved room', roomTop > 6, `got ${roomTop}`);

    // and an ocean: carve a basin into lit solid ground and check the water surface
    const gen3 = new TerrainGenerator(5);
    const w3 = new World(5, gen3);
    const c3 = w3.createChunk(0, 0);
    gen3.generateChunk(c3);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 128; y++) w3.setBlock(x, y, z, stone);
        for (let y = 62; y < 128; y++) w3.setBlock(x, y, z, air);
      }
    }
    w3.light.initialLight(c3);
    const beforeCarve = w3.getSkyLightAt(8, 62, 8);
    check('air above solid ground is lit before carving', beforeCarve === 15, `got ${beforeCarve}`);
    // carve a basin: stone out to y=57, water 58..62
    for (let z = 2; z <= 13; z++) {
      for (let x = 2; x <= 13; x++) {
        for (let y = 58; y <= 62; y++) w3.setBlock(x, y, z, water);
      }
    }
    const surf = w3.getSkyLightAt(8, 62, 8);
    const shallow = w3.getSkyLightAt(8, 60, 8);
    const floor = w3.getSkyLightAt(8, 57, 8);
    info(`carved basin: water surface sky ${surf}, shallow ${shallow}, floor ${floor}`);
    check('a carved basin keeps its surface lit', surf >= 12, `got ${surf}`);
    check('a carved basin is lit below the surface', shallow > 4, `got ${shallow}`);

    // and the meshed water light the shader receives
    const { buildBlockAtlas: bba } = await load('render/atlas.js');
    const { VoxelMesher: VM } = await load('render/mesher.js');
    const m3 = new VM(bba());
    const r3 = m3.build(w3, c3);
    if (r3.transparent) {
      let zero = 0;
      let total = 0;
      for (let i = 0; i < r3.transparent.light.length; i += 2) {
        total++;
        if (r3.transparent.light[i] === 0) zero++;
      }
      info(`carved basin water vertices at sky light 0: ${zero}/${total}`);
      check('carved basin water is not black', zero / Math.max(1, total) < 0.5, `${zero}/${total}`);
    } else {
      check('carved basin emitted water geometry', false, 'no transparent buffer');
    }
  }

  /*
   * Light must be continuous across a chunk border.
   *
   * Reported from play as a hard vertical seam: sky light and torch light both
   * stopping dead along a line, which vanished as soon as an unrelated block was
   * broken nearby. That is the signature of a chunk lit before its neighbour
   * existed - it keeps the border it was given while the neighbour was empty and
   * nothing ever pushes the new light back into it.
   *
   * The chunks here are lit in the order the streamer uses: oldest first.
   */
  {
    const gen4 = new TerrainGenerator(17);
    const w4 = new World(17, gen4);
    const torchId = idOf('torch');

    const make = (cx) => {
      const c = w4.createChunk(cx, 0);
      gen4.generateChunk(c);
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) {
          const wx = cx * 16 + x;
          for (let y = 0; y < 128; y++) w4.setBlock(wx, y, z, air);
          w4.setBlock(wx, 63, z, stone);
        }
      }
      return c;
    };
    const a = make(0);
    const b = make(1);
    // a torch just inside the second chunk, one block from the shared border
    w4.setBlock(16, 64, 8, torchId);

    // exactly the streaming order: the left chunk is lit first, alone
    w4.light.initialLight(a);
    const beforeCross = w4.getBlockLightAt(15, 64, 8);
    w4.light.initialLight(b);
    const afterCross = w4.getBlockLightAt(15, 64, 8);
    info(`torch at world x=16; light one block inside chunk 0 (x=15): before=${beforeCross} after=${afterCross}`);
    check('a torch lights the neighbouring chunk across the border', afterCross > 0, `got ${afterCross}`);

    // the whole border must be continuous: light may fall by at most 1 per block
    let worstSky = 0;
    let worstBlk = 0;
    for (let z = 0; z < 16; z++) {
      for (let y = 1; y < 100; y++) {
        const d1 = Math.abs(w4.getSkyLightAt(15, y, z) - w4.getSkyLightAt(16, y, z));
        if (d1 > worstSky) worstSky = d1;
        const d2 = Math.abs(w4.getBlockLightAt(15, y, z) - w4.getBlockLightAt(16, y, z));
        if (d2 > worstBlk) worstBlk = d2;
      }
    }
    info(`worst light step across the border: sky ${worstSky}, block ${worstBlk} (1 is the physical maximum)`);
    check('sky light is continuous across a chunk border', worstSky <= 1, `step of ${worstSky}`);
    check('block light is continuous across a chunk border', worstBlk <= 1, `step of ${worstBlk}`);
  }

  /*
   * A light change must mark every chunk whose baked vertex light it invalidates.
   *
   * Meshes carry light in their vertices, so a chunk whose light changed but
   * which was never marked dirty keeps showing the old values - a hard seam
   * along the chunk border with torch light and shadow stopping dead at it.
   *
   * `markDirtyAround` used to mark neighbours only when the edited block sat
   * exactly on a chunk border, but light carries 14 blocks. A torch placed in the
   * middle of a chunk lights the neighbours and none of them were rebuilt; that
   * is the reported seam, and it is why breaking a plant that happened to be on
   * a border made it disappear.
   */
  {
    const gen5 = new TerrainGenerator(29);
    const w5 = new World(29, gen5);
    const torchId = idOf('torch');
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        const c = w5.createChunk(cx, cz);
        gen5.generateChunk(c);
        for (let z = 0; z < 16; z++) {
          for (let x = 0; x < 16; x++) {
            const wx = cx * 16 + x;
            const wz = cz * 16 + z;
            for (let y = 0; y < 128; y++) w5.setBlock(wx, y, wz, air);
            w5.setBlock(wx, 63, wz, stone);
          }
        }
        w5.light.initialLight(c);
        c.dirty = false;
      }
    }

    // dead centre of chunk (0,0) - seven blocks from the border, well inside
    w5.setBlock(8, 64, 8, torchId);

    const marked = [];
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) {
        const c = w5.getChunk(cx, cz);
        if (c && c.dirty) marked.push(`${cx},${cz}`);
      }
    }
    info(`torch placed at the centre of chunk 0,0; chunks marked dirty: ${marked.join(' ') || 'none'}`);

    const centre = w5.getChunk(0, 0);
    const east = w5.getChunk(1, 0);
    const west = w5.getChunk(-1, 0);
    const north = w5.getChunk(0, -1);
    const south = w5.getChunk(0, 1);
    check('the edited chunk is marked dirty', !!centre && centre.dirty === true);
    check('an eastern neighbour reached by the light is marked dirty', !!east && east.dirty === true);
    check('a western neighbour reached by the light is marked dirty', !!west && west.dirty === true);
    check('a northern neighbour reached by the light is marked dirty', !!north && north.dirty === true);
    check('a southern neighbour reached by the light is marked dirty', !!south && south.dirty === true);

    // and the light really does reach them, so the marking is not unnecessary
    // The torch is at x=8 and carries 14 blocks, so x=16 (eight away) is inside
    // its range; x=23 would be fifteen and legitimately dark.
    const crossLight = w5.getBlockLightAt(16, 64, 8);
    info(`torch light 8 blocks east, one block inside chunk 1: ${crossLight}`);
    check('the torch light does reach the neighbouring chunk', crossLight > 0, `got ${crossLight}`);

    // an edit that cannot change light must not fan out to nine chunks
    for (let cz = -1; cz <= 1; cz++) for (let cx = -1; cx <= 1; cx++) w5.getChunk(cx, cz).dirty = false;
    w5.setBlock(8, 63, 8, idOf('sand'));
    let marked2 = 0;
    for (let cz = -1; cz <= 1; cz++) {
      for (let cx = -1; cx <= 1; cx++) if (w5.getChunk(cx, cz).dirty) marked2++;
    }
    info(`an opaque-to-opaque swap marked ${marked2} chunk(s) dirty`);
    check('a light-neutral edit stays local', marked2 <= 1, `${marked2} chunks`);
  }

  console.log(`light: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
