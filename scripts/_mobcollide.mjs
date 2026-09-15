// Minimal collision repro on a flat platform with a pit.
import * as THREE from 'three';
const { World } = await import('../.mobbuild/world/world.js');
const { createMob } = await import('../.mobbuild/entities/mobs.js');
const { B } = await import('../.mobbuild/world/blocks.js');

const gen = { heightAt: () => 40, biomeAt: () => 3, generateChunk() {}, seed: 1, caves: null, structures: null };
const world = new World(7, gen);
for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) world.createChunk(cx, cz);
const GROUND = 40;
for (let x = -32; x < 32; x++) {
  for (let z = -32; z < 32; z++) {
    world.setBlockRaw(x, GROUND, z, B.grass_block);
    world.setBlockRaw(x, GROUND - 1, z, B.dirt);
    for (let y = GROUND + 1; y < GROUND + 12; y++) world.setBlockRaw(x, y, z, 0);
  }
}
for (let x = 4; x <= 8; x++) for (let z = -20; z <= 20; z++) world.setBlockRaw(x, GROUND, z, 0);

const pig = createMob('pig', -2.5, GROUND + 1, 0.5);
console.log('start', pig.position.toArray().map((v) => v.toFixed(2)).join(','), 'intersects=',
  // @ts-ignore - protected at TS level, present at runtime
  pig.intersects(world));
for (let i = 0; i < 12; i++) {
  pig.velocity.set(1.32, 0, 0);
  pig.onGround = true;
  // @ts-ignore
  pig.moveWithCollision(1 / 20, world);
  console.log(`t${i}`, pig.position.toArray().map((v) => v.toFixed(3)).join(','), 'v=', pig.velocity.x.toFixed(2), 'onGround=', pig.onGround);
}
// now check the edge probe used by the cliff logic
// @ts-ignore
console.log('edgeAhead(+x) =', pig.edgeAhead(world, 1, 0, GROUND + 1));
// @ts-ignore
console.log('canStand at own cell =', pig.canStandAt(world, pig.position.x, GROUND + 1, pig.position.z));
