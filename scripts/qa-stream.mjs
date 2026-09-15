// End-to-end streaming / spawn reproduction.
//
// Mirrors the exact sequence Game.startWorld performs (create world -> centre the
// streamer -> preload -> place the player) and asserts the things that a blank
// screen would violate: chunk meshes exist with real geometry, the player ends up
// above the surface with headroom, and the "is the camera underground" test used
// to darken the fog behaves sanely.

export async function run(load) {
  const THREE = await import('three');
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { buildBlockAtlas } = await load('render/atlas.js');
  const { VoxelMesher } = await load('render/mesher.js');
  const { ChunkManager } = await load('world/chunkmanager.js');
  const { Player } = await load('player/player.js');
  const { SEA_LEVEL, CHUNK_Y } = await load('world/chunk.js');
  const { biomeById } = await load('worldgen/biomes.js');
  const { getBlock } = await load('world/blocks.js');

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const info = (msg) => console.log(`  . ${msg}`);

  /* ---------------- replicate Game.findSpawn ---------------- */
  const seed = Number(process.env.SEED || 1337);
  const gen = new TerrainGenerator(seed);
  const world = new World(seed, gen);

  const findSpawn = () => {
    let best = [8, 8];
    let bestScore = -Infinity;
    for (let r = 0; r < 900; r += 6) {
      const a = r * 2.399963;
      const x = Math.round(Math.cos(a) * r);
      const z = Math.round(Math.sin(a) * r);
      const ci = gen.columnInfo(x, z);
      if (ci.height <= SEA_LEVEL + 1) continue;
      const biome = biomeById(ci.biome);
      if (!biome.villageWeight && biome.name === 'ocean') continue;
      let score = ci.height - SEA_LEVEL;
      if (biome.name === 'plains' || biome.name === 'forest' || biome.name === 'birch_forest') score += 20;
      if (biome.name === 'mountains' || biome.name === 'snowy_mountains') score -= 18;
      if (ci.river > 0.4) score -= 14;
      if (score > bestScore) {
        bestScore = score;
        best = [x, z];
      }
      if (bestScore > 34) break;
    }
    return best;
  };
  const [spawnX, spawnZ] = findSpawn();
  info(`spawn column ${spawnX},${spawnZ} surface ${gen.columnInfo(spawnX, spawnZ).height} biome ${biomeById(gen.columnInfo(spawnX, spawnZ).biome).name}`);

  /* ---------------- replicate the preload ---------------- */
  const atlas = buildBlockAtlas();
  const mesher = new VoxelMesher(atlas);
  const mat = new THREE.MeshBasicMaterial();
  const cm = new ChunkManager(world, mesher, mat, mat);
  cm.renderDistance = 8;
  cm.setCentre(spawnX, spawnZ);

  const state = { radius: 8, pass: 0, index: 0 };
  let guard = 0;
  while (guard++ < 100000) {
    const p = cm.preloadStep(state, 4000);
    if (p >= 1) break;
  }
  info(`preloaded: loaded=${cm.stats.loaded} meshed=${cm.stats.meshed} faces=${cm.stats.faces}`);
  check('chunks were generated', cm.stats.loaded > 100, String(cm.stats.loaded));
  check('chunk meshes were created', cm.stats.meshed > 50, String(cm.stats.meshed));
  check('mesh faces exist', cm.stats.faces > 10000, String(cm.stats.faces));

  // every mesh in the group must have real geometry
  let emptyGeoms = 0;
  let totalVerts = 0;
  let sampleMesh = null;
  for (const child of cm.group.children) {
    if (!child.isMesh) continue;
    const pos = child.geometry.getAttribute('position');
    const idx = child.geometry.getIndex();
    if (!pos || !idx || idx.count === 0) emptyGeoms++;
    else {
      totalVerts += pos.count;
      if (!sampleMesh) sampleMesh = child;
    }
  }
  check('no empty chunk geometries', emptyGeoms === 0, `${emptyGeoms} empty`);
  check('mesh vertices present', totalVerts > 10000, String(totalVerts));

  if (sampleMesh) {
    const pos = sampleMesh.geometry.getAttribute('position');
    let minY = Infinity;
    let maxY = -Infinity;
    let bad = 0;
    for (let i = 0; i < pos.count; i++) {
      const y = pos.getY(i);
      if (!Number.isFinite(y)) bad++;
      if (y < minY) minY = y;
      if (y > maxY) maxY = y;
    }
    check('mesh positions are finite', bad === 0, `${bad} bad`);
    check('mesh Y range is sane', minY >= -1 && maxY <= CHUNK_Y + 1, `${minY}..${maxY}`);
    info(`sample mesh at ${sampleMesh.position.x},${sampleMesh.position.z}, y ${minY}..${maxY}, verts ${pos.count}`);
  }

  /* ---------------- replicate Player.placeOnGround ---------------- */
  const player = new Player();
  player.gameMode = 'creative';
  player.placeOnGround(world, spawnX + 0.5, spawnZ + 0.5);
  info(`player placed at ${player.position.x.toFixed(2)} ${player.position.y.toFixed(2)} ${player.position.z.toFixed(2)}`);

  const px = Math.floor(player.position.x);
  const pz = Math.floor(player.position.z);
  const feetY = Math.floor(player.position.y);
  const headY = Math.floor(player.position.y + player.height - 0.05);
  const eyeY = Math.floor(player.eyeY);

  const blockAt = (y) => world.getBlockAt(px, y, pz);
  info(`feet block=${getBlock(blockAt(feetY)).name} eye block=${getBlock(blockAt(eyeY)).name} head block=${getBlock(blockAt(headY)).name}`);
  check('feet are not inside a solid block', !getBlock(blockAt(feetY)).solid, getBlock(blockAt(feetY)).name);
  check('eye is not inside a solid block', !getBlock(blockAt(eyeY)).solid, getBlock(blockAt(eyeY)).name);
  check('head has clearance', !getBlock(blockAt(headY)).solid, getBlock(blockAt(headY)).name);
  check('feet have ground below', getBlock(blockAt(feetY - 1)).solid, getBlock(blockAt(feetY - 1)).name);
  check('player is above sea level', player.position.y > SEA_LEVEL, String(player.position.y));

  /* ------------- the fog-darkening heuristic used by Game ------------- */
  const heightAtSpawn = world.heightAt(px, pz);
  const underground = heightAtSpawn > 0 && player.eyeY < heightAtSpawn;
  info(`heightMap=${heightAtSpawn} eyeY=${player.eyeY.toFixed(2)} -> underground=${underground}`);
  check('spawn is not classified as underground', !underground, `heightMap ${heightAtSpawn} vs eye ${player.eyeY.toFixed(2)}`);

  /* ---------------- the streamer keeps up while walking ---------------- */
  const spawnChunk = world.getChunk(spawnX >> 4, spawnZ >> 4);
  // The streamer spends a wall-clock budget per step, so how many chunks it
  // finishes depends on how fast the machine is: this used to assert a fixed
  // count and failed intermittently (9, 20, 51, 65 chunks across identical
  // runs). Assert the invariants instead - it makes progress, it does not fall
  // behind without bound, and it keeps the chunks immediately around the player.
  for (let step = 0; step < 40; step++) {
    cm.update(spawnX + step * 8, spawnZ + Math.round(step * 4), 6);
  }
  info(`after walking: loaded=${cm.stats.loaded} meshed=${cm.stats.meshed} pending=${cm.stats.pending}`);
  // `stats.meshed` is a snapshot of how many chunks currently have meshes, not a
  // running total, so it legitimately falls as chunks behind the player unload.
  check('the streamer still has meshed chunks after walking', cm.meshedCount > 0, String(cm.meshedCount));
  check('streamer does not fall arbitrarily far behind', cm.stats.pending < 400, String(cm.stats.pending));
  // the chunk the player ends up standing in must exist and be meshed
  const endX = spawnX + 39 * 8;
  const endZ = spawnZ + Math.round(39 * 4);
  const endChunk = world.getChunk(endX >> 4, endZ >> 4);
  check('the chunk under the player after walking is loaded', !!endChunk, `${endX >> 4},${endZ >> 4}`);
  check('streamer unloaded chunks behind the player', world.loadedCount < 400, String(world.loadedCount));
  void spawnChunk;

  /* ---------------- the mesher must also mesh a chunk on demand ---------------- */
  const c = spawnChunk ?? world.getChunk((spawnX + 320) >> 4, (spawnZ + 160) >> 4);
  if (c) {
    const res = mesher.build(world, c);
    check('direct mesh build returns opaque geometry', !!res.opaque && res.opaque.indices.length > 0);
    if (res.opaque) {
      let maxIndex = 0;
      for (let i = 0; i < res.opaque.indices.length; i++) maxIndex = Math.max(maxIndex, res.opaque.indices[i]);
      check('indices stay in range', maxIndex < res.opaque.positions.length / 3, `${maxIndex} vs ${res.opaque.positions.length / 3}`);
      let badColor = 0;
      for (let i = 0; i < res.opaque.colors.length; i += 4) {
        if (res.opaque.colors[i + 3] !== 255) badColor++;
      }
      check('vertex alpha is opaque', badColor === 0, `${badColor} bad`);
      let badLight = 0;
      for (let i = 0; i < res.opaque.light.length; i++) {
        const v = res.opaque.light[i];
        if (!Number.isFinite(v) || v < 0 || v > 255) badLight++;
      }
      check('aLight stays in 0..255', badLight === 0, `${badLight} out of range`);
    }
  } else {
    check('spawn chunk exists', false);
  }

  console.log(`stream: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
