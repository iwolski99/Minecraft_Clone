// Locate the probe swatch row precisely by finding the magenta/cyan checker,
// then report what each of the seven swatches actually rendered.
import { decodePng, sampleRegion, hexOf } from './pngread.mjs';

const file = process.argv[2];
const img = decodePng(file);
console.log(`image ${img.width}x${img.height}`);

const at = (x, y) => {
  const o = (y * img.width + x) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2]];
};

// The checker is saturated magenta (255,0,255) and cyan-ish (0,255,255).
let magX = [];
let magY = [];
for (let y = 0; y < img.height; y++) {
  for (let x = 0; x < img.width; x++) {
    const [r, g, b] = at(x, y);
    if (r > 200 && g < 90 && b > 200) {
      magX.push(x);
      magY.push(y);
    }
  }
}
if (!magX.length) {
  console.log('no magenta checker found - swatches 3 and 5 did not render their texture');
} else {
  magY.sort((a, b) => a - b);
  const yLo = magY[0];
  const yHi = magY[magY.length - 1];
  console.log(`magenta checker rows: y ${yLo}..${yHi} (${magX.length} px)`);
  // cluster the x hits into runs
  magX.sort((a, b) => a - b);
  const runs = [];
  let start = magX[0];
  let prev = magX[0];
  for (const x of magX) {
    if (x - prev > 12) {
      runs.push([start, prev]);
      start = x;
    }
    prev = x;
  }
  runs.push([start, prev]);
  console.log('checker x-runs:', runs.map(([a, b]) => `${a}-${b}`).join('  '));
}

// Use the checker row (or a sensible default) as the swatch row.
const rowY = magX.length ? Math.round((Math.min(...magY) + Math.max(...magY)) / 2) : Math.round(img.height * 0.2);
console.log(`\nassuming swatch row y=${rowY}\n`);

const NAMES = [
  '1 solid colour          (no texture)',
  '2 basic  + block atlas',
  '3 basic  + checker',
  '4 shader + block atlas',
  '5 shader + checker',
  '6 shader + cloud texture',
  '7 basic  + item atlas',
];
const fractions = [0, 1, 2, 3, 4, 5, 6].map((i) => (-0.72 + i * 0.24 + 1) / 2);

let textured = 0;
let black = 0;
for (let i = 0; i < 7; i++) {
  const cx = Math.round(fractions[i] * img.width);
  const set = new Set();
  let r = 0;
  let g = 0;
  let b = 0;
  let n = 0;
  for (let y = rowY - 8; y <= rowY + 8; y++) {
    for (let x = cx - 16; x <= cx + 16; x++) {
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const [pr, pg, pb] = at(x, y);
      set.add(((pr >> 4) << 8) | ((pg >> 4) << 4) | (pb >> 4));
      r += pr;
      g += pg;
      b += pb;
      n++;
    }
  }
  const avg = [Math.round(r / n), Math.round(g / n), Math.round(b / n)];
  const lum = 0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2];
  let verdict;
  if (lum < 10) {
    verdict = 'BLACK / EMPTY   <-- broken';
    black++;
  } else if (set.size <= 3) {
    verdict = 'flat colour (no texture sampled)';
  } else {
    verdict = 'DRAWS TEXTURE';
    textured++;
  }
  console.log(`  ${NAMES[i].padEnd(34)} rgb(${avg.join(',').padEnd(12)}) ${hexOf(avg)}  ${String(set.size).padStart(3)} colours  ${verdict}`);
}
console.log(`\n  ${textured}/7 draw texture detail, ${black}/7 are black or empty`);
