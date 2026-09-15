// Trace A* + zombie chase frame by frame.
import * as THREE from 'three';
const { World } = await import('../.mobbuild/world/world.js');
const { MobManager } = await import('../.mobbuild/entities/mobmanager.js');
const { createMob } = await import('../.mobbuild/entities/mobs.js');
const { B } = await import('../.mobbuild/world/blocks.js');

const gen = { heightAt: () => 40, biomeAt: () => 3, generateChunk() {}, seed: 1, caves: null, structures: null };
const world = new World(7, gen);
for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) world.createChunk(cx, cz);
const GROUND = 40;
for (let x = -32; x < 32; x++) for (let z = -32; z < 32; z++) {
  world.setBlockRaw(x, GROUND, z, B.grass_block);
  world.setBlockRaw(x, GROUND - 1, z, B.dirt);
  for (let y = GROUND + 1; y < GROUND + 12; y++) world.setBlockRaw(x, y, z, 0);
}

const pig = createMob('pig', -6, GROUND + 1, 0.5);
for (let i = 0; i < 24; i++) {
  pig.pathTo(1 / 20, world, 12, GROUND + 1, 0.5, 1.4);
  const before = pig.position.x;
  pig.moveWithCollision(1 / 20, world);
  console.log(`pig i=${i} x=${pig.position.x.toFixed(3)} (d=${(pig.position.x - before).toFixed(4)}) z=${pig.position.z.toFixed(2)} ` +
    `pathLen=${pig.path.length} idx=${pig.pathIndex} targetSet=(${pig.pathTargetX.toFixed(1)},${pig.pathTargetZ.toFixed(1)})`);
}

const zombie = createMob('zombie', -10, GROUND + 1, -10);
const player = {
  position: new THREE.Vector3(-6, GROUND + 1, -10),
  velocity: new THREE.Vector3(), yaw: 0, pitch: 0, width: 0.6, height: 1.8, eyeHeight: 1.62,
  health: 20, maxHealth: 20, dead: false, gameMode: 'survival',
  get eyeY() { return this.position.y + this.eyeHeight; },
  damage() { this.hits = (this.hits || 0) + 1; },
};
let sounds = 0;
const host = { world, player, playSound() { sounds++; }, spawnParticles() {}, dayFactor: 0.5, isNight: false, difficulty: 2, timeOfDay: 6000 };
const mgr = new MobManager(host);
mgr.spawnEntity(zombie);
for (let i = 0; i < 60; i++) {
  mgr.update(1 / 20, player.position.x, player.position.y, player.position.z);
  const d = Math.hypot(zombie.position.x - player.position.x, zombie.position.z - player.position.z);
  if (i % 5 === 0) {
    console.log(`zombie i=${i} pos=(${zombie.position.x.toFixed(2)},${zombie.position.y.toFixed(2)},${zombie.position.z.toFixed(2)}) ` +
      `v=(${zombie.velocity.x.toFixed(2)},${zombie.velocity.z.toFixed(2)}) dist=${d.toFixed(2)} hits=${player.hits || 0} ` +
      `pathLen=${zombie.path.length} idx=${zombie.pathIndex} cooldown=${zombie.attackCooldown.toFixed(2)}`);
  }
}
console.log('total hits', player.hits || 0, 'sounds', sounds);
