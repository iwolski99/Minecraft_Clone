// Spawn robustness sweep.
//
// The reported symptom (black terrain, camera below the surface, uniform dark
// fog) means the player is being placed inside the terrain. This runs the real
// findSpawn + placeOnGround sequence across many random seeds and reports how
// often the resulting position is buried, in the dark, or inside a liquid.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { Player } = await load('player/player.js');
  const { SEA_LEVEL } = await load('world/chunk.js');
  const { biomeById } = await load('worldgen/biomes.js');
  const { getBlock } = await load('world/blocks.js');

  const seeds = [];
  const n = Number(process.env.SEEDS || 40);
  for (let i = 0; i < n; i++) seeds.push((Math.imul(i + 1, 2654435761) ^ 0x9e3779b9) >>> 0);

  let buried = 0;
  let dark = 0;
  let wet = 0;
  let ok = 0;
  const report = [];

  for (const seed of seeds) {
    const gen = new TerrainGenerator(seed);
    const world = new World(seed, gen);

    // the same spiral Game.findSpawn uses
    let best = [8, 8];
    let bestScore = -Infinity;
    for (let r = 0; r < 900; r += 6) {
      const a = r * 2.399963;
      const x = Math.round(Math.cos(a) * r);
      const z = Math.round(Math.sin(a) * r);
      const ci = gen.columnInfo(x, z);
      if (ci.height <= SEA_LEVEL + 1) continue;
      const b = biomeById(ci.biome);
      if (!b.villageWeight && b.name === 'ocean') continue;
      let score = ci.height - SEA_LEVEL;
      if (b.name === 'plains' || b.name === 'forest' || b.name === 'birch_forest') score += 20;
      if (b.name === 'mountains' || b.name === 'snowy_mountains') score -= 18;
      if (ci.river > 0.4) score -= 14;
      if (score > bestScore) {
        bestScore = score;
        best = [x, z];
      }
      if (bestScore > 34) break;
    }
    const [sx, sz] = best;

    // generate the chunks the preload would generate around the spawn
    const pcx = sx >> 4;
    const pcz = sz >> 4;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const c = world.createChunk(pcx + dx, pcz + dz);
        gen.generateChunk(c);
      }
    }
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        const c = world.getChunk(pcx + dx, pcz + dz);
        if (c) world.light.initialLight(c);
      }
    }

    const player = new Player();
    player.placeOnGround(world, sx + 0.5, sz + 0.5);

    const px = Math.floor(player.position.x);
    const pz = Math.floor(player.position.z);
    const feet = Math.floor(player.position.y + 0.1);
    const eye = Math.floor(player.eyeY);
    const head = Math.floor(player.position.y + player.height - 0.05);

    const feetDef = getBlock(world.getBlockAt(px, feet, pz));
    const eyeDef = getBlock(world.getBlockAt(px, eye, pz));
    const headDef = getBlock(world.getBlockAt(px, head, pz));
    const sky = world.getSkyLightAt(px, eye, pz);

    const isBuried = feetDef.solid || eyeDef.solid || headDef.solid;
    const isDark = sky < 9;
    const isWet = feetDef.liquid || eyeDef.liquid;

    if (isBuried) buried++;
    if (isDark) dark++;
    if (isWet) wet++;
    if (isBuried || isWet) {
      if (report.length < 14) {
        report.push(
          `seed ${seed} at ${px},${pz}: y=${player.position.y.toFixed(2)} surface=${world.heightAt(px, pz)} ` +
            `feet=${feetDef.name} eye=${eyeDef.name} head=${headDef.name} sky=${sky}`,
        );
      }
    } else if (isDark) {
      if (report.length < 14) {
        report.push(`seed ${seed} at ${px},${pz}: standable but DARK (sky=${sky}, y=${player.position.y.toFixed(1)}, surface=${world.heightAt(px, pz)})`);
      }
    } else {
      ok++;
    }
  }

  console.log(`spawn: ${ok}/${seeds.length} clean, ${buried} buried, ${wet} in liquid, ${dark} dark`);
  for (const r of report) console.log(`  . ${r}`);
  if (buried > 0 || wet > 0) {
    console.error(`spawn: FAIL - ${buried} buried, ${wet} in liquid`);
    process.exit(1);
  }
  if (dark > seeds.length * 0.1) {
    console.error(`spawn: FAIL - ${dark} of ${seeds.length} spawns land in the dark`);
    process.exit(1);
  }
}
