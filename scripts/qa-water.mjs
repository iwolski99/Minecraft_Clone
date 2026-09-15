// The water shader writes vec4(c, tex.a * uOpacity). If that alpha is ~0 the
// water is invisible and the player sees straight through to the unlit sea floor,
// which reads as a black void in daylight. Check every link in that chain.

export async function run(load) {
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { blockByName } = await load('world/blocks.js');
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
  const painted = new Set(tileNames());

  for (const name of ['water', 'lava']) {
    const def = blockByName(name);
    if (!def) {
      info(`${name}: no such block`);
      continue;
    }
    const t = def.tex ?? {};
    const used = [...new Set([t.all, t.side, t.top, t.bottom, t.sprite, t.east, t.west, t.south, t.north].filter(Boolean))];
    info(`${name}: render=${def.render} liquid=${!!def.liquid} tex=[${used.join(', ')}]`);

    for (const tn of used) {
      const present = painted.has(tn) || atlas.index.has(tn) || atlas.slot(tn) !== 0;
      if (!present) {
        check(`tile "${tn}" is painted`, false, 'missing from the atlas');
        continue;
      }
      const i = atlas.slot(tn);
      const tile = atlas.tile;
      const cx = (i % atlas.cols) * tile;
      const cy = Math.floor(i / atlas.cols) * tile;
      let min = 255;
      let max = 0;
      let sum = 0;
      let n = 0;
      for (let y = 0; y < tile; y++) {
        for (let x = 0; x < tile; x++) {
          const a = atlas.data[((cy + y) * atlas.width + cx + x) * 4 + 3];
          if (a < min) min = a;
          if (a > max) max = a;
          sum += a;
          n++;
        }
      }
      const mean = sum / n / 255;
      info(`  tile "${tn}" slot ${i}: alpha min ${min} max ${max} mean ${(mean * 255).toFixed(0)}`);
      // the shader discards below uAlphaTest (0.02) and blends by tex.a * uOpacity
      check(`${name}: tile "${tn}" is not discarded by the alpha test`, min / 255 >= 0.02, `min alpha ${min}`);
      check(`${name}: tile "${tn}" is visibly opaque`, mean > 0.35, `mean alpha ${(mean * 255).toFixed(0)}`);
    }
  }

  // the uniform that multiplies it
  const { createTerrainUniforms } = await load('render/materials.js');
  const u = createTerrainUniforms(null);
  const op = u.uOpacity.value;
  info(`uOpacity default = ${op}`);
  check('uOpacity does not zero the alpha', op > 0.2, `got ${op}`);

  console.log(`water: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
