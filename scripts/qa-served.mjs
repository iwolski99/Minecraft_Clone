// Final verification that a running dev server delivers the fixed build.
const base = process.env.BASE || 'http://127.0.0.1:5199';

const endpoints = [
  '/',
  '/src/main.js',
  '/src/render/renderer.js',
  '/src/render/probe.js',
  '/src/render/sky.js',
  '/src/debug.js',
  '/src/player/player.js',
  '/vendor/three/three.module.js',
  '/diagnostic.html',
  '/src/diag.js',
];

const expectations = [
  ['/src/render/renderer.js', 'passive frame sampler (no auto-downgrade)', 'frame shows'],
  ['/src/render/renderer.js', 'old auto-downgrade is gone', 'runSelfTest', true],
  ['/src/render/renderer.js', 'tier override kept', 'setForcedTier'],
  ['/src/render/renderer.js', 'default-framebuffer readback', 'sampleDefaultFramebuffer'],
  ['/src/render/renderer.js', 'tier1 minimal textured shader', 'terrain-fallback-opaque'],
  ['/src/render/renderer.js', 'tier2 flat fallback', 'terrain-flat-opaque'],
  ['/src/render/renderer.js', 'scene sanitizer', 'assertSceneGraph'],
  ['/src/render/renderer.js', 'no colour clear after world', 'autoClear = false'],
  ['/src/render/probe.js', 'material probe', 'MaterialProbe'],
  ['/src/main.js', '?safe=1', "get('safe')"],
  ['/src/main.js', '?probe=1', "get('probe')"],
  ['/src/game.js', 'held item populated on spawn', 'updateHeld()'],
  ['/src/world/chunkmanager.js', 'streamer guard', 'enabled = true'],
  ['/src/player/player.js', 'movement maths fixed', 'fx * cos + fz * sin'],
  ['/src/render/mesher.js', 'aLight is Float32', 'Float32Array(vertexCapacity * 2)'],
  ['/src/render/materials.js', 'colour management disabled', 'ColorManagement.enabled = false'],
];

let bad = 0;
for (const p of endpoints) {
  try {
    const r = await fetch(base + p);
    console.log(`  ${p.padEnd(34)} ${r.ok ? r.status : r.status + ' FAILED'}`);
    if (!r.ok) bad++;
  } catch (e) {
    console.log(`  ${p.padEnd(34)} FAILED ${e.message}`);
    bad++;
  }
}

const cache = new Map();
for (const [file, label, needle, negate] of expectations) {
  if (!cache.has(file)) cache.set(file, await (await fetch(base + file)).text());
  const found = cache.get(file).includes(needle);
  const okText = negate ? !found : found;
  console.log(`  ${okText ? 'ok  ' : 'FAIL'} ${label}`);
  if (!okText) bad++;
}

console.log(bad === 0 ? '\nserved build: all fixes present' : `\nserved build: ${bad} problem(s)`);
process.exit(bad === 0 ? 0 : 1);
