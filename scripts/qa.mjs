// Visual QA harness.
//
// Browsers cannot launch in this environment, so instead of screenshots the
// project ships a headless software renderer that consumes the *same* atlas,
// mesher and worldgen code the game uses and writes PNGs for inspection.
//
//   node scripts/qa.mjs atlas     - dump the generated texture atlases
//   node scripts/qa.mjs world     - dump biome / height maps for a seed
//   node scripts/qa.mjs render    - software-render first-person views
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ROOT, compileOnce } from './compile.mjs';
import { writePng, makeCanvas, blitScaled } from './png.mjs';

const OUT = path.join(ROOT, '.qa');
fs.mkdirSync(OUT, { recursive: true });

const BUILD = path.join(ROOT, '.qa-build');
const force = !process.argv.includes('--no-rebuild');
if (force || !fs.existsSync(BUILD)) {
  fs.rmSync(BUILD, { recursive: true, force: true });
  const { ok } = compileOnce(BUILD);
  if (!ok) {
    console.error('QA: compile failed');
    process.exit(1);
  }
}

const cmd = process.argv[2] || 'atlas';

async function load(rel) {
  // the compiler emits with the repo root as rootDir, so modules live under src/
  return import(new URL(`../.qa-build/src/${rel}`, import.meta.url).href);
}

/* ------------------------------------------------------------------ */

async function dumpAtlas() {
  const { buildBlockAtlas, buildItemAtlas } = await load('render/atlas.js');
  const { tileNames } = await load('render/blockTextures.js');

  const blocks = buildBlockAtlas();
  const items = buildItemAtlas();

  const scale = 5;
  const pad = 4;
  const bg = [18, 18, 24, 255];

  const bw = blocks.width * scale;
  const bh = blocks.height * scale;
  let canvas = makeCanvas(bw, bh, bg);
  blitScaled(canvas, bw, blocks.data, blocks.width, blocks.height, 0, 0, scale);
  writePng(path.join(OUT, 'atlas-blocks.png'), bw, bh, canvas);

  const iw = items.width * scale;
  const ih = items.height * scale;
  canvas = makeCanvas(iw, ih, bg);
  blitScaled(canvas, iw, items.data, items.width, items.height, 0, 0, scale);
  writePng(path.join(OUT, 'atlas-items.png'), iw, ih, canvas);

  // A labelled contact sheet at a readable size for art review.
  const names = [...tileNames()].sort();
  const cols = 10;
  const cell = 16 * 6 + pad * 2;
  const rows = Math.ceil(names.length / cols);
  const cw = cols * cell;
  const ch = rows * cell;
  const sheet = makeCanvas(cw, ch, bg);
  for (let i = 0; i < names.length; i++) {
    const cx = (i % cols) * cell + pad;
    const cy = Math.floor(i / cols) * cell + pad;
    const slot = blocks.slot(names[i]);
    const sx = (slot % blocks.cols) * 16;
    const sy = Math.floor(slot / blocks.cols) * 16;
    for (let y = 0; y < 96; y++) {
      for (let x = 0; x < 96; x++) {
        const px = sx + ((x / 6) | 0);
        const py = sy + ((y / 6) | 0);
        const so = (py * blocks.width + px) * 4;
        const a = blocks.data[so + 3] / 255;
        const d = ((cy + y) * cw + cx + x) * 4;
        sheet[d] = blocks.data[so] * a + sheet[d] * (1 - a);
        sheet[d + 1] = blocks.data[so + 1] * a + sheet[d + 1] * (1 - a);
        sheet[d + 2] = blocks.data[so + 2] * a + sheet[d + 2] * (1 - a);
        sheet[d + 3] = 255;
      }
    }
  }
  writePng(path.join(OUT, 'sheet-blocks.png'), cw, ch, sheet);

  console.log(`atlas: ${blocks.count} block tiles -> .qa/atlas-blocks.png, .qa/sheet-blocks.png`);
  console.log(`atlas: ${items.count} item sprites -> .qa/atlas-items.png`);
}

/* ------------------------------------------------------------------ */

async function main() {
  if (cmd === 'camtrace') {
    const m = await import('./qa-camtrace.mjs');
    return m.run(load);
  }
  if (cmd === 'perf') {
    const m = await import('./qa-perf.mjs');
    return m.run(load);
  }
  if (cmd === 'shaders') {
    const m = await import('./qa-shaders.mjs');
    return m.run(load);
  }
  if (cmd === 'watermesh') {
    const m = await import('./qa-watermesh.mjs');
    return m.run(load);
  }
  if (cmd === 'water') {
    const m = await import('./qa-water.mjs');
    return m.run(load);
  }
  if (cmd === 'light') {
    const m = await import('./qa-light.mjs');
    return m.run(load);
  }
  if (cmd === 'worldids') {
    const m = await import('./qa-worldids.mjs');
    return m.run(load);
  }
  if (cmd === 'player') {
    const m = await import('./qa-player.mjs');
    return m.run(load);
  }
  if (cmd === 'inventory') {
    const m = await import('./qa-inventory.mjs');
    return m.run(load);
  }
  if (cmd === 'colours') {
    const m = await import('./qa-colours.mjs');
    return m.run(load);
  }
  if (cmd === 'blocks') {
    const m = await import('./qa-blocks.mjs');
    return m.run(load);
  }
  if (cmd === 'textures') {
    const m = await import('./qa-textures.mjs');
    return m.run(load);
  }
  if (cmd === 'alpha') {
    const m = await import('./qa-alpha.mjs');
    return m.run(load);
  }
  if (cmd === 'uv') {
    const m = await import('./qa-uv.mjs');
    return m.run(load);
  }
  if (cmd === 'uvflip') {
    const m = await import('./qa-uvflip.mjs');
    return m.run(load);
  }
  if (cmd === 'attrib') {
    const m = await import('./qa-attrib.mjs');
    return m.run(load);
  }
  if (cmd === 'spawn') {
    const m = await import('./qa-spawn.mjs');
    return m.run(load);
  }
  if (cmd === 'runtime') {
    const m = await import('./qa-runtime.mjs');
    return m.run(load);
  }
  if (cmd === 'stream') {
    const m = await import('./qa-stream.mjs');
    return m.run(load);
  }
  if (cmd === 'modules') {
    const m = await import('./qa-modules.mjs');
    return m.run();
  }
  if (cmd === 'mobs') {
    const m = await import('./qa-mobs.mjs');
    return m.run(load);
  }
  if (cmd === 'logic') {
    const m = await import('./qa-logic.mjs');
    return m.run(load);
  }
  if (cmd === 'trees') {
    const m = await import('./qa-trees.mjs');
    return m.run(load);
  }
  if (cmd === 'models') {
    const m = await import('./qa-models.mjs');
    return m.run(load);
  }
  if (cmd === 'atlas') return dumpAtlas();
  if (cmd === 'world') {
    const m = await import('./qa-world.mjs');
    return m.run(OUT, load);
  }
  if (cmd === 'render') {
    const m = await import('./qa-render.mjs');
    return m.run(OUT, load, process.argv.slice(3));
  }
  if (cmd === 'renderpath') {
    const m = await import('./qa-renderpath.mjs');
    return m.run(load);
  }
  if (cmd === 'viewmodel') {
    const m = await import('./qa-viewmodel.mjs');
    return m.run(load);
  }
  console.error(`unknown QA command: ${cmd}`);
  process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
