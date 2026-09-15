# CubeWorld

An original voxel survival sandbox built from scratch with **TypeScript + Three.js**.

Not a Minecraft mod, not a wrapper, and not a copy: every texture, sound, model and
world-generation rule in this repository is generated procedurally by code in
`src/`. It deliberately targets the *feel* of classic-era voxel survival games —
16×16 pixel textures, one-metre cube blocks, flat-lit voxel terrain, chunky trees,
hard fog, a pixel UI — while remaining 100% original work.

---

## Quick start

```bash
npm install
npm run dev          # http://127.0.0.1:5173
```

Production build:

```bash
npm run build        # type-checks, emits dist/, copies the shell + three.js runtime
npm run preview      # serves dist/ at http://127.0.0.1:4173
```

Other scripts:

| script | what it does |
| --- | --- |
| `npm run typecheck` | full `strict` type-check with no emit |
| `npm run verify` | everything below, in order: the full pre-flight check |
| `npm run qa:modules` | imports all compiled modules to catch load-time errors |
| `npm run qa:logic` | 71 headless regression tests (world, light, inventory, crafting, saves) |
| `npm run qa:mobs` | 47 headless entity tests (AI, collision, combat, persistence) |
| `npm run qa:spawn` | sweeps 40 seeds and fails if any spawn is buried, wet or unlit |
| `npm run qa:stream` | drives the real chunk streamer and asserts meshes + geometry |
| `npm run qa:runtime` | **boots the real `Game` against a stub WebGL2 context** and asserts the renderer actually submits draw calls |
| `npm run qa:bundle` | verifies every relative import and HTML reference resolves in `dist/` |
| `npm run qa:atlas` | dumps the generated texture atlases to `.qa/*.png` |
| `npm run qa:world` | renders biome / height / cross-section maps of a seed |
| `npm run qa:render [shots…]` | software-renders first-person views of the real mesher output |

### Browser diagnostic page

`npm run dev`, then open **http://127.0.0.1:5173/diagnostic.html** (or
`/diagnostic.html` on the preview server after `npm run build`). It boots the real
game without any interaction, runs for ~6 seconds, and prints a copyable report:
uncaught errors with stacks, WebGL version and `getError()`, renderer draw calls and
triangles, per-program shader diagnostics captured from `console.error`, scene and
chunk-group composition, chunk streaming stats, player/world/light state, camera
state, and a `gl.readPixels` probe of the framebuffer with a one-line `VERDICT:`.

`npm run dev` drives the TypeScript compiler **in-process** instead of shelling out
to a bundler. That keeps the toolchain dependency-light and means the game builds
and runs in restricted environments where spawning a bundler's native binary is not
possible. A `vite` dev setup is equally viable — the source is plain ES modules with
explicit `.js` import specifiers, and `index.html` uses an import map for `three`.

---

## Controls

| input | action |
| --- | --- |
| `W A S D` | move |
| `Space` | jump (swim up in water / fly up in creative) |
| `Shift` | sneak (slower, lowers the camera) |
| `Ctrl` or `R` | sprint |
| mouse | look (click the canvas to capture the pointer) |
| left click | hold to mine; click a mob to attack |
| right click | place the held block / use (crafting table, furnace, chest) / eat |
| `1`–`9` | select hotbar slot |
| mouse wheel | cycle hotbar |
| `E` | inventory + 2×2 crafting |
| `Q` | drop one of the held item |
| `F` | toggle creative flight |
| `Esc` | pause menu (saves the world) |
| `F3` | debug overlay (FPS, position, chunk, biome, light, chunk budget) |
| `F1` | hide the HUD |
| `/` | command console |

### Commands

```
/help  /time <0..1|day|noon|night|dusk>  /gamemode <survival|creative>
/give <item> [count]   /tp <x> <z> [y]   /seed   /locate <village|dungeon>
/weather <clear|rain|snow>   /summon <pig|cow|sheep|chicken|zombie|skeleton|spider|creeper>
/spawn  /heal  /rd <4..16>  /save  /pos1  /pos2  /fill  /fly  /killall
```

---

## What is implemented

**World**
- 16 × 128 × 16 chunk storage, streamed around the player with a per-frame time
  budget so crossing a chunk border never hitches.
- Deterministic, order-independent generation: the same seed always produces the
  same terrain, biomes, caves, ores, trees and structures — and trees that straddle
  a chunk border are complete on both sides.
- Layered elevation noise (continents → hills → detail → ridged mountains), river
  carving at a global sea level, beaches, oceans and a 16-biome climate table with
  temperature/humidity/altitude rules.
- 3D-noise cave systems (winding spaghetti tunnels *and* cheese caverns), with lava
  below y≈10 and ore veins exposed by the carving.
- Depth- and rarity-graded ores: coal, iron, gold, redstone, lapis, diamond, plus
  dirt/gravel/clay pockets.
- Trees: oak, big oak, birch, spruce (layered conical canopy), cactus and dead bush,
  all built from the same block grid and clipped across chunk borders.
- Villages with a well, gable-roofed houses of varying size, cobblestone corners,
  glass windows, doors, furniture, dirt paths, lamp posts, fenced farm plots with
  irrigation channels and crops; plus underground dungeons and desert wells.

**Rendering**
- One merged mesh per chunk per layer (opaque + blended), only visible faces emitted.
- Per-vertex voxel ambient occlusion *and* smooth voxel lighting baked into vertex
  attributes; a single shader combines them with the time-of-day sky colour, warm
  block light, biome tint and distance fog.
- Nearest-neighbour texture atlas with half-texel UV insets, so no bleeding and no
  smoothing.
- Sky dome with gradient, square sun, moon, procedural stars, drifting blocky
  clouds and sky-matched fog; a real day/night cycle that drives light colour.
- Animated water surface (slightly lowered, UV scrolling), alpha-tested cutout
  foliage, cracking overlay with 8 generated stages, block selection outline.
- Held-item view model with walk bob and a swing animation.

**Gameplay**
- Survival (health, hunger, fall/drown/lava damage, regeneration, death + drops) and
  Creative (instant break, flight, full palette).
- Voxel DDA raycasting for targeting; hold-to-mine with per-block hardness, tool
  class and tool tier; correct drops; placement that refuses to intersect the player.
- 45-slot inventory with stacking, splitting, merging, hotbar, durability bars and
  a cursor stack shared by every container.
- Data-driven crafting: 2×2 and 3×3 shaped/shapeless pattern matching, ~70 recipes.
- Working furnace (fuel, burn time, cook progress, lit block state), chests
  (27 slots) and a full smelting table.
- Item drops that fall, merge, bob, spin and are magnetically collected.
- Passive and hostile mobs with blocky multi-part models, procedural animation,
  daytime/night-time spawning, combat, knockback and explosions.
- Procedural audio (41 synthesised sounds) and a pooled pixel particle system.

**Persistence**
- Worlds are saved as *seed + deviations*: only blocks the player actually changed
  are stored, packed 3 bytes each and base64-encoded, with player state, inventory,
  time of day, containers and mobs. Autosaves every 60 seconds and on quit.

---

## Architecture

```
src/
  main.ts            bootstrap: canvas + UI shell, error fallback
  game.ts            world lifecycle, input, interaction, survival loop, frame
  debug.ts           F3 overlay + command console
  world/
    blocks.ts        block registry (the single source of block behaviour)
    chunk.ts         16x128x16 storage, one flat byte array per layer
    world.ts         chunk map, block access, lighting hooks, falling blocks
    lighting.ts      incremental sky/block light propagation (add + remove BFS)
    chunkmanager.ts  streaming: generate -> light -> mesh, nearest first
  worldgen/
    terrain.ts       elevation, climate, strata, ores, decoration pipeline
    biomes.ts        biome table (surface blocks, tints, vegetation, relief)
    caves.ts         3D-noise tunnel + cavern carving
    trees.ts         tree shapes as clipped block offsets
    structures.ts    deterministic region grid -> per-chunk structure stamps
  render/
    pixel.ts         tiny RGBA pixel buffer + tileable noise helpers
    blockTextures.ts every 16x16 block texture, painted from code
    itemTextures.ts  every 16x16 item sprite
    atlas.ts         atlas packing and UV lookup
    mesher.ts        visible-face extraction, AO, smooth light, layers
    materials.ts     terrain/sky/cloud shaders
    sky.ts           sun, moon, stars, clouds, day/night lighting model
    renderer.ts      scene, camera, settings, frame submission
    viewmodel.ts     held item + selection/breaking overlay
    particles.ts     pooled pixel particle system
  player/
    player.ts        AABB collision, movement, swimming, survival stats
    raycast.ts       Amanatides & Woo voxel traversal
  items/
    items.ts         item registry (tools, food, materials, fuels)
    inventory.ts     inventory, crafting grid, furnace/chest state, slot clicks
    recipes.ts       shaped/shapeless recipes + smelting table
    drops.ts         dropped item entities
  entities/
    entity.ts        base entity: collision, steering, local A*
    models.ts        procedural voxel creature models + textures
    mobs.ts          pig/cow/sheep/chicken/zombie/skeleton/spider/creeper + arrow
    mobmanager.ts    spawning, ticking, throttling, raycast, persistence
  audio/audio.ts     Web Audio synthesis for every sound
  ui/                icons, HUD, container screens, menu screens, stylesheet
  save/save.ts       world metadata, edit packing, localStorage persistence
```

### Notable decisions

- **No realtime lights.** Lighting is a voxel flood fill baked into vertex
  attributes, which is why a 128-block render distance stays cheap.
- **Two light channels** (sky and block) combined with `max()` in the shader,
  exactly like the classic model.
- **Order-independent worldgen.** Every feature is a pure function of
  `(seed, world position)`; chunk-local RNG is seeded from the chunk coordinates so
  borders always agree.
- **Structures are stamped, not generated in place.** Each village bakes once into
  per-chunk stamp lists, so a chunk only looks up its own list.
- **Saves store deviations, not blocks.** A world with a few hundred edits is a few
  kilobytes.
- **Flat lookup tables in hot loops.** The mesher and lighting engine flatten block
  properties into typed arrays, which is roughly a 5× speedup over property lookups.

### Visual QA without a browser

Browsers cannot be launched in every environment, so the repository ships a headless
software rasteriser (`scripts/qa-render.mjs`) that consumes the *same* atlas, mesher
and worldgen modules the game uses and writes PNGs. It catches UV mistakes, winding
errors, chunk seams, lighting bugs and fog problems without a GPU:

```bash
npm run qa render day night cave wide village underwater
```

---

## Credits

Everything — textures, models, sounds, terrain algorithms, UI — is generated by the
code in this repository. No third-party art, audio or game assets are used, and no
Mojang/Microsoft code or assets are included.
