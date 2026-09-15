// Minimal repro: one mob, ten frames, count what the manager attaches.
import * as THREE from 'three';
const { World } = await import('../.mobbuild/world/world.js');
const { TerrainGenerator } = await import('../.mobbuild/worldgen/terrain.js');
const { MobManager } = await import('../.mobbuild/entities/mobmanager.js');
const { createMob } = await import('../.mobbuild/entities/mobs.js');

const seed = 999;
const world = new World(seed, new TerrainGenerator(seed));
for (let cx = -1; cx <= 1; cx++) for (let cz = -1; cz <= 1; cz++) {
  const c = world.createChunk(cx, cz);
  world.generator.generateChunk(c);
}
const player = {
  position: new THREE.Vector3(8.5, world.generator.heightAt(8, 8) + 1, 8.5),
  velocity: new THREE.Vector3(), yaw: 0, pitch: 0, width: 0.6, height: 1.8, eyeHeight: 1.62,
  health: 20, maxHealth: 20, dead: false, gameMode: 'survival',
  get eyeY() { return this.position.y + this.eyeHeight; },
  damage() {},
};
const host = {
  world, player,
  playSound() {}, spawnParticles() {},
  dayFactor: 0.5, isNight: false, difficulty: 2, timeOfDay: 6000,
};
const mgr = new MobManager(host);
const origAdd = mgr.group.add.bind(mgr.group);
let addCalls = 0;
mgr.group.add = (...args) => { addCalls++; return origAdd(...args); };

const e = createMob('pig', player.position.x + 2, player.position.y, player.position.z);
console.log('created, object3D =', e.object3D, 'in array =', mgr.entities.includes(e));
for (let i = 0; i < 10; i++) {
  mgr.update(1 / 20, player.position.x, player.position.y, player.position.z);
  console.log(`frame ${i}: group.add calls=${addCalls} children=${mgr.group.children.length} ` +
    `entities=${mgr.count} e.object3D=${e.object3D ? 'SET' : 'null'} entityInArray=${mgr.entities.includes(e)} ` +
    `ownedByEntity=${mgr.entities.filter((x) => x.object3D).length}`);
}
