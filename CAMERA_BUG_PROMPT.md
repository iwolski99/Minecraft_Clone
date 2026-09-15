# Prompt to give your other agent

Copy everything in the block below.

---

I have a voxel game (a Minecraft clone) written in TypeScript with three.js, and
there is a camera bug I have not been able to fix. I need you to fix it. Read
`CAMERA_BUG_HANDOFF.md` in the repo root **first** — it contains everything that
has already been measured and ruled out, and three fixes that were tried and
reverted. Please do not repeat those; they made things worse and I had to undo
them.

**The repo:** locally at `T:\Deepseek Projects\Minecraft`, or
https://github.com/iwolski99/Minecraft_Clone

**The bug, from my own experience of playing it:** when I turn my head with the
mouse, the view sometimes jumps — an instantaneous extra rotation that I did not
make. It is rotation only, never position. The jumps have been as large as ~30
degrees, occasionally much more. It is worse sweeping one direction than the
other. Separately, and possibly related, the look movement is sometimes *jagged*:
it advances, stalls, advances, like the camera is catching on something, while my
movement and jumping stay perfectly smooth. It also sometimes feels like the
mouse "gets locked".

**What has already been established by measurement** (details in the handoff):

- Across thousands of frames in three separate captures, the rotation the game
  applies **always exactly matches** the mouse input it received. The readout says
  `unexplained 0` every time. So the look code is not at fault — the *mouse
  reports themselves* are sometimes wrong.
- The wrong reports are single mousemove events of **183–639 pixels**, where
  normal reports are 1–90 px (up to ~240 px when I sweep fast).
- The legitimate and spurious ranges **overlap and drift between sessions**, which
  is why every fixed size threshold tried so far has failed.
- My frame rate is low, 12–26 FPS, which makes per-frame judgement noisy and
  makes smooth mouse motion look steppy on its own.
- The trace shows **8–16 pointer-lock "relocks" per session, arriving in pairs
  ~100 ms apart.** While pointer lock is lost, the mousemove handler returns early
  so *no* look input arrives and the camera freezes. I suspect the lock dropping
  and re-acquiring is a real cause of the jagged movement, but this has not been
  investigated. It is the strongest unexplored lead.

**What I have already built for debugging** (all in the repo):

- `src/player/camtrace.ts` — records every frame's raw mouse input, the rotation
  applied, and the rotation the input justified, in a 900-frame ring buffer.
- **F3** shows a live summary; **F4** copies a full pasteable report to the
  clipboard. I can send you F4 dumps.
- `scripts/qa-camtrace.mjs` — 50 checks including replays of my real captures.
  `npm run qa:camtrace`.
- `npm run verify` runs 27 verification suites. Please keep it green.

**Important constraints:**

- Do not add any fix expressed in **pixels per frame** — that is frame-rate
  dependent and throttled my normal turning badly. There is a test for this.
- Do not add a fixed per-event size threshold; it either misses the spikes or
  destroys my legitimate fast sweeps. Both have been tried.
- A check that only asserts "spikes are rejected" is not enough — it will happily
  accept a fix that breaks legitimate input. Test **both** directions.
- `qa-render` does **not** draw the sky or clouds (it only renders chunk meshes),
  so it is not evidence about anything in the sky.

**What I would like from you:**

1. Start with the pointer-lock lead — instrument the transitions and correlate
   them against the zero-input frames in the trace.
2. Ask me for a fresh F4 dump whenever you need one, and tell me exactly what to
   do while recording (e.g. "turn slowly left, then sweep fast right").
3. Tell me if you think the two failure modes (large jump / jagged sweep) are one
   bug or two, and what you would need to distinguish them.

I would rather you measure than reason from the code — the handoff explains why.
