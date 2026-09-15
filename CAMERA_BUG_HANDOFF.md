# Handoff: the camera "shift" bug

A note for whoever picks this up next. It exists so you do not have to rediscover
what has already been established by measurement, and so you do not repeat the
three fixes that were tried and reverted.

Read this before touching the look path. Several plausible-sounding fixes have
already been tried and made things worse.

---

## The symptom, in the player's words

> "It's not that the camera position itself is shifting out of place, it's the
> rotation, the way my camera is facing, the direction my player is looking.
> It's like I'll be turning my player's head, and then the camera will jump. If I
> was turning to look east it might shift to looking south, or shift over 30
> degrees extra instantaneously, and that wasn't part of me moving my mouse."

Later refinement, which is important:

> "When I said the stars were stretched near the horizon that wasn't 100% true...
> If I looked in a different direction near the horizon, there were only slightly
> stretched ones." — i.e. the severity varies with view direction.

And the most recent description, which describes a *different* failure mode from
the big jumps:

> "The camera like jitters or stops frequently and it's not a smooth back and
> forth motion, it's like a jagged motion. You can tell it's not from the low FPS
> because my running and jumping are smooth but the camera is not. It's like the
> camera is getting caught on something."

**So there are two observable failure modes and they may or may not share a
cause:**

1. **A large instantaneous rotation** (~30 degrees, up to ~140 degrees in one
   captured frame).
2. **A jagged/stalling sweep** — the look advances, stalls, advances, while
   movement and jumping stay smooth.

The player also reports: *"it does feel like it's getting locked"*.

---

## What is PROVEN, not guessed

### The rotation code is not at fault

Three separate `F4` captures (real sessions, thousands of frames) all report:

```
unexplained 0        no-input turns 0        worst unexplained rotation 0.000000 rad
```

The tracer compares, every frame, the rotation actually applied against the
rotation the input justifies:

```
applied yaw change  ==  -clampLookDelta(movementX) * sensitivity
```

Across every capture that identity holds **exactly**. The camera never rotates by
anything the mouse reports do not account for, and never rotates with no input.
**So the fault is upstream of the look path: the mouse reports themselves are
sometimes wrong.**

Do not go looking for an accumulation bug, an ordering bug, a smoothing bug or a
double-apply in `frame()`. Those have been ruled out by measurement.

### The camera is derived directly from the player

```ts
// src/game.ts, in frame()
this.renderer3d.camera.position.set(p.position.x + bobX * ..., p.eyeY + bobY, ...);
this.renderer3d.camera.rotation.set(p.pitch, p.yaw, 0);
```

No smoothing, no interpolation, no separate camera state. A camera shift is
therefore always a change in `player.yaw` or `player.pitch`.

Mouse look is applied once per frame:

```ts
const wantYaw = -this.lookDeltaX * sens;      // sens = 0.0022 * settings.mouseSensitivity
...
this.player.yaw += wantYaw;
this.player.pitch += wantPitch;
const appliedYaw = this.player.yaw - beforeYaw;   // measured PRE-wrap, deliberately
this.player.pitch = clamp(...);
this.player.yaw = wrapYaw(this.player.yaw);
this.cameraTrace.endFrame(appliedYaw, wantYaw, appliedPitch, wantPitch, 1e-6);
```

### The spurious input is real and measurable

Magnitudes of individual mouse reports, from the captures. "Legitimate" means
seen during ordinary mouse movement; "spurious" means an isolated report that
produced a visible jolt.

| capture | spurious single reports | legitimate range |
|---|---|---|
| 1 | 183, 185, 192, 203, 216, 480, 481, 483, 484, 639 px | up to ~90 px |
| 2 | 183–639 px | up to 140 px |
| 3 | 192, 193, 194, 201, 211, 216, 220, 231, 235, 237, 243, 246, 249, 282, 311, 317, 330, 385 px | up to ~240 px |

**The two distributions overlap and they drift between sessions.** This is the
single most important fact in this document: it is why no fixed size threshold
can work, and why two of the three attempted fixes failed.

Example from capture 3 of a jolt in context — note the smooth run-up:

```
185664 rawX=-17
185704 rawX=-6
185741 rawX=-6
185777 rawX=-5
185814 events=4 rawX=-479.0 spikeX=235   dYaw=0.487080   <- 28 degrees in one frame
185855 rawX=-25
```

The player was moving 5–17 px per frame, then one frame carried 479 px.

The player's sensitivity works out at about **0.00132 rad/px**
(`0.0022 * mouseSensitivity`, with their setting around 0.6). So 490 px in one
report is **~37 degrees**, and the worst captured frame carried 4965 px across 23
events — **~141 degrees**.

### Frame rate is very low

Captured frame intervals are 38–50 ms, i.e. **20–26 FPS**, sometimes worse. This
matters twice over: it makes any *per-frame* judgement noisy, and it means a
smooth mouse motion is rendered as coarse steps, which by itself reads as jitter.

---

## What was tried, and why each failed

### 1. Per-event clamp at 180 px — IN THE CODE FOR A WHILE

Clamped each report to ±180 px. **Reduced the jolts from 141° to ~11°** — the
player confirmed it was "a bit better". But it did not remove the cause, and an
11° jolt is still a jolt.

### 2. Per-frame cap at 150 px — REMOVED, DO NOT REINSTATE

`capFrameLook(dx, dy)` scaled each frame's total down to 150 px. This bounded the
jolt at ~11° but **it is a rate that scales with frame rate**:

| frame rate | what 150 px/frame actually allows |
|---|---|
| 60 FPS | 9000 px/s — never reached |
| 24 FPS | 3600 px/s — a normal turn exceeds this |
| 12 FPS | 1800 px/s — badly throttled |

At the frame rates this game actually runs at, it silently applied a *fraction*
of the player's mouse movement, unevenly, frame by frame. The player reported:
*"my camera movements are slowed all the time and I can barely turn my
character's head... it jitters a little bit."* That was this.

**Any fix expressed in pixels per frame is wrong here. `qa-camtrace.mjs` has a
frame-rate independence check that will catch a reintroduction.**

### 3. Per-event rejection threshold at 140 px — REMOVED, DO NOT REINSTATE

Dropped any report whose magnitude exceeded 140 px. Caught the spikes, but the
player's *normal fast sweeps* produce reports of 100–140 px (capture 3 shows
accepted reports of 74, 138 and 103 px in a row). So it discarded legitimate
input: the camera advanced, stalled, advanced — the **jagged sweep** failure
mode. Reported as *"the camera is getting caught on something"*.

### 4. Context gate: `mag > 260 && mag > prevMag * 3` — SUPERSEDED

Dropped a report only if it was large *and* far larger than the one before it.
Better in principle, but the floor of 260 px let the capture-3 spikes (192–385 px)
straight through, and the big jolts came back.

---

## Where it stands now

`src/player/look.ts` contains **`LookGate`**, which judges each **frame** against
recent frames rather than any fixed size:

- Keeps the magnitudes of the last 24 frames as a baseline.
- Computes `limit = max(FLOOR=70, median * RATIO=8)`.
- Rejects a frame whose total exceeds `limit` — **unless the previous frame was
  also rejected** (a spurious report is a *lone* frame; a fast sweep is a *run*).
  That escape hatch matters: without it a player holding a fast turn is locked
  out forever, because rejected frames never enter the baseline. That deadlock
  was found by the test suite before shipping, at 6/60 frames kept.

This is self-calibrating, which is the point: there is no constant that can go
stale when the mouse, the sensitivity or the player's habits change.

`game.ts` calls it once per frame:

```ts
const [gx, gy] = this.lookGate.check(this.lookDeltaX, this.lookDeltaY);
const wantYaw = -gx * sens;
const wantPitch = -gy * sens;
```

**It is still not fully fixed.** The player reports the big jumps are gone or much
smaller, but residual jitter remains.

---

## The strongest unexplored lead: pointer lock

The player said, unprompted: *"I don't know what relocks are but it does feel
like it's getting locked."*

The tracer reports **8 to 16 `relock` events per session**, and they arrive in
**pairs about 100 ms apart**:

```
114420 relock
114514 relock      (+94ms)
129395 relock
129504 relock      (+109ms)
471193 relock
471284 relock      (+91ms)
```

`markRelock()` is called from the `pointerlockchange` listener in `game.ts`:

```ts
document.addEventListener('pointerlockchange', () => {
  this.pointerLocked = document.pointerLockElement === this.canvas;
  this.lookDeltaX = 0;
  this.lookDeltaY = 0;
  this.cameraTrace.markRelock();
  if (!this.pointerLocked && this.running && !this.containers.isOpen && !this.screens.isOpen) {
    this.pause();
  }
});
```

And the mouse handler drops every report while unlocked:

```ts
window.addEventListener('mousemove', (e) => {
  if (!this.pointerLocked) return;   // <-- no input at all while unlocked
  ...
});
```

**While the lock is gone, no look input arrives at all, so the camera freezes
completely.** If the lock is genuinely being dropped and re-acquired ~100 ms
later, that is a *third* mechanism for the jagged sweep, independent of the
spurious magnitudes — and it matches "it feels like it's getting locked".

**This has not been investigated.** Suggested first steps:

1. Log the reason and duration of every lock transition, not just that one
   happened. `document.pointerLockElement`, `document.hasFocus()`,
   `performance.now()` on each edge.
2. Correlate lock transitions against frames with `events=0` in the trace. There
   are long runs of zero-event frames in the captures (up to ~200 ms) and they
   have not been checked against the relock timestamps.
3. Establish whether the browser is dropping the lock (a browser/driver issue) or
   whether this code is calling `requestPointerLock()` or `exitPointerLock()`
   somewhere unexpectedly.
4. Note the un-explained oddity: normally losing the lock should call `pause()`
   and show a menu, which the player would notice. Either that path is not firing
   or the lock is being re-acquired fast enough to avoid it.

**If the lock theory is wrong, the next question is why a mouse produces reports
of 183–639 px at all.** Possible causes: OS pointer acceleration at a screen
edge, a high-polling-rate mouse with browser coalescing, or a driver quirk. That
is worth testing outside this codebase — the player should try a different mouse
and a different browser and compare `F4` dumps.

---

## The debugging tools that already exist

### `src/player/camtrace.ts` — `CameraTrace`

A ring buffer of the last 900 frames. Per frame it records: mousemove count, raw
`movementX` summed, largest single-event magnitude, applied yaw/pitch, and the
yaw/pitch the input justified. Each frame is classified:

`''` | `'spike'` | `'unexplained'` | `'pitch-clamp'` | `'relock'` | `'no-input-turn'`

- **`summary()`** is shown on the **F3** overlay.
- **`dump()`** is copied to the clipboard by **F4** (falls back to `console.log`
  with a toast if the clipboard is blocked, which it often is on `file://`).

**Critical detail:** `endFrame()` is called with the rotation measured *before*
the yaw wrap:

```ts
this.player.yaw += wantYaw;
const appliedYaw = this.player.yaw - beforeYaw;   // BEFORE wrapYaw
...
this.player.yaw = wrapYaw(this.player.yaw);
```

Measure it after the wrap and every wrap looks like a 6.28-radian jolt. There is
a test for exactly this (`qa-camtrace.mjs`, section 9).

**Ask the player for F4 dumps.** They are the ground truth here; three of them
have already redirected this investigation twice.

### `scripts/qa-camtrace.mjs` — 50 checks

Includes replays of the real captures, a frame-rate independence check, and
fast-sweep-preservation checks. Run with:

```
npm run qa:camtrace
```

**Both directions are tested, deliberately:** that spikes are rejected *and* that
fast sweeps are preserved. Every failed fix above passed one direction and failed
the other. A check that only asserts rejections will happily accept a fix that
destroys legitimate input.

### `npm run verify`

27 steps. Run it before believing anything.

---

## Traps and conventions

- **`qa-render` does NOT draw the sky, clouds, sun, moon or entities.** It builds
  its triangle list directly from chunk meshes and never traverses the scene. It
  cannot be used as evidence about anything in the sky. This has caused
  misdiagnosis more than once.
- **`npm run verify` compiles with `tsc` in-process; there is no bundler.**
- **GLSL has no implicit vector-size conversion** and a shader that fails to
  compile fails *silently* at runtime — three.js logs to the browser console,
  which nothing headless can see, and draws nothing for that material. `qa:shaders`
  now type-checks calls to user-defined shader functions; keep it passing.
- **The user's standing instruction: "test, don't theorise."** This bug has been
  misdiagnosed repeatedly by reasoning from the code. Measure, or ask for an F4
  dump.
- **Mutation-test new checks.** Remove the fix, confirm the check goes red, put it
  back. Several checks in this repo were written in a way that could never fail.

---

## Ranked suggestions

1. **Instrument the pointer-lock transitions properly.** It is the only signal in
   the captures that is unexplained, the player independently suspects it, and a
   frozen camera during an unlocked window matches the jagged sweep exactly.
2. **Correlate `events=0` frame runs against relock timestamps.** Cheap, and
   either confirms or kills the theory.
3. **Ask the player to test a different mouse and browser**, comparing F4 dumps.
   If the 183–639 px reports vanish, the cause is hardware/OS/driver and no code
   change will fix it — a per-report sanity filter is then the right answer.
4. **Reconsider whether the two failure modes are one bug.** The large jump is
   fully explained by spurious input magnitudes. The jagged sweep may be
   frame-rate-induced stepping *plus* input gaps, and may need a different fix
   (higher frame rate, or interpolating the look across the frame).
5. **Only then** revisit the gate thresholds, with a fresh F4 dump in hand.
