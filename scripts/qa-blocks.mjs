// Mesh every block type in isolation and prove it produces visible geometry.
//
// This is the test that would have caught the black cactus: a block can have a
// correct definition, a correct texture and correct UV tables, and still emit
// nothing (or emit UVs that land on unpainted atlas space) because of an early
// return, a culling rule or a dispatch gap. Asserting on the *emitted mesh* is
// the only way to see that from outside a browser.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { VoxelMesher } = await load('render/mesher.js');
  const { BLOCKS, blockByName } = await load('world/blocks.js');

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

  const atlas = buildBlockAtlas();
  const gen = new TerrainGenerator(99);
  const world = new World(99, gen);
  const mesher = new VoxelMesher(atlas);
  const CHUNK_Y_SAFE = 128;

  // Alpha of the texel a UV addresses, honouring the GPU's bottom-up sampling.
  const alphaAt = (u, v) => {
    const x = Math.min(atlas.width - 1, Math.max(0, Math.floor(u * atlas.width)));
    const y = Math.min(atlas.height - 1, Math.max(0, Math.floor((1 - v) * atlas.height)));
    return atlas.data[(y * atlas.width + x) * 4 + 3];
  };

  /**
   * The colour the shader would actually show for a UV.
   *
   * Checking alpha alone is not enough: a texel of rgba(0,0,0,255) is fully
   * "opaque" and still renders pure black, which is exactly how a block can pass
   * an alpha-based test while being invisible in game.
   */
  const rgbAt = (u, v) => {
    const x = Math.min(atlas.width - 1, Math.max(0, Math.floor(u * atlas.width)));
    const y = Math.min(atlas.height - 1, Math.max(0, Math.floor((1 - v) * atlas.height)));
    const o = (y * atlas.width + x) * 4;
    return [atlas.data[o], atlas.data[o + 1], atlas.data[o + 2]];
  };

  // Each block is meshed in an otherwise EMPTY chunk, so every emitted vertex
  // belongs to the block under test. The previous version put each block on a
  // 16x16 stone floor, whose ~6000 vertices swamped the ~24 belonging to the
  // block - a completely black block was 0.4% of the sample and always passed.
  const noGeometry = [];
  const allClear = [];
  const darkUV = [];
  let tested = 0;

  /** Build a chunk containing nothing but `place()`, and mesh it. */
  const meshOnly = (place) => {
    const chunk = world.createChunk(0, 0);
    gen.generateChunk(chunk);
    world.light.initialLight(chunk);
    for (let y = 0; y < CHUNK_Y_SAFE; y++) {
      for (let z = 0; z < 16; z++) {
        for (let x = 0; x < 16; x++) world.setBlock(x, y, z, 0);
      }
    }
    place();
    world.light.initialLight(chunk);
    chunk.dirty = true;
    return mesher.build(world, chunk);
  };

  const inspect = (res) => {
    const layers = [res.opaque, res.transparent].filter(Boolean);
    let verts = 0;
    let opaqueHits = 0;
    let clear = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    const uvs = [];
    for (const data of layers) {
      const uv = data.uvs;
      for (let i = 0; i < uv.length; i += 2) {
        verts++;
        uvs.push([uv[i], uv[i + 1]]);
        const a = alphaAt(uv[i], uv[i + 1]);
        if (a >= 128) {
          opaqueHits++;
          const c = rgbAt(uv[i], uv[i + 1]);
          r += c[0];
          g += c[1];
          b += c[2];
        } else clear++;
      }
    }
    const n = Math.max(1, opaqueHits);
    return { verts, opaqueHits, clear, uvs, rgb: [Math.round(r / n), Math.round(g / n), Math.round(b / n)] };
  };

  const BLACK_LUM = 34;
  const tooDark = [];
  // Textures that are meant to be near-black; flagged only if something else is.
  const INTENTIONALLY_DARK = new Set(['obsidian', 'coal_block', 'coal_ore', 'bedrock']);
  // Cutouts whose corner texels are transparent by design.
  const isCutout = (def) => def.render === 'cross' || def.name === 'torch' || def.name === 'glass';

  for (const def of BLOCKS) {
    if (def.id === 0) continue;
    if (def.render === 'none') continue;
    tested++;

    // isolated single block
    const solo = inspect(meshOnly(() => world.setBlock(8, 70, 8, def.id)));
    if (solo.verts === 0) {
      noGeometry.push(`${def.name} (${def.render ?? 'cube'})`);
      continue;
    }
    const [r, g, b] = solo.rgb;
    const lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
    if (!isCutout(def) && !INTENTIONALLY_DARK.has(def.name) && solo.opaqueHits > 0 && lum < BLACK_LUM) {
      tooDark.push(`${def.name}: samples rgb(${r},${g},${b}) lum ${lum.toFixed(1)}`);
    }
    // A face's four corners are not enough to judge a tile that has holes in it.
    // Leaves are a solid block with a see-through texture: their corners are
    // legitimately clear while the interior is opaque, and the shader discards
    // per fragment, so the face still draws its solid parts. Only call a block
    // blank if its whole tile is empty.
    const tileHasInk = (def) => {
      const t = def.tex ?? {};
      const names = [t.east, t.west, t.top, t.bottom, t.south, t.north, t.side, t.all, t.sprite].filter(Boolean);
      for (const n of names) {
        const idx = atlas.slot(n);
        if (idx < 0) continue;
        const tile = atlas.tile;
        const cx = (idx % atlas.cols) * tile;
        const cy = Math.floor(idx / atlas.cols) * tile;
        let opaque = 0;
        for (let y = 0; y < tile; y++) {
          for (let x = 0; x < tile; x++) {
            if (atlas.data[((cy + y) * atlas.width + cx + x) * 4 + 3] >= 128) opaque++;
          }
        }
        if (opaque >= tile * tile * 0.1) return true;
      }
      return false;
    };

    const solidOutput = solo.clear === solo.verts && !isCutout(def);
    if (solidOutput && !tileHasInk(def)) allClear.push(def.name);
    if (!isCutout(def) && solo.opaqueHits > 0 && solo.clear > solo.verts * 0.35) {
      darkUV.push(`${def.name}: ${solo.clear}/${solo.verts} verts sample transparent atlas space`);
    }
  }

  // stacked columns: the way cacti actually generate. Reeds are a cross and are
  // legitimately mostly transparent, so only solid column blocks are asserted.
  const stackedBad = [];
  for (const name of ['cactus']) {
    const def = BLOCKS.find((b) => b.name === name);
    if (!def) continue;
    const res = inspect(
      meshOnly(() => {
        for (let y = 70; y <= 73; y++) world.setBlock(8, y, 8, def.id);
      }),
    );
    if (res.verts === 0) {
      stackedBad.push(`${name}: a 4-high column emits nothing`);
    } else if (res.clear > res.verts * 0.1) {
      stackedBad.push(`${name}: ${res.clear}/${res.verts} verts sample transparent atlas space`);
    } else {
      const [r, g, b] = res.rgb;
      info(`${name}: 4-high column ok (${res.verts} verts, ${res.clear} clear, rgb(${r},${g},${b}))`);
    }
  }

  info(`meshed ${tested} block types in isolation (empty chunk, no floor)`);
  if (noGeometry.length) info(`emitted no geometry: ${noGeometry.join(', ')}`);
  if (allClear.length) info(`entirely transparent output: ${allClear.join(', ')}`);
  if (darkUV.length) info(`sampling unpainted atlas space: ${darkUV.join(' | ')}`);
  if (tooDark.length) info(`sampling black texels: ${tooDark.join(' | ')}`);

  // the block the user reported, called out explicitly
  for (const n of ['cactus', 'sand', 'stone', 'oak_log', 'oak_leaves']) {
    const def = BLOCKS.find((b) => b.name === n);
    if (!def) continue;
    const s = inspect(meshOnly(() => world.setBlock(8, 70, 8, def.id)));
    info(`${n.padEnd(11)} ${String(s.verts).padStart(3)} verts, ${s.clear} clear, mean sampled rgb(${s.rgb.join(',')})`);
  }

  check('every renderable block emits geometry', noGeometry.length === 0, `${noGeometry.length} silent`);
  check('no solid block samples only empty atlas space', allClear.length === 0, allClear.join(', '));
  check('solid blocks sample painted texels', darkUV.length === 0, darkUV.slice(0, 6).join(' | '));
  check('solid blocks do not sample black texels', tooDark.length === 0, tooDark.slice(0, 6).join(' | '));
  check('stacked columns sample painted texels', stackedBad.length === 0, stackedBad.join(' | '));

  /* ---- fences join up ---- */
  {
    /*
     * Reported from play: fences side by side stayed separate instead of
     * connecting. Each one rendered as a free-standing post with no rails, so a
     * line of them looked like a row of columns rather than a fence.
     *
     * A fence now emits rails toward every neighbour it joins, so a joined fence
     * must produce strictly more geometry than an isolated one - and a fence
     * beside a solid wall must join that too, which is the original's rule.
     */
    const fence = blockByName('oak_fence')?.id ?? 0;
    const stone = blockByName('stone')?.id ?? 0;
    const vertCount = (res) =>
      [res.opaque, res.transparent].filter(Boolean).reduce((n, d) => n + d.positions.length / 3, 0);

    const alone = vertCount(meshOnly(() => world.setBlock(8, 70, 8, fence)));
    const pair = vertCount(
      meshOnly(() => {
        world.setBlock(8, 70, 8, fence);
        world.setBlock(9, 70, 8, fence);
      }),
    );
    const againstWall = vertCount(
      meshOnly(() => {
        world.setBlock(8, 70, 8, fence);
        world.setBlock(9, 70, 8, stone);
      }),
    );
    const corner = vertCount(
      meshOnly(() => {
        world.setBlock(8, 70, 8, fence);
        world.setBlock(9, 70, 8, fence);
        world.setBlock(8, 70, 9, fence);
      }),
    );

    info(`fence vertices: alone ${alone}, two in a row ${pair}, against stone ${againstWall}, corner of three ${corner}`);
    check('a single fence has a post', alone > 0, String(alone));
    check('two fences emit more than twice one fence', pair > alone * 2, `${pair} vs ${alone * 2}`);
    check('a fence joins an adjacent fence', pair - alone * 2 > 0, `+${pair - alone * 2}`);
    check('a fence joins a solid block', againstWall > alone * 2, `${againstWall} vs ${alone * 2}`);
    check('a corner fence joins two neighbours', corner > alone * 3, `${corner} vs ${alone * 3}`);
    // and a lone fence must have no rails, or a single post would look like a cross
    check('a lone fence is just a post', alone < 40, `${alone} vertices`);
  }

  /* ---- doors exist as two halves, in both states ---- */
  {
    /*
     * Reported from play: only the bottom half of a door was visible, and
     * right-clicking did nothing. The block was a one-cell slab with no state,
     * so there was nothing to fill the upper cell and nothing to toggle. The
     * four ids are what carry the half and the open/closed state, since the
     * world stores nothing but an id per cell.
     */
    const lower = blockByName('oak_door')?.id ?? 0;
    const upper = blockByName('oak_door_top')?.id ?? 0;
    const openLower = blockByName('oak_door_open')?.id ?? 0;
    const openUpper = blockByName('oak_door_open_top')?.id ?? 0;
    check('both door halves exist', lower > 0 && upper > 0, `${lower}/${upper}`);
    check('both open halves exist', openLower > 0 && openUpper > 0, `${openLower}/${openUpper}`);

    const boxOf = (n) => blockByName(n)?.box ?? [];
    const [cx0, , cz0, cx1, , cz1] = boxOf('oak_door');
    const [ox0, , oz0, ox1, , oz1] = boxOf('oak_door_open');
    info(`closed slab ${cx1 - cx0} x ${cz1 - cz0}, open slab ${ox1 - ox0} x ${oz1 - oz0}`);
    // a closed door is a slab across the cell, the open one the same slab turned
    check('a closed door is a thin slab', Math.abs(cz1 - cz0 - 0.1875) < 1e-6, String(cz1 - cz0));
    check('an open door is that slab turned a quarter turn', Math.abs(ox1 - ox0 - 0.1875) < 1e-6 && Math.abs(oz1 - oz0 - 1) < 1e-6, `${ox1 - ox0} x ${oz1 - oz0}`);
    check('the two states are different shapes', cx1 - cx0 !== ox1 - ox0 || cz1 - cz0 !== oz1 - oz0);

    // both halves must render, or the doorway has a gap above the leaf
    const lowVerts = (() => {
      const r = meshOnly(() => world.setBlock(8, 70, 8, lower));
      return [r.opaque, r.transparent].filter(Boolean).reduce((n, d) => n + d.positions.length / 3, 0);
    })();
    const topVerts = (() => {
      const r = meshOnly(() => world.setBlock(8, 70, 8, upper));
      return [r.opaque, r.transparent].filter(Boolean).reduce((n, d) => n + d.positions.length / 3, 0);
    })();
    info(`door halves render: lower ${lowVerts} verts, upper ${topVerts} verts`);
    check('the lower half renders', lowVerts > 0, String(lowVerts));
    check('the upper half renders', topVerts > 0, String(topVerts));
  }

  console.log(`blocks: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
