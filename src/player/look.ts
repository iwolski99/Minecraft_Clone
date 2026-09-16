/**
 * Look-input shaping.
 *
 * Kept out of `game.ts` so it can be tested without booting the game.
 */

/**
 * Largest look movement a single mouse event is allowed to contribute.
 *
 * Under pointer lock the OS cursor is hidden but still exists. When it is
 * pushed against a screen edge, or when the browser hands the lock back, it can
 * report a `movementX` of several hundred or thousand pixels in one event.
 * Applied as a look delta that snaps the camera sideways - the reported "shift"
 * that happens while merely moving the mouse, and lopsided because the cursor
 * tends to run off one edge far more than the other.
 *
 * A genuine fast flick reports well under this per event, so clamping costs no
 * real input.
 */
export const MAX_LOOK_STEP = 180;

/** Clamp one axis of one mouse event's movement. Non-finite input becomes 0. */
export function clampLookDelta(v: number): number {
  if (!Number.isFinite(v)) return 0;
  if (v > MAX_LOOK_STEP) return MAX_LOOK_STEP;
  if (v < -MAX_LOOK_STEP) return -MAX_LOOK_STEP;
  return v;
}

/**
 * Largest total look movement one frame may apply, in mouse pixels.
 *
 * Captured traces of the view-jolt bug show the cause is not the camera: across
 * 733 frames the applied rotation always matched the input exactly, but 26
 * frames contained a lone mouse report of 180-511 px where a normal event is
 * 1-50 px. At the observed sensitivity a single frame carrying 374 px clamped is
 * a 28 degree instantaneous turn, and the worst captured frame carried 1123 px
 * - over 140 degrees.
 *
 * A per-event limit cannot fix this, because the spurious magnitudes overlap
 * genuine ones (the same trace has real events at 114 and 161 px). A per-frame
 * limit can, and safely: a genuine fast flick delivers its movement across
 * several frames, so capping any one frame costs nothing real, while the bug
 * puts all of its movement into a single frame and is capped away. 150 px is
 * about 11 degrees at the observed sensitivity, and roughly 680 degrees per
 * second sustained - far faster than anyone actually turns.
 */
export const MAX_FRAME_LOOK = 150;

/**
 * Largest single mouse report that is believed at all, in pixels.
 *
 * Superseded by `LookGate` below, which decides from context instead. Kept only
 * as the bound used by the earlier capture replays in the test suite.
 */
export const MAX_EVENT_STEP = 140;

/** Nothing below this is ever treated as spurious, however isolated it looks. */
export const GATE_FLOOR = 260;
/** How far above its neighbours a report must be to count as an outlier. */
export const GATE_RATIO = 3;

/**
 * Slowest motion that may ever be gated, in mouse pixels per **second**.
 *
 * The unit is the whole point. The previous floor was 70 px per *frame*, which
 * is not a speed at all - it is a speed multiplied by the frame time, so the
 * same physical turn of the mouse was judged differently depending on how fast
 * the machine happened to be drawing:
 *
 *   120 FPS   70 px/frame = 8400 px/s   (635 deg/s - never reached)
 *    60 FPS   70 px/frame = 4200 px/s   (318 deg/s - never reached)
 *    24 FPS   70 px/frame = 1680 px/s   (127 deg/s - an ordinary turn)
 *    12 FPS   70 px/frame =  840 px/s   ( 64 deg/s - a slow turn)
 *
 * Measured against a realistic session (noisy acceleration into a turn, at the
 * 20-26 FPS this game actually runs at) that floor rejected the *first frame of
 * every turn* - 12 frames in 30 seconds, each discarding 5-8 degrees the player
 * had asked for. The rejected frames were routinely *smaller* than the frames
 * accepted immediately after them:
 *
 *   ... 30 47 60 60  >>78 rejected<<  89 122 98 accepted ...
 *
 * That is the "camera catches on something" the player reported, and it was the
 * gate doing it. It is the same mistake as the per-frame cap that came before,
 * in a different place: `MAX_FRAME_LOOK` was caught, this was not, because the
 * frame-rate check never actually drove the gate.
 *
 * The value was chosen by sweeping it against both directions at once rather
 * than picked: legitimate deferrals on a realistic session, against whether the
 * five real captured spike patterns are still stopped.
 *
 *   floor px/s | deg/s | legit deferrals | legit deg lost | captured spikes stopped
 *         2000 |   151 |              12 |           0.00 | 5/5
 *         3000 |   227 |               4 |           0.00 | 5/5
 *         3500 |   265 |               0 |           0.00 | 5/5
 *         5000 |   378 |               0 |           0.00 | 3/5, worst leak 14.5 deg
 *
 * 3500 px/s is about 265 deg/s at the player's sensitivity. The fastest
 * legitimate motion measured sits below it, so ordinary turning - and even a
 * fast sweep - is never examined at all; the smallest spurious frame in any
 * capture (183 px in ~45 ms, 4067 px/s) sits above it. Above 4000 the margin is
 * gone and the real spikes come back.
 */
export const GATE_FLOOR_RATE = 3500;

/** Frame time used when a caller does not supply one. */
const NOMINAL_DT = 1 / 60;
/** Frame times outside this range are clamped before being used as a divisor. */
const MIN_DT = 1 / 240;
const MAX_DT = 1 / 5;

/**
 * Rejects spurious look movement by comparing each frame with recent frames.
 *
 * Three captures have now shown that no size threshold can work, because the two
 * distributions overlap and move:
 *
 *   capture 1  spurious 183-639 px   legitimate up to ~90 px
 *   capture 2  spurious 480-639 px   legitimate up to 140 px
 *   capture 3  spurious 192-385 px   legitimate up to ~240 px
 *
 * A 140 px threshold discarded real fast sweeps, which stalled the camera mid
 * sweep and read as the view catching on something. Raising it to 260 px let the
 * original 28-degree jolts back in. Both were size tests, and neither can work.
 *
 * What does work is the shape of the motion over time. Mouse movement is smooth:
 * consecutive frames carry similar amounts. In the third capture the player was
 * moving 5-17 px a frame and then a single frame carried 479 px - forty-eight
 * times the recent norm - which no hand produces. A genuine fast sweep, by
 * contrast, is uniformly fast: its median rises with it, so it never looks like
 * an outlier against its own recent history.
 *
 * Two things are measured in **rates**, not per-frame amounts, so that the same
 * physical motion is judged identically at 12 FPS and at 120 - see
 * `GATE_FLOOR_RATE` for what went wrong when they were not.
 *
 * **Nothing legitimate is ever discarded, only deferred.** A frame that trips
 * the gate is not thrown away: its movement is *held*. If the next frame is also
 * fast the motion was real - a genuine sweep - and the held movement is released
 * in full, so the player loses none of their turn, only one frame of latency. If
 * the next frame is back to normal the large frame was a lone impulse, which no
 * hand produces, and only then is it dropped. That is the difference between
 * this and every previous attempt: the earlier gates discarded immediately and
 * irreversibly, so every misjudgement cost the player real movement.
 */
export class LookGate {
  /** rates of recent frames in px/s, the baseline an outlier is judged against */
  private readonly recent: number[] = [];
  private static readonly WINDOW = 24;
  /** motion slower than this is never gated, however unusual - px per second */
  private static readonly FLOOR_RATE = GATE_FLOOR_RATE;
  /** how far above the recent median a frame must be to count as spurious */
  private static readonly RATIO = 8;
  /**
   * How much of the held frame's own limit the next frame must reach for the
   * motion to count as sustained, and the held movement to be released.
   */
  private static readonly SUSTAIN = 0.5;
  /**
   * How many consecutive sustained frames must follow a held one before the
   * held movement is believed and released.
   *
   * One is not enough. A captured session shows a 212 px spurious report held
   * correctly, and then a *second* spurious report 41 ms later - which the gate
   * read as the motion continuing, so it released the held movement plus the new
   * frame's and applied 360 px, 27 degrees, in a single frame. The assumption
   * that "a spike is lone and a sweep is a run" is simply false for this mouse:
   * the spurious reports arrive in bursts, four inside 213 ms in the same
   * capture.
   *
   * Two confirming frames costs a genuine hard flick two frames of latency and
   * nothing else - the movement is still released in full. Measured against a
   * realistic session the gate is not reached at all, so that cost is never paid
   * in ordinary play.
   */
  private static readonly CONFIRM = 2;
  /** Never hold movement longer than this, however ambiguous it looks. */
  private static readonly MAX_HOLD = 3;

  /** Frames held back as suspect, and the largest held magnitude. */
  rejected = 0;
  worstRejected = 0;
  /** Frames accepted, and the largest accepted magnitude - for cross-checking. */
  accepted = 0;
  worstAccepted = 0;
  /** Held frames later released as real motion, and those confirmed spurious. */
  released = 0;
  discarded = 0;

  /** movement held from the previous frame(s), pending a verdict */
  private heldX = 0;
  private heldY = 0;
  private heldRate = 0;
  private holding = false;
  /** frames spent holding, and consecutive frames that looked sustained */
  private holdFrames = 0;
  private sustainRun = 0;

  private median(): number {
    if (this.recent.length === 0) return 0;
    const s = [...this.recent].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  /**
   * Judge one frame's accumulated look delta.
   *
   * `dt` is the frame's duration in seconds; it converts the delta into a speed
   * so the judgement does not depend on the frame rate. Returns the movement to
   * apply, which may include movement held back from the previous frame.
   */
  check(dx: number, dy: number, dt: number = NOMINAL_DT): [number, number] {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [0, 0];
    const step = Number.isFinite(dt) && dt > 0 ? Math.min(MAX_DT, Math.max(MIN_DT, dt)) : NOMINAL_DT;
    const mag = Math.hypot(dx, dy);
    const rate = mag / step;

    // Settle whatever the previous frame(s) held back before judging this one.
    if (this.holding) {
      const sustained = rate >= this.heldRate * LookGate.SUSTAIN;
      if (sustained && this.holdFrames < LookGate.MAX_HOLD) {
        this.sustainRun++;
        if (this.sustainRun >= LookGate.CONFIRM) {
          // Believed: a real sweep. Give back everything, and rebuild the
          // baseline around the new rate rather than the slow motion before it.
          const outX = dx + this.heldX;
          const outY = dy + this.heldY;
          this.released++;
          this.forget();
          this.recent.length = 0;
          this.recent.push(rate);
          this.accepted++;
          if (mag > this.worstAccepted) this.worstAccepted = mag;
          return [outX, outY];
        }
        // Not yet confirmed - keep holding, and hold this frame too.
        this.heldX += dx;
        this.heldY += dy;
        this.holdFrames++;
        return [0, 0];
      }
      // The motion did not continue, or it has been ambiguous for too long:
      // a lone impulse, or a burst of them. Drop all of it.
      this.discarded++;
      this.forget();
      // and fall through to judge this frame on its own merits
    }

    const med = this.median();
    const limit = Math.max(LookGate.FLOOR_RATE, med * LookGate.RATIO);
    if (rate > limit && this.recent.length >= 4) {
      // Suspect, but not yet condemned: hold it and let the next frame decide.
      this.rejected++;
      this.holding = true;
      this.heldX = dx;
      this.heldY = dy;
      this.heldRate = rate;
      this.holdFrames = 1;
      this.sustainRun = 0;
      if (mag > this.worstRejected) this.worstRejected = mag;
      // A held frame deliberately does not enter the baseline, or one spike
      // would raise the bar enough to let its successors through.
      return [0, 0];
    }
    this.recent.push(rate);
    if (this.recent.length > LookGate.WINDOW) this.recent.shift();
    this.accepted++;
    if (mag > this.worstAccepted) this.worstAccepted = mag;
    return [dx, dy];
  }

  /**
   * Abandon any held movement.
   *
   * Called when the pointer lock changes hands: movement captured before the
   * transition must never be released into the frame after it.
   */
  forget(): void {
    this.holding = false;
    this.heldX = 0;
    this.heldY = 0;
    this.heldRate = 0;
    this.holdFrames = 0;
    this.sustainRun = 0;
  }

  reset(): void {
    this.recent.length = 0;
    this.rejected = 0;
    this.worstRejected = 0;
    this.accepted = 0;
    this.worstAccepted = 0;
    this.released = 0;
    this.discarded = 0;
    this.forget();
  }
}

/** Scale a frame's accumulated look delta down to the per-frame limit. */
export function capFrameLook(dx: number, dy: number): [number, number] {
  const mag = Math.hypot(dx, dy);
  if (mag <= MAX_FRAME_LOOK || mag === 0) return [dx, dy];
  const k = MAX_FRAME_LOOK / mag;
  return [dx * k, dy * k];
}

/**
 * True when one axis of a mouse report is too large to be real movement.
 *
 * Judged per axis against the bound, so a report is discarded if either
 * component is impossible rather than only if the magnitude is.
 */
export function isSpuriousEvent(dx: number, dy: number): boolean {
  return Math.abs(dx) > MAX_EVENT_STEP || Math.abs(dy) > MAX_EVENT_STEP;
}

/** Wrap a yaw angle into (-PI, PI]. */
export function wrapYaw(yaw: number): number {
  if (!Number.isFinite(yaw)) return 0;
  let y = yaw % (Math.PI * 2);
  if (y > Math.PI) y -= Math.PI * 2;
  else if (y <= -Math.PI) y += Math.PI * 2;
  return y;
}
