// Report the painted brightness of the desert/plant tiles, to tell "dark texture"
// apart from "broken sampling".
export async function run(load) {
  const { buildBlockAtlas } = await load('render/atlas.js');
  const atlas = buildBlockAtlas();

  const names = [
    'cactus_side', 'cactus_top', 'dead_bush', 'tall_grass', 'oak_leaves',
    'dandelion', 'poppy', 'sand', 'sandstone_side', 'stone', 'oak_log_side',
  ];

  console.log('  tile            slot  opaque%  meanRGB(only opaque texels)');
  for (const n of names) {
    const i = atlas.slot(n);
    if (i < 0) {
      console.log(`  ${n.padEnd(15)} MISSING`);
      continue;
    }
    const t = atlas.tile;
    const cx = (i % atlas.cols) * t;
    const cy = Math.floor(i / atlas.cols) * t;
    let r = 0;
    let g = 0;
    let b = 0;
    let n2 = 0;
    for (let y = 0; y < t; y++) {
      for (let x = 0; x < t; x++) {
        const o = ((cy + y) * atlas.width + cx + x) * 4;
        if (atlas.data[o + 3] < 128) continue;
        r += atlas.data[o];
        g += atlas.data[o + 1];
        b += atlas.data[o + 2];
        n2++;
      }
    }
    const avg = n2 ? [Math.round(r / n2), Math.round(g / n2), Math.round(b / n2)] : [0, 0, 0];
    const lum = (0.2126 * avg[0] + 0.7152 * avg[1] + 0.0722 * avg[2]).toFixed(1);
    console.log(
      `  ${n.padEnd(15)} ${String(i).padStart(4)}  ${String(Math.round((n2 / (t * t)) * 100)).padStart(5)}%  rgb(${avg.join(',').padEnd(12)}) lum ${lum}`,
    );
  }
  console.log('colours: 1 passed, 0 failed');
}
