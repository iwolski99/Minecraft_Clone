# Handoff: the camera "shift" bug — current state

**Status: mostly fixed.** The player reports the jolts are now very small and
acceptable. This file replaces the earlier handoff, which is now wrong in its
main conclusion (it named pointer lock as the strongest lead; pointer lock has
since been measured and ruled out).

Branch: `claude/confident-goldberg-xh8e7o`. Three commits: `78b7502`, `6a80f4c`,
`c6e2a46`.

---

## What the bug was

The mouse itself emits spurious `movementX` reports of 183–639 px where ordinary
reports are 1–90 px. That is hardware/OS/driver, not code — nothing in this repo
causes it. The job of the code is to reject those reports without damaging real
input. Everything below is about that filter.

Two observable symptoms, and they had **different causes**:

1. **Large instantaneous rotation** (up to 45° in one captured frame) — caused by
   the spurious reports getting through the filter.
2. **Jagged/stalling sweep** — caused by the filter discarding *legitimate*
   input. This was self-inflicted.

---

## What was fixed

### 1. The gate's floor was in the wrong unit (the jagged sweep)

`LookGate.FLOOR` was **70 px per frame**, which is not a speed — it is a speed
times the frame time. Above 30 FPS it never fired; at the 12–26 FPS this game
actually runs at it rejected **the first frame of every ordinary turn**, 5–8° of
real movement each. The rejected frames were routinely *smaller* than the frames
accepted right after them:

```
... 30 47 60 60  >>78 rejected<<  89 122 98 accepted ...
```

Now judged in **pixels per second** (`GATE_FLOOR_RATE = 3500`), chosen by
sweeping it against both directions at once, not picked. A realistic session now
touches the gate zero times and loses 0.00°.

### 2. Suspect frames are deferred, not discarded

A frame that trips the gate is **held**, not thrown away. If the motion
continues it is released in full — the player loses no movement, only latency.
Only a lone impulse is dropped. Every earlier gate discarded irreversibly, so
every misjudgement cost real movement and stalled the camera.

### 3. The ±180 per-event clamp was hiding the spikes from the gate

This was the big one. `clampLookDelta` truncated every spurious report to
exactly 180 px. 543 px in a frame is 12,000 px/s and unmistakable; 180 px is
2100–4000 px/s — ordinary fast turning. **The clamp converted an impossible
report into a plausible one, and the gate passed it** — eight times in one
capture, 13.6° each. Removed from the accumulation path in `game.ts`.

### 4. Deferral released bursts as if they were sweeps

"A spike is lone, a sweep is a run" is **false for this mouse** — one capture has
four spurious reports inside 213 ms. A 212 px report was held correctly, then a
second spurious 197 px arrived 41 ms later, was read as "motion continuing", and
both were released: 360 px = 27.2° in one frame. Release now requires
`CONFIRM = 2` consecutive confirming frames.

### 5. The tracer was hiding evidence

`endFrame()` tested the pointer-lock edge *first*, so a frame that both changed
lock state and jolted was filed as `relock` and **never counted as
unexplained**. The "unexplained 0" evidence the whole investigation rested on was
blind on exactly the frames under most suspicion. Fixed — the lock edge is now
recorded alongside the classification, not instead of it.

---

## Pointer lock: ruled out, do not revisit

Measured from a real 224-second capture: **4 transitions total**. Two are a
double-`ACQUIRED` 71 ms apart at startup — *that is what the earlier captures'
mysterious "pairs ~100 ms apart" actually were*: the lock being taken, not
dropped. The third/fourth bracket a 63-second pause (the player's menu), focus
held throughout.

And: of 26 runs of zero-input frames, **25 do not overlap an unlocked window at
all**. Pointer lock does not cause the stalls.

---

## Rules that still hold — do not retry these

- **No fix expressed in pixels per frame.** That is a frame-rate-dependent rate.
  Two separate fixes have now died of this. There is a check for it.
- **No fixed per-event size threshold.** The spurious and legitimate ranges
  overlap and drift between sessions. Tried twice, failed twice.
- **Never discard look input outright** — hold it and decide next frame. Dropping
  is what produces the jagged sweep.
- **Test both directions.** A check that only asserts "spikes are rejected" will
  happily accept a fix that destroys real input. Every failed attempt passed one
  direction.
- **Mutation-test new checks.** The old frame-rate check never called the gate —
  it just re-added a column of numbers, so it could not fail. That hole is
  precisely how the px/frame floor shipped.
- `qa-render` does **not** draw sky, clouds, sun, moon or entities. It is not
  evidence about anything in the sky.

---

## Tools

- `src/player/look.ts` — `LookGate`. All constants documented with the
  measurements that chose them.
- `src/player/camtrace.ts` — ring buffer. F3 = live summary, F4 = full dump.
  Dump now includes a **pointer-lock timeline** (edge direction, focus,
  visibility, duration), a **stall correlation** (zero-input runs vs unlocked
  windows), and a **gap report** (where the frame loop stopped entirely — which
  is what a lock-induced stall actually looks like, since losing the lock calls
  `pause()`).
- `npm run qa:camtrace` — **99 checks** (was 50). `npm run verify` — 27 suites,
  green.
- On `file://` the clipboard is blocked, so F4 falls back to `console.log`. Use
  `npm run dev` if you want F4 to copy directly.

---

## Still open

- **Residual tiny jolts remain.** Acceptable to the player, not zero.
- Only one leak could be replayed against real data, because `dump()` prints
  surrounding frames for the *newest* anomaly only. If you chase the remainder,
  **widen that window first** — two mechanisms were proven, but not all 19
  captured leaks were individually verified to share them.
- With the per-event clamp gone, nothing bounds a single frame except the gate.
  Deliberate — the clamp capped jolts rather than removing them, and blinded the
  gate — but a genuinely new spurious pattern would be unbounded rather than
  capped at 13.6°.
- Worth trying outside the codebase: **a different mouse and a different
  browser**, comparing F4 dumps. If the 183–639 px reports vanish, the cause is
  confirmed as hardware and no further code change will improve on filtering.

## Unrelated, also fixed

`scripts/qa-mobs.mjs` was failing ~1 run in 4 (5/20 on unmodified main), which
made `verify` randomly red. Two causes: the suite seeded terrain but let
`MobManager` seed itself from `Math.random()`; and the persistence check counted
in-flight arrows as "alive" when `createMob()` has no projectile spec and cannot
restore them. Now deterministic, 25/25.
