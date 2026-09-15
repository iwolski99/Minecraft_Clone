// Worldgen QA: generates a block of chunks and renders top-down maps plus a
// vertical cross-section so terrain, biomes, caves, ores, trees and structures
// can all be inspected without a browser.
import path from 'node:path';
import { writePng, makeCanvas } from './png.mjs';

export async function run(OUT, load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { BIOMES } = await load('worldgen/biomes.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { CHUNK_Y, SEA_LEVEL } = await load('world/chunk.js');

  const seed = Number(process.env.SEED || 1337);
  const CH = Number(process.env.CHUNKS || 20);
  const gen = new TerrainGenerator(seed);
  const world = new World(seed, gen);
  const atlas = buildBlockAtlas();

  const { BLOCKS } = await load('world/blocks.js');
  // map a block id to the texture that best represents it from above
  const topTexName = BLOCKS.map((b) => (b.tex && (b.tex.top || b.tex.all || b.tex.side || b.tex.sprite)) || 'stone');

  const blockName = (id) => topTexName[id] || 'stone';

  const t0 = Date.now();
  let totalChunks = 0;
  let tGen = 0;
  let tLight = 0;
  for (let cz = -2; cz < CH - 2; cz++) {
    for (let cx = -2; cx < CH - 2; cx++) {
      const c = world.createChunk(cx, cz);
      const a = Date.now();
      gen.generateChunk(c);
      const b = Date.now();
      world.light.initialLight(c);
      const d = Date.now();
      tGen += b - a;
      tLight += d - b;
      totalChunks++;
    }
  }
  const genMs = Date.now() - t0;
  console.log(`world: breakdown gen ${(tGen / totalChunks).toFixed(2)} ms/chunk, light ${(tLight / totalChunks).toFixed(2)} ms/chunk`);

  const N = CH * 16;
  const scale = 3;
  const W = N * scale;
  const biomeMap = makeCanvas(W, W);
  const topMap = makeCanvas(W, W);
  const heightMap = makeCanvas(W, W);

  let minH = 999;
  let maxH = -999;
  const hist = new Map();
  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      const wx = x - 64;
      const wz = z - 64;
      const h = world.heightAt(wx, wz);
      const b = world.biomeAt(wx, wz);
      hist.set(b, (hist.get(b) || 0) + 1);
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
      const biome = BIOMES[b] || BIOMES[3];
      const tint = biome.grassTint;
      const shade = 0.55 + ((h - 20) / 90) * 0.7;
      const col = [
        Math.min(255, 90 * tint[0] * shade + (biome.snowy ? 120 : 0)),
        Math.min(255, 150 * tint[1] * shade + (biome.snowy ? 120 : 0)),
        Math.min(255, 70 * tint[2] * shade + (biome.snowy ? 130 : 0)),
      ];
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = ((z * scale + sy) * W + (x * scale + sx)) * 4;
          biomeMap[o] = col[0];
          biomeMap[o + 1] = col[1];
          biomeMap[o + 2] = col[2];
          biomeMap[o + 3] = 255;
          const g = Math.max(0, Math.min(255, ((h - minH) / Math.max(1, maxH - minH)) * 255));
          heightMap[o] = g * 0.85 + 20;
          heightMap[o + 1] = g;
          heightMap[o + 2] = g * 0.9 + 30;
          heightMap[o + 3] = 255;
        }
      }
      // top block colour, shaded by height
      const id = world.getBlockAt(wx, h, wz);
      const slot = atlas.slot(blockName(id));
      const c = atlas.averageColor(slot);
      const f = 0.62 + ((h - minH) / Math.max(1, maxH - minH)) * 0.55;
      for (let sy = 0; sy < scale; sy++) {
        for (let sx = 0; sx < scale; sx++) {
          const o = ((z * scale + sy) * W + (x * scale + sx)) * 4;
          topMap[o] = Math.min(255, c[0] * f);
          topMap[o + 1] = Math.min(255, c[1] * f);
          topMap[o + 2] = Math.min(255, c[2] * f);
          topMap[o + 3] = 255;
        }
      }
    }
  }
  writePng(path.join(OUT, 'map-biome.png'), W, W, biomeMap);
  writePng(path.join(OUT, 'map-top.png'), W, W, topMap);
  writePng(path.join(OUT, 'map-height.png'), W, W, heightMap);

  // ---- wide overview: biome + relief across several thousand blocks --------
  {
    const SPAN = Number(process.env.SPAN || 4096);
    const STEP = 8;
    const OW = SPAN / STEP;
    const overview = makeCanvas(OW, OW);
    let omin = 999;
    let omax = -999;
    const grid = new Int16Array(OW * OW);
    const bs = new Uint8Array(OW * OW);
    for (let z = 0; z < OW; z++) {
      for (let x = 0; x < OW; x++) {
        const info = gen.columnInfo(x * STEP - SPAN / 2, z * STEP - SPAN / 2);
        grid[z * OW + x] = info.height;
        bs[z * OW + x] = info.biome;
        omin = Math.min(omin, info.height);
        omax = Math.max(omax, info.height);
      }
    }
    for (let z = 0; z < OW; z++) {
      for (let x = 0; x < OW; x++) {
        const i = z * OW + x;
        const h = grid[i];
        const biome = BIOMES[bs[i]] || BIOMES[3];
        const t = biome.grassTint;
        const band = Math.floor(h / 6) % 2 === 0 ? 1 : 0.92;
        const rel = (h - SEA_LEVEL) / 40;
        const shade = (rel < 0 ? 0.44 + (1 + rel) * 0.30 : 0.62 + Math.min(rel, 1.3) * 0.22) * band;
        const o = i * 4;
        if (h < SEA_LEVEL) {
          const d = Math.min(1, (SEA_LEVEL - h) / 30);
          overview[o] = 46 * (1 - d) + 12 * d;
          overview[o + 1] = 104 * (1 - d) + 34 * d;
          overview[o + 2] = 196 * (1 - d) + 78 * d;
        } else {
          overview[o] = Math.min(255, 100 * t[0] * shade + (biome.snowy ? 128 : 0));
          overview[o + 1] = Math.min(255, 156 * t[1] * shade + (biome.snowy ? 130 : 0));
          overview[o + 2] = Math.min(255, 76 * t[2] * shade + (biome.snowy ? 138 : 0));
        }
        overview[o + 3] = 255;
      }
    }
    writePng(path.join(OUT, 'map-overview.png'), OW, OW, overview);
    const oh = new Map();
    for (let i = 0; i < bs.length; i++) oh.set(bs[i], (oh.get(bs[i]) || 0) + 1);
    const olist = [...oh.entries()]
      .sort((a, c) => c[1] - a[1])
      .map(([b, n]) => `${(BIOMES[b] || {}).name || b}:${((n / bs.length) * 100).toFixed(1)}%`);
    console.log(`world: overview ${SPAN}x${SPAN} blocks, height ${omin}..${omax}`);
    console.log(`world: overview biomes ${olist.join('  ')}`);
  }

  // ---- vertical cross-section through the middle --------------------------
  const sliceW = N;
  const sliceH = CHUNK_Y;
  const slice = makeCanvas(sliceW * 2, sliceH * 2);
  const zMid = 0;
  for (let x = 0; x < N; x++) {
    for (let y = 0; y < CHUNK_Y; y++) {
      const id = world.getBlockAt(x - 64, y, zMid);
      const name = blockName(id);
      const slot = atlas.slot(name);
      const c = id === 0 ? [14, 16, 26, 255] : atlas.averageColor(slot);
      const sky = world.getSkyLightAt(x - 64, y, zMid);
      const blk = world.getBlockLightAt(x - 64, y, zMid);
      const light = Math.max(sky / 15, blk / 15 * 0.95, 0.06);
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          const o = (((CHUNK_Y - 1 - y) * 2 + sy) * sliceW * 2 + x * 2 + sx) * 4;
          slice[o] = c[0] * light;
          slice[o + 1] = c[1] * light;
          slice[o + 2] = c[2] * light;
          slice[o + 3] = 255;
        }
      }
    }
  }
  writePng(path.join(OUT, 'slice.png'), sliceW * 2, sliceH * 2, slice);

  // ---- report -------------------------------------------------------------
  const names = [];
  for (const [b, n] of [...hist.entries()].sort((a, c) => c[1] - a[1])) {
    names.push(`${(BIOMES[b] || {}).name || b}:${((n / (N * N)) * 100).toFixed(1)}%`);
  }
  console.log(`world: ${totalChunks} chunks in ${genMs} ms (${(genMs / totalChunks).toFixed(2)} ms/chunk)`);
  console.log(`world: height range ${minH}..${maxH}`);
  console.log(`world: biomes ${names.join('  ')}`);
  console.log(`world: structures ${JSON.stringify(gen.structures.discovered.slice(0, 12))}`);
  console.log('world: wrote .qa/map-biome.png .qa/map-top.png .qa/map-height.png .qa/slice.png');
}

