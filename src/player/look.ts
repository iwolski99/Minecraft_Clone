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
 * This is self-calibrating. There is no fixed number that goes stale when the
 * mouse, the sensitivity or the player's habits change, which is precisely how
 * the previous two attempts failed.
 */
export class LookGate {
  /** magnitudes of recent frames, the baseline an outlier is judged against */
  private readonly recent: number[] = [];
  private static readonly WINDOW = 24;
  /** a frame below this is never rejected, however unusual */
  private static readonly FLOOR = 70;
  /** how far above the recent median a frame must be to count as spurious */
  private static readonly RATIO = 8;

  /** Frames rejected as spurious, and the largest rejected magnitude. */
  rejected = 0;
  worstRejected = 0;
  /** Frames accepted, and the largest accepted magnitude - for cross-checking. */
  accepted = 0;
  worstAccepted = 0;
  /**
   * Consecutive rejections.
   *
   * A spurious report is a *lone* frame; a fast sweep is a *run* of them. Without
   * this, a player who held a genuinely fast turn would be locked out forever:
   * rejected frames never enter the baseline, so the median stays at the old low
   * value and every subsequent fast frame is judged against it. The second
   * consecutive large frame is therefore taken as real, and the baseline is
   * rebuilt from it.
   */
  private consecutiveRejects = 0;

  private median(): number {
    if (this.recent.length === 0) return 0;
    const s = [...this.recent].sort((a, b) => a - b);
    return s[s.length >> 1];
  }

  /**
   * Judge one frame's accumulated look delta. Returns [0, 0] when the frame is
   * rejected, which drops that frame's rotation entirely.
   */
  check(dx: number, dy: number): [number, number] {
    if (!Number.isFinite(dx) || !Number.isFinite(dy)) return [0, 0];
    const mag = Math.hypot(dx, dy);
    const med = this.median();
    const limit = Math.max(LookGate.FLOOR, med * LookGate.RATIO);
    if (mag > limit && this.recent.length >= 4 && this.consecutiveRejects === 0) {
      this.rejected++;
      this.consecutiveRejects++;
      if (mag > this.worstRejected) this.worstRejected = mag;
      // A rejected frame deliberately does not enter the baseline, or one spike
      // would raise the bar enough to let its successors through.
      return [0, 0];
    }
    // Accepted, either as ordinary movement or as the second frame of a run -
    // in which case the baseline is rebuilt so the new rate becomes the norm.
    if (this.consecutiveRejects > 0) {
      this.consecutiveRejects = 0;
      this.recent.length = 0;
    }
    this.recent.push(mag);
    if (this.recent.length > LookGate.WINDOW) this.recent.shift();
    this.accepted++;
    if (mag > this.worstAccepted) this.worstAccepted = mag;
    return [dx, dy];
  }

  reset(): void {
    this.recent.length = 0;
    this.rejected = 0;
    this.worstRejected = 0;
    this.accepted = 0;
    this.worstAccepted = 0;
    this.consecutiveRejects = 0;
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
