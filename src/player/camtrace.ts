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
}

const RING = 900;

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
   * Close the frame.
   *
   * `appliedYaw` is what the game actually added to the player's yaw this frame
   * (already signed), `wantYaw` what the clamped input called for. `eps` absorbs
   * float noise from the wrap and the clamp.
   */
  endFrame(appliedYaw: number, wantYaw: number, appliedPitch: number, wantPitch: number, eps = 1e-9): void {
    const events = this.pendingEvents;
    const rawX = this.pendingRawX;
    const spikeX = this.pendingSpike;
    const relock = this.relockPending;

    let note: TraceFrame['note'] = '';
    const dz = Math.abs(appliedYaw - wantYaw);
    const dp = Math.abs(appliedPitch - wantPitch);
    if (relock) note = 'relock';
    else if (dz > eps) note = 'unexplained';
    else if (spikeX > 0 && spikeX > 180) note = 'spike';
    else if (dp > eps) note = 'pitch-clamp';
    else if (events === 0 && Math.abs(appliedYaw) > eps) note = 'no-input-turn';

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
    };
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
    return `camera trace: ${t.frames}f  gated ${this.gatedFrames}f (max ${t.worstRejected.toFixed(0)}px)  unexplained ${t.unexplained}  no-input ${t.noInputTurns}  relock ${t.relocks}  worst ${t.worstUnexplained.toFixed(4)}rad\n${latest}`;
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
    // the window around the newest anomaly, so the run-up is visible
    let newest = -1;
    for (let i = this.ring.length - 1; i >= 0; i--) {
      if (this.ring[i].note !== '') {
        newest = i;
        break;
      }
    }
    if (newest >= 0) {
      lines.push('');
      lines.push('# frames around the newest anomaly');
      for (let i = Math.max(0, newest - 12); i <= Math.min(this.ring.length - 1, newest + 12); i++) {
        const f = this.ring[i];
        const mark = i === newest ? '>>' : '  ';
        lines.push(
          `${mark} ${f.t} ${f.note || '-'} events=${f.events} rawX=${f.rawX.toFixed(1)} spike=${f.spikeX.toFixed(0)} dYaw=${f.dYaw.toFixed(6)} want=${f.wantYaw.toFixed(6)}`,
        );
      }
    }
    if (!this.ring.some((f) => f.note)) {
      lines.push('');
      lines.push('(no anomalies recorded - if the camera still jolted, the cause is');
      lines.push(' not a rotation the input cannot account for)');
    }
    return lines.join('\n');
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
  }
}
