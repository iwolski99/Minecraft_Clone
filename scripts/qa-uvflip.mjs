// GPU-side UV contract test.
//
// The terrain, the mobs and the dropped/held items all address their textures
// through UVs computed from an atlas *grid slot* by `atlas.uvSlot()` (and the
// equivalent `uvRect()` in entities/models.ts):
//
//     v0 = 1 - (y + tile - e) / height      // y = the tile's row in `atlas.data`
//     v1 = 1 - (y + e) / height
//
// That is the *canvas* convention: data row 0 is the TOP row of the picture.
// WebGL DataTextures are uploaded with `flipY = false` (three.js hard-codes it
// in the DataTexture constructor), and for an ArrayBufferView source the first
// row of the array is the BOTTOM row of the texture, i.e. v = 0. So the GPU
// resolves those UVs to the vertically mirrored band of the atlas.
//
// The earlier `qa.mjs uv` test could not see this, because it converted UVs back
// to texels with the same canvas convention the UVs were built from - it
// validated the atlas, not the GPU. This test samples the *uploaded* texture the
// way the rasteriser does and asks the only question that matters: does the
// fragment shader see a painted texel?
//
//   node scripts/qa-uvflip.mjs            (standalone)
//   node scripts/qa.mjs uvflip            (through the QA runner)

import fs from 'node:fs';
import path from 'node:path';
import { ROOT, compileOnce } from './compile.mjs';

const BUILD = path.join(ROOT, '.qa-build');

async function ensureBuild() {
  if (!fs.existsSync(BUILD) || process.argv.includes('--rebuild')) {
    fs.rmSync(BUILD, { recursive: true, force: true });
    const { ok } = compileOnce(BUILD);
    if (!ok) throw new Error('compile failed');
  }
}

/** The texel a GPU resolves for (u,v) when the texture was uploaded with flipY = false. */
function gpuWasFlipped(texture) {
  return texture && texture.flipY === true;
}

/** Emulate texture2D() for a nearest-filtered DataTexture. */
function gpuSampleOf(tex, u, v) {
  const w = tex.image.width;
  const h = tex.image.height;
  const data = tex.image.data;
  const x = Math.min(w - 1, Math.max(0, Math.floor(u * w)));
  const row = Math.min(h - 1, Math.max(0, Math.floor(v * h)));
  // flipY === false  ->  the first row of the buffer is at v = 0
  const y = gpuWasFlipped(tex) ? h - 1 - row : row;
  const o = (y * w + x) * 4;
  return [data[o], data[o + 1], data[o + 2], data[o + 3]];
}

export async function run(load) {
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

  const { buildBlockAtlas, buildItemAtlas } = await load('render/atlas.js');
  const { createAtlasTexture } = await load('render/materials.js');
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { VoxelMesher } = await load('render/mesher.js');

  /* ---------------- 1. what the rasteriser does with a DataTexture --------- */

  const atlas = buildBlockAtlas();
  const tex = createAtlasTexture(atlas);
  info(`block atlas: ${atlas.width}x${atlas.height}, ${atlas.count} tiles in a ${atlas.cols}x${atlas.rows} grid`);
  info(`DataTexture.flipY = ${tex.flipY}  (three.js uploads with UNPACK_FLIP_Y_WEBGL = flipY)`);
  info(`image.data is ${tex.image.data.constructor.name} of ${tex.image.data.length} bytes`);

  const upload = tex.image.data;
  const W = tex.image.width;
  const H = tex.image.height;

  /** Emulate texture2D() for a nearest-filtered, non-flipped DataTexture. */
  const gpuSample = (u, v) => gpuSampleOf(tex, u, v);
  /** The texel the UV was *meant* to address: the canvas-convention lookup. */
  const intendedSample = (u, v) => {
    const x = Math.min(W - 1, Math.max(0, Math.floor(u * W)));
    const y = Math.min(H - 1, Math.max(0, Math.floor((1 - v) * H)));
    const o = (y * W + x) * 4;
    return [atlas.data[o], atlas.data[o + 1], atlas.data[o + 2], atlas.data[o + 3]];
  };

  /* ---------------- 2. how much of the atlas grid is painted --------------- */

  const rowFilled = new Array(atlas.rows).fill(0);
  for (let i = 0; i < atlas.count; i++) {
    const c = atlas.averageColor(i);
    if (c[3] > 0 && !(c[0] === 255 && c[1] === 0 && c[2] === 255)) rowFilled[Math.floor(i / atlas.cols)]++;
  }
  info(`painted tiles per atlas grid row: [${rowFilled.join(', ')}]`);
  const paintedRows = rowFilled.filter((n) => n > 0).length;
  info(`painted grid rows: ${paintedRows}/${atlas.rows} - rows ${paintedRows}..${atlas.rows - 1} are empty`);

  /* ---------------- 3. terrain UVs, sampled the way the GPU samples them --- */

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

  const stats = {};
  const scanLayer = (name, uvs) => {
    const s = (stats[name] = { verts: 0, gpuPainted: 0, gpuEmpty: 0, intendedPainted: 0, mismatch: 0, lum: 0, examples: [] });
    for (let i = 0; i < uvs.length; i += 2) {
      const u = uvs[i];
      const v = uvs[i + 1];
      s.verts++;
      const g = gpuSample(u, v);
      const t = intendedSample(u, v);
      s.lum += 0.2126 * g[0] + 0.7152 * g[1] + 0.0722 * g[2];
      if (g[3] >= 128) s.gpuPainted++;
      else {
        s.gpuEmpty++;
        if (s.examples.length < 3) {
          s.examples.push(`uv(${u.toFixed(4)},${v.toFixed(4)}) gpu texel rgba(${g.join(',')})`);
        }
      }
      if (t[3] >= 128) s.intendedPainted++;
      if (g[3] >= 128 !== t[3] >= 128 || g[0] !== t[0] || g[1] !== t[1] || g[2] !== t[2]) s.mismatch++;
    }
  };

  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const chunk = world.getChunk(cx, cz);
      if (!chunk) continue;
      const res = mesher.build(world, chunk);
      if (res.opaque) scanLayer('terrain opaque', res.opaque.uvs);
      if (res.transparent) scanLayer('terrain water', res.transparent.uvs);
    }
  }

  for (const [name, s] of Object.entries(stats)) {
    const pct = (n) => `${((n / Math.max(1, s.verts)) * 100).toFixed(1)}%`;
    info(
      `${name}: ${s.verts} verts - GPU-visible ${pct(s.gpuPainted)}, ` +
        `empty on the GPU ${pct(s.gpuEmpty)}, canvas-convention hit ${pct(s.intendedPainted)}, ` +
        `mean sampled luminance ${(s.lum / Math.max(1, s.verts)).toFixed(1)}`,
    );
    if (s.examples.length) info(`  e.g. ${s.examples[0]}`);
  }

  /* ---------------- 4. the same question for mobs and items ---------------- */

  const models = await load('entities/models.js');
  const rig = models.buildMobRig('pig');
  const mobTex = rig.material.map;
  const mobData = mobTex.image.data;
  const MW = mobTex.image.width;
  const MH = mobTex.image.height;
  let mobVerts = 0;
  let mobPaintedGpu = 0;
  let mobPaintedCanvas = 0;
  const mobMeshes = [];
  rig.root.traverse((o) => {
    if (o.isMesh) mobMeshes.push(o);
  });
  for (const m of mobMeshes) {
    const uv = m.geometry.attributes.uv;
    for (let i = 0; i < uv.count; i++) {
      const u = uv.getX(i);
      const v = uv.getY(i);
      mobVerts++;
      const gx = Math.min(MW - 1, Math.max(0, Math.floor(u * MW)));
      const grow = Math.min(MH - 1, Math.max(0, Math.floor(v * MH)));
      const gy = mobTex.flipY ? MH - 1 - grow : grow;
      if (mobData[(gy * MW + gx) * 4 + 3] >= 128) mobPaintedGpu++;
      const cy = Math.min(MH - 1, Math.max(0, Math.floor((1 - v) * MH)));
      if (mobData[(cy * MW + gx) * 4 + 3] >= 128) mobPaintedCanvas++;
    }
  }
  info(
    `mob atlas ${MW}x${MH} flipY=${mobTex.flipY}: ${mobVerts} UVs over ${mobMeshes.length} meshes - ` +
      `painted in the band the shader samples ${((mobPaintedGpu / Math.max(1, mobVerts)) * 100).toFixed(1)}%, ` +
      `painted in the mirrored band ${((mobPaintedCanvas / Math.max(1, mobVerts)) * 100).toFixed(1)}%`,
  );

  /* ---------------- 5. full round trip: atlas texel <-> GPU sample --------- */

  // For a canvas-ordered atlas the UV that addresses texel (x, y) is
  // u = (x + 0.5) / width, v = 1 - (y + 0.5) / height. Sampling the uploaded
  // texture the way the rasteriser does must return that exact texel.
  const itemAtlas = buildItemAtlas();
  let roundTrip = 0;
  let roundTripBad = 0;
  const roundTripExamples = [];
  for (const a of [atlas, itemAtlas]) {
    const t = createAtlasTexture(a);
    for (let slot = 0; slot < a.count; slot++) {
      for (let y = 0; y < a.tile; y += 3) {
        for (let x = 0; x < a.tile; x += 3) {
          const want = a.texel(slot, x, y);
          const gx = (slot % a.cols) * a.tile + x;
          const gy = Math.floor(slot / a.cols) * a.tile + y;
          const u = (gx + 0.5) / a.width;
          const v = 1 - (gy + 0.5) / a.height;
          const gpu = gpuSampleOf(t, u, v);
          roundTrip++;
          if (gpu[0] !== want[0] || gpu[1] !== want[1] || gpu[2] !== want[2] || gpu[3] !== want[3]) {
            roundTripBad++;
            if (roundTripExamples.length < 3) {
              roundTripExamples.push(
                `${a === atlas ? 'blocks' : 'items'} slot ${slot} texel (${x},${y}) authored rgba(${want.join(',')}) but the GPU sees rgba(${gpu.join(',')})`,
              );
            }
          }
        }
      }
    }
  }
  info(`atlas round trip: ${roundTrip - roundTripBad}/${roundTrip} sampled texels arrive at the shader unchanged`);
  if (roundTripExamples.length) info(`  e.g. ${roundTripExamples[0]}`);

  /* ---------------- assertions ------------------------------------------- */

  check(
    'terrain UVs hit painted texels the way the GPU samples them',
    stats['terrain opaque'] && stats['terrain opaque'].gpuEmpty === 0,
    stats['terrain opaque']
      ? `${stats['terrain opaque'].gpuEmpty}/${stats['terrain opaque'].verts} vertices sample an empty atlas texel on the GPU (the fragment shader discards or renders black)`
      : 'no opaque geometry',
  );
  check(
    'mob UVs hit painted texels the way the GPU samples them',
    mobVerts === 0 || mobPaintedGpu / mobVerts > 0.9,
    `${mobVerts - mobPaintedGpu}/${mobVerts} mob UVs sample an empty texel (a MeshBasicMaterial draws those black)`,
  );
  check(
    'the atlas reaches the shader upright and unmirrored',
    roundTripBad === 0,
    `${roundTripBad}/${roundTrip} texels sampled something other than what was painted`,
  );

  console.log(`uvflip: ${pass} passed, ${fail} failed`);
  return fail;
}

// standalone mode
if (import.meta.url === new URL(`file://${process.argv[1]}`).href || process.argv[1]?.endsWith('qa-uvflip.mjs')) {
  await ensureBuild();
  const load = (rel) => import(new URL(`../.qa-build/src/${rel}`, import.meta.url).href);
  const failed = await run(load);
  if (failed) process.exit(1);
}
