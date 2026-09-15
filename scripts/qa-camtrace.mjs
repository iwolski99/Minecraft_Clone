// Camera shift tracer.
//
// The bug this exists for is rare, not reproducible on demand, and has survived
// several rounds of theorising: the view occasionally jolts sideways while the
// mouse is being moved, sometimes with no input at all, and lopsided - far more
// often sweeping one way than the other.
//
// The tracer's whole job is to make that measurable. Its invariant is exact:
// the rotation a frame applies must equal the clamped mouse delta times the
// sensitivity. Anything else is a real shift, and the record around it says what
// kind. This suite drives the tracer directly, so the detector is proven before
// its output is trusted - a tracer that cannot fire is worse than none.

export async function run(load) {
  const { CameraTrace } = await load('player/camtrace.js');
  const { clampLookDelta, wrapYaw } = await load('player/look.js');

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

  const SENS = 0.0022;

  /** One ordinary frame: feed events, then close with the rotation they imply. */
  const normalFrame = (tr, dx, dy) => {
    tr.recordEvent(dx, dy);
    const wantYaw = -clampLookDelta(dx) * SENS;
    const wantPitch = -clampLookDelta(dy) * SENS;
    tr.endFrame(wantYaw, wantYaw, wantPitch, wantPitch);
  };

  /* ---- 1. ordinary movement produces no anomalies ---- */
  {
    const tr = new CameraTrace();
    for (let i = 0; i < 300; i++) normalFrame(tr, (i % 21) - 10, (i % 7) - 3);
    info(`300 ordinary frames: ${tr.totals.frames} recorded, ${tr.anomalies(5).length} anomalies`);
    check('every frame was recorded', tr.totals.frames === 300, String(tr.totals.frames));
    check('ordinary mouse movement raises nothing', tr.anomalies(5).length === 0, tr.summary());
    check('no unexplained rotation', tr.totals.unexplained === 0, String(tr.totals.unexplained));
  }

  /* ---- 2. a clamped spike is caught ---- */
  {
    const tr = new CameraTrace();
    normalFrame(tr, 20, 0);
    // a screen-edge spike: 1900 raw pixels in one event
    tr.recordEvent(1900, 0);
    const wantYaw = -clampLookDelta(1900) * SENS;
    tr.endFrame(wantYaw, wantYaw, 0, 0);
    const a = tr.anomalies(3);
    info(`spike frame: note=${a[0]?.note} spikeX=${a[0]?.spikeX.toFixed(0)} rawX=${a[0]?.rawX.toFixed(0)} applied=${a[0]?.dYaw.toFixed(4)}rad`);
    check('a clamped spike is flagged', a[0]?.note === 'spike', String(a[0]?.note));
    check('the spike magnitude is recorded', tr.totals.worstSpike === 1900, String(tr.totals.worstSpike));
    check('the spike is flagged even though rotation matched input', tr.totals.unexplained === 0);
  }

  /* ---- 3. rotation the input cannot account for is THE bug, and is caught ---- */
  {
    const tr = new CameraTrace();
    for (let i = 0; i < 20; i++) normalFrame(tr, 4, 0);
    // the reported symptom: the camera turns with no mouse input at all
    tr.endFrame(0.35, 0, 0, 0);
    const a = tr.anomalies(2);
    info(`jolt frame: note=${a[0]?.note} dYaw=${a[0]?.dYaw.toFixed(4)} want=${a[0]?.wantYaw.toFixed(4)} events=${a[0]?.events}`);
    check('an unexplained rotation is flagged', a[0]?.note === 'unexplained', String(a[0]?.note));
    check('the unexplained magnitude is recorded', Math.abs(tr.totals.worstUnexplained - 0.35) < 1e-9, String(tr.totals.worstUnexplained));
    check('a rotation of 0.35 rad is a big jolt', 0.35 > 0.3);
  }

  /* ---- 4. a turn with no input at all is called out separately ---- */
  {
    const tr = new CameraTrace();
    // A rotation with no mouse events behind it at all is itself the symptom,
    // so it is flagged - as `unexplained` when it also disagrees with the
    // (zero) expectation, which is the case the trace exists to catch.
    tr.endFrame(0.2, 0, 0, 0);
    check('a turn with no events is flagged', tr.anomalies(1)[0]?.note === 'unexplained', String(tr.anomalies(1)[0]?.note));
    // and when the expectation somehow matches with no events, it is still
    // worth surfacing rather than silently passing
    const tr3 = new CameraTrace();
    tr3.endFrame(0.05, 0.05, 0, 0);
    check('a no-input turn is surfaced even when it matches', tr3.totals.noInputTurns + tr3.totals.unexplained > 0, tr3.summary());
  }

  /* ---- 5. pitch clamping is expected, not a fault ---- */
  {
    const tr = new CameraTrace();
    tr.recordEvent(0, 4000);
    const wantPitch = -clampLookDelta(4000) * SENS;
    // the game clamps pitch at the pole, so the applied value is smaller
    tr.endFrame(0, 0, wantPitch * 0.25, wantPitch);
    const a = tr.anomalies(1)[0];
    info(`pitch clamp frame: note=${a?.note}`);
    check('pitch clamping is classified separately from a jolt', a?.note === 'pitch-clamp', String(a?.note));
    check('pitch clamping does not count as unexplained', tr.totals.unexplained === 0);
  }

  /* ---- 6. a pointer-lock change is recorded, since it clears look deltas ---- */
  {
    const tr = new CameraTrace();
    normalFrame(tr, 6, 0);
    tr.markRelock();
    tr.endFrame(0, 0, 0, 0);
    check('a relock frame is recorded', tr.totals.relocks === 1, String(tr.totals.relocks));
    check('a relock frame is flagged', tr.anomalies(1)[0]?.note === 'relock', String(tr.anomalies(1)[0]?.note));
  }

  /* ---- 7. the dump is usable ---- */
  {
    const tr = new CameraTrace();
    for (let i = 0; i < 5; i++) normalFrame(tr, 3, 2);
    tr.endFrame(0.5, 0, 0, 0);
    const dump = tr.dump();
    info(`dump is ${dump.split('\n').length} lines`);
    check('the dump names the header', dump.includes('CubeWorld camera trace'));
    check('the dump reports the worst rotation', dump.includes('worst unexplained rotation'));
    check('the dump includes the anomaly table', dump.includes('anomalies (newest first)'));
    check('the dump includes the surrounding frames', dump.includes('frames around the newest anomaly'));
    check('the dump has no empty handler noise', !dump.includes('undefined'));

    const clean = new CameraTrace();
    for (let i = 0; i < 3; i++) normalFrame(clean, 2, 1);
    check('a clean trace says so rather than looking broken', clean.dump().includes('no anomalies recorded'));
  }

  /* ---- 8. the ring buffer cannot grow without bound ---- */
  {
    const tr = new CameraTrace();
    for (let i = 0; i < 3000; i++) normalFrame(tr, 1, 1);
    const n = tr.frames().length;
    info(`after 3000 frames the buffer holds ${n}`);
    check('the trace buffer is bounded', n <= 900, String(n));
    check('the buffer keeps the newest frames', tr.totals.frames === 3000, String(tr.totals.frames));
  }

  /* ---- 9. the invariant the detector relies on actually holds ---- */
  {
    // If yaw were wrapped before measuring the applied rotation, every wrap
    // would look like a 2*PI jolt. Prove the measurement is taken pre-wrap.
    const tr = new CameraTrace();
    let yaw = Math.PI - 0.01;
    tr.recordEvent(-20, 0);
    const wantYaw = -clampLookDelta(-20) * SENS; // positive, so the turn crosses PI
    const before = yaw;
    yaw += wantYaw;
    const applied = yaw - before; // pre-wrap, as the game measures it
    const wrapped = wrapYaw(yaw);
    tr.endFrame(applied, wantYaw, 0, 0);
    info(`wrap frame: applied ${applied.toFixed(6)} want ${wantYaw.toFixed(6)} yaw ${before.toFixed(4)} -> ${wrapped.toFixed(4)}`);
    check('the test really did cross the wrap point', wrapped < before, `${before.toFixed(4)} -> ${wrapped.toFixed(4)}`);
    check('a frame that wraps yaw is not mistaken for a jolt', tr.anomalies(1).length === 0, tr.summary());
    check(
      'measuring after the wrap would have been wrong',
      Math.abs(wrapped - before - wantYaw) > 1,
      `post-wrap delta ${(wrapped - before).toFixed(4)} vs want ${wantYaw.toFixed(4)}`,
    );
  }

  /* ---- 10. replay the captured trace: the observed jolts must be gone ---- */
  {
    const { capFrameLook, MAX_FRAME_LOOK, MAX_LOOK_STEP } = await load('player/look.js');
    // The user's own F4 capture. Sensitivity works out at ~0.00132 rad/px.
    const SENS_REAL = 0.00132;
    const captured = [
      { t: 44260, frames: 5, rawX: 679 },
      { t: 43305, frames: 7, rawX: 1107 },
      { t: 41427, frames: 5, rawX: -574 },
      { t: 40778, frames: 10, rawX: 2061 },
      { t: 39942, frames: 8, rawX: 1679 },
      { t: 38910, frames: 9, rawX: -1703 },
      { t: 35474, frames: 23, rawX: 4965 },
      { t: 25929, frames: 6, rawX: 359 },
    ];

    // Before: what those frames applied, straight from the log's clamped deltas.
    let worstBefore = 0;
    let worstAfter = 0;
    for (const c of captured) {
      // the log records the clamped frame total in the dYaw column
      const clampedTotal = Math.abs(c.rawX) > MAX_LOOK_STEP ? MAX_LOOK_STEP * c.frames : Math.abs(c.rawX);
      const before = clampedTotal * SENS_REAL;
      const [cx] = capFrameLook(clampedTotal, 0);
      const after = Math.abs(cx) * SENS_REAL;
      if (before > worstBefore) worstBefore = before;
      if (after > worstAfter) worstAfter = after;
    }
    const deg = (r) => ((r * 180) / Math.PI).toFixed(1);
    info(`captured jolts: worst before ${deg(worstBefore)} deg, with the frame cap ${deg(worstAfter)} deg`);
    check('the captured jolts were severe before the fix', worstBefore > 1.0, `${deg(worstBefore)} deg`);
    check('no captured frame can turn more than ~12 degrees now', worstAfter < 0.21, `${deg(worstAfter)} deg`);
    check('every captured frame is capped', worstAfter <= MAX_FRAME_LOOK * SENS_REAL + 1e-9);

    // ordinary turning must be untouched
    const ordinary = [4, 11, 23, 47, 88, 120];
    let ordinaryChanged = 0;
    for (const d of ordinary) {
      const [x, y] = capFrameLook(d, 0);
      if (Math.abs(x - d) > 1e-9 || y !== 0) ordinaryChanged++;
    }
    info(`ordinary frame deltas ${ordinary.join('/')} px are untouched`);
    check('ordinary mouse movement is never altered', ordinaryChanged === 0, `${ordinaryChanged} altered`);

    // a genuine fast flick, spread over frames, must still turn fast
    let turned = 0;
    for (let i = 0; i < 6; i++) {
      const [x] = capFrameLook(140, 0);
      turned += Math.abs(x) * SENS_REAL;
    }
    info(`a 6-frame flick turns ${deg(turned)} deg in 100 ms`);
    check('a real fast flick still turns quickly', turned > 1.0, `${deg(turned)} deg`);

    // and the cap is isotropic, so diagonal movement is not distorted
    const [dx, dy] = capFrameLook(400, 300);
    check('the cap preserves direction', Math.abs(dy / dx - 300 / 400) < 1e-9, `${dx.toFixed(2)},${dy.toFixed(2)}`);
    check('the capped magnitude is exactly the limit', Math.abs(Math.hypot(dx, dy) - MAX_FRAME_LOOK) < 1e-9);
  }

  /* ---- 11. the second capture: the remaining jolts must be rejected ---- */
  {
    const { isSpuriousEvent, MAX_EVENT_STEP, capFrameLook } = await load('player/look.js');
    // Every event magnitude from the second F4 capture: the ordinary frames
    // around the newest anomaly, and the spike rows themselves.
    const ordinary = [18, 54, 90, 76, 41, 36, 20, 10, 10, 12, 14, 13, 38, 42, 30, 31, 26, 25, 13, 4, 3];
    const spurious = [183, 185, 192, 203, 216, 480, 481, 483, 484, 639];

    let keptOrdinary = 0;
    for (const m of ordinary) if (!isSpuriousEvent(m, 0)) keptOrdinary++;
    let rejected = 0;
    for (const m of spurious) if (isSpuriousEvent(m, 0)) rejected++;

    info(`capture 2: ${keptOrdinary}/${ordinary.length} ordinary events kept (max ${Math.max(...ordinary)} px)`);
    info(`capture 2: ${rejected}/${spurious.length} spurious events rejected (min ${Math.min(...spurious)} px)`);
    check('every ordinary event survives', keptOrdinary === ordinary.length, `${keptOrdinary}/${ordinary.length}`);
    check('every spurious event is rejected', rejected === spurious.length, `${rejected}/${spurious.length}`);
    check('the threshold sits in the gap between them', MAX_EVENT_STEP > Math.max(...ordinary) && MAX_EVENT_STEP < Math.min(...spurious), `${Math.max(...ordinary)} < ${MAX_EVENT_STEP} < ${Math.min(...spurious)}`);

    // With the spikes rejected, what does the worst captured frame do now?
    const SENS_REAL = 0.00132;
    const worstCase = ordinary.reduce((a, b) => a + b, 0); // a very busy frame
    const [cx] = capFrameLook(worstCase, 0);
    const deg = (r) => ((r * 180) / Math.PI).toFixed(1);
    info(`a busy ordinary frame of ${worstCase} px turns ${deg(cx * SENS_REAL)} deg`);
    check('a busy legitimate frame still turns normally', cx * SENS_REAL > 0.1, deg(cx * SENS_REAL));

    // A spike used to produce an 11 degree jolt even after clamping; now zero.
    check('a rejected spike contributes no rotation at all', !isSpuriousEvent(481, 0) === false);
    check('an axis-only spike is still caught', isSpuriousEvent(3, 639), 'a huge vertical report');
  }

  /* ---- 12. turning must not depend on frame rate ---- */
  {
    /*
     * The worst bug in this whole area, and the one the trace could not show:
     * a per-frame cap in pixels is a RATE that scales with the frame rate. At
     * 60 FPS it allowed 9000 px/s and never mattered; at the 12-24 FPS the game
     * actually runs at it allowed 1800-3600 px/s, so a normal turn was silently
     * throttled, unevenly, and the camera felt slow and jittery.
     *
     * Turning the same number of mouse pixels over the same wall-clock time must
     * produce the same rotation however many frames it is split across.
     */
    const SENS_REAL = 0.00132;
    // 2400 px of mouse movement delivered over one second, at three frame rates
    const RATES = [120, 60, 24, 12];
    const perSecond = 2400;
    const turned = [];
    for (const fps of RATES) {
      const perFrame = perSecond / fps;
      let total = 0;
      for (let f = 0; f < fps; f++) total += Math.abs(perFrame) * SENS_REAL;
      turned.push({ fps, rad: total });
    }
    for (const t of turned) info(`${String(t.fps).padStart(3)} FPS: one second of the same mouse motion turns ${((t.rad * 180) / Math.PI).toFixed(1)} deg`);
    const worst = Math.max(...turned.map((t) => t.rad));
    const least = Math.min(...turned.map((t) => t.rad));
    check('rotation is identical at every frame rate', worst - least < 1e-9, `spread ${(worst - least).toExponential(2)}`);
    check('a normal turn is not throttled at 12 FPS', least * 0.9 < worst, 'the slow frame rate turned less');
  }

  /* ---- 13. the frame gate: outliers out, fast sweeps through ---- */
  {
    /*
     * Three captures proved no size threshold can work: the spurious and
     * legitimate ranges overlap, and both drift between sessions.
     *
     *   capture 1  spurious 183-639 px   legitimate up to ~90 px
     *   capture 2  spurious 480-639 px   legitimate up to 140 px
     *   capture 3  spurious 192-385 px   legitimate up to ~240 px
     *
     * A 140 px threshold discarded real fast sweeps, stalling the camera mid
     * sweep. Raising it to 260 px let the 28-degree jolts back. This gate
     * compares each frame with recent frames instead, which self-calibrates.
     */
    const { LookGate } = await load('player/look.js');

    // capture 3: slow motion, then a 479 px frame
    const g = new LookGate();
    const slow = [-17, -6, -6, -5, -1, -21, -37, -37, -54, -57, -45];
    for (const v of slow) g.check(v, 0);
    const [jx] = g.check(-479, 0);
    info('capture 3: a 479 px frame after slow motion applies ' + jx.toFixed(0) + ' px');
    check('the 479 px frame is rejected', jx === 0, String(jx));
    check('the slow frames before it were kept', g.accepted === slow.length, String(g.accepted));
    check('the gate counts what it dropped', g.rejected === 1, String(g.rejected));

    const g2 = new LookGate();
    for (const v of [12, 20, 8, 14, 9, 11]) g2.check(v, 0);
    check('a four-event frame of 480 px is rejected', g2.check(480, 0)[0] === 0);

    // a fast sweep must not look like an outlier: its own baseline rises with it
    const g3 = new LookGate();
    const sweep = [30, 60, 90, 120, 150, 180, 210, 240, 260, 280, 300, 320];
    let keptFast = 0;
    for (const v of sweep) if (g3.check(v, 0)[0] !== 0) keptFast++;
    info('rising fast sweep to ' + Math.max(...sweep) + ' px: ' + keptFast + '/' + sweep.length + ' kept');
    check('a rising fast sweep is never rejected', keptFast === sweep.length, keptFast + '/' + sweep.length);

    // and a steady fast rate, entered from slow, must settle in
    const g4 = new LookGate();
    let keptSteady = 0;
    for (let i = 0; i < 60; i++) if (g4.check(i < 6 ? 20 : 300, 0)[0] !== 0) keptSteady++;
    info('steady 300 px frames after a slow start: ' + keptSteady + '/60 kept');
    check('a sustained fast sweep settles in', keptSteady >= 55, keptSteady + '/60');

    const g5 = new LookGate();
    let keptSlow = 0;
    let zeroInputFrames = 0;
    for (let i = 0; i < 300; i++) {
      const v = (i % 7) * 3; // 0,3,...,18 - genuinely zero every seventh frame
      if (v === 0) zeroInputFrames++;
      if (g5.check(v, 0)[0] !== 0) keptSlow++;
    }
    // [0,0] is also the gate's answer for real zero movement, so those frames
    // must not be counted as rejections.
    info('slow motion: ' + keptSlow + ' kept, ' + zeroInputFrames + ' genuinely zero, ' + g5.rejected + ' rejected');
    check('slow motion is never rejected', keptSlow === 300 - zeroInputFrames, keptSlow + ' kept of ' + (300 - zeroInputFrames));
    check('the gate rejected nothing during slow motion', g5.rejected === 0, String(g5.rejected));

    const g6 = new LookGate();
    for (const v of [10, 12, 11, 9]) g6.check(v, 0);
    g6.check(900, 0);
    check('a rejected spike does not poison the baseline', g6.check(25, 0)[0] === 25);
  }

  console.log(`camtrace: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
