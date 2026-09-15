// Every texture name a block references must actually be painted into the atlas.
//
// A missing name makes `Atlas.slot()` return a sentinel and the tile UVs collapse
// onto unpainted atlas space, which renders as solid black rather than as an
// obvious error - exactly how the cactus was lost.

export async function run(load) {
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { tileNames } = await load('render/blockTextures.js');
  const { BLOCKS } = await load('world/blocks.js');

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

  /*
   * `Atlas.slot()` returns 0 for an unknown name, and slot 0 is a legitimate
   * tile (bedrock), so a missing texture is indistinguishable from a real one by
   * slot number alone: the block silently renders as bedrock, which is
   * near-black. Membership therefore has to be tested three ways - painted
   * directly, present in the atlas index, or resolving through an alias to a
   * slot other than the fallback - because checking `slot() < 0` (the original
   * mistake) can never fire.
   */
  const present = (n) => painted.has(n) || atlas.index.has(n) || atlas.slot(n) !== 0;

  /** name -> the block that references it */
  const referenced = new Map();
  for (const def of BLOCKS) {
    const t = def.tex ?? {};
    const list = [t.east, t.west, t.top, t.bottom, t.south, t.north, t.side, t.all, t.sprite].filter(Boolean);
    for (const n of list) if (!referenced.has(n)) referenced.set(n, def.name);
  }

  const missing = [];
  for (const [n, owner] of referenced) {
    if (!present(n)) missing.push(`${n} (used by ${owner})`);
  }
  info(`atlas paints ${atlas.count} tiles; blocks reference ${referenced.size} distinct names`);
  if (missing.length) info(`MISSING: ${missing.join(', ')}`);
  check('every block texture is present in the atlas', missing.length === 0, `${missing.length} missing`);

  // A tile is unusable if it resolves outside the painted region or is entirely
  // transparent - both draw as black under the opaque material.
  const broken = [];
  for (const [n] of referenced) {
    if (!present(n)) continue;
    const i = atlas.slot(n);
    const t = atlas.tile;
    const cx = (i % atlas.cols) * t;
    const cy = Math.floor(i / atlas.cols) * t;
    let opaqueTexels = 0;
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        if (atlas.data[((cy + y) * atlas.width + cx + x) * 4 + 3] >= 128) opaqueTexels++;
      }
    }
    if (opaqueTexels === 0) broken.push(`${n} (fully transparent)`);
  }
  check('no referenced tile is entirely transparent', broken.length === 0, broken.join(', '));

  // spot-check the tiles that have historically gone wrong
  for (const n of ['cactus_side', 'cactus_top', 'oak_leaves', 'tall_grass', 'sand', 'stone']) {
    const ok = present(n);
    const i = ok ? atlas.slot(n) : -1;
    const uv = ok ? atlas.uv(n) : null;
    info(
      `${n.padEnd(13)} ${!ok ? 'MISSING' : `slot ${String(i).padStart(3)}  u ${uv.u0.toFixed(4)}..${uv.u1.toFixed(4)}  v ${uv.v0.toFixed(4)}..${uv.v1.toFixed(4)}`}`,
    );
  }

  console.log(`textures: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
