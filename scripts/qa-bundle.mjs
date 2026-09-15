// Verifies the built output is self-consistent: every relative import in every
// emitted module resolves to a file that actually exists, and index.html only
// references paths that are present. This is the check a browser would perform
// by 404-ing, done here without a browser.
import fs from 'node:fs';
import path from 'node:path';

const dir = process.argv[2] || 'dist';
const root = path.resolve(dir);
if (!fs.existsSync(root)) {
  console.error(`${dir}/ not found - build first`);
  process.exit(1);
}

let checked = 0;
let missing = 0;
const files = [];
const walk = (d) => {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else files.push(p);
  }
};
walk(root);

for (const f of files) {
  if (!f.endsWith('.js')) continue;
  const src = fs.readFileSync(f, 'utf8');
  const re = /(?:from|import)\s*\(?\s*['"](\.[^'"]+)['"]/g;
  let m;
  while ((m = re.exec(src))) {
    const spec = m[1];
    const target = path.resolve(path.dirname(f), spec);
    checked++;
    if (!fs.existsSync(target)) {
      missing++;
      console.error(`  MISSING ${path.relative(root, f)} -> ${spec}`);
    }
  }
}

// index.html references
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const refs = [...html.matchAll(/(?:src|href)="(\/[^"]+)"/g)].map((x) => x[1]);
for (const r of refs) {
  const p = path.join(root, r.replace(/^\//, ''));
  checked++;
  if (!fs.existsSync(p)) {
    missing++;
    console.error(`  MISSING index.html -> ${r}`);
  }
}

// the import map must point at a real file
const mapMatch = html.match(/<script type="importmap">([\s\S]*?)<\/script>/);
if (mapMatch) {
  const map = JSON.parse(mapMatch[1]);
  for (const [k, v] of Object.entries(map.imports || {})) {
    const p = path.join(root, String(v).replace(/^\//, ''));
    checked++;
    if (v.endsWith('/')) continue;
    if (!fs.existsSync(p)) {
      missing++;
      console.error(`  MISSING importmap "${k}" -> ${v}`);
    }
  }
} else {
  missing++;
  console.error('  MISSING import map in index.html');
}

console.log(`bundle: ${files.length} files, ${checked} references checked, ${missing} missing`);
if (missing) process.exit(1);
