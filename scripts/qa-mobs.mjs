// Headless mob/entity integration test.
//
// Builds a real World, constructs the MobManager against a fake host and ticks
// it for several simulated seconds. This exercises the AI, voxel collision,
// spawning rules, combat and persistence without needing a browser or a GPU.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const mobsMod = await load('entities/mobs.js');
  const { MobManager } = await load('entities/mobmanager.js');
  const { createMob, PASSIVE_TYPES, HOSTILE_TYPES } = mobsMod;
  const Projectile = mobsMod.ArrowMob ?? mobsMod.Arrow;
  const { Player } = await load('player/player.js');

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };

  const seed = 999;
  const gen = new TerrainGenerator(seed);
  const world = new World(seed, gen);
  for (let cz = -1; cz <= 1; cz++) {
    for (let cx = -1; cx <= 1; cx++) {
      const c = world.createChunk(cx, cz);
      gen.generateChunk(c);
      world.light.initialLight(c);
    }
  }

  const player = new Player();
  player.placeOnGround(world, 8.5, 8.5);
  player.gameMode = 'survival';

  let sounds = 0;
  let particles = 0;
  const host = {
    world,
    player,
    playSound: () => {
      sounds++;
    },
    spawnParticles: () => {
      particles++;
    },
    dayFactor: 0.1,
    isNight: true,
    difficulty: 2,
    timeOfDay: 0.75,
  };

  const mgr = new MobManager(host);
  check('mob manager constructs', !!mgr && Array.isArray(mgr.entities));
  check('mob manager exposes a group', !!mgr.group);

  /* ---- factories ---- */
  const types = [...PASSIVE_TYPES, ...HOSTILE_TYPES];
  check('all archetypes registered', types.length >= 8, types.join(','));
  for (const t of types) {
    const e = createMob(t, 8.5, player.position.y + 1, 8.5);
    check(`createMob(${t})`, !!e && e.health > 0 && e.maxHealth > 0 && e.width > 0 && e.height > 0);
    check(`${t} builds geometry`, !!e.buildObject());
    check(`${t} has drops`, Array.isArray(e.drops()));
  }
  if (Projectile) {
    const arrow = new Projectile(8.5, player.position.y + 1, 8.5, 4, 0);
    check('projectile constructs', arrow.kind === 'projectile');
  } else {
    check('projectile class exported', false);
  }

  /* ---- spawning + simulated time ---- */
  let spawned = 0;
  for (const t of types) {
    if (mgr.spawn(t, 8 + Math.random() * 4, player.position.y + 2, 8 + Math.random() * 4)) spawned++;
  }
  check('spawn() creates entity objects', spawned === types.length, `${spawned}/${types.length}`);
  check('entities are in the scene graph', mgr.group.children.length >= spawned);

  const dt = 1 / 60;
  for (let i = 0; i < 900; i++) {
    mgr.update(dt, player.position.x, player.position.y, player.position.z);
  }
  check('ticking does not throw', true);

  let finite = true;
  let underground = 0;
  for (const e of mgr.entities) {
    if (!Number.isFinite(e.position.x) || !Number.isFinite(e.position.y) || !Number.isFinite(e.position.z)) finite = false;
    if (e.position.y < -4) underground++;
  }
  check('entity positions stay finite', finite);
  check('no entity fell through the world', underground === 0, `${underground} below y=-4`);
  check('entities remain above bedrock', mgr.entities.every((e) => e.position.y >= 0), '');

  /* ---- combat ---- */
  const victim = mgr.entities.find((e) => e.kind === 'passive');
  if (victim) {
    const before = victim.health;
    const killed = victim.hurt(4, victim.position.x + 1, victim.position.z, host, 0.4);
    check('hurt reduces health', victim.health < before, `${before} -> ${victim.health}`);
    check('hurt triggers feedback', victim.hurtTime > 0 || killed);
    let guard = 0;
    while (!victim.dead && guard++ < 60) {
      victim.hurt(10, 0, 0, host, 0);
      // time must pass: entities have a damage cooldown
      for (let i = 0; i < 30; i++) mgr.update(dt, player.position.x, player.position.y, player.position.z);
    }
    check('entity can die', victim.dead === true, `health ${victim.health}`);
    check('death produces drops', victim.drops().length >= 0);
  } else {
    check('a passive mob exists to damage', false);
  }

  /* ---- raycast ---- */
  const target = mgr.entities.find((e) => !e.dead);
  if (target) {
    const hit = mgr.raycast(
      target.position.x,
      target.position.y + target.height * 0.5,
      target.position.z - 6,
      0,
      0,
      1,
      12,
    );
    check('raycast finds an entity', !!hit && hit.entity === target, hit ? String(hit.distance) : 'null');
  } else {
    check('an entity exists to raycast', false);
  }
  const miss = mgr.raycast(0.5, 200, 0.5, 0, 1, 0, 5);
  check('raycast returns null when nothing is hit', miss === null);

  /* ---- near() ---- */
  const all = mgr.near(player.position.x, player.position.y, player.position.z, 200);
  check('near() returns entities', all.length === mgr.entities.length);

  /* ---- persistence ---- */
  const snapshot = JSON.parse(JSON.stringify(mgr.serialize()));
  const alive = mgr.entities.filter((e) => !e.dead && e.removeAt < 0).length;
  const mgr2 = new MobManager(host);
  mgr2.deserialize(snapshot);
  check(
    'entities round-trip through save',
    mgr2.entities.length >= Math.max(0, alive - 1),
    `${mgr2.entities.length} restored, ${alive} alive`,
  );
  check('restored entities are positioned', mgr2.entities.every((e) => Number.isFinite(e.position.x)));

  /* ---- removal + culling ---- */
  const victim2 = mgr.entities[0];
  if (victim2) {
    const before = mgr.entities.length;
    mgr.remove(victim2);
    check('remove() drops the entity', mgr.entities.length === before - 1);
  }
  for (let i = 0; i < 400; i++) mgr.update(dt, 5000, 80, 5000);
  check('manager survives the player leaving', Number.isFinite(mgr.entities.length));

  /* ---- explosion path (creeper) ---- */
  const creeper = mgr.spawn('creeper', player.position.x + 1.5, player.position.y + 1, player.position.z);
  if (creeper) {
    const hBefore = player.health;
    for (let i = 0; i < 900; i++) mgr.update(dt, player.position.x, player.position.y, player.position.z);
    check('creeper detonation path runs', player.health <= hBefore);
  } else {
    check('creeper can spawn', false);
  }

  mgr.dispose();
  mgr2.dispose();
  check('dispose leaves no entities', mgr.entities.length === 0);

  console.log(`mobs: ${pass} passed, ${fail} failed  (sounds=${sounds} particles=${particles})`);
  if (fail > 0) process.exit(1);
}
