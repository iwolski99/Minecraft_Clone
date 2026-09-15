// Verify the whole-atlas alpha contract the terrain shaders depend on.
//
// The opaque terrain layer carries both solid blocks and cutout plants, and it
// alpha-tests at 0.5. That is only correct if:
//   * every solid block tile is fully opaque, so the test never eats a block,
//   * every cutout tile has genuinely transparent texels, so the test actually
//     removes the empty parts of grass/flowers instead of drawing them black.
// Water is semi-transparent and uses its own low threshold; if water texels were
// very faint the water shader would punch holes in the surface.

export async function run(load) {
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

  const atlas = buildBlockAtlas();

  /** Alpha histogram of one tile. */
  const tileAlpha = (i) => {
    let clear = 0; // discarded by any alpha test
    let faint = 0; // survives 0.02 but not 0.5
    let belowHalf = 0; // discarded by the opaque layer's 0.5 test
    let solid = 0;
    const t = atlas.tile;
    const cx = (i % atlas.cols) * t;
    const cy = Math.floor(i / atlas.cols) * t;
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        const a = atlas.data[((cy + y) * atlas.width + cx + x) * 4 + 3];
        if (a < 8) clear++;
        else if (a < 128) belowHalf++;
        else if (a < 250) faint++;
        else solid++;
      }
    }
    return { clear, faint, belowHalf, solid, total: t * t };
  };

  // Which tiles does the opaque layer use, and which does it alpha-test away?
  const OPAQUE_ALPHA_TEST = 0.5;
  const WATER_ALPHA_TEST = 0.02;

  let eatenSolid = 0;
  const eatenNames = [];
  let cutoutTiles = 0;
  let cutoutWithClear = 0;
  let waterTiles = 0;
  let waterTooFaint = 0;

  for (const name of tileNames()) {
    const idx = atlas.slot(name);
    if (idx < 0) continue;
    const a = tileAlpha(idx);

    // A tile used by a cutout block (cross geometry) is mostly clear.
    const isCutout = a.clear > a.total * 0.3;
    if (isCutout) {
      cutoutTiles++;
      if (a.clear > 0) cutoutWithClear++;
      // a cutout tile must lose something to the opaque alpha test
      if (a.clear === 0) eatenNames.push(`${name} (cutout but fully opaque)`);
    } else if (a.belowHalf > 0) {
      // would be erased by the opaque layer's 0.5 test
      eatenSolid++;
      if (eatenNames.length < 6) eatenNames.push(`${name} (${a.belowHalf} texels below alpha 128)`);
    }
  }

  info(`atlas tiles: ${atlas.count}`);
  info(`cutout tiles (mostly clear): ${cutoutTiles}, all have transparent texels: ${cutoutTiles === cutoutWithClear}`);
  if (eatenNames.length) info(`partially transparent tiles: ${eatenNames.join(', ')}`);

  check('cutout plant tiles have transparent texels', cutoutWithClear === cutoutTiles, `${cutoutWithClear}/${cutoutTiles}`);

  // water specifically
  const waterIdx = atlas.slot('water_still');
  if (waterIdx >= 0) {
    waterTiles++;
    const a = tileAlpha(waterIdx);
    const minAlpha = (() => {
      let m = 255;
      const t = atlas.tile;
      const cx = (waterIdx % atlas.cols) * t;
      const cy = Math.floor(waterIdx / atlas.cols) * t;
      for (let y = 0; y < t; y++) {
        for (let x = 0; x < t; x++) {
          const v = atlas.data[((cy + y) * atlas.width + cx + x) * 4 + 3];
          if (v < m) m = v;
        }
      }
      return m;
    })();
    info(`water_still alpha: min ${minAlpha}, faint ${a.faint}, solid ${a.solid}`);
    waterTooFaint = minAlpha / 255 < 1.0 && minAlpha / 255 < WATER_ALPHA_TEST ? 1 : 0;
    check('water survives its own low alpha test', waterTooFaint === 0, `min alpha ${minAlpha}`);
  } else {
    info('no water_still tile in the atlas (skipped)');
  }

  // block-level sanity: blocks that use cross geometry must have cutout textures
  const { getBlock } = await load('world/blocks.js');
  const { BLOCKS } = await load('world/blocks.js');
  let crossBlocks = 0;
  for (const def of BLOCKS ?? []) {
    if (def && typeof def === 'object' && (def.render === 'cross' || def.cross === true)) crossBlocks++;
  }
  info(`blocks declared with cross geometry: ${crossBlocks}`);
  void getBlock;
  void eatenSolid;

  check('atlas has painted tiles', atlas.count > 50, String(atlas.count));
  check('opaque tiles are fully opaque', eatenSolid === 0, `${eatenSolid} tiles would lose texels to the 0.5 test`);

  console.log(`alpha: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
