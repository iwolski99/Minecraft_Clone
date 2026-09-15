import { World } from "../.mobbuild/world/world.js";
import { createMob } from "../.mobbuild/entities/mobs.js";
import { B } from "../.mobbuild/world/blocks.js";
const gen = { heightAt: () => 40, biomeAt: () => 3, generateChunk() {}, seed: 1, caves: null, structures: null };
const world = new World(7, gen);
for (let cx = -2; cx <= 2; cx++) for (let cz = -2; cz <= 2; cz++) world.createChunk(cx, cz);
const GROUND = 40;
for (let x = -32; x < 32; x++) for (let z = -32; z < 32; z++) {
  world.setBlockRaw(x, GROUND, z, B.grass_block);
  world.setBlockRaw(x, GROUND - 1, z, B.dirt);
  for (let y = GROUND + 1; y < GROUND + 12; y++) world.setBlockRaw(x, y, z, 0);
}
for (let x = 4; x <= 8; x++) for (let z = -20; z <= 20; z++) for (let y = GROUND; y > GROUND - 20; y--) world.setBlockRaw(x, y, z, 0);
const pig = createMob('pig', -2, GROUND + 1, 0);
for (const [cx, cy, cz] of [[2.5,41,0.5],[1.5,41,0.5],[2.5,42,0.5],[-1.5,41,0.5],[2.5,41,-0.5],[2.5,40,0.5],[2.5,43,0.5]]) {
  console.log(`canStand(${cx},${cy},${cz}) = ${pig.canStandAt(world, cx, cy, cz)} ` +
    `solidBelow=${world.isSolidAt(Math.floor(cx), cy-1, Math.floor(cz))} intersects=${pig.intersects(world, cx, cy, cz)}`);
}
console.log('pig pos', pig.position.x, pig.position.y, pig.position.z);
