// Analyse a screenshot of the running game: report the exact colours of the
// viewport so a blank render can be identified from its pixel values.
import { decodePng, sampleRegion, hexOf } from './pngread.mjs';

const file = process.argv[2];
if (!file) {
  console.error('usage: node scripts/qa-shot.mjs <screenshot.png>');
  process.exit(1);
}
const img = decodePng(file);
console.log(`image ${img.width}x${img.height}`);

const pts = [
  ['viewport top-left', Math.round(img.width * 0.06), Math.round(img.height * 0.15)],
  ['viewport upper-mid', Math.round(img.width * 0.5), Math.round(img.height * 0.2)],
  ['viewport left-mid', Math.round(img.width * 0.08), Math.round(img.height * 0.5)],
  ['viewport centre', Math.round(img.width * 0.5), Math.round(img.height * 0.5)],
  ['viewport right-mid', Math.round(img.width * 0.92), Math.round(img.height * 0.5)],
  ['viewport lower-mid', Math.round(img.width * 0.5), Math.round(img.height * 0.72)],
  ['bottom-left', Math.round(img.width * 0.05), Math.round(img.height * 0.85)],
];
for (const [name, x, y] of pts) {
  const c = sampleRegion(img, x, y, 6, 6);
  console.log(`  ${name.padEnd(20)} (${x},${y}) rgb(${c.join(',')}) ${hexOf(c)}`);
}

// distinct-colour census over the viewport (excluding the chrome at the top and
// the hotbar at the bottom)
const counts = new Map();
const y0 = Math.round(img.height * 0.12);
const y1 = Math.round(img.height * 0.8);
for (let y = y0; y < y1; y += 3) {
  for (let x = 0; x < img.width; x += 3) {
    const o = (y * img.width + x) * 4;
    const key = (img.data[o] >> 3) * 1024 + (img.data[o + 1] >> 3) * 32 + (img.data[o + 2] >> 3);
    counts.set(key, (counts.get(key) || 0) + 1);
  }
}
const total = [...counts.values()].reduce((a, b) => a + b, 0);
const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8);
console.log('dominant colours in the viewport:');
for (const [key, n] of top) {
  const r = Math.floor(key / 1024) * 8;
  const g = (Math.floor(key / 32) % 32) * 8;
  const b = (key % 32) * 8;
  console.log(`  rgb(${r},${g},${b})  ${((n / total) * 100).toFixed(1)}%`);
}
console.log(`  distinct colour buckets: ${counts.size}`);
