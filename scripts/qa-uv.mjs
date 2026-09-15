// Decisive UV test: for every vertex the mesher emits, look up the atlas texel
// its UV actually addresses and check the alpha.
//
// The existing render-path test only asserted `0 <= uv <= 1`, which all-zero UVs
// satisfy - so a geometry that sampled entirely empty atlas space would pass.
// This test asks the only question that matters: does the UV land on a texel the
// terrain shader will not discard?

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { VoxelMesher } = await load('render/mesher.js');

  const atlas = buildBlockAtlas();
  const gen = new TerrainGenerator(4242);
  const world = new World(4242, gen);
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const c = world.createChunk(cx, cz);
      gen.generateChunk(c);
      world.light.initialLight(c);
    }
  }

  const mesher = new VoxelMesher(atlas);
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

  // how much of the atlas is actually painted?
  let filled = 0;
  for (let i = 0; i < atlas.count; i++) {
    const c = atlas.averageColor(i);
    if (c[3] > 0 && !(c[0] === 255 && c[1] === 0 && c[2] === 255)) filled++;
  }
  info(`atlas: ${atlas.count} tiles painted of ${atlas.cols * atlas.rows} slots (${((atlas.count / (atlas.cols * atlas.rows)) * 100).toFixed(0)}% of the grid)`);

  /** Alpha of the texel a UV addresses, using the same mapping the GPU uses. */
  const alphaAt = (u, v) => {
    const x = Math.min(atlas.width - 1, Math.max(0, Math.floor(u * atlas.width)));
    const y = Math.min(atlas.height - 1, Math.max(0, Math.floor((1 - v) * atlas.height)));
    return atlas.data[(y * atlas.width + x) * 4 + 3];
  };

  let verts = 0;
  let opaqueHits = 0;
  let transparentHits = 0;
  let zeroUv = 0;
  let uvMin = 1;
  let uvMax = 0;
  const distinctUv = new Set();
  const sampleMisses = [];

  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = world.getChunk(cx, cz);
      if (!chunk) continue;
      const res = mesher.build(world, chunk);
      if (!res.opaque) continue;
      const uv = res.opaque.uvs;
      for (let i = 0; i < uv.length; i += 2) {
        const u = uv[i];
        const v = uv[i + 1];
        verts++;
        if (u === 0 && v === 0) zeroUv++;
        if (u < uvMin) uvMin = u;
        if (u > uvMax) uvMax = u;
        distinctUv.add(`${u.toFixed(5)},${v.toFixed(5)}`);
        const a = alphaAt(u, v);
        if (a >= 128) opaqueHits++;
        else {
          transparentHits++;
          if (sampleMisses.length < 5) sampleMisses.push(`uv(${u.toFixed(5)},${v.toFixed(5)}) -> texel alpha ${a}`);
        }
      }
    }
  }

  info(`vertices sampled: ${verts}`);
  info(`uv range: u ${uvMin.toFixed(5)}..${uvMax.toFixed(5)}, distinct uv pairs ${distinctUv.size}`);
  info(`texel alpha >= 128: ${opaqueHits} (${((opaqueHits / Math.max(1, verts)) * 100).toFixed(1)}%)`);
  if (sampleMisses.length) info(`sample misses: ${sampleMisses.join(' | ')}`);

  check('mesher emitted vertices', verts > 1000, String(verts));
  check('UVs are not all zero', zeroUv < verts, `${zeroUv}/${verts} vertices had uv (0,0)`);
  check('UVs vary across vertices', distinctUv.size > 20, `${distinctUv.size} distinct pairs`);
  check(
    'terrain UVs land on painted atlas texels',
    opaqueHits / Math.max(1, verts) > 0.9,
    `${transparentHits}/${verts} vertices sampled an empty texel (alpha < 128)`,
  );

  // ---- the regression test for the actual black-terrain bug ----------------
  //
  // Atlas.uvSlot() writes `v = 1 - row / height`, i.e. the standard image
  // convention where v = 1 is the top row. A three.js DataTexture is sampled
  // bottom-up, so the bytes handed to the GPU must have their rows flipped or
  // every UV silently addresses the mirrored band of the atlas. With a 16-row
  // atlas that only paints rows 0-6, that mirror lands entirely on unpainted
  // space: alpha-tested terrain vanishes, untested terrain renders black.
  const { createAtlasTexture } = await load('render/materials.js');
  const tex = createAtlasTexture(atlas);
  const uploaded = tex.image.data;
  const w = atlas.width;
  const h = atlas.height;
  const sameRow = (buf, row) => buf.subarray(row * w * 4, (row + 1) * w * 4);
  const rowsFlipped = sameRow(uploaded, h - 1).every((v, i) => v === sameRow(atlas.data, 0)[i]);
  check('atlas is row-flipped for the GPU', rowsFlipped, 'uploaded row 0 does not match source row 0');
  check('uploaded payload is the right size', uploaded.length === w * h * 4, String(uploaded.length));

  // and prove the mechanism: the mirrored band really is unpainted, so getting
  // this wrong cannot merely tint the world, it erases it
  let paintedRows = 0;
  for (let r = 0; r < h; r++) {
    let any = false;
    for (let i = 0; i < w * 4 && !any; i += 4) if (sameRow(atlas.data, r)[i + 3] > 8) any = true;
    if (any) paintedRows++;
  }
  const mirroredRow = h - 1 - (paintedRows - 1);
  let mirroredPainted = false;
  for (let i = 3; i < w * 4; i += 4) if (sameRow(atlas.data, mirroredRow)[i] > 8) mirroredPainted = true;
  info(`atlas paints the first ${paintedRows} of ${h} tile rows; the mirrored band (row ${mirroredRow}+) is ${mirroredPainted ? 'painted' : 'EMPTY'}`);
  check('an unflipped atlas would sample empty space', !mirroredPainted, `row ${mirroredRow} unexpectedly painted`);

  console.log(`uv: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
