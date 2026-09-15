// Production build: type-check + emit ES modules into dist/, copy the shell and
// the three.js runtime, and write an import map so the browser resolves `three`.
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, compileOnce, copyStatic } from './compile.mjs';

const outDir = path.join(ROOT, 'dist');
fs.rmSync(outDir, { recursive: true, force: true });

console.log('CubeWorld - production build');
const t0 = Date.now();
const { ok, emitted } = compileOnce(outDir);
if (!ok) {
  console.error('\nBuild failed: type errors above.');
  process.exit(1);
}
copyStatic(outDir);
console.log(`  compiled ${emitted.length} modules -> dist/  (${Date.now() - t0} ms)`);

// Bundle-size sanity report.
let total = 0;
const walk = (dir) => {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else total += fs.statSync(p).size;
  }
};
walk(outDir);
console.log(`  dist size: ${(total / 1024).toFixed(0)} KB`);
console.log('Build OK. Serve dist/ with any static file server.');
