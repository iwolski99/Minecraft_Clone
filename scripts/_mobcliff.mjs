// Focused cliff-avoidance trace.
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
pig.age = 0;
for (let i = 0; i < 260; i++) {
  pig.pathTo(1 / 20, world, 14, GROUND + 1, 0, 1.4);
  pig.moveWithCollision(1 / 20, world);
  if (i % 5 === 0 && i < 130) {
    const vx = pig.velocity.x, vz = pig.velocity.z;
    const h = Math.hypot(vx, vz) || 1;
    console.log(`i=${i} x=${pig.position.x.toFixed(2)} z=${pig.position.z.toFixed(2)} y=${pig.position.y.toFixed(3)} ` +
      `v=(${vx.toFixed(2)},${vz.toFixed(2)}) pathIdx=${pig.pathIndex}/${pig.path.length} onGround=${pig.onGround} ` +
      `edgeAhead(+x)=${pig.edgeAhead(world, 1, 0, Math.round(pig.position.y - 0.02))} ` +
      `edgeAhead(dir)=${pig.edgeAhead(world, vx / h, vz / h, Math.round(pig.position.y - 0.02))} ` +
      `target=(${pig.pathTargetX.toFixed(1)},${pig.pathTargetZ.toFixed(1)})`);
  }
}
