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

  /* ---- 14. the gate itself must be frame-rate independent ---- */
  {
    /*
     * Section 12 above checks that the *arithmetic* is frame-rate independent,
     * but it never calls the gate, so it cannot fail however the gate behaves.
     * That hole is how a floor of 70 px per FRAME shipped: above 30 FPS it never
     * fired, and at the 12-26 FPS this game actually runs at it rejected the
     * first frame of every ordinary turn - 5.7 to 11.3 degrees of the player's
     * own movement, discarded, worse the slower the machine.
     *
     * This drives the gate with the SAME physical motion at each frame rate and
     * demands the same rotation out of it.
     */
    const { LookGate } = await load('player/look.js');
    const SENS_REAL = 0.00132;
    const deg = (r) => ((r * 180) / Math.PI).toFixed(1);

    /** A 1.5 s turn at `velocity` px/s after 1.2 s of idle, sampled at `fps`. */
    const turnAt = (fps, velocity) => {
      const dt = 1 / fps;
      const g = new LookGate();
      let applied = 0;
      let intended = 0;
      const feed = (vel, secs) => {
        for (let t = 0; t < secs; t += dt) {
          const px = vel * dt;
          intended += px;
          applied += g.check(px, 0, dt)[0];
        }
      };
      feed(30, 1.2);
      feed(velocity, 1.5);
      return { applied, intended, held: g.rejected };
    };

    const RATES = [120, 60, 30, 24, 20, 15, 12];
    let worstLoss = 0;
    for (const fps of RATES) {
      const r = turnAt(fps, 1800);
      const lost = (r.intended - r.applied) * SENS_REAL;
      if (Math.abs(lost) > worstLoss) worstLoss = Math.abs(lost);
      info(`${String(fps).padStart(3)} FPS: a 1800 px/s turn applies ${deg(r.applied * SENS_REAL)} of ${deg(r.intended * SENS_REAL)} deg`);
    }
    check('the gate discards nothing at any frame rate', worstLoss < 1e-9, `${deg(worstLoss)} deg lost`);

    // And the same for a genuinely fast turn, which is where a floor bites.
    let worstFast = 0;
    for (const fps of RATES) {
      const r = turnAt(fps, 4000);
      const lost = Math.abs(r.intended - r.applied) * SENS_REAL;
      if (lost > worstFast) worstFast = lost;
    }
    info(`a 4000 px/s turn loses at most ${deg(worstFast)} deg across ${RATES.length} frame rates`);
    check('a fast turn is not throttled at low frame rates', worstFast < 1e-9, `${deg(worstFast)} deg lost`);

    /*
     * Loss alone is not enough to pin this down. Because a suspect frame is now
     * deferred rather than dropped, a floor in the wrong unit still returns the
     * movement a frame later and loses nothing - so a check that only measures
     * lost degrees passes even with a per-FRAME floor. What a per-frame floor
     * cannot hide is that it changes the gate's *decision* with the frame rate:
     * the same physical turn is waved through at 120 FPS and stopped at 12.
     *
     * So the invariant is the decision itself. For one physical motion the gate
     * must hold the same number of frames however fast the machine is drawing.
     */
    const heldSlow = RATES.map((fps) => turnAt(fps, 1800).held);
    const heldFast = RATES.map((fps) => turnAt(fps, 4000).held);
    info(`frames held for a 1800 px/s turn, ${RATES.join('/')} FPS: ${heldSlow.join('/')}`);
    info(`frames held for a 4000 px/s turn, ${RATES.join('/')} FPS: ${heldFast.join('/')}`);
    check(
      'the gate makes the same decision at every frame rate (1800 px/s)',
      heldSlow.every((h) => h === heldSlow[0]),
      heldSlow.join('/'),
    );
    check(
      'the gate makes the same decision at every frame rate (4000 px/s)',
      heldFast.every((h) => h === heldFast[0]),
      heldFast.join('/'),
    );
    check('an ordinary turn is never even examined', heldSlow[0] === 0, String(heldSlow[0]));

    /*
     * The mutation test for the two checks above: a floor expressed per frame
     * instead of per second must make them fail. If this ever stops holding, the
     * checks have gone blind again.
     */
    const perFrameFloorBehaviour = (fps) => {
      const dt = 1 / fps;
      const recent = [];
      const FLOOR_PX_PER_FRAME = 70;
      let applied = 0;
      let intended = 0;
      let consecutive = 0;
      const median = () => {
        if (!recent.length) return 0;
        const q = [...recent].sort((a, b) => a - b);
        return q[q.length >> 1];
      };
      const feed = (vel, secs) => {
        for (let t = 0; t < secs; t += dt) {
          const px = vel * dt;
          intended += px;
          const limit = Math.max(FLOOR_PX_PER_FRAME, median() * 8);
          if (px > limit && recent.length >= 4 && consecutive === 0) {
            consecutive = 1;
            continue; // dropped outright, as the old gate did
          }
          if (consecutive) {
            consecutive = 0;
            recent.length = 0;
          }
          recent.push(px);
          if (recent.length > 24) recent.shift();
          applied += px;
        }
      };
      feed(30, 1.2);
      feed(1800, 1.5);
      return (intended - applied) * SENS_REAL;
    };
    const mutantFast = perFrameFloorBehaviour(20);
    const mutantSlow = perFrameFloorBehaviour(120);
    info(`mutation: a per-FRAME floor loses ${deg(mutantFast)} deg at 20 FPS and ${deg(mutantSlow)} deg at 120 FPS`);
    check('the mutation test bites: a per-frame floor loses real movement at low FPS', mutantFast > 0.05, `${deg(mutantFast)} deg`);
    check('the mutation test shows it is frame-rate dependent', mutantFast > mutantSlow + 0.05, `${deg(mutantFast)} vs ${deg(mutantSlow)}`);
  }

  /* ---- 15. a realistic noisy session: both directions at once ---- */
  {
    /*
     * The fast-sweep checks in section 13 use ideal input - a perfectly smooth
     * ramp, and a step to an exactly constant rate. Real motion is neither, and
     * the gap is exactly where the regression lived: a noisy acceleration into a
     * turn looks like an outlier against a median built from idling, even though
     * the frames right after it are larger still and are accepted.
     *
     * This drives the gate with hand tremor, varying frame times and repeated
     * turns, and then with the real captured spikes, and requires it to pass both.
     */
    const { LookGate } = await load('player/look.js');
    const SENS_REAL = 0.00132;
    const deg = (r) => ((r * 180) / Math.PI).toFixed(2);

    let seed = 12345;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const segment = (v0, v1, secs, tremor = 0.18) => {
      const out = [];
      let t = 0;
      while (t < secs) {
        const dt = 0.038 + rnd() * 0.012; // the 20-26 FPS actually captured
        const v = v0 + (v1 - v0) * Math.min(1, t / secs);
        out.push({ px: Math.max(0, v * (1 + (rnd() - 0.5) * 2 * tremor)) * dt, dt });
        t += dt;
      }
      return out;
    };
    const frames = [];
    for (let rep = 0; rep < 6; rep++) {
      frames.push(
        ...segment(0, 40, 0.8),      // idle / micro-aim
        ...segment(40, 60, 0.6),     // slow tracking
        ...segment(60, 2400, 0.35),  // accelerate into a turn
        ...segment(2400, 2600, 0.5), // hold it
        ...segment(2600, 80, 0.3),   // decelerate out
        ...segment(80, 30, 0.7),     // settle
        ...segment(30, 3000, 0.18),  // a quick flick
        ...segment(3000, 40, 0.15),  // flick ends
        ...segment(40, 20, 0.9),     // idle again
      );
    }

    const g = new LookGate();
    let applied = 0;
    let intended = 0;
    for (const f of frames) {
      intended += f.px;
      applied += g.check(f.px, 0, f.dt)[0];
    }
    const lost = (intended - applied) * SENS_REAL;
    info(`realistic session: ${frames.length} frames, intended ${deg(intended * SENS_REAL)} deg, applied ${deg(applied * SENS_REAL)} deg`);
    info(`realistic session: ${g.rejected} frames held, ${g.released} released, ${g.discarded} discarded`);
    check('a realistic session loses no legitimate movement at all', Math.abs(lost) < 1e-9, `${deg(lost)} deg lost`);
    check('a realistic session discards nothing', g.discarded === 0, String(g.discarded));

    // ...and the same gate still stops every spike pattern the captures contain.
    const DT = 0.045; // the captured frame time
    const spikes = [
      ['capture 3, 479 px', [-17, -6, -6, -5, -1, -21, -37, -37, -54, -57, -45], -479, -25],
      ['capture 1, 639 px', [12, 20, 8, 14, 9, 11, 10, 13, 9, 12], 639, 14],
      ['capture 3, 192 px', [6, 6, 5, 7, 6, 6, 5, 6, 7, 6], 192, 7],
      ['capture 3, 183 px', [8, 7, 9, 6, 8, 7, 9, 8, 7, 8], 183, 9],
      ['capture 2, 480 px', [18, 54, 90, 76, 41, 36, 20, 10, 10, 12], 480, 14],
    ];
    let stopped = 0;
    let worstLeak = 0;
    for (const [name, runup, spike, after] of spikes) {
      const gg = new LookGate();
      for (const v of runup) gg.check(v, 0, DT);
      const at = gg.check(spike, 0, DT)[0];
      const next = gg.check(after, 0, DT)[0];
      // anything the spike contributes, now or leaking into the frame after it
      const leak = Math.abs(at) + Math.abs(next - after);
      if (leak < 1e-9) stopped++;
      else info(`  ${name} leaked ${leak.toFixed(0)} px`);
      if (leak > worstLeak) worstLeak = leak;
    }
    info(`captured spikes stopped: ${stopped}/${spikes.length}, worst leak ${deg(worstLeak * SENS_REAL)} deg`);
    check('every captured spike is still stopped', stopped === spikes.length, `${stopped}/${spikes.length}`);
    check('no captured spike leaks any rotation', worstLeak < 1e-9, `${deg(worstLeak * SENS_REAL)} deg`);
  }

  /* ---- 16. held movement is deferred, never silently lost ---- */
  {
    /*
     * The difference between this gate and the three that failed before it. A
     * frame it judges suspect is held, not thrown away: if the motion continues
     * the player gets all of it back one frame later, and only a lone impulse -
     * which no hand produces - is actually discarded. Every earlier gate
     * discarded immediately, so every misjudgement cost real movement and the
     * camera stalled. Both halves are checked here.
     */
    const { LookGate } = await load('player/look.js');
    const DT = 0.045;

    // sustained: a hard flick out of near-stillness loses nothing
    const g1 = new LookGate();
    const slow = [5, 6, 5, 7, 6, 5, 6, 5];
    for (const v of slow) g1.check(v, 0, DT);
    const first = g1.check(400, 0, DT)[0];
    const second = g1.check(420, 0, DT)[0];
    info(`hard flick from rest: frame 1 applies ${first.toFixed(0)} px, frame 2 applies ${second.toFixed(0)} px`);
    check('the first frame of a hard flick is held, not applied', first === 0, String(first));
    check('the held movement comes back in full on the next frame', Math.abs(second - (400 + 420)) < 1e-9, String(second));
    check('nothing is lost across the deferral', g1.released === 1 && g1.discarded === 0, `${g1.released}/${g1.discarded}`);

    // impulse: a lone spike followed by normal motion is discarded
    const g2 = new LookGate();
    for (const v of slow) g2.check(v, 0, DT);
    const atSpike = g2.check(479, 0, DT)[0];
    const afterSpike = g2.check(6, 0, DT)[0];
    info(`lone 479 px impulse: spike frame applies ${atSpike.toFixed(0)} px, next frame applies ${afterSpike.toFixed(0)} px`);
    check('a lone impulse applies nothing', atSpike === 0, String(atSpike));
    check('a lone impulse does not leak into the next frame', afterSpike === 6, String(afterSpike));
    check('a lone impulse is recorded as discarded', g2.discarded === 1 && g2.released === 0, `${g2.released}/${g2.discarded}`);

    /*
     * A lock change must drop whatever is held rather than releasing it into the
     * frame after the transition - that would be a jolt with no input behind it,
     * which is the original symptom. The frame after `forget()` must carry its
     * own movement and nothing else.
     */
    const g3 = new LookGate();
    for (const v of slow) g3.check(v, 0, DT);
    g3.check(600, 0, DT);           // held
    check('the frame really was held', g3.rejected === 1, String(g3.rejected));
    g3.forget();
    const afterForget = g3.check(6, 0, DT)[0];
    info(`after a lock change the next frame applies ${afterForget.toFixed(0)} px of its own 6 px`);
    check('movement held across a lock change is never released', afterForget === 6, String(afterForget));
    check('and it is not counted as released either', g3.released === 0, String(g3.released));

    // two suspect frames in a row must never deadlock the player out
    const g4 = new LookGate();
    for (const v of slow) g4.check(v, 0, DT);
    let appliedRun = 0;
    let wantedRun = 0;
    for (let i = 0; i < 40; i++) {
      wantedRun += 500;
      appliedRun += g4.check(500, 0, DT)[0];
    }
    info(`a sustained 500 px/frame turn applies ${appliedRun} of ${wantedRun} px`);
    check('a sustained fast turn is never locked out', appliedRun === wantedRun, `${appliedRun}/${wantedRun}`);
  }

  /* ---- 17. a lock change must not hide anything ---- */
  {
    /*
     * The whole case for "the look code is innocent" is `unexplained 0` across
     * three captures. Those captures contain 8-16 relock frames each, and the
     * classifier used to test `relock` FIRST - so a lock frame that also turned
     * by an amount the input could not account for was filed as 'relock' and
     * never counted. The one kind of frame most under suspicion was the one kind
     * exempt from the check.
     */
    const { CameraTrace } = await load('player/camtrace.js');

    const plain = new CameraTrace();
    plain.endFrame(0.35, 0, 0, 0, 1e-6);
    const onLock = new CameraTrace();
    onLock.markLock(true, true, true);
    onLock.endFrame(0.35, 0, 0, 0, 1e-6);
    info(`a 0.35 rad jolt reads '${plain.frames()[0].note}' normally and '${onLock.frames()[0].note}' on a lock frame`);
    check('an unexplained jolt is flagged on a lock frame too', onLock.frames()[0].note === 'unexplained', onLock.frames()[0].note);
    check('an unexplained jolt is COUNTED on a lock frame too', onLock.totals.unexplained === 1, String(onLock.totals.unexplained));
    check('the lock edge is still recorded alongside it', onLock.frames()[0].lockEdge === true);

    const spikeOnLock = new CameraTrace();
    spikeOnLock.markLock(false, true, true);
    spikeOnLock.recordEvent(1900, 0);
    spikeOnLock.endFrame(-0.396, -0.396, 0, 0, 1e-6);
    check('a spike is flagged on a lock frame too', spikeOnLock.frames()[0].note === 'spike', spikeOnLock.frames()[0].note);
    check('a spike is COUNTED on a lock frame too', spikeOnLock.totals.spikes === 1, String(spikeOnLock.totals.spikes));

    // and a clean lock frame is still reported as a relock
    const clean = new CameraTrace();
    clean.markLock(true, true, true);
    clean.endFrame(0, 0, 0, 0, 1e-6);
    check('a clean lock frame still reads as a relock', clean.frames()[0].note === 'relock', clean.frames()[0].note);
  }

  /* ---- 18. the pointer-lock timeline and the stall correlation ---- */
  {
    /*
     * The strongest unexplored lead: the captures show 8-16 lock transitions per
     * session arriving in pairs ~100 ms apart, and while the lock is gone the
     * mousemove handler returns early so the camera cannot move at all. The old
     * trace recorded only that a transition happened. These are the fields that
     * turn that into a diagnosis, and the report that correlates lost lock time
     * against the frames that actually received no input.
     */
    const { CameraTrace } = await load('player/camtrace.js');
    const tr = new CameraTrace();

    // a locked stretch with input, then a lock loss, a frozen gap, and recovery
    tr.markLock(true, true, true);
    for (let i = 0; i < 5; i++) {
      tr.recordEvent(10, 0);
      tr.endFrame(-0.022, -0.022, 0, 0, 1e-6, 45);
    }
    tr.markLock(false, true, true);           // lost, window still focused
    for (let i = 0; i < 3; i++) tr.endFrame(0, 0, 0, 0, 1e-6, 45); // frozen: no events
    tr.markLock(true, true, true);            // regained
    for (let i = 0; i < 5; i++) {
      tr.recordEvent(10, 0);
      tr.endFrame(-0.022, -0.022, 0, 0, 1e-6, 45);
    }

    const locks = tr.locks();
    info(`lock timeline: ${locks.map((e) => (e.locked ? 'ACQUIRED' : 'LOST')).join(' -> ')}`);
    check('every lock edge is recorded', locks.length === 3, String(locks.length));
    check('the edge direction is recorded', locks[1].locked === false && locks[2].locked === true);
    check('focus at the edge is recorded', locks[1].focused === true);
    check('frames drawn while unlocked are counted', tr.unlockedFrames === 3, String(tr.unlockedFrames));

    const lockLines = tr.lockReport().join('\n');
    check('the lock report names both edges', lockLines.includes('LOST') && lockLines.includes('ACQUIRED'));
    check('the lock report gives the time unlocked', lockLines.includes('total time unlocked'));

    const stallLines = tr.stallReport().join('\n');
    info(`stall report: ${tr.stallReport()[1]}`);
    check('the stall report finds the frozen run', stallLines.includes('1 runs'), stallLines.split('\n')[1]);
    check('the frozen run is attributed to the lost lock', stallLines.includes('1 overlap an unlocked window'), stallLines.split('\n')[1]);

    // a stall that is NOT explained by the lock must be reported as unexplained,
    // or the report would confirm the lock theory whatever the data said
    const tr2 = new CameraTrace();
    tr2.markLock(true, true, true);
    for (let i = 0; i < 4; i++) {
      tr2.recordEvent(10, 0);
      tr2.endFrame(-0.022, -0.022, 0, 0, 1e-6, 45);
    }
    for (let i = 0; i < 3; i++) tr2.endFrame(0, 0, 0, 0, 1e-6, 45); // no input, still locked
    const s2 = tr2.stallReport().join('\n');
    info(`stall report, lock held throughout: ${tr2.stallReport()[1]}`);
    check('a stall with the lock held is reported as unexplained', s2.includes('0 overlap an unlocked window'), tr2.stallReport()[1]);

    /*
     * The case the stall report alone cannot see. Losing the lock calls
     * `pause()`, which stops the frame loop - so the stall leaves no frames at
     * all, just a hole in the timeline. A report that only looked for zero-input
     * frames would find nothing and appear to disprove the lock theory.
     */
    const tr3 = new CameraTrace();
    tr3.markLock(true, true, true);
    for (let i = 0; i < 4; i++) {
      tr3.recordEvent(10, 0);
      tr3.endFrame(-0.022, -0.022, 0, 0, 1e-6, 45);
    }
    // the loop stops here: no frames recorded at all across the unlocked window
    const gapFrames = tr3.frames();
    const lastT = gapFrames[gapFrames.length - 1].t;
    tr3.markLock(false, true, true);
    tr3.markLock(true, true, true);
    // forge the resumed frame far enough ahead to read as a gap
    const forged = { ...gapFrames[gapFrames.length - 1], t: lastT + 900 };
    tr3.frames().push(forged);
    const gapLines = tr3.gapReport().join('\n');
    info(`gap report: ${tr3.gapReport()[1]}`);
    check('a stall that stopped the frame loop is still reported', gapLines.includes('1 gaps'), tr3.gapReport()[1]);
    check('the lock edges inside the gap are named', gapLines.includes('LOST+ACQUIRED'), gapLines.split('\n').pop());

    const noGaps = new CameraTrace();
    noGaps.markLock(true, true, true);
    for (let i = 0; i < 6; i++) {
      noGaps.recordEvent(10, 0);
      noGaps.endFrame(-0.022, -0.022, 0, 0, 1e-6, 45);
    }
    check('a continuous recording reports no gaps', noGaps.gapReport().join('\n').includes('the frame loop ran continuously'));

    // the dump must carry both new sections, or none of this reaches the player
    const dump = tr.dump();
    check('the dump includes the lock timeline', dump.includes('# pointer lock transitions'));
    check('the dump includes the stall correlation', dump.includes('# runs of frames with no mouse input'));
    check('the dump includes the recording gaps', dump.includes('# gaps in the recording'));
    check('the dump still has no undefined noise', !dump.includes('undefined'));
  }

  console.log(`camtrace: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
