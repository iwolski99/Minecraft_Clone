// Verify the standalone single-file build without a browser.
//
// Extracts the embedded payload from dist/cubeworld.html and runs the exact
// resolution the page performs at runtime: every import specifier in every
// module must resolve to another embedded module (or to the embedded three.js).
// If this passes, the file has everything it needs to boot from disk.

import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './compile.mjs';

const file = process.argv[2] || path.join(ROOT, 'dist', 'cubeworld.html');
if (!fs.existsSync(file)) {
  console.error(`${file} not found - run \`node scripts/build-standalone.mjs\``);
  process.exit(1);
}
const html = fs.readFileSync(file, 'utf8');

const grab = (id) => {
  const re = new RegExp(`<script type="text/plain" id="${id}">([\\s\\S]*?)<\\/script>`);
  const m = html.match(re);
  if (!m) throw new Error(`embedded payload "${id}" missing from the standalone file`);
  return m[1];
};

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

const THREE_PATH = 'vendor/three/three.module.js';

let threeSrc = '';
let sources = {};
try {
  threeSrc = grab('cw-three');
  sources = JSON.parse(grab('cw-modules').replace(/<\\\/script/gi, '</script'));
} catch (e) {
  console.error(`  FAIL payload extraction: ${e.message}`);
  process.exit(1);
}

info(`file size ${(fs.statSync(file).size / 1024).toFixed(0)} KB`);
info(`embedded three.js ${(threeSrc.length / 1024).toFixed(0)} KB, ${Object.keys(sources).length} modules`);

check('three.js payload is present', threeSrc.length > 500000, `${threeSrc.length} bytes`);
check('entry module present', typeof sources['src/main.js'] === 'string');
check('css is inlined', html.includes('#hotbar') && html.includes('.hotbar-slot'));
check('no external script/link references', !/<script[^>]+src=|<link[^>]+href="http/i.test(html));

// must match the builder exactly
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*)(['"])((?:\.\.?\/)[^'"\n]*?\.js|three)\2/g;
const resolve = (from, spec) => {
  if (spec === 'three') return THREE_PATH;
  if (!spec.startsWith('.')) return spec;
  const base = from.split('/').slice(0, -1);
  for (const part of spec.split('/')) {
    if (part === '.' || part === '') continue;
    if (part === '..') base.pop();
    else base.push(part);
  }
  return base.join('/');
};

const unresolved = [];
let edges = 0;
for (const [rel, src] of Object.entries(sources)) {
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[3];
    const target = resolve(rel, spec);
    edges++;
    if (target === THREE_PATH) continue;
    if (!(target in sources)) unresolved.push(`${rel} -> ${spec}`);
  }
}
info(`checked ${edges} import edges across ${Object.keys(sources).length} modules`);
check('every import resolves inside the payload', unresolved.length === 0, unresolved.slice(0, 8).join(' | '));

// the three.js payload itself must be self-contained (no relative imports)
const threeRelative = [...threeSrc.matchAll(IMPORT_RE)].filter((m) => m[3].startsWith('.'));
check('embedded three.js has no external imports', threeRelative.length === 0, threeRelative.map((m) => m[3]).join(', '));

// every payload must be non-empty and contain its own source (a cheap sanity
// check that nothing was truncated during embedding)
let emptyPayloads = 0;
for (const [rel, src] of Object.entries(sources)) {
  if (typeof src !== 'string' || src.length < 20) {
    emptyPayloads++;
    if (emptyPayloads < 4) console.error(`  FAIL truncated payload: ${rel}`);
  }
}
check('no truncated module payloads', emptyPayloads === 0, `${emptyPayloads} bad`);
check('payload survived the </script> guard', threeSrc.length > 500000 && !threeSrc.includes('<\/script'));

console.log(`standalone: ${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
