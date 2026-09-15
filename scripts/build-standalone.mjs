// Standalone build: one self-contained .html file that runs by double-clicking.
//
// The project is plain ES modules with no bundler, so this assembles them into a
// single file by:
//   1. embedding every module (and three.js) as inert <script type="text/plain">
//      blocks, which needs no escaping and no server,
//   2. walking the import graph and creating a Blob URL per module in dependency
//      order, rewriting each module's import specifiers to those Blob URLs,
//   3. importing the entry module.
//
// The result has no network dependencies, no localhost server, and no MIME-type
// or CORS surface - which also removes a whole class of "it works over http but
// not from disk" failures.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './compile.mjs';

const DIST = path.join(ROOT, 'dist');
const OUT = path.join(DIST, 'cubeworld.html');

if (!fs.existsSync(path.join(DIST, 'src', 'main.js'))) {
  console.error('dist/ not built - run `node scripts/build.mjs` first.');
  process.exit(1);
}

/* ---------------- collect modules ---------------- */

const modules = new Map(); // dist-relative path -> source
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.js')) modules.set(path.relative(DIST, p).replace(/\\/g, '/'), fs.readFileSync(p, 'utf8'));
  }
};
walk(path.join(DIST, 'src'));

const THREE_PATH = 'vendor/three/three.module.js';
const threeSource = fs.readFileSync(path.join(DIST, THREE_PATH), 'utf8');

/* ---------------- resolve the import graph ---------------- */

// Only real module specifiers: either the bare "three", or a relative path ending
// in .js. A looser pattern also matched prose inside comments and strings
// ("...distinguishable from 'the texture arrived and is black'"), which left the
// module registered under a bogus name and the page unable to boot.
const IMPORT_RE = /(\bfrom\s*|\bimport\s*\(\s*)(['"])((?:\.\.?\/)[^'"\n]*?\.js|three)\2/g;

function depsOf(rel) {
  const src = modules.get(rel) ?? '';
  const out = [];
  for (const m of src.matchAll(IMPORT_RE)) {
    const spec = m[3];
    if (spec === 'three') out.push(THREE_PATH);
    else if (spec.startsWith('.')) {
      const resolved = path.posix.normalize(path.posix.join(path.posix.dirname(rel), spec));
      if (modules.has(resolved)) out.push(resolved);
      else if (resolved === THREE_PATH) out.push(THREE_PATH);
    }
  }
  return out;
}

const order = [];
const state = new Map(); // 0 = visiting, 1 = done
function visit(rel) {
  const s = state.get(rel);
  if (s === 1) return;
  if (s === 0) {
    // a cycle: emit the module now and let the Blob URL resolve on the next pass
    return;
  }
  state.set(rel, 0);
  for (const d of depsOf(rel)) if (d !== THREE_PATH) visit(d);
  state.set(rel, 1);
  order.push(rel);
}
for (const rel of [...modules.keys()].sort()) visit(rel);

/* ---------------- emit ---------------- */

/** A `</script>` inside the payload would close the host block early. */
const inert = (src) => src.replace(/<\/script/gi, '<\\/script');

const payload = { three: threeSource, modules: {} };
for (const rel of order) payload.modules[rel] = modules.get(rel);

const boot = fs.readFileSync(path.join(ROOT, 'scripts', 'standalone-boot.js'), 'utf8');
const css = fs.readFileSync(path.join(DIST, 'src', 'ui', 'style.css'), 'utf8');

const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no" />
<meta name="color-scheme" content="dark" />
<title>CubeWorld</title>
<style>
${css}
</style>
</head>
<body>
<div id="app"></div>

<script type="text/plain" id="cw-three">${inert(threeSource)}</script>
<script type="text/plain" id="cw-modules">${inert(JSON.stringify(payload.modules))}</script>

<script>
${boot}
</script>
</body>
</html>
`;

fs.writeFileSync(OUT, html);
const kb = (fs.statSync(OUT).size / 1024).toFixed(0);
console.log(`standalone: dist/cubeworld.html (${kb} KB, ${order.length} modules + three.js)`);
console.log('  open it by double-clicking - no server required');
