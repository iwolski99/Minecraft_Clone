// Player physics regression tests.
//
// Both of these were reported from play and are easy to break silently:
//   * a player in water could never climb out, because the swim-up impulse was
//     far too weak to clear a one-block bank;
//   * there was no double-tap-forward sprint at all.

export async function run(load) {
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { Player } = await load('player/player.js');
  const { blockByName } = await load('world/blocks.js');

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const info = (m) => console.log(`  . ${m}`);

  const idOf = (name) => blockByName(name)?.id ?? 0;
  const stone = idOf('stone');
  const water = idOf('water');
  const air = 0;

  /** A flat stone shelf at y=70, a water trench beside it, and a bank at y=71. */
  const buildPool = () => {
    const gen = new TerrainGenerator(7);
    const world = new World(7, gen);
    const chunk = world.createChunk(0, 0);
    gen.generateChunk(chunk);
    world.light.initialLight(chunk);
    // a thick solid floor everywhere, so nothing can fall out of the world
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 58; y <= 70; y++) world.setBlock(x, y, z, stone);
        for (let y = 71; y < 96; y++) world.setBlock(x, y, z, air);
      }
    }
    // trench along x = 0..3: water from 66 to 70, solid below
    for (let x = 0; x <= 3; x++) {
      for (let z = 0; z < 16; z++) {
        for (let y = 66; y <= 70; y++) world.setBlock(x, y, z, water);
      }
    }
    // one-block bank at x = 4, water level is y = 70
    for (let z = 0; z < 16; z++) world.setBlock(4, 71, z, stone);
    world.light.initialLight(chunk);
    return world;
  };

  const input = (o = {}) => ({
    forward: false, back: false, left: false, right: false,
    jump: false, sneak: false, sprint: false, ...o,
  });

  /* ---- 1. the player can climb out of water onto a one-block bank ---- */
  {
    const world = buildPool();
    const p = new Player();
    // Start submerged, the way a swimmer actually reaches the bank. Starting at
    // the surface would leave the jump-out unarmed by design.
    p.position.set(2.5, 67.0, 8.5);
    p.velocity.set(0, 0, 0);
    // camera forward is (-sin(yaw), 0, -cos(yaw)); -PI/2 faces +x, toward the bank
    p.yaw = -Math.PI / 2;
    const dt = 1 / 60;
    let peak = 0;
    for (let i = 0; i < 240; i++) {
      p.update(world, input({ jump: true, forward: true }), dt);
      peak = Math.max(peak, p.position.y);
    }
    info(`after 4 s of jump+forward: y=${p.position.y.toFixed(2)} x=${p.position.x.toFixed(2)} peakY=${peak.toFixed(2)} onGround=${p.onGround}`);
    check('player rises above the water surface', peak > 71.0, `peak ${peak.toFixed(2)}`);
    check('player ends up out of the trench', p.position.x > 3.5, `x ${p.position.x.toFixed(2)}`);
  }

  /* ---- 2. underwater the swim stroke stays gentle ---- */
  {
    const world = buildPool();
    const p = new Player();
    p.position.set(2.5, 66.0, 8.5);
    p.velocity.set(0, 0, 0);
    const dt = 1 / 60;
    for (let i = 0; i < 30; i++) p.update(world, input({ jump: true }), dt);
    info(`underwater after 0.5 s: vy=${p.velocity.y.toFixed(2)}`);
    check('swim stroke stays gentle underwater', p.velocity.y <= 3.25, `vy ${p.velocity.y.toFixed(2)}`);
  }

  /* ---- 3. a normal jump still clears exactly one block ---- */
  {
    const world = buildPool();
    const p = new Player();
    p.position.set(8.5, 71.0, 8.5);
    p.velocity.set(0, 0, 0);
    const dt = 1 / 60;
    let peak = 0;
    for (let i = 0; i < 90; i++) {
      p.update(world, input({ jump: i < 3 }), dt);
      peak = Math.max(peak, p.position.y);
    }
    info(`jump peak height above the shelf: ${(peak - 71).toFixed(2)} blocks`);
    check('a jump clears one block with headroom', peak - 71 > 1.0 && peak - 71 < 2.0, `${(peak - 71).toFixed(2)}`);
  }

  /* ---- 4. sprinting is faster than walking ---- */
  {
    const run = (sprint) => {
      const world = buildPool();
      const p = new Player();
      p.position.set(8.5, 71.0, 8.5);
      p.velocity.set(0, 0, 0);
      const dt = 1 / 60;
      for (let i = 0; i < 60; i++) p.update(world, input({ forward: true, sprint }), dt);
      return Math.hypot(p.velocity.x, p.velocity.z);
    };
    const walk = run(false);
    const sprint = run(true);
    info(`walk ${walk.toFixed(2)} m/s, sprint ${sprint.toFixed(2)} m/s`);
    check('sprinting is faster than walking', sprint > walk * 1.15, `${walk.toFixed(2)} vs ${sprint.toFixed(2)}`);
  }

  /* ---- 5. jumping while turning must never teleport the player ---- */
  {
    /*
     * Reported from play: the camera "shifts" while jumping and swinging the
     * look around, with no directional input. The camera is derived from the
     * player every frame - position, pitch and yaw straight through - so a
     * camera shift can only mean the PLAYER moved in a way the physics does not
     * explain. This drives that exact motion and asserts the step each frame is
     * no larger than the velocity can account for.
     */
    const world = buildPool();
    const p = new Player();
    p.position.set(8.5, 71.0, 8.5);
    p.velocity.set(0, 0, 0);
    const dt = 1 / 60;
    // settle on the shelf first
    for (let i = 0; i < 30; i++) p.update(world, input(), dt);

    let worstStep = 0;
    let worstAt = -1;
    let worstYaw = 0;
    let prev = p.position.clone();
    // jump repeatedly while sweeping the look left-to-right and back, the motion
    // that was reported to trigger it
    for (let i = 0; i < 900; i++) {
      const t = i / 60;
      p.yaw = Math.sin(t * 3.1) * 1.4;
      p.pitch = Math.sin(t * 2.3) * 0.5;
      p.update(world, input({ jump: true }), dt);

      const dx = p.position.x - prev.x;
      const dy = p.position.y - prev.y;
      const dz = p.position.z - prev.z;
      // what the velocity can account for, plus a small collision tolerance
      const budget =
        (Math.abs(p.velocity.x) + Math.abs(p.velocity.y) + Math.abs(p.velocity.z)) * dt + 0.06;
      const step = Math.abs(dx) + Math.abs(dy) + Math.abs(dz);
      if (step > worstStep) {
        worstStep = step;
        worstAt = i;
        worstYaw = p.yaw;
      }
      if (step > budget) {
        check(
          `no teleport while jumping and turning (frame ${i})`,
          false,
          `moved ${step.toFixed(3)} in one frame, physics allows ${budget.toFixed(3)} (dx ${dx.toFixed(3)} dy ${dy.toFixed(3)} dz ${dz.toFixed(3)})`,
        );
        break;
      }
      prev.copy(p.position);
    }
    info(`900 frames of jump-and-turn: largest single-frame movement ${worstStep.toFixed(3)} blocks (frame ${worstAt}, yaw ${worstYaw.toFixed(2)})`);
    check('the player never moves further in one frame than its velocity explains', worstStep < 0.35, `worst ${worstStep.toFixed(3)}`);
  }

  /* ---- 6. sprinting over water must not walk on it ---- */
  {
    /*
     * Reported from play: sprinting with jump held lets you run across water
     * indefinitely. The surface hop added to let a swimmer climb out gives a full
     * jump impulse whenever the feet are in water and the block above is clear -
     * and a player skimming the surface satisfies that every single frame.
     */
    const gen2 = new TerrainGenerator(9);
    const w2 = new World(9, gen2);
    const c2 = w2.createChunk(0, 0);
    gen2.generateChunk(c2);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 128; y++) w2.setBlock(x, y, z, 0);
        w2.setBlock(x, 60, z, idOf('stone'));
        // a long shallow sea to run across
        for (let y = 61; y <= 62; y++) w2.setBlock(x, y, z, water);
      }
    }
    w2.light.initialLight(c2);

    const p = new Player();
    p.position.set(3.5, 63.0, 8.5);
    p.velocity.set(0, 0, 0);
    p.yaw = -Math.PI / 2; // face +x, along the sea
    const dt = 1 / 60;
    let wet = 0;
    for (let i = 0; i < 240; i++) {
      p.update(w2, input({ forward: true, jump: true, sprint: true }), dt);
      if (p.inWater) wet++;
    }
    info(`after 4 s sprinting with jump held across water: x=${p.position.x.toFixed(1)} y=${p.position.y.toFixed(2)} inWater=${p.inWater} framesInWater=${wet}`);
    check('sprinting over water stays in the water', p.position.y < 63.6, `y ${p.position.y.toFixed(2)}`);
    check('sprinting over water does not cross it', p.position.x < 14, `x ${p.position.x.toFixed(1)}`);
  }

  /* ---- 7. look input cannot be jolted by a spurious mouse delta ---- */
  {
    /*
     * Reported from play: the camera "shifts" while merely moving the mouse,
     * even standing still, and far more often sweeping one way than the other.
     * A pointer-lock `movementX` spike at a screen edge is the classic cause,
     * so each event is clamped before it becomes a look delta.
     */
    const { clampLookDelta, wrapYaw, MAX_LOOK_STEP } = await load('player/look.js');
    info(`look clamp is +/-${MAX_LOOK_STEP} per event`);
    check('an ordinary movement passes through unchanged', clampLookDelta(37) === 37);
    check('a small negative movement passes through', clampLookDelta(-12) === -12);
    check('a huge positive spike is clamped', clampLookDelta(4200) === MAX_LOOK_STEP, String(clampLookDelta(4200)));
    check('a huge negative spike is clamped', clampLookDelta(-9000) === -MAX_LOOK_STEP, String(clampLookDelta(-9000)));
    check('a screen-width spike is clamped', clampLookDelta(1920) === MAX_LOOK_STEP);
    check('zero stays zero', clampLookDelta(0) === 0);
    check('NaN becomes zero rather than poisoning the yaw', clampLookDelta(NaN) === 0);
    // Non-finite input is dropped entirely rather than clamped: a delta that
    // cannot be trusted should contribute nothing, not a maximum turn.
    check('Infinity is dropped rather than turned into a full-rate flick', clampLookDelta(Infinity) === 0, String(clampLookDelta(Infinity)));

    // a spike must not be able to turn the camera by a large angle at normal
    // sensitivity (0.0022 rad per unit)
    const sens = 0.0022;
    const worstTurn = clampLookDelta(99999) * sens;
    info(`worst single-event turn at default sensitivity: ${((worstTurn * 180) / Math.PI).toFixed(1)} degrees`);
    check('one mouse event cannot snap the view', worstTurn < 0.5, `${worstTurn.toFixed(3)} rad`);

    check('yaw wraps into (-PI, PI]', Math.abs(wrapYaw(7.5)) <= Math.PI, String(wrapYaw(7.5)));
    check('yaw wrap is exact for a full turn', Math.abs(wrapYaw(Math.PI * 2)) < 1e-9, String(wrapYaw(Math.PI * 2)));
    check('yaw wrap preserves direction', Math.abs(wrapYaw(-7.5) - (-7.5 + Math.PI * 2)) < 1e-9, String(wrapYaw(-7.5)));
  }

  /* ---- 8. cactus contact damages the player ---- */
  {
    const gen3 = new TerrainGenerator(4);
    const w3 = new World(4, gen3);
    const c3 = w3.createChunk(0, 0);
    gen3.generateChunk(c3);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 128; y++) w3.setBlock(x, y, z, 0);
        w3.setBlock(x, 60, z, idOf('stone'));
      }
    }
    w3.setBlock(8, 61, 8, idOf('cactus'));
    w3.light.initialLight(c3);

    // Pressed against the cactus. Placing the player *inside* it is not a valid
    // test: collision pushes them straight back out, which is how the first
    // attempt at this reported no damage.
    const p = new Player();
    p.gameMode = 'survival';
    p.health = 20;
    p.position.set(9.3, 61.0, 8.5);
    p.velocity.set(0, 0, 0);
    const before = p.health;
    for (let i = 0; i < 180; i++) {
      p.update(w3, input(), 1 / 60);
      p.position.x = 9.3; // hold them against it; collision would push them off
      p.position.z = 8.5;
    }
    const lost = before - p.health;
    info(`pressed against a cactus for 3 s: health ${before} -> ${p.health} (${lost} lost)`);
    check('pressing against a cactus hurts', lost > 0, `lost ${lost}`);
    check('cactus damage is half a heart at a time', lost % 1 === 0, String(lost));

    // brushing past at a distance must not
    const p2 = new Player();
    p2.gameMode = 'survival';
    p2.health = 20;
    p2.position.set(9.9, 61.0, 8.5);
    p2.velocity.set(0, 0, 0);
    for (let i = 0; i < 180; i++) p2.update(w3, input(), 1 / 60);
    info(`standing a block away for 3 s: health ${p2.health}`);
    check('standing clear of a cactus is safe', p2.health === 20, String(p2.health));
  }

  /* ---- 9. fences must not be climbable ---- */
  {
    /*
     * Reported from play: walking into a fence climbed it like a ladder. The
     * cause was unstick() asking whether the block in the player's cell blocked
     * movement, rather than whether the player's body touched it. A fence's
     * collider is a quarter of a block wide, so standing in its cell without
     * touching it was enough to be declared buried and lifted 3.2 blocks a
     * second.
     */
    const w4 = new World(4, new TerrainGenerator(11));
    const c4 = w4.createChunk(0, 0);
    new TerrainGenerator(11).generateChunk(c4);
    for (let z = 0; z < 16; z++) {
      for (let x = 0; x < 16; x++) {
        for (let y = 0; y < 128; y++) w4.setBlock(x, y, z, 0);
        w4.setBlock(x, 60, z, idOf('stone'));
      }
    }
    w4.setBlock(8, 61, 8, idOf('oak_fence'));
    w4.light.initialLight(c4);

    const p = new Player();
    p.gameMode = 'survival';
    // standing in the fence's own cell, but clear of its quarter-block collider
    p.position.set(8.15, 61.0, 8.5);
    p.velocity.set(0, 0, 0);
    const startY = p.position.y;
    for (let i = 0; i < 180; i++) {
      p.update(w4, input({ forward: true }), 1 / 60);
      p.position.x = 8.15; // hold them against it
      p.position.z = 8.5;
      p.velocity.x = 0;
      p.velocity.z = 0;
    }
    info(`pressed against a fence for 3 s: y ${startY.toFixed(2)} -> ${p.position.y.toFixed(2)}`);
    check('a fence is not climbable', p.position.y - startY < 0.5, `rose ${(p.position.y - startY).toFixed(2)}`);

    // but a player genuinely inside a solid block must still be rescued
    const p2 = new Player();
    p2.gameMode = 'survival';
    p2.position.set(8.5, 61.0, 8.5);
    w4.setBlock(8, 61, 8, idOf('stone'));
    w4.setBlock(8, 62, 8, idOf('stone'));
    p2.velocity.set(0, 0, 0);
    const y0 = p2.position.y;
    for (let i = 0; i < 120; i++) p2.update(w4, input(), 1 / 60);
    info(`buried in stone: y ${y0.toFixed(2)} -> ${p2.position.y.toFixed(2)}`);
    check('a genuinely buried player is still lifted out', p2.position.y > y0 + 0.5, `rose ${(p2.position.y - y0).toFixed(2)}`);
  }

  console.log(`player: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
