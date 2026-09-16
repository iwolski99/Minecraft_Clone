/**
 * Camera shift tracer.
 *
 * A bug that has resisted several attempts: the view occasionally jolts
 * sideways while the mouse is being moved, sometimes without any input at all,
 * and it is lopsided - happening far more often sweeping one way than the other.
 * It is rare and not reproducible on demand, so theorising about it has not
 * worked. This records what actually happens, frame by frame, and flags the
 * frames that cannot be explained by the input.
 *
 * The invariant it checks is simple and exact. Mouse movement is accumulated
 * from events and applied once per frame as `yaw -= dx * sensitivity`. So for
 * every frame:
 *
 *     applied yaw change == -clamped delta * sensitivity
 *
 * Any frame that breaks that - the camera turning by an amount the mouse cannot
 * account for - is a genuine shift, and the buffer around it says whether it was
 * a spike, a dropped or doubled frame, a pitch clamp, or a pointer-lock change.
 *
 * Kept free of three.js and the DOM so it can be driven headlessly.
 */

/** One recorded frame. */
export interface TraceFrame {
  /** ms since the trace started */
  t: number;
  /** mousemove events folded into this frame */
  events: number;
  /** raw movementX summed over those events */
  rawX: number;
  /** largest |movementX| seen in a single event this frame */
  spikeX: number;
  /** yaw actually applied */
  dYaw: number;
  /** yaw the input accounts for */
  wantYaw: number;
  /** pitch actually applied */
  dPitch: number;
  /** pitch the input accounts for, before clamping */
  wantPitch: number;
  /** classification, empty when the frame is fully explained */
  note: '' | 'spike' | 'unexplained' | 'pitch-clamp' | 'relock' | 'no-input-turn';
  /** how long the frame took, in ms - so px per frame can be read as px per second */
  dtMs: number;
  /** whether the pointer was locked while this frame was drawn */
  locked: boolean;
  /** whether the pointer lock changed hands during this frame */
  lockEdge: boolean;
}

/**
 * One pointer-lock transition.
 *
 * The trace previously recorded only that a transition had happened, which was
 * enough to see 8-16 of them per session arriving in pairs ~100 ms apart and not
 * enough to say anything about why. The direction of the edge, whether the
 * document still had focus, and how long the previous state lasted are what
 * distinguish the browser dropping the lock from this code releasing it.
 */
export interface LockEvent {
  /** ms since the trace started */
  t: number;
  /** true when this edge acquired the lock, false when it lost it */
  locked: boolean;
  /** `document.hasFocus()` at the edge - a lost focus explains a lost lock */
  focused: boolean;
  /** `document.visibilityState === 'visible'` at the edge */
  visible: boolean;
  /** how long the previous lock state had lasted, in ms */
  heldMs: number;
}

const RING = 900;
/** how many anomalies get their surrounding frames printed in a dump */
const WINDOWS = 6;
/** how many frames either side of an anomaly to print */
const SPAN = 12;

export class CameraTrace {
  private readonly ring: TraceFrame[] = [];
  private readonly start = Date.now();

  /** events folded into the frame currently being recorded */
  private pendingEvents = 0;
  private pendingRawX = 0;
  private pendingRawY = 0;
  private pendingSpike = 0;

  /** counters, for the summary */
  readonly totals = {
    frames: 0,
    spikes: 0,
    unexplained: 0,
    noInputTurns: 0,
    relocks: 0,
    worstUnexplained: 0,
    worstSpike: 0,
    /** largest mouse report discarded as impossible */
    worstRejected: 0,
  };

  /** set by the game when pointer lock changes, consumed by the next frame */
  private relockPending = false;

  /** every pointer-lock transition, oldest first */
  private readonly lockEvents: LockEvent[] = [];
  /** current lock state, and when it was entered */
  private lockedNow = false;
  private lockSince = 0;
  /** frames drawn while the pointer was not locked - the camera is frozen for these */
  unlockedFrames = 0;

  /**
   * Note a mouse report that was discarded as impossible before it could affect
   * the camera.
   *
   * Kept separate from `recordEvent`: a rejected report must not contribute to
   * the rotation the frame expects, or every discard would itself look like a
   * discrepancy. It is counted and its magnitude remembered so the trace reports
   * what was thrown away rather than a misleadingly clean sky.
   */
  /**
   * Note that a frame's look input was discarded as spurious.
   *
   * The rotation will legitimately read zero for that frame, so without this the
   * trace would show a still frame and hide the fact that movement was thrown
   * away rather than there having been none.
   */
  noteGate(rejected: boolean): void {
    if (rejected) this.gatedFrames++;
  }

  /** frames whose look input was discarded by the gate */
  gatedFrames = 0;

  recordRejected(rawX: number, rawY: number): void {
    this.rejectedEvents++;
    const m = Math.max(Math.abs(rawX), Math.abs(rawY));
    if (m > this.totals.worstRejected) this.totals.worstRejected = m;
  }

  rejectedEvents = 0;

  /** Called for every mousemove event, with raw (unclamped) movement. */
  recordEvent(rawX: number, rawY: number): void {
    this.pendingEvents++;
    this.pendingRawX += rawX;
    this.pendingRawY += rawY;
    const ax = Math.abs(rawX);
    if (ax > this.pendingSpike) this.pendingSpike = ax;
  }

  /** Called when the pointer lock is acquired or released. */
  markRelock(): void {
    this.relockPending = true;
    this.totals.relocks++;
  }

  /**
   * Record a pointer-lock transition with the context needed to explain it.
   *
   * `markRelock` only ever said "something happened". Whether the lock was lost
   * or gained, whether the window still had focus, and how long the state before
   * it lasted are what turn a pair of anonymous relocks into a diagnosis: a lost
   * lock while focus was also lost is the OS or another window taking it, a lost
   * lock with focus intact is the browser or this code, and the gap between the
   * two edges is exactly how long the camera was frozen.
   */
  markLock(locked: boolean, focused: boolean, visible: boolean): void {
    const t = Date.now() - this.start;
    const heldMs = this.lockEvents.length === 0 ? 0 : t - this.lockSince;
    this.lockEvents.push({ t, locked, focused, visible, heldMs });
    if (this.lockEvents.length > 200) this.lockEvents.shift();
    this.lockedNow = locked;
    this.lockSince = t;
    this.markRelock();
  }

  /** Every recorded lock transition. For tests. */
  locks(): readonly LockEvent[] {
    return this.lockEvents;
  }

  /**
   * Total time the pointer lock was absent while the trace was running.
   *
   * This is the upper bound on how much of the jagged sweep a lost lock can
   * possibly account for: while unlocked the mousemove handler returns early, so
   * the camera cannot move at all.
   */
  unlockedMs(): number {
    let total = 0;
    for (let i = 0; i < this.lockEvents.length; i++) {
      const e = this.lockEvents[i];
      if (e.locked && e.heldMs > 0 && i > 0 && !this.lockEvents[i - 1].locked) total += e.heldMs;
    }
    return total;
  }

  /**
   * Close the frame.
   *
   * `appliedYaw` is what the game actually added to the player's yaw this frame
   * (already signed), `wantYaw` what the clamped input called for. `eps` absorbs
   * float noise from the wrap and the clamp.
   */
  endFrame(
    appliedYaw: number,
    wantYaw: number,
    appliedPitch: number,
    wantPitch: number,
    eps = 1e-9,
    dtMs = 0,
  ): void {
    const events = this.pendingEvents;
    const rawX = this.pendingRawX;
    const spikeX = this.pendingSpike;
    const relock = this.relockPending;

    /*
     * A lock transition must not hide anything.
     *
     * This used to test `relock` first, so a frame that both changed lock state
     * and turned by an amount the input could not account for was filed as
     * 'relock' and never counted as unexplained - and the same for a spike. The
     * whole case for "the look code is innocent" rests on `unexplained 0` across
     * three captures, and those captures contain 8-16 relock frames each: the one
     * kind of frame most under suspicion was the one kind exempt from the check.
     * The lock edge is now recorded alongside the classification instead of
     * replacing it, and 'relock' is only the verdict when nothing worse applies.
     */
    let note: TraceFrame['note'] = '';
    const dz = Math.abs(appliedYaw - wantYaw);
    const dp = Math.abs(appliedPitch - wantPitch);
    if (dz > eps) note = 'unexplained';
    else if (spikeX > 0 && spikeX > 180) note = 'spike';
    else if (dp > eps) note = 'pitch-clamp';
    else if (events === 0 && Math.abs(appliedYaw) > eps) note = 'no-input-turn';
    else if (relock) note = 'relock';

    const frame: TraceFrame = {
      t: Date.now() - this.start,
      events,
      rawX,
      spikeX,
      dYaw: appliedYaw,
      wantYaw,
      dPitch: appliedPitch,
      wantPitch,
      note,
      dtMs,
      locked: this.lockedNow,
      lockEdge: relock,
    };
    if (!this.lockedNow) this.unlockedFrames++;
    this.ring.push(frame);
    if (this.ring.length > RING) this.ring.shift();

    this.totals.frames++;
    if (note === 'spike') this.totals.spikes++;
    if (note === 'unexplained') this.totals.unexplained++;
    if (note === 'no-input-turn') this.totals.noInputTurns++;
    if (dz > this.totals.worstUnexplained) this.totals.worstUnexplained = dz;
    if (spikeX > this.totals.worstSpike) this.totals.worstSpike = spikeX;

    this.pendingEvents = 0;
    this.pendingRawX = 0;
    this.pendingRawY = 0;
    this.pendingSpike = 0;
    this.relockPending = false;
  }

  /** Frames flagged with the given note, newest first. */
  anomalies(limit = 40): TraceFrame[] {
    const out: TraceFrame[] = [];
    for (let i = this.ring.length - 1; i >= 0 && out.length < limit; i--) {
      if (this.ring[i].note) out.push(this.ring[i]);
    }
    return out;
  }

  /** One line per anomaly, plus a total - what F3 shows. */
  summary(): string {
    const t = this.totals;
    if (t.frames === 0) return 'camera trace: no frames yet';
    const a = this.anomalies(1)[0];
    const latest = a
      ? `  latest ${a.note} @${(a.t / 1000).toFixed(1)}s dYaw ${a.dYaw.toFixed(4)} want ${a.wantYaw.toFixed(4)} events ${a.events} spike ${a.spikeX.toFixed(0)}`
      : '  no anomalies';
    return `camera trace: ${t.frames}f  gated ${this.gatedFrames}f (max ${t.worstRejected.toFixed(0)}px)  unexplained ${t.unexplained}  no-input ${t.noInputTurns}  relock ${t.relocks} (${this.unlockedMs()}ms unlocked, ${this.unlockedFrames}f frozen)  worst ${t.worstUnexplained.toFixed(4)}rad\n${latest}`;
  }

  /**
   * A pasteable report: the totals, every anomaly, and the raw frames around the
   * newest one so the moments either side are visible.
   */
  dump(): string {
    const lines: string[] = [];
    const t = this.totals;
    lines.push('# CubeWorld camera trace');
    lines.push(
      `frames ${t.frames}  spikes ${t.spikes}  unexplained ${t.unexplained}  no-input turns ${t.noInputTurns}  relocks ${t.relocks}`,
    );
    lines.push(`worst unexplained rotation ${this.totals.worstUnexplained.toFixed(6)} rad`);
    lines.push(`worst single-event movement ${t.worstSpike.toFixed(0)} px`);
    lines.push('');
    lines.push('# anomalies (newest first)');
    lines.push('t_ms note events rawX spikeX dYaw wantYaw dPitch wantPitch');
    for (const f of this.anomalies(60)) {
      lines.push(
        `${f.t} ${f.note} ${f.events} ${f.rawX.toFixed(1)} ${f.spikeX.toFixed(0)} ${f.dYaw.toFixed(6)} ${f.wantYaw.toFixed(6)} ${f.dPitch.toFixed(6)} ${f.wantPitch.toFixed(6)}`,
      );
    }
    /*
     * The run-up around several anomalies, not just the newest.
     *
     * This used to print one window, around the newest anomaly only, and that
     * cost two rounds of investigation: a capture would contain nineteen leaks
     * and exactly one of them could be replayed against real data, because the
     * other eighteen had no surrounding frames to replay. What a frame's
     * neighbours were is the whole diagnosis here - the same 480 px event is
     * stopped or applied depending entirely on what preceded it.
     */
    const anomalyIndices: number[] = [];
    for (let i = this.ring.length - 1; i >= 0 && anomalyIndices.length < WINDOWS; i--) {
      if (this.ring[i].note === '') continue;
      // skip one already covered by a printed window, so the windows spread out
      if (anomalyIndices.some((j) => Math.abs(j - i) <= SPAN)) continue;
      anomalyIndices.push(i);
    }
    for (const centre of anomalyIndices) {
      lines.push('');
      lines.push(`# frames around the anomaly at ${this.ring[centre].t} ms (${this.ring[centre].note})`);
      lines.push('   t_ms note events rawX spike dt_ms locked dYaw want');
      for (let i = Math.max(0, centre - SPAN); i <= Math.min(this.ring.length - 1, centre + SPAN); i++) {
        const f = this.ring[i];
        const mark = i === centre ? '>>' : '  ';
        lines.push(
          `${mark} ${f.t} ${f.note || '-'} events=${f.events} rawX=${f.rawX.toFixed(1)} spike=${f.spikeX.toFixed(0)} dt=${f.dtMs.toFixed(0)} ${f.locked ? 'locked' : 'UNLOCKED'} dYaw=${f.dYaw.toFixed(6)} want=${f.wantYaw.toFixed(6)}`,
        );
      }
    }
    lines.push('');
    lines.push(...this.lockReport());
    lines.push('');
    lines.push(...this.stallReport());
    if (!this.ring.some((f) => f.note)) {
      lines.push('');
      lines.push('(no anomalies recorded - if the camera still jolted, the cause is');
      lines.push(' not a rotation the input cannot account for)');
    }
    return lines.join('\n');
  }

  /**
   * Every pointer-lock transition, with the state around it.
   *
   * The captures show these arriving in pairs about 100 ms apart, which is the
   * shape of the lock being lost and immediately regained - and while it is lost
   * the mousemove handler returns early, so the camera cannot move at all. This
   * says which edge is which, whether the window still had focus across it, and
   * exactly how long the gap was.
   */
  lockReport(): string[] {
    const lines: string[] = ['# pointer lock transitions'];
    if (this.lockEvents.length === 0) {
      lines.push('(none recorded)');
      return lines;
    }
    lines.push(`total time unlocked ${this.unlockedMs()} ms over ${this.lockEvents.length} transitions`);
    lines.push(`frames drawn while unlocked ${this.unlockedFrames} of ${this.totals.frames}`);
    lines.push('t_ms edge focused visible held_ms');
    for (const e of this.lockEvents) {
      lines.push(
        `${e.t} ${e.locked ? 'ACQUIRED' : 'LOST    '} ${e.focused ? 'focus' : 'NOFOCUS'} ${e.visible ? 'visible' : 'HIDDEN '} ${e.heldMs}`,
      );
    }
    return lines;
  }

  /**
   * Runs of consecutive frames that received no mouse input at all, correlated
   * against the lock transitions.
   *
   * This is the measurement that separates the two theories of the jagged sweep.
   * If the stalls line up with unlocked windows, the lock is the cause and no
   * amount of input filtering will help. If they do not, the camera is being
   * starved of input for some other reason - and the gate, which also produces
   * zero-movement frames, is the first suspect.
   */
  stallReport(): string[] {
    const lines: string[] = ['# runs of frames with no mouse input'];
    const runs: { from: number; to: number; frames: number; ms: number; unlocked: number }[] = [];
    let i = 0;
    while (i < this.ring.length) {
      if (this.ring[i].events !== 0) {
        i++;
        continue;
      }
      let j = i;
      let unlocked = 0;
      let ms = 0;
      while (j < this.ring.length && this.ring[j].events === 0) {
        if (!this.ring[j].locked) unlocked++;
        ms += this.ring[j].dtMs;
        j++;
      }
      // A single quiet frame is just a still hand; a run is a stall.
      if (j - i >= 2) {
        runs.push({ from: this.ring[i].t, to: this.ring[j - 1].t, frames: j - i, ms, unlocked });
      }
      i = j;
    }
    if (runs.length === 0) {
      lines.push('(none - every frame received mouse input)');
      return lines;
    }
    const explained = runs.filter((r) => r.unlocked > 0).length;
    lines.push(`${runs.length} runs, ${explained} overlap an unlocked window, ${runs.length - explained} do not`);
    lines.push('from_ms to_ms frames ms unlocked_frames');
    for (const r of runs.slice(-40)) {
      lines.push(`${r.from} ${r.to} ${r.frames} ${r.ms.toFixed(0)} ${r.unlocked}`);
    }
    lines.push(...this.gapReport());
    return lines;
  }

  /**
   * Stretches where the trace stopped recording altogether.
   *
   * Losing the pointer lock calls `pause()`, which stops the frame loop - so a
   * lock-induced stall leaves no zero-input frames to find, only a hole in the
   * timeline. Without this the stall report would confidently find nothing and
   * the lock theory would look disproved when it had simply been invisible. A
   * gap bracketed by a LOST/ACQUIRED pair is the signature being looked for.
   */
  gapReport(): string[] {
    const lines: string[] = ['# gaps in the recording (the frame loop stopped)'];
    const gaps: { from: number; to: number; ms: number }[] = [];
    for (let i = 1; i < this.ring.length; i++) {
      const prev = this.ring[i - 1];
      const cur = this.ring[i];
      const expected = Math.max(prev.dtMs, cur.dtMs, 1);
      const actual = cur.t - prev.t;
      // Generous: only a gap several frames long is worth reporting.
      if (actual > expected * 3 + 50) gaps.push({ from: prev.t, to: cur.t, ms: actual });
    }
    if (gaps.length === 0) {
      lines.push('(none - the frame loop ran continuously)');
      return lines;
    }
    lines.push(`${gaps.length} gaps`);
    lines.push('from_ms to_ms ms lock_edges_inside');
    for (const g of gaps.slice(-20)) {
      const inside = this.lockEvents.filter((e) => e.t >= g.from && e.t <= g.to);
      const desc = inside.length === 0 ? 'none' : inside.map((e) => (e.locked ? 'ACQUIRED' : 'LOST')).join('+');
      lines.push(`${g.from} ${g.to} ${g.ms} ${desc}`);
    }
    return lines;
  }

  /** Every frame recorded, oldest first. For tests. */
  frames(): readonly TraceFrame[] {
    return this.ring;
  }

  reset(): void {
    this.ring.length = 0;
    this.pendingEvents = 0;
    this.pendingRawX = 0;
    this.pendingRawY = 0;
    this.pendingSpike = 0;
    this.relockPending = false;
    this.totals.frames = 0;
    this.totals.spikes = 0;
    this.totals.unexplained = 0;
    this.totals.noInputTurns = 0;
    this.totals.relocks = 0;
    this.totals.worstUnexplained = 0;
    this.totals.worstSpike = 0;
    this.totals.worstRejected = 0;
    this.rejectedEvents = 0;
    this.gatedFrames = 0;
    this.lockEvents.length = 0;
    this.lockedNow = false;
    this.lockSince = 0;
    this.unlockedFrames = 0;
  }
}
