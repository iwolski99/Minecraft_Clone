// Scratch: flat-world behaviour checks (cliff avoidance, walking, collision).
// Deleted before finishing.
import * as THREE from 'three';
const { World } = await import('../.mobbuild/world/world.js');
const { terrainStub } = await import('../.mobbuild/world/world.js').catch(() => ({ terrainStub: null }));
const { MobManager } = await import('../.mobbuild/entities/mobmanager.js');
const { createMob } = await import('../.mobbuild/entities/mobs.js');
const { B } = await import('../.mobbuild/world/blocks.js');

/** Minimal TerrainGenerator stand-in: unused because we set blocks directly. */
const gen = { heightAt: () => 40, biomeAt: () => 3, generateChunk() {}, seed: 1, caves: null, structures: null };

const world = new World(7, gen);
for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) world.createChunk(cx, cz);

const GROUND = 40;
// solid platform everywhere, then carve two pits
for (let x = -32; x < 32; x++) {
  for (let z = -32; z < 32; z++) {
    world.setBlockRaw(x, GROUND, z, B.grass_block);
    world.setBlockRaw(x, GROUND - 1, z, B.dirt);
    for (let y = GROUND + 1; y < GROUND + 12; y++) world.setBlockRaw(x, y, z, 0);
  }
}
// a 5-wide, 20-deep pit centred at x=4..8, z=-20..20
for (let x = 4; x <= 8; x++) {
  for (let z = -20; z <= 20; z++) {
    for (let y = GROUND; y > GROUND - 20; y--) world.setBlockRaw(x, y, z, 0);
  }
}
// a 1-block step wall at z = -8 for x in -20..-14
for (let x = -20; x <= -14; x++) world.setBlockRaw(x, GROUND + 1, -8, B.stone);
// a 2-block wall at z = 6 for x in 14..20
for (let x = 14; x <= 20; x++) {
  world.setBlockRaw(x, GROUND + 1, 6, B.stone);
  world.setBlockRaw(x, GROUND + 2, 6, B.stone);
}

const player = {
  position: new THREE.Vector3(-24.5, GROUND + 1, -24.5),
  velocity: new THREE.Vector3(), yaw: 0, pitch: 0, width: 0.6, height: 1.8, eyeHeight: 1.62,
  health: 20, maxHealth: 20, dead: false, gameMode: 'survival',
  get eyeY() { return this.position.y + this.eyeHeight; },
  damage() {},
};
const host = { world, player, playSound() {}, spawnParticles() {}, dayFactor: 0.5, isNight: false, difficulty: 0, timeOfDay: 6000 };
const mgr = new MobManager(host);

/* --- 1. cliff avoidance: aim a pig straight at the pit -------------------- */
{
  // stand the pig up by hand (protected surfaceY is not reachable from here)
  const pig = createMob('pig', -6, GROUND + 1, 0);
  pig.yaw = Math.PI / 2;
  pig.installRng;
  mgr.spawnEntity;
  // push it into the manager and force it to walk east toward the pit at x=4
  const m = mgr;
  m.entities.push(pig);
  pig.object3D = pig.buildObject();
  m.group.add(pig.object3D);

  let frames = 0;
  let minY = pig.position.y;
  let fell = false;
  while (frames++ < 500) {
    // keep steering east, straight at the pit
    pig.targetX = 20;
    pig.targetZ = 0;
    pig.hasTarget = true;
    pig.fleeTimer = 0;
    // simulate: steer + move only (bypasses the wander randomness)
    pig.steerTo(1 / 20, world, 20, 0, 1.2);
    pig.moveWithCollision(1 / 20, world);
    minY = Math.min(minY, pig.position.y);
    if (pig.position.y < GROUND - 1.5) { fell = true; break; }
  }
  console.log(`cliff: pig x=${pig.position.x.toFixed(2)} y=${pig.position.y.toFixed(2)} minY=${minY.toFixed(2)} fell=${fell} (expected: stops at x<4, fell=false)`);
}

/* --- 2. a pig with no pit in the way should actually walk ------------------ */
{
  const pig = createMob('pig', -28, GROUND + 1, -28);
  mgr.entities.push(pig);
  pig.object3D = pig.buildObject();
  mgr.group.add(pig.object3D);
  const start = pig.position.clone();
  for (let f = 0; f < 200; f++) {
    pig.steerTo(1 / 20, world, -18, -28, 1.2);
    pig.moveWithCollision(1 / 20, world);
  }
  console.log(`walk: moved ${pig.position.x - start.x >= 0 ? '+' : ''}${(pig.position.x - start.x).toFixed(2)} blocks on x, ` +
    `y=${pig.position.y.toFixed(2)} (expected: > 5 and y ~ ${GROUND + 1})`);
}

/* --- 3. step up a 1-block ledge, blocked by a 2-block wall ---------------- */
{
  const a = createMob('pig', -17, GROUND + 1, -11);
  mgr.entities.push(a);
  a.object3D = a.buildObject();
  mgr.group.add(a.object3D);
  for (let f = 0; f < 200; f++) {
    a.steerTo(1 / 20, world, -17, -4, 1.2);
    a.moveWithCollision(1 / 20, world);
  }
  console.log(`step: pig y=${a.position.y.toFixed(2)} z=${a.position.z.toFixed(2)} (expected: y=${GROUND + 2}, past z=-8)`);

  const b = createMob('pig', 17, GROUND + 1, 9);
  mgr.entities.push(b);
  b.object3D = b.buildObject();
  mgr.group.add(b.object3D);
  for (let f = 0; f < 200; f++) {
    b.steerTo(1 / 20, world, 17, 2, 1.2);
    b.moveWithCollision(1 / 20, world);
  }
  console.log(`wall: pig y=${b.position.y.toFixed(2)} z=${b.position.z.toFixed(2)} (expected: y=${GROUND + 1}, stuck before z=6)`);
}

/* --- 4. local A* actually routes around the pit --------------------------- */
{
  const pig = createMob('pig', -2, GROUND + 1, 0);
  mgr.entities.push(pig);
  pig.object3D = pig.buildObject();
  mgr.group.add(pig.object3D);
  let minY = pig.position.y;
  let frames = 0;
  for (let f = 0; f < 3; f++) {
    pig.pathTo(1 / 20, world, 14, GROUND + 1, 0, 1.4);
    console.log(`  probe f${f}: pathLen=${pig.path.length} idx=${pig.pathIndex} head=${JSON.stringify(pig.path[0])} ` +
      `v=(${pig.velocity.x.toFixed(2)},${pig.velocity.z.toFixed(2)}) ` +
      `dbg=${pig.dbg}`);
    pig.moveWithCollision(1 / 20, world);
  }
  while (frames++ < 1500) {
    pig.pathTo(1 / 20, world, 14, GROUND + 1, 0, 1.4);
    pig.moveWithCollision(1 / 20, world);
    minY = Math.min(minY, pig.position.y);
  }
  console.log(`astar: pig x=${pig.position.x.toFixed(2)} z=${pig.position.z.toFixed(2)} minY=${minY.toFixed(2)} ` +
    `(expected: pig walks around the pit, x passes 4, minY stays at ` + String(GROUND+1) + `)`);
}

/* --- 5. attack behaviour ------------------------------------------------- */
{
  const { createMob: cm } = await import('../.mobbuild/entities/mobs.js');
  const zombie = cm('zombie', -10, GROUND + 1, -10);
  mgr.entities.push(zombie);
  zombie.object3D = zombie.buildObject();
  mgr.group.add(zombie.object3D);
  player.position.set(-6, GROUND + 1, -10);
  let hits = 0;
  const origDamage = player.damage.bind(player);
  player.damage = (amount) => { hits++; };
  for (let f = 0; f < 500; f++) mgr.update(1 / 20, player.position.x, player.position.y, player.position.z);
  player.damage = origDamage;
  console.log(`zombie: hits landed in 15 simulated seconds = ${hits} (expected ~10 or fewer), dist now ` +
    `${Math.hypot(zombie.position.x - player.position.x, zombie.position.z - player.position.z).toFixed(2)}`);
}
mgr.dispose();
console.log('FLAT TEST DONE');
