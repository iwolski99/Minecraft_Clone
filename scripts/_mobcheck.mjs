// Scratch runtime smoke test for the entity subsystem. Deleted before finishing.
import * as THREE from 'three';

const { World } = await import('../.mobbuild/world/world.js');
const { TerrainGenerator } = await import('../.mobbuild/worldgen/terrain.js');
const { MobManager } = await import('../.mobbuild/entities/mobmanager.js');
const { createMob, SPECS, PASSIVE_TYPES, HOSTILE_TYPES } = await import('../.mobbuild/entities/mobs.js');
const { getBlock, isSolid } = await import('../.mobbuild/world/blocks.js');

const seed = 12345;
const world = new World(seed, new TerrainGenerator(seed));

const px = 8;
const pz = 8;
for (let cx = -3; cx <= 3; cx++) {
  for (let cz = -3; cz <= 3; cz++) {
    const c = world.createChunk(cx, cz);
    world.generator.generateChunk(c);
    c.stage = 'terrain';
  }
}
console.log('chunks loaded:', world.loadedCount);

const player = {
  position: new THREE.Vector3(px + 0.5, world.generator.heightAt(px, pz) + 1, pz + 0.5),
  velocity: new THREE.Vector3(),
  yaw: 0, pitch: 0, width: 0.6, height: 1.8, eyeHeight: 1.62,
  health: 20, maxHealth: 20, dead: false, gameMode: 'survival',
  get eyeY() { return this.position.y + this.eyeHeight; },
  damage(amount, sx, sz, kb) {
    this.health -= amount;
    this.lastHit = { amount, sx, sz, kb };
  },
};

const log = { sounds: 0, particles: 0, lastSound: '', dropped: [] };
const host = {
  world,
  player,
  playSound(name) { log.sounds++; log.lastSound = name; },
  spawnParticles() { log.particles++; },
  dayFactor: 0.5,
  isNight: false,
  difficulty: 2,
  timeOfDay: 6000,
  dropItems(items, x, y, z) { log.dropped.push({ items, x, y, z }); },
};

const mgr = new MobManager(host);

// ---- 1. spawn one of every type on solid ground near the player -------------
const spawned = [];
for (const type of [...PASSIVE_TYPES, ...HOSTILE_TYPES]) {
  // find ground
  let y = -1;
  for (let yy = Math.floor(player.position.y) + 8; yy > 2; yy--) {
    const below = world.getBlockAt(px + 3, yy - 1, pz + 3);
    if (isSolid(below) && !world.isSolidAt(px + 3, yy, pz + 3) && !world.isSolidAt(px + 3, yy + 1, pz + 3)) { y = yy; break; }
  }
  if (y < 0) { console.log('NO GROUND for', type); continue; }
  const e = mgr.spawn(type, px + 3.5, y, pz + 3.5);
  if (!e) { console.log('spawn returned null for', type); continue; }
  spawned.push(e);
}
console.log('spawned:', spawned.map((e) => `${e.typeName}(h=${e.height.toFixed(2)})`).join(' '));

// ---- 2. run frames ---------------------------------------------------------
const dt = 1 / 20;
let minY = Infinity;
let maxY = -Infinity;
const startPos = spawned.map((e) => e.position.clone());
for (let f = 0; f < 200; f++) {
  // keep the player alive & near so hostiles engage
  player.health = 20;
  mgr.update(dt, player.position.x, player.position.y, player.position.z);
  for (const e of spawned) {
    if (e.dead) continue;
    minY = Math.min(minY, e.position.y);
    maxY = Math.max(maxY, e.position.y);
    if (!Number.isFinite(e.position.x) || !Number.isFinite(e.position.y) || !Number.isFinite(e.position.z)) {
      throw new Error(`${e.typeName} produced a non-finite position`);
    }
  }
}
console.log('alive after 200 frames:', mgr.count, 'of', spawned.length);

// ---- 3. terrain standing check --------------------------------------------
let badStand = 0;
let moved = 0;
for (let i = 0; i < spawned.length; i++) {
  const e = spawned[i];
  if (e.dead) continue;
  const fx = Math.floor(e.position.x);
  const fy = Math.floor(e.position.y);
  const fz = Math.floor(e.position.z);
  const below = getBlock(world.getBlockAt(fx, fy - 1, fz));
  if (!below.solid) { badStand++; console.log('floating/inside:', e.typeName, e.position.toArray().map((v) => v.toFixed(2)).join(','), 'below=', below.name); }
  if (world.isSolidAt(fx, fy, fz)) { badStand++; console.log('inside block:', e.typeName, below.name); }
  if (e.position.distanceTo(startPos[i]) > 0.5) moved++;
}
console.log('standing ok:', spawned.length - badStand, '/', spawned.length, ' moved:', moved);

// ---- 4. yaw faces movement -------------------------------------------------
const walker = spawned.find((e) => !e.dead && Math.hypot(e.velocity.x, e.velocity.z) > 0.5);
if (walker) {
  const want = Math.atan2(-walker.velocity.x, -walker.velocity.z);
  let d = want - walker.yaw;
  while (d > Math.PI) d -= Math.PI * 2;
  while (d < -Math.PI) d += Math.PI * 2;
  console.log('yaw error (rad):', Math.abs(d).toFixed(3));
}

// ---- 5. raycast ------------------------------------------------------------
const target = spawned.find((e) => !e.dead && e.kind === 'passive');
if (target) {
  const o = target.position.clone();
  const ox = o.x, oy = o.y + target.height * 0.5, oz = o.z - 6;
  const hit = mgr.raycast(ox, oy, oz, 0, 0, 1, 12);
  console.log('raycast hit:', hit ? `${hit.entity.typeName} @ ${hit.distance.toFixed(2)}` : 'MISS');
  const miss = mgr.raycast(ox, oy + 40, oz, 0, 0, 1, 12);
  console.log('raycast miss (expected null):', miss === null);
  console.log('near():', mgr.near(o.x, o.y, o.z, 8).length);
}

// ---- 6. hurt / kill / drops ------------------------------------------------
const victim = spawned.find((e) => !e.dead && e.kind === 'passive');
if (victim) {
  const hp0 = victim.health;
  victim.hurt(3, victim.position.x + 1, victim.position.z, host, 0.4);
  console.log('hurt:', hp0, '->', victim.health, 'flash', victim.hurtFlash, 'knock vx', victim.velocity.x.toFixed(2));
  const before = log.dropped.length;
  let guard = 0;
  while (!victim.dead && guard++ < 800) victim.hurt(5, victim.position.x + 1, victim.position.z, host, 0);
  mgr.update(dt, player.position.x, player.position.y, player.position.z);
  let g2 = 0;
  while (mgr.entities.includes(victim) && g2++ < 200) mgr.update(dt, player.position.x, player.position.y, player.position.z);
  console.log('killed:', victim.dead, 'drops:', JSON.stringify(log.dropped.slice(before).map((d) => d.items)));
}

// ---- 7. creeper explosion --------------------------------------------------
{
  const px2 = px + 2.5;
  const pz2 = pz + 2.5;
  let y = -1;
  for (let yy = Math.floor(player.position.y) + 8; yy > 2; yy--) {
    if (world.isSolidAt(px2, yy - 1, pz2) && !world.isSolidAt(px2, yy, pz2)) { y = yy; break; }
  }
  const creeper = mgr.spawn('creeper', px2, y, pz2);
  if (!creeper) throw new Error('creeper spawn failed');
  // move the player right next to it so the fuse lights
  player.position.set(px2 + 2.0, y, pz2);
  const blocksBefore = countSolid(px2, y, pz2, 4);
  let frames = 0;
  while (frames++ < 120 && !creeper.dead) {
    mgr.update(dt, player.position.x, player.position.y, player.position.z);
  }
  const blocksAfter = countSolid(px2, y, pz2, 4);
  console.log('creeper exploded:', creeper.dead, 'blocks', blocksBefore, '->', blocksAfter,
    'player hp', player.health, 'lastSound', log.lastSound, 'particles', log.particles > 0);
  if (!creeper.dead) console.log('  (fuse progress', creeper.fuseProgress, ')');
}

function countSolid(cx, cy, cz, r) {
  let n = 0;
  for (let y = cy - r; y <= cy + r; y++) {
    for (let z = cz - r; z <= cz + r; z++) {
      for (let x = cx - r; x <= cx + r; x++) if (world.isSolidAt(x, y, z)) n++;
    }
  }
  return n;
}

// ---- 8. skeleton arrow -----------------------------------------------------
{
  let y = -1;
  for (let yy = Math.floor(player.position.y) + 8; yy > 2; yy--) {
    if (world.isSolidAt(px - 3, yy - 1, pz - 3) && !world.isSolidAt(px - 3, yy, pz - 3)) { y = yy; break; }
  }
  const skel = mgr.spawn('skeleton', px - 3.5, y, pz - 3.5);
  player.position.set(px, y, pz);
  let frames = 0;
  while (frames++ < 100) {
    player.health = 20;
    mgr.update(dt, player.position.x, player.position.y, player.position.z);
  }
  const arrows = mgr.entities.filter((e) => e.typeName === 'arrow');
  console.log('skeleton:', skel ? 'ok' : 'null', 'arrows alive:', arrows.length, 'player hit logged:', !!player.lastHit);
}

// ---- 9. serialize / deserialize round trip ---------------------------------
const data = mgr.serialize();
console.log('serialized', data.length, 'sample:', JSON.stringify(data[0]));
const mgr2 = new MobManager({ ...host });
mgr2.deserialize(data);
console.log('deserialized:', mgr2.count, 'types:', [...new Set(mgr2.entities.map((e) => e.typeName))].join(','));
mgr2.update(dt, player.position.x, player.position.y, player.position.z);
console.log('deserialized update ok');
mgr2.dispose();

// ---- 10. render objects ----------------------------------------------------
let meshes = 0;
let tris = 0;
mgr.group.traverse((o) => {
  if (o.isMesh) {
    meshes++;
    const pos = o.geometry.attributes.position;
    tris += pos.count / 3;
  }
});
console.log('group children:', mgr.group.children.length, 'meshes:', meshes, 'tris:', tris,
  'entities:', mgr.count, '(should be ~= children)');
let owned = 0;
const seen = new Set();
let dupes = 0;
for (const e of mgr.entities) {
  if (!e.object3D) continue;
  owned++;
  if (seen.has(e.object3D)) dupes++;
  seen.add(e.object3D);
}
let strays = 0;
for (const c of mgr.group.children) if (!seen.has(c)) strays++;
console.log('entities with object3D:', owned, 'duplicate refs:', dupes, 'unowned group children:', strays,
  '| sample:', mgr.group.children.slice(0, 3).map((c) => c.type + ':' + c.name).join(' '));
for (const e of mgr.entities.slice(0, 8)) {
  if (!e.object3D) console.log('  no object3D for', e.typeName);
}

// ---- 10b. arrow collides with blocks --------------------------------------
{
  const { ArrowMob } = await import('../.mobbuild/entities/mobs.js');
  const ax = px + 0.5, az = pz + 0.5;
  const ay = player.position.y + 3;
  const arrow = new ArrowMob(ax, ay, az, 4, 0);
  // fire straight down into the ground
  arrow.velocity.set(0, -22, 0);
  mgr.spawnEntity(arrow);
  let f = 0;
  const y0 = arrow.position.y;
  while (f++ < 60 && mgr.entities.includes(arrow)) {
    mgr.update(dt, player.position.x, player.position.y, player.position.z);
  }
  console.log('arrow fell', (y0 - arrow.position.y).toFixed(2), 'blocks; stuck/alive:',
    arrow.position.y > 0 ? 'stopped at y=' + arrow.position.y.toFixed(2) : 'gone', 'still tracked:', mgr.entities.includes(arrow));
}

// ---- 11. dispose -----------------------------------------------------------
mgr.dispose();
console.log('disposed, entities:', mgr.count, 'group children:', mgr.group.children.length);
console.log('SOUNDS', log.sounds, 'PARTICLES', log.particles);
console.log('SMOKE TEST OK');
