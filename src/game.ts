/**
 * The game: world lifecycle, input, block interaction, survival loop,
 * persistence and the main frame.
 */

import * as THREE from 'three';
import { Atlas, buildBlockAtlas, buildItemAtlas, missingPainters } from './render/atlas.js';
import { setLeafHoles } from './render/blockTextures.js';
import { Renderer } from './render/renderer.js';
import type { SkyState } from './render/sky.js';
import { World } from './world/world.js';
import { CHUNK_X, CHUNK_Y, CHUNK_Z, SEA_LEVEL, Chunk, blockIndex } from './world/chunk.js';
import { TerrainGenerator } from './worldgen/terrain.js';
import { BIOMES, biomeById } from './worldgen/biomes.js';
import { B, BLOCKS, getBlock, breakTime, canHarvest, dropsFor, lightEmission } from './world/blocks.js';
import { Player } from './player/player.js';
import { raycastVoxels, RayHit } from './player/raycast.js';
import { Inventory, CraftingGrid, FurnaceState, ChestState, ItemStack, makeStack } from './items/inventory.js';
import { blockIdOf, creativePalette, itemDef, itemDisplay, maxStack } from './items/items.js';
import { findRecipe, smeltFor } from './items/recipes.js';
import { ItemDropManager } from './items/drops.js';
import { MobManager } from './entities/mobmanager.js';
import type { EntityHost } from './entities/entity.js';
import { audio } from './audio/audio.js';
import { Hud } from './ui/hud.js';
import { ContainerUI, ContainerKind } from './ui/containers.js';
import { Screens, Settings, loadSettings, saveSettings, DEFAULT_SETTINGS } from './ui/screens.js';
import { SaveSystem, WorldMeta, WorldSaveData, GameModeName, packEdits, unpackEdits, defaultPlayer, SAVE_VERSION } from './save/save.js';
import { DebugConsole } from './debug.js';
import { chunkKey } from './world/chunk.js';

/**
 * Door halves, by the id you clicked: [lower, upper] after the swap.
 *
 * A door is two cells that must always change together, so the pairing lives in
 * one place rather than being reconstructed at each use.
 */
const DOOR_SWAP: Record<number, [number, number]> = {
  [B.oak_door]: [B.oak_door_open, B.oak_door_open_top],
  [B.oak_door_top]: [B.oak_door_open, B.oak_door_open_top],
  [B.oak_door_open]: [B.oak_door, B.oak_door_top],
  [B.oak_door_open_top]: [B.oak_door, B.oak_door_top],
};import { clampLookDelta, wrapYaw, capFrameLook, LookGate } from './player/look.js';
import { installShaderFaultCapture } from './render/shaderFaults.js';
import { CameraTrace } from './player/camtrace.js';

type Weather = 'clear' | 'rain' | 'snow';

const REACH_SURVIVAL = 4.5;
const REACH_CREATIVE = 5.5;
/** how quickly forward must be tapped twice to start a sprint */
const DOUBLE_TAP_MS = 300;

export class Game {
  readonly renderer3d: Renderer;
  readonly atlas: Atlas;
  readonly itemAtlas: Atlas;
  world!: World;
  player = new Player();
  inventory = new Inventory();
  crafting = new CraftingGrid(2);
  tableCrafting = new CraftingGrid(3);
  drops!: ItemDropManager;
  mobs!: MobManager;
  hud: Hud;
  containers: ContainerUI;
  screens: Screens;
  debug: DebugConsole;

  meta: WorldMeta | null = null;
  gameMode: GameModeName = 'survival';
  settings: Settings = loadSettings();

  private canvas: HTMLCanvasElement;
  private uiRoot: HTMLElement;
  running = false;
  private lastTime = 0;
  private accum = 0;
  private elapsed = 0;
  private tickAccum = 0;
  private autosaveTimer = 0;

  // input
  private keys = new Set<string>();
  private mouseDown = [false, false, false];
  private pointerLocked = false;
  /**
   * Records the camera rotation actually applied each frame and flags any that
   * the mouse input cannot account for, so the "view jolts sideways" bug can be
   * diagnosed from real data instead of reproduced on demand.
   */
  readonly cameraTrace = new CameraTrace();
  /** mouse reports discarded as impossible, shown by the tracer */
  private spuriousEvents = 0;
  /** decides whether a mouse report is real, from its context */
  private readonly lookGate = new LookGate();
  private lookDeltaX = 0;
  private lookDeltaY = 0;
  private wheelAccum = 0;

  // interaction
  private target: RayHit | null = null;
  private miningKey = '';
  private miningProgress = 0;
  private attackCooldown = 0;
  private placeCooldown = 0;
  private useCooldown = 0;

  // containers
  private furnaces = new Map<number, FurnaceState>();
  private chests = new Map<number, ChestState>();
  private openFurnace: FurnaceState | null = null;
  private openChest: ChestState | null = null;

  // world-ish state
  private weather: Weather = 'clear';
  private weatherTimer = 240;
  private skyState!: SkyState;
  private viewLight = new THREE.Color(1, 1, 1);

  constructor(canvas: HTMLCanvasElement, layers: { hud: HTMLElement; containers: HTMLElement; screens: HTMLElement; debug: HTMLElement }) {
    this.canvas = canvas;
    this.uiRoot = layers.hud;

    // Leaf cut-outs are baked into the atlas, so the graphics mode has to be
    // applied before it is built: "fancy" gives the see-through canopy,
    // "fast" fills the gaps in for a solid, cheaper block.
    setLeafHoles(this.settings.graphics === 'fancy');
    this.atlas = buildBlockAtlas();
    this.itemAtlas = buildItemAtlas();
    this.checkMissingTextures();

    // a placeholder world so the renderer can be constructed before a save loads
    const gen = new TerrainGenerator(1);
    this.world = new World(1, gen);
    // Installed before any material exists, so a shader that fails to compile is
    // recorded here rather than only reaching a browser console nothing can read.
    installShaderFaultCapture();
    this.renderer3d = new Renderer(canvas, this.atlas, this.itemAtlas, this.world);

    // The host object is captured by the mob manager, so every field is a live
    // getter: swapping worlds must not leave the entities pointing at the old one.
    const self = this;
    this.host = {
      get world() {
        return self.world;
      },
      get player() {
        return self.player;
      },
      playSound: (name: string, volume = 1, pitch = 1) => audio.play(name as never, { volume, pitch }),
      /*
       * Loot from a killed mob.
       *
       * The manager looks for this handler on the host and skips loot silently
       * when it is missing - so every species had drops defined and none of them
       * ever reached the ground. Same shape of bug as the item pickup handler.
       */
      dropItems: (items: [string, number][], x: number, y: number, z: number) => {
        for (const [item, count] of items) {
          if (!item || count <= 0) continue;
          self.drops.spawn(item, count, x, y, z);
        }
      },
      spawnParticles: (kind: string, x: number, y: number, z: number, count = 8) => {
        if (kind === 'explosion') self.renderer3d.particles.explosion(x, y, z, 2.4);
        else if (kind === 'smoke') self.renderer3d.particles.smoke(x, y, z, count);
        else if (kind === 'splash') self.renderer3d.particles.splash(x, y, z, count);
        else self.renderer3d.particles.damage(x, y, z, count);
      },
      get dayFactor() {
        return self.dayFactor;
      },
      get isNight() {
        return self.isNight;
      },
      difficulty: 2,
      get timeOfDay() {
        return self.skyTime;
      },
    };

    this.hud = new Hud(layers.hud, this.atlas, this.itemAtlas);
    this.containers = new ContainerUI(layers.containers, this.atlas, this.itemAtlas);
    this.screens = new Screens(layers.screens, this.atlas, {
      onPlay: (meta, mode) => void this.startWorld(meta, mode),
      onDelete: () => undefined,
      onSettingsChanged: (s) => this.applySettings(s),
      onQuitToTitle: () => this.quitToTitle(),
      onResume: () => this.resume(),
      onSave: () => this.save(),
      onSaveAndQuit: () => this.saveAndQuit(),
      onRespawn: () => this.respawn(),
    });
    this.debug = new DebugConsole(layers.debug, this);
    this.drops = new ItemDropManager(this.atlas, this.itemAtlas, this.renderer3d.blockTexture, this.renderer3d.itemTexture);
    // A walked-over drop is only *collected* by the game: the inventory is the
    // one place that knows how much of the stack fits. Without this handler the
    // entity manager still removed the drop from the world and the item simply
    // vanished (reported from play as "not going into the hotbar").
    this.drops.onCollect = (stack) => this.collectDrop(stack);
    this.mobs = new MobManager(this.host);

    this.bindInput();

    this.renderer3d.scene.add(this.drops.group);
    this.renderer3d.scene.add(this.mobs.group);
    this.renderer3d.chunkManager.onChunkGenerated = (chunk) => applyEditsToChunk(this.world, chunk);
    this.applySettings(this.settings);

    this.screens.showTitle();
    this.resize();
    window.addEventListener('resize', () => this.resize());
    this.loop = this.loop.bind(this);
    requestAnimationFrame(this.loop);
    void biomeById;
    void CHUNK_Z;
  }

  private host: EntityHost;

  private checkMissingTextures(): void {
    const required = new Set<string>();
    for (const b of BLOCKS) {
      for (const t of [b.tex.all, b.tex.side, b.tex.top, b.tex.bottom, b.tex.north, b.tex.south, b.tex.east, b.tex.west, b.tex.sprite]) {
        if (t) required.add(t);
      }
    }
    const missing = missingPainters(required);
    if (missing.length) console.warn('[cubeworld] block textures with no painter:', missing);
  }

  /* ---------------------------------------------------------------- */
  /* World lifecycle                                                   */
  /* ---------------------------------------------------------------- */

  async startWorld(meta: WorldMeta, mode: GameModeName): Promise<void> {
    this.meta = meta;
    this.gameMode = mode;
    this.player.gameMode = mode === 'creative' ? 'creative' : 'survival';
    this.screens.showLoading('Building terrain');
    await nextFrame();

    const saved = SaveSystem.load(meta.id);
    const gen = new TerrainGenerator(saved ? saved.seed : meta.seed);
    this.world = new World(saved ? saved.seed : meta.seed, gen);
    unpackEditsInto(this.world, saved ? saved.edits : '');

    this.renderer3d.chunkManager.dispose();
    this.renderer3d.scene.remove(this.renderer3d.chunkManager.group);
    const cm = this.renderer3d.chunkManager as unknown as { world: World };
    cm.world = this.world;
    this.renderer3d.scene.add(this.renderer3d.chunkManager.group);
    this.renderer3d.chunkManager.onChunkGenerated = (chunk) => applyEditsToChunk(this.world, chunk);

    this.renderer3d.chunkManager.renderDistance = this.settings.renderDistance;
    this.renderer3d.chunkManager.markAllDirty();
    // Freeze streaming until the world is ready and the camera is on the player.
    // The streamer follows the render camera, which is still at the origin here.
    this.renderer3d.chunkManager.enabled = false;

    // entities from the previous world must not leak into the new one
    for (const e of this.mobs.entities.slice()) this.mobs.remove(e);
    this.drops.clear();

    // pick a safe spawn
    let spawnX = 0;
    let spawnZ = 0;
    if (saved) {
      spawnX = Math.round(saved.player.x);
      spawnZ = Math.round(saved.player.z);
    } else {
      const found = this.findSpawn();
      spawnX = found[0];
      spawnZ = found[1];
    }
    this.player.gameMode = mode === 'creative' ? 'creative' : 'survival';
    this.player.flying = mode === 'creative' && saved ? saved.player.flying : false;

    this.renderer3d.chunkManager.setCentre(spawnX, spawnZ);

    // staged preload so the loading screen can actually animate
    const state = { radius: Math.min(this.settings.renderDistance + 1, 8), pass: 0, index: 0 };
    let guard = 0;
    while (guard++ < 100000) {
      const p = this.renderer3d.chunkManager.preloadStep(state, 24);
      this.screens.setLoading(p * 0.96, p < 0.34 ? 'Generating terrain...' : p < 0.67 ? 'Lighting chunks...' : 'Building meshes...');
      await nextFrame();
      if (p >= 1) break;
    }

    // place the player on the surface
    if (saved) {
      const p = saved.player;
      this.player.position.set(p.x, p.y, p.z);
      this.player.yaw = p.yaw;
      this.player.pitch = p.pitch;
      this.player.health = p.health ?? 20;
      this.player.hunger = p.hunger ?? 20;
      this.player.air = p.air ?? 300;
      this.player.spawnPoint.set(p.spawnX, p.spawnY, p.spawnZ);
      this.inventory.deserialize(saved.inventory);
      this.restoreContainers(saved);
      this.renderer3d.sky.setTime(saved.time ?? 0.28);
      this.player.gameMode = saved.gameMode === 'creative' ? 'creative' : this.player.gameMode;
      try {
        this.mobs.deserialize(saved.mobs ?? []);
      } catch {
        /* mobs are best-effort */
      }
    } else {
      this.player.placeOnGround(this.world, spawnX + 0.5, spawnZ + 0.5);
      this.player.spawnPoint.copy(this.player.position);
      this.inventory.clear();
      if (mode === 'creative') {
        const starter = ['stone', 'dirt', 'grass_block', 'oak_planks', 'oak_log', 'glass', 'torch', 'cobblestone', 'sand'];
        for (let i = 0; i < starter.length; i++) this.inventory.slots[i] = makeStack(starter[i], 64);
      } else {
        this.inventory.slots[0] = makeStack('wooden_pickaxe', 1);
        this.inventory.slots[1] = makeStack('wooden_axe', 1);
        this.inventory.slots[2] = makeStack('torch', 8);
      }
      this.renderer3d.sky.setTime(0.28);
    }

    if (this.player.position.y < 1 || !Number.isFinite(this.player.position.y)) {
      this.player.placeOnGround(this.world, spawnX + 0.5, spawnZ + 0.5);
      this.player.spawnPoint.copy(this.player.position);
    }

    // A saved world may have been saved inside terrain (or the terrain changed):
    // never hand the player a buried camera.
    this.player.rescueIfBuried(this.world);

    // Park the camera on the player before re-enabling streaming, so the
    // streamer's first update centres on the spawn rather than on the origin.
    this.renderer3d.camera.position.set(this.player.position.x, this.player.eyeY, this.player.position.z);
    this.renderer3d.camera.rotation.set(this.player.pitch, this.player.yaw, 0);
    this.renderer3d.chunkManager.setCentre(this.player.position.x, this.player.position.z);
    this.renderer3d.chunkManager.enabled = true;

    this.screens.setLoading(1, 'Ready');
    await nextFrame();
    this.screens.hideAll();
    this.containers.close();
    this.running = true;
    // The view model is only rebuilt when the held slot changes, so populate it
    // now or the player starts with an empty hand until they scroll.
    this.updateHeld();
    this.hud.setCrosshairVisible(true);
    this.requestLock();
    this.hud.showToast(`${meta.name} — ${this.gameMode}`, 3);
    audio.setVolumes(this.settings.masterVolume, this.settings.sfxVolume, this.settings.musicVolume);
    void audio.resume();
  }

  private restoreContainers(saved: WorldSaveData): void {
    this.furnaces.clear();
    this.chests.clear();
    for (const f of saved.furnaces ?? []) {
      const st = FurnaceState.from(f);
      if (st) this.furnaces.set(containerKey(st.x, st.y, st.z), st);
    }
    for (const c of saved.chests ?? []) {
      const st = ChestState.from(c);
      if (st) this.chests.set(containerKey(st.x, st.y, st.z), st);
    }
  }

  private findSpawn(): [number, number] {
    // walk outward looking for a pleasant land biome above sea level
    const gen = this.world.generator;
    let best: [number, number] = [8, 8];
    let bestScore = -Infinity;
    for (let r = 0; r < 900; r += 6) {
      const a = r * 2.399963;
      const x = Math.round(Math.cos(a) * r);
      const z = Math.round(Math.sin(a) * r);
      const info = gen.columnInfo(x, z);
      if (info.height <= SEA_LEVEL + 1) continue;
      const biome = biomeById(info.biome);
      if (!biome.villageWeight && biome.name === 'ocean') continue;
      let score = info.height - SEA_LEVEL;
      if (biome.name === 'plains' || biome.name === 'forest' || biome.name === 'birch_forest') score += 20;
      if (biome.name === 'mountains' || biome.name === 'snowy_mountains') score -= 18;
      if (info.river > 0.4) score -= 14;
      if (score > bestScore) {
        bestScore = score;
        best = [x, z];
      }
      if (bestScore > 34) break;
    }
    return best;
  }

  quitToTitle(): void {
    this.running = false;
    this.save();
    document.exitPointerLock?.();
    this.containers.close();
    for (const e of this.mobs.entities.slice()) this.mobs.remove(e);
    this.drops.group.clear();
    this.renderer3d.chunkManager.dispose();
    for (const c of [...this.world.chunks.values()]) this.world.removeChunk(c.cx, c.cz);
    this.screens.hideAll();
    this.screens.showTitle();
    audio.setMusicEnabled(true);
    void this.player;
  }

  saveAndQuit(): void {
    this.save();
    this.quitToTitle();
  }

  save(): void {
    if (!this.meta || !this.world) return;
    const data: WorldSaveData = {
      version: SAVE_VERSION,
      id: this.meta.id,
      name: this.meta.name,
      seed: this.world.seed,
      gameMode: this.player.gameMode === 'creative' ? 'creative' : 'survival',
      dimension: this.world.dimension,
      time: this.renderer3d.sky.time,
      player: {
        x: this.player.position.x,
        y: this.player.position.y,
        z: this.player.position.z,
        yaw: this.player.yaw,
        pitch: this.player.pitch,
        health: this.player.health,
        hunger: this.player.hunger,
        air: this.player.air,
        flying: this.player.flying,
        spawnX: this.player.spawnPoint.x,
        spawnY: this.player.spawnPoint.y,
        spawnZ: this.player.spawnPoint.z,
      },
      inventory: this.inventory.serialize(),
      edits: packEdits(this.world.edits),
      furnaces: [...this.furnaces.values()].map((f) => f.serialize()),
      chests: [...this.chests.values()].map((c) => c.serialize()),
      mobs: this.mobs ? this.mobs.serialize() : [],
    };
    const res = SaveSystem.save(data);
    if (!res.ok) this.hud.showToast(`Save failed: ${res.error ?? 'unknown error'}`, 5);
    else this.hud.showToast('World saved', 1.6);
  }

  respawn(): void {
    this.player.respawn();
    this.screens.hideAll();
    this.requestLock();
    void audio.resume();
  }

  /* ---------------------------------------------------------------- */
  /* Input                                                             */
  /* ---------------------------------------------------------------- */

  private bindInput(): void {
    window.addEventListener('keydown', (e) => this.onKeyDown(e));
    window.addEventListener('keyup', (e) => {
      this.keys.delete(e.code);
      // releasing forward ends a double-tap sprint, as it does in Minecraft
      if (e.code === 'KeyW') this.sprintLatched = false;
    });
    window.addEventListener('blur', () => {
      this.keys.clear();
      this.mouseDown = [false, false, false];
    });
    window.addEventListener('mousemove', (e) => {
      if (!this.pointerLocked) return;
      const rawX = e.movementX || 0;
      const rawY = e.movementY || 0;
      // Record every report for the trace. Whether it is real is decided once
      // per frame against recent history - see LookGate for why a per-event size
      // test cannot work: the spurious and legitimate ranges overlap.
      this.cameraTrace.recordEvent(rawX, rawY);
      /*
       * Deliberately NOT clamped per event any more.
       *
       * The +/-180 clamp was hiding the bug from the thing meant to catch it. A
       * captured session shows eight jolts that applied exactly 180 px - every
       * one a single spurious report of 183-543 px truncated to exactly the
       * clamp. 543 px in one frame is 12000 px/s and unmistakable; 180 px is
       * 2100-4000 px/s at this game's frame times, which is ordinary fast
       * turning. The clamp took an impossible report and handed the gate a
       * plausible one, so the gate passed it and the player got 13.6 degrees.
       *
       * The gate judges the frame's true magnitude instead. Bounding the size
       * here cannot help anyway: it caps the jolt without removing it, which is
       * what "reduced the jolts from 141 to 11 degrees" meant.
       */
      this.lookDeltaX += rawX;
      this.lookDeltaY += rawY;
    });
    this.canvas.addEventListener('mousedown', (e) => {
      if (!this.running) return;
      if (!this.pointerLocked) {
        this.requestLock();
        return;
      }
      this.mouseDown[e.button] = true;
      if (e.button === 2) this.tryUse();
      if (e.button === 0) this.tryAttack();
      e.preventDefault();
    });
    window.addEventListener('mouseup', (e) => {
      this.mouseDown[e.button] = false;
    });
    this.canvas.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('wheel', (e) => this.onWheel(e), { passive: false });
    document.addEventListener('pointerlockchange', () => {
      this.pointerLocked = document.pointerLockElement === this.canvas;
      /*
       * Drop any look movement captured before the lock changed hands. The
       * browser delivers a single large `movementX` when the pointer is
       * re-acquired or clamped at a screen edge, and applying that as a look
       * delta is a visible jolt of the camera - which is the "shift" reported
       * while simply moving the mouse, sometimes with no input at all.
       */
      this.lookDeltaX = 0;
      this.lookDeltaY = 0;
      // Movement the gate was holding belongs to the old lock - releasing it
      // into the frame after a transition would be a jolt with no input behind it.
      this.lookGate.forget();
      /*
       * Record the edge, not just that something happened. The captures show
       * these arriving in pairs ~100 ms apart and the old `markRelock()` could
       * not say which was the loss and which the recovery, nor whether the
       * window had kept focus across them - which is the difference between the
       * OS taking the lock and this code releasing it.
       */
      this.cameraTrace.markLock(this.pointerLocked, document.hasFocus(), document.visibilityState === 'visible');
      if (!this.pointerLocked && this.running && !this.containers.isOpen && !this.screens.isOpen) {
        this.pause();
      }
    });
    this.canvas.addEventListener('click', () => {
      if (this.running && !this.pointerLocked && !this.containers.isOpen && !this.screens.isOpen) this.requestLock();
    });
  }

  requestPointerLock(): void {
    this.requestLock();
  }

  private requestLock(): void {
    const p = this.canvas.requestPointerLock() as unknown as Promise<void> | undefined;
    if (p && typeof p.catch === 'function') p.catch(() => undefined);
    void audio.resume();
  }

  private onWheel(e: WheelEvent): void {
    if (!this.running || this.containers.isOpen) return;
    e.preventDefault();
    const dir = Math.sign(e.deltaY);
    if (dir === 0) return;
    const n = 9;
    this.inventory.selected = (this.inventory.selected + (dir > 0 ? 1 : n - 1)) % n;
    this.updateHeld();
  }

  private onKeyDown(e: KeyboardEvent): void {
    if (this.debug.isTyping) {
      this.debug.handleKey(e);
      return;
    }
    /*
     * Double-tapping forward sprints, the way it does in Minecraft.
     *
     * `e.repeat` is ignored so holding W does not count as repeated taps, and
     * the latch is cleared on key-up, which is what makes the sprint end when you
     * let go of forward rather than sticking on for the rest of the session.
     */
    if (e.code === 'KeyW' && !e.repeat) {
      const now = performance.now();
      if (now - this.lastForwardTap < DOUBLE_TAP_MS) this.sprintLatched = true;
      this.lastForwardTap = now;
    }
    this.keys.add(e.code);

    if (e.code === 'F3') {
      e.preventDefault();
      this.debug.toggleOverlay();
      return;
    }
    if (e.code === 'F4') {
      // Copy the camera trace so a rare view-jolt can be pasted for diagnosis.
      e.preventDefault();
      const dump = this.cameraTrace.dump();
      void navigator.clipboard?.writeText?.(dump).then(
        () => this.hud.showToast('Camera trace copied to clipboard', 3),
        () => {
          // clipboard blocked (not a secure context, or permission denied):
          // fall back to the console so the data is not lost
          console.log(dump);
          this.hud.showToast('Camera trace written to the console (F12)', 4);
        },
      );
      return;
    }
    if (e.code === 'F1' && this.running) {
      e.preventDefault();
      this.hudHidden = !this.hudHidden;
      this.uiRoot.classList.toggle('hud-hidden', this.hudHidden);
      return;
    }
    if (e.code === 'Slash' && this.running && !this.containers.isOpen) {
      e.preventDefault();
      this.debug.open();
      return;
    }
    if (!this.running) {
      if (e.code === 'Escape' && this.screens.isOpen) this.screens.showTitle();
      return;
    }
    if (this.containers.isOpen) {
      /*
       * E closes any container, not just the inventory.
       *
       * The condition used to exempt furnaces and chests, so with either open
       * the key did nothing at all and the only way out was Escape - reported as
       * E not exiting the furnace. Both keys now close whatever is open, which
       * is what the key does in the original.
       */
      if (e.code === 'Escape' || e.code === 'KeyE') {
        e.preventDefault();
        this.closeContainer();
      }
      return;
    }
    if (e.code === 'Escape') {
      this.pause();
      return;
    }
    if (e.code === 'KeyE') {
      e.preventDefault();
      this.openContainer('inventory');
      return;
    }
    if (e.code === 'KeyQ' && !e.repeat) {
      this.dropHeld();
      return;
    }
    if (e.code === 'KeyF' && !e.repeat) {
      this.toggleFlight();
      return;
    }
    const num = /^Digit([1-9])$/.exec(e.code);
    if (num) {
      this.inventory.selected = Number(num[1]) - 1;
      this.updateHeld();
      return;
    }
  }

  private updateHeld(): void {
    const held = this.inventory.held;
    const blockId = held ? blockIdOf(held.item) : 0;
    this.renderer3d.viewModel.setHeld(blockId, held && blockId === 0 ? held.item : null);
    if (held) this.hud.showItemName(itemDisplay(held.item));
  }

  private toggleFlight(): void {
    if (this.player.gameMode !== 'creative') return;
    this.player.flying = !this.player.flying;
    if (this.player.flying) this.player.velocity.y = 0;
    this.hud.showToast(this.player.flying ? 'Flying' : 'Walking', 1.2);
  }

  private dropHeld(): void {
    const held = this.inventory.held;
    if (!held) return;
    const dir = this.player.lookDir();
    const p = this.player.eyePosition();
    this.drops.spawn(held.item, 1, p.x + dir.x * 0.6, p.y - 0.2, p.z + dir.z * 0.6, 0.2);
    this.inventory.consumeHeld(1);
    this.updateHeld();
    audio.play('pop', { volume: 0.4 });
  }

  /**
   * Put a walked-over drop into the inventory. Returns how many items did not
   * fit so the entity manager can leave the remainder lying on the ground.
   */
  private collectDrop(stack: ItemStack): number {
    const before = stack.count;
    const heldBefore = this.inventory.held?.item ?? null;
    const leftover = this.inventory.add(stack);
    if (leftover < before) {
      audio.play('pop', { volume: 0.35, pitch: 1.1 + Math.random() * 0.25 });
      // picking something up can fill the empty selected slot, in which case
      // the held-item view model has to follow
      if ((this.inventory.held?.item ?? null) !== heldBefore) this.updateHeld();
      else this.hud.showItemName(itemDisplay(stack.item));
    }
    return leftover;
  }

  pause(): void {
    if (!this.running || this.containers.isOpen) return;
    this.running = false;
    document.exitPointerLock?.();
    this.screens.showPause();
    this.save();
  }

  resume(): void {
    this.screens.hideAll();
    this.running = true;
    this.requestLock();
  }

  /* ---------------------------------------------------------------- */
  /* Containers                                                        */
  /* ---------------------------------------------------------------- */

  private openContainer(kind: ContainerKind, furnace?: FurnaceState, chest?: ChestState): void {
    this.openFurnace = furnace ?? null;
    this.openChest = chest ?? null;
    if (kind === 'inventory') this.crafting = new CraftingGrid(2);
    this.containers.open({
      kind,
      inventory: this.inventory,
      crafting: kind === 'crafting_table' ? this.tableCrafting : kind === 'furnace' || kind === 'chest' ? this.tableCrafting : this.crafting,
      furnace: furnace ?? null,
      chest: chest ?? null,
    });
    this.containers.onCraft = () => audio.play('craft', { volume: 0.5 });
    // Anything that did not fit when a screen closed is dropped on the ground
    // rather than deleted, so a full inventory can never destroy an item.
    this.containers.onDropCursor = (stack) => {
      const dir = this.player.lookDir();
      const p = this.player.eyePosition();
      this.drops.spawn(stack.item, stack.count, p.x + dir.x * 0.6, p.y - 0.2, p.z + dir.z * 0.6, 0.2);
    };
    this.containers.onClose = () => {
      this.openFurnace = null;
      this.openChest = null;
    };
    document.exitPointerLock?.();
  }

  private closeContainer(): void {
    this.containers.close();
    this.openFurnace = null;
    this.openChest = null;
    if (this.running) this.requestLock();
  }

  /* ---------------------------------------------------------------- */
  /* Block interaction                                                 */
  /* ---------------------------------------------------------------- */

  private reach(): number {
    return this.player.gameMode === 'creative' ? REACH_CREATIVE : REACH_SURVIVAL;
  }

  private updateTarget(): void {
    const eye = this.player.eyePosition();
    const dir = this.player.lookDir();
    this.target = raycastVoxels(
      this.world,
      eye.x,
      eye.y,
      eye.z,
      dir.x,
      dir.y,
      dir.z,
      this.reach(),
      (id) => getBlock(id).render !== 'none' && !getBlock(id).liquid,
    );
  }

  private heldTool(): { tier: number; cls: ReturnType<typeof itemDef> } {
    const held = this.inventory.held;
    const def = held ? itemDef(held.item) : undefined;
    return { tier: def?.tier ?? 0, cls: def };
  }

  private tryAttack(): void {
    if (this.attackCooldown > 0) return;
    const eye = this.player.eyePosition();
    const dir = this.player.lookDir();
    const hit = this.mobs
      ? this.mobs.raycast(eye.x, eye.y, eye.z, dir.x, dir.y, dir.z, this.reach())
      : null;
    const blockDist = this.target ? this.target.distance : Infinity;
    if (hit && hit.distance <= Math.min(blockDist + 0.4, this.reach())) {
      const def = this.inventory.held ? itemDef(this.inventory.held.item) : undefined;
      const dmg = def && def.toolClass === 'sword' ? def.attack : def && def.attack > 1 ? def.attack * 0.8 : 1;
      this.player.startSwing();
      this.attackCooldown = 0.28;
      const killed = hit.entity.hurt(dmg, this.player.position.x, this.player.position.z, this.entityHost, 0.4);
      this.renderer3d.particles.damage(hit.entity.position.x, hit.entity.position.y + hit.entity.height * 0.6, hit.entity.position.z, 8);
      audio.play('mob.hurt', { volume: 0.9, pitch: 0.9 + Math.random() * 0.25 });
      if (this.inventory.held) this.inventory.damageHeld(1);
      void killed;
      return;
    }
    // otherwise start/continue mining
    this.mouseDown[0] = true;
  }

  private updateMining(dt: number): void {
    if (!this.mouseDown[0] || this.containers.isOpen || !this.running) {
      this.miningProgress = 0;
      this.miningKey = '';
      return;
    }
    this.updateTarget();
    const t = this.target;
    if (!t) {
      this.miningProgress = 0;
      this.miningKey = '';
      return;
    }
    const key = `${t.x},${t.y},${t.z}`;
    if (key !== this.miningKey) {
      this.miningKey = key;
      this.miningProgress = 0;
    }
    const block = getBlock(t.id);
    if (this.player.gameMode === 'creative') {
      this.breakBlock(t, true);
      this.miningProgress = 0;
      return;
    }
    const { tier, cls } = this.heldTool();
    const time = breakTime(block, tier, cls?.toolClass ?? 'none', cls?.speed ?? 1);
    if (!Number.isFinite(time)) return;
    const step = dt / Math.max(0.05, time);
    this.miningProgress += step;
    this.player.startSwing();
    if (Math.random() < dt * 6) {
      const c = this.atlas.averageColor(this.atlas.slot(block.tex.all ?? block.tex.side ?? block.tex.top ?? 'stone'));
      this.renderer3d.particles.blockHit(t.x + 0.5, t.y + 0.5, t.z + 0.5, t.id, 1);
      void c;
    }
    if (this.miningProgress >= 1) {
      this.breakBlock(t, false);
      this.miningProgress = 0;
    }
    void this.wheelAccum;
  }

  private breakBlock(t: RayHit, instant: boolean): void {
    const block = getBlock(t.id);
    if (block.hardness < 0) return;
    const { tier, cls } = this.heldTool();
    const toolClass = cls?.toolClass ?? 'none';

    if (!instant) {
      audio.playBlock('break', block.sound, { volume: 0.6, pitch: 0.85 + Math.random() * 0.3 });
      if (canHarvest(block, tier)) {
        const drops = dropsFor(block);
        for (const d of drops) {
          if (d.chance !== undefined && Math.random() > d.chance) continue;
          const n = d.min !== undefined && d.max !== undefined ? d.min + Math.floor(Math.random() * (d.max - d.min + 1)) : 1;
          if (n <= 0) continue;
          this.drops.spawn(d.item, n, t.x + 0.5, t.y + 0.5, t.z + 0.5);
        }
      }
      const shearsDrop = block.name.includes('leaves') && toolClass === 'shears';
      if (shearsDrop) this.drops.spawn(block.name, 1, t.x + 0.5, t.y + 0.5, t.z + 0.5);
      if (this.inventory.held) this.inventory.damageHeld(1);
    }
    this.renderer3d.particles.blockBreak(t.x + 0.5, t.y + 0.5, t.z + 0.5, t.id, 22);
    this.world.setBlock(t.x, t.y, t.z, 0);
    this.removeContainerAt(t.x, t.y, t.z);
    // plants resting on the removed block fall away
    for (const [ox, oy, oz] of [[0, 1, 0], [0, -1, 0]] as [number, number, number][]) {
      const id = this.world.getBlockAt(t.x + ox, t.y + oy, t.z + oz);
      const def = getBlock(id);
      if (def.render === 'cross' || def.name === 'torch') {
        if (oy === 1 || def.render === 'cross') this.world.setBlock(t.x + ox, t.y + oy, t.z + oz, 0);
        this.drops.spawn(def.name, 1, t.x + ox + 0.5, t.y + oy + 0.5, t.z + oz + 0.5);
      }
    }
    void this.placeCooldown;
  }

  private tryUse(): void {
    if (!this.running || this.containers.isOpen) return;
    if (this.useCooldown > 0) return;
    this.useCooldown = 0.2;
    this.updateTarget();

    // block interactions first
    const t = this.target;
    if (t) {
      const id = t.id;
      /*
       * Doors swing on a right click. The world stores only a block id per cell,
       * so the state and the half are carried by four ids; whichever half is
       * clicked, both are swapped together.
       */
      const swap = DOOR_SWAP[id];
      if (swap) {
        const top = id === B.oak_door_top || id === B.oak_door_open_top;
        const lower = top ? { x: t.x, y: t.y - 1, z: t.z } : { x: t.x, y: t.y, z: t.z };
        const upper = top ? { x: t.x, y: t.y, z: t.z } : { x: t.x, y: t.y + 1, z: t.z };
        this.world.setBlock(lower.x, lower.y, lower.z, swap[0]);
        this.world.setBlock(upper.x, upper.y, upper.z, swap[1]);
        // the wooden place sound stands in for a door's creak
        audio.play('place.wood', { volume: 0.55, pitch: 1.25 });
        return;
      }
      if (id === B.crafting_table) {
        this.openContainer('crafting_table');
        return;
      }
      if (id === B.furnace || id === B.furnace_lit) {
        const key = containerKey(t.x, t.y, t.z);
        let f = this.furnaces.get(key);
        if (!f) {
          f = new FurnaceState();
          f.x = t.x;
          f.y = t.y;
          f.z = t.z;
          this.furnaces.set(key, f);
        }
        this.openContainer('furnace', f);
        return;
      }
      if (id === B.chest) {
        const key = containerKey(t.x, t.y, t.z);
        let c = this.chests.get(key);
        if (!c) {
          c = new ChestState();
          c.x = t.x;
          c.y = t.y;
          c.z = t.z;
          this.chests.set(key, c);
        }
        this.openContainer('chest', undefined, c);
        return;
      }
    }

    const held = this.inventory.held;
    if (!held) return;
    const def = itemDef(held.item);

    // eating
    if (def?.food && this.player.hunger < 20 && !this.player.dead) {
      this.player.hunger = Math.min(20, this.player.hunger + def.food.hunger);
      this.inventory.consumeHeld(1);
      this.updateHeld();
      audio.play('pop', { volume: 0.5, pitch: 1.4 });
      return;
    }

    const blockId = blockIdOf(held.item);
    if (blockId <= 0) return;
    if (!t) return;
    const px = t.px;
    const py = t.py;
    const pz = t.pz;
    const existing = this.world.getBlockAt(px, py, pz);
    const existingDef = getBlock(existing);
    if (existing !== 0 && !existingDef.replaceable) return;

    // never place inside the player
    const def2 = getBlock(blockId);
    if (def2.solid && this.playerIntersectsBlock(px, py, pz)) return;

    /*
     * A door fills two cells.
     *
     * Placing only the lower half is what produced the reported "you can only
     * see the bottom half of the door" - the upper cell stayed empty, so the
     * doorway had a gap above the leaf. Both halves are placed together, and the
     * placement is refused outright if the upper cell is not free rather than
     * leaving half a door behind.
     */
    if (blockId === B.oak_door) {
      if (py + 1 >= 128) return;
      const above = this.world.getBlockAt(px, py + 1, pz);
      if (above !== 0 && !getBlock(above).replaceable) return;
      this.world.setBlock(px, py + 1, pz, B.oak_door_top);
    }

    this.world.setBlock(px, py, pz, blockId);
    this.renderer3d.particles.blockPlace(px + 0.5, py + 0.5, pz + 0.5, blockId);
    audio.playBlock('place', def2.sound, { volume: 0.55, pitch: 0.9 + Math.random() * 0.2 });
    this.player.startSwing();
    if (this.player.gameMode !== 'creative') {
      this.inventory.consumeHeld(1);
      this.updateHeld();
    }
    if (blockId === B.furnace) {
      const key = containerKey(px, py, pz);
      const f = new FurnaceState();
      f.x = px;
      f.y = py;
      f.z = pz;
      this.furnaces.set(key, f);
    } else if (blockId === B.chest) {
      const key = containerKey(px, py, pz);
      const c = new ChestState();
      c.x = px;
      c.y = py;
      c.z = pz;
      this.chests.set(key, c);
    }
  }

  private playerIntersectsBlock(x: number, y: number, z: number): boolean {
    const p = this.player.position;
    const hw = this.player.width / 2;
    return (
      p.x + hw > x && p.x - hw < x + 1 &&
      p.y + this.player.height > y && p.y < y + 1 &&
      p.z + hw > z && p.z - hw < z + 1
    );
  }

  private removeContainerAt(x: number, y: number, z: number): void {
    const key = containerKey(x, y, z);
    const f = this.furnaces.get(key);
    if (f) {
      for (const s of [f.input, f.fuel, f.output]) if (s) this.drops.spawn(s.item, s.count, x + 0.5, y + 0.6, z + 0.5);
      this.furnaces.delete(key);
      if (this.openFurnace === f) this.closeContainer();
    }
    const c = this.chests.get(key);
    if (c) {
      for (const s of c.slots) if (s) this.drops.spawn(s.item, s.count, x + 0.5, y + 0.6, z + 0.5);
      this.chests.delete(key);
      if (this.openChest === c) this.closeContainer();
    }
  }

  /* ---------------------------------------------------------------- */
  /* Simulation                                                        */
  /* ---------------------------------------------------------------- */

  private tickFurnaces(dt: number): void {
    for (const f of this.furnaces.values()) {
      const recipe = f.input ? smeltFor(f.input.item) : undefined;
      const canOutput =
        recipe &&
        (!f.output || (f.output.item === recipe.output && f.output.count < maxStack(recipe.output)));

      if (f.burnTime > 0) f.burnTime = Math.max(0, f.burnTime - dt);

      if (f.burnTime <= 0 && canOutput && f.fuel) {
        const fuelDef = itemDef(f.fuel.item);
        const value = fuelDef?.fuel ?? 0;
        if (value > 0) {
          f.burnTime = value;
          f.burnTotal = value;
          f.fuel.count -= 1;
          if (f.fuel.count <= 0) f.fuel = null;
        }
      }

      if (f.burnTime > 0 && canOutput && f.input) {
        const recipeTime = recipe ? recipe.time : 10;
        f.cookTotal = recipeTime;
        f.cookProgress += dt;
        if (f.cookProgress >= f.cookTotal) {
          f.cookProgress = 0;
          const out = makeStack(recipe.output, recipe.count);
          if (f.output) f.output.count += recipe.count;
          else f.output = out;
          f.input.count -= 1;
          if (f.input && f.input.count <= 0) f.input = null;
          audio.play('pop', { volume: 0.25, pitch: 0.8 });
        }
      } else {
        f.cookProgress = Math.max(0, f.cookProgress - dt * 2);
      }

      // swap the block visually when lit
      const litId = this.world.getBlockAt(f.x, f.y, f.z);
      if (f.burnTime > 0 && litId === B.furnace) this.world.setBlock(f.x, f.y, f.z, B.furnace_lit, true);
      else if (f.burnTime <= 0 && litId === B.furnace_lit) this.world.setBlock(f.x, f.y, f.z, B.furnace, true);
    }
    if (this.containers.isOpen) this.containers.refresh(false);
  }

  private updateWeather(dt: number): void {
    this.weatherTimer -= dt;
    if (this.weatherTimer <= 0) {
      if (this.weather === 'clear') {
        this.weather = Math.random() < 0.3 ? 'snow' : 'rain';
        this.weatherTimer = 180 + Math.random() * 300;
      } else {
        this.weather = 'clear';
        this.weatherTimer = 300 + Math.random() * 600;
      }
    }
    if (this.weather !== 'clear' && this.running) {
      const p = this.player.position;
      this.renderer3d.particles.weather(p.x, p.y + 12, p.z, this.weather === 'snow' ? 'snow' : 'rain', dt);
    }
  }

  private tick(dt: number): void {
    this.updateTarget();
    this.updateMining(dt);
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.useCooldown > 0) this.useCooldown -= dt;
    if (this.placeCooldown > 0) this.placeCooldown -= dt;

    const input = {
      forward: this.keys.has('KeyW') || this.keys.has('ArrowUp'),
      back: this.keys.has('KeyS') || this.keys.has('ArrowDown'),
      left: this.keys.has('KeyA') || this.keys.has('ArrowLeft'),
      right: this.keys.has('KeyD') || this.keys.has('ArrowRight'),
      jump: this.keys.has('Space'),
      sneak: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      sprint:
        this.keys.has('ControlLeft') ||
        this.keys.has('ControlRight') ||
        this.keys.has('KeyR') ||
        this.sprintLatched,
    };
    this.player.update(this.world, input, dt);
    this.world.tickFallingBlocks(48);

    // footstep sounds
    if (this.player.onGround && Math.hypot(this.player.velocity.x, this.player.velocity.z) > 0.8) {
      const prev = this.footstepPhase;
      this.footstepPhase += dt * (this.player.sprinting ? 3.1 : 2.2);
      if (Math.floor(prev) !== Math.floor(this.footstepPhase)) {
        const below = this.world.getBlockAt(Math.floor(this.player.position.x), Math.floor(this.player.position.y - 0.2), Math.floor(this.player.position.z));
        if (below !== 0) audio.playBlock('step', getBlock(below).sound, { volume: 0.32, pitch: 0.9 + Math.random() * 0.25 });
      }
    }

    this.drops.update(dt, this.world, this.player, this.viewLight, this.elapsed);
    this.mobs.update(dt, this.player.position.x, this.player.position.y, this.player.position.z);
    this.tickFurnaces(dt);
    this.updateWeather(dt);
    this.mobs.group.visible = true;

    if (this.player.dead && !this.screens.isOpen) {
      this.dropInventoryOnDeath();
      this.screens.showDeath();
      document.exitPointerLock?.();
    }

    // autosave
    this.autosaveTimer += dt;
    if (this.autosaveTimer > 60) {
      this.autosaveTimer = 0;
      this.save();
      this.hud.showToast('Autosaved', 1.2);
    }
  }

  private footstepPhase = 0;
  private hudHidden = false;
  private fallbackNotified = false;
  /** time of the previous fresh W press, for double-tap sprinting */
  private lastForwardTap = -1e9;
  private sprintLatched = false;

  private dropInventoryOnDeath(): void {
    const p = this.player.position;
    for (let i = 0; i < this.inventory.slots.length; i++) {
      const s = this.inventory.slots[i];
      if (!s) continue;
      this.drops.spawn(s.item, s.count, p.x, p.y + 0.8, p.z, 0.3);
      this.inventory.slots[i] = null;
    }
    this.crafting.drainTo(this.inventory);
    this.updateHeld();
  }

  /* ---------------------------------------------------------------- */
  /* Frame                                                             */
  /* ---------------------------------------------------------------- */

  private resize(): void {
    const w = window.innerWidth;
    const h = window.innerHeight;
    this.renderer3d.resize(w, h);
  }

  private applySettings(s: Settings): void {
    this.settings = s;
    this.renderer3d.applySettings(
      {
        fov: s.fov,
        renderDistance: s.renderDistance,
        bobAmount: s.bobAmount,
        graphics: s.graphics,
        showFps: s.showFps,
      },
      this.world,
    );
    audio.setVolumes(s.masterVolume, s.sfxVolume, s.musicVolume);
  }

  private loop(now: number): void {
    requestAnimationFrame(this.loop);
    try {
      this.frame(now);
    } catch (e) {
      // A single bad frame must not silently blank the game: report it once,
      // visibly, and keep the loop alive.
      this.reportFrameError(e);
    }
  }

  private frameErrors = 0;
  private reportFrameError(e: unknown): void {
    this.frameErrors++;
    if (this.frameErrors > 3) return;
    const msg = e instanceof Error ? `${e.message}\n${(e.stack ?? '').split('\n').slice(0, 4).join('\n')}` : String(e);
    console.error('[cubeworld] frame error:', e);
    this.screens.showError(`Runtime error (frame ${this.frameErrors})\n\n${msg}`);
  }

  private frame(now: number): void {
    // Measured from here to the end of the render submission, so F3 can show how
    // much of the frame is JavaScript and how much is waiting on the GPU.
    const frameStart = performance.now();
    const dtRaw = this.lastTime ? (now - this.lastTime) / 1000 : 0.016;
    this.lastTime = now;
    const dt = Math.min(0.1, Math.max(0, dtRaw));
    this.elapsed += dt;

    if (this.running) {
      // mouse look
      const sens = 0.0022 * this.settings.mouseSensitivity;
      /*
       * No per-frame cap here.
       *
       * One was added to bound the view-jolt, and it was a mistake: a cap in
       * pixels per *frame* is a rate that scales with the frame rate. At 60 FPS
       * it allows 9000 px/s and is never reached, but at the 12-24 FPS this game
       * actually runs at it allows only 1800-3600 px/s - which a normal turn
       * exceeds - so the camera silently applied a fraction of the mouse's
       * movement, unevenly, frame by frame. That is the "slowed and jittery"
       * that followed it.
       *
       * The spurious movement is removed per frame instead, by comparing this
       * frame's total with recent ones - see LookGate for why a size threshold
       * cannot work.
       */
      const [gx, gy] = this.lookGate.check(this.lookDeltaX, this.lookDeltaY, dt);
      this.cameraTrace.noteGate(gx === 0 && gy === 0 && (this.lookDeltaX !== 0 || this.lookDeltaY !== 0));
      const wantYaw = -gx * sens;
      const wantPitch = -gy * sens;
      const beforeYaw = this.player.yaw;
      const beforePitch = this.player.pitch;
      this.player.yaw += wantYaw;
      this.player.pitch += wantPitch;
      // Captured before the wrap, so the applied rotation is exactly comparable
      // with what the input called for rather than being off by a whole turn.
      const appliedYaw = this.player.yaw - beforeYaw;
      this.player.pitch = Math.max(-Math.PI / 2 + 0.001, Math.min(Math.PI / 2 - 0.001, this.player.pitch));
      const appliedPitch = this.player.pitch - beforePitch;
      this.player.yaw = wrapYaw(this.player.yaw);
      this.cameraTrace.endFrame(appliedYaw, wantYaw, appliedPitch, wantPitch, 1e-6, dt * 1000);
    }
    // Reset unconditionally: while paused, deltas used to accumulate and then
    // land as one large jolt the moment the game resumed.
    this.lookDeltaX = 0;
    this.lookDeltaY = 0;
    if (this.running) {
      this.tickAccum += dt;
      let steps = 0;
      while (this.tickAccum >= 1 / 60 && steps < 5) {
        this.tick(1 / 60);
        this.tickAccum -= 1 / 60;
        steps++;
      }
      if (steps === 0) this.updateTarget();
    }

    // camera
    const p = this.player;
    const bob = this.settings.bobAmount;
    const bobX = Math.sin(p.bobPhase) * 0.045 * bob * Math.min(1, Math.hypot(p.velocity.x, p.velocity.z) / 4);
    const bobY = Math.abs(Math.cos(p.bobPhase)) * 0.05 * bob * Math.min(1, Math.hypot(p.velocity.x, p.velocity.z) / 4);
    this.renderer3d.camera.position.set(p.position.x + bobX * Math.cos(p.yaw), p.eyeY + bobY, p.position.z - bobX * Math.sin(p.yaw));
    this.renderer3d.camera.rotation.set(p.pitch, p.yaw, 0);

    const sky = this.renderer3d.sky.update(dt, this.renderer3d.camera, p.position.y);
    this.skyState = sky;
    if (this.weather !== 'clear') {
      sky.skyLight.multiplyScalar(0.62);
      sky.ambient.multiplyScalar(0.7);
      sky.fogColor.lerp(new THREE.Color(0.42, 0.45, 0.5), 0.55);
    }

    const underwater = p.headInWater;
    // "Underground" drives the darkened fog. It must be based on the light at the
    // camera, not on the column height map: the height map includes leaves and
    // anything above the player, so simply standing under a tree used to plunge
    // the whole view into near-black cave fog.
    const eyeSky = this.world.getSkyLightAt(Math.floor(p.position.x), Math.floor(p.eyeY), Math.floor(p.position.z));
    const underground = !underwater && eyeSky < 9;
    this.renderer3d.update(dt, this.world, sky, {
      underwater,
      underground,
      bobAmount: bob,
      light: this.viewLight,
    });

    // held item lighting comes from the block the player is standing in
    const eye = p.eyePosition();
    const sky15 = this.world.getSkyLightAt(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) / 15;
    const blk15 = this.world.getBlockLightAt(Math.floor(eye.x), Math.floor(eye.y), Math.floor(eye.z)) / 15;
    this.viewLight.setRGB(
      Math.max(sky15 * sky.skyLight.r, blk15 * 1.0, 0.12),
      Math.max(sky15 * sky.skyLight.g, blk15 * 0.78, 0.12),
      Math.max(sky15 * sky.skyLight.b, blk15 * 0.52, 0.14),
    );

    // highlight
    if (this.running && this.target) {
      this.renderer3d.highlight.show(this.target.x, this.target.y, this.target.z);
      const t = this.target;
      const block = getBlock(t.id);
      if (this.player.gameMode === 'creative') this.renderer3d.highlight.setProgress(0);
      else this.renderer3d.highlight.setProgress(this.miningKey === `${t.x},${t.y},${t.z}` ? this.miningProgress : 0);
      void block;
    } else {
      this.renderer3d.highlight.hide();
    }

    this.renderer3d.render();
    if (!this.hudHidden && (this.running || !this.screens.isOpen)) {
      this.renderer3d.renderViewModel(this.viewLight, p.swing, p.swingActive, p.bobPhase, bob);
    }

    this.renderer3d.sampleFps(dt);
    this.renderer3d.sampleFrame(performance.now() - frameStart, dt);
    // If the terrain shader failed to produce an image, the renderer downgrades
    // to a plain textured material. Tell the player rather than silently
    // changing how the world looks.
    if (!this.fallbackNotified && this.renderer3d.usingFallbackTerrain) {
      this.fallbackNotified = true;
      this.hud.showToast('Terrain shader fallback active - press F3 for details', 6);
    }
    this.hud.setClickHint(this.running && !this.pointerLocked && !this.containers.isOpen && !this.screens.isOpen);
    this.hud.update(dt, this.inventory, {
      debugVisible: this.debug.overlayVisible,
      debugText: this.debug.text(),
      damageFlash: p.damageFlash,
      underwater,
    }, {
      health: p.health,
      hunger: p.hunger,
      air: p.air,
      maxAir: p.maxAir,
      survival: p.gameMode === 'survival',
    });
    audio.update(dt);
  }

  get entityHost(): EntityHost {
    return this.host;
  }

  /** Called by the debug console. */
  debugSetTime(t: number): void {
    this.renderer3d.sky.setTime(t);
  }

  debugSetGameMode(mode: GameModeName): void {
    this.gameMode = mode;
    this.player.gameMode = mode === 'creative' ? 'creative' : 'survival';
    if (mode === 'survival') this.player.flying = false;
    this.hud.showToast(`Game mode: ${mode}`, 1.5);
  }

  debugHeldBlockId(): number {
    const held = this.inventory.held;
    return held ? blockIdOf(held.item) : 0;
  }

  debugGive(item: string, count: number): boolean {
    if (!itemDef(item)) return false;
    const left = this.inventory.add(makeStack(item, count));
    this.updateHeld();
    return left < count;
  }

  debugTeleport(x: number, y: number, z: number): void {
    this.player.position.set(x, y, z);
    this.player.velocity.set(0, 0, 0);
    this.renderer3d.chunkManager.update(x, z);
  }

  debugEnsureChunks(x: number, z: number): void {
    const cx = Math.floor(x / CHUNK_X);
    const cz = Math.floor(z / CHUNK_Z);
    for (let dz = -2; dz <= 2; dz++) {
      for (let dx = -2; dx <= 2; dx++) {
        if (!this.world.getChunk(cx + dx, cz + dz)) {
          const c = this.world.createChunk(cx + dx, cz + dz);
          this.world.generator.generateChunk(c);
          c.stage = 'terrain';
          this.world.light.initialLight(c);
          c.stage = 'lit';
        }
      }
    }
    this.renderer3d.chunkManager.markAllDirty();
  }

  debugLocate(kind: 'village' | 'dungeon'): string {
    const px = this.player.position.x;
    const pz = this.player.position.z;
    const list = this.world.generator.structures.discovered.filter((s) => s.kind === kind);
    let best: { x: number; y: number; z: number; kind: string } | null = null;
    let bestD = Infinity;
    for (const s of list) {
      const d = (s.x - px) ** 2 + (s.z - pz) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    if (!best) {
      // force a wider search by generating a ring of chunk metadata
      for (let r = 1; r <= 24 && !best; r++) {
        for (let i = 0; i < 32; i++) {
          const a = (i / 32) * Math.PI * 2;
          const x = Math.round(px + Math.cos(a) * r * 64);
          const z = Math.round(pz + Math.sin(a) * r * 64);
          this.world.generator.structures.stampsForChunk(x >> 4, z >> 4);
        }
        const found = this.world.generator.structures.discovered.filter((s) => s.kind === kind);
        for (const s of found) {
          const d = (s.x - px) ** 2 + (s.z - pz) ** 2;
          if (d < bestD) {
            bestD = d;
            best = s;
          }
        }
      }
    }
    if (!best) return `No ${kind} found nearby.`;
    const dist = Math.round(Math.sqrt(bestD));
    return `Nearest ${kind}: ${best.x} ${best.y} ${best.z} (${dist} blocks away)`;
  }

  debugSpawnMob(type: string): void {
    const dir = this.player.lookDir();
    const p = this.player.eyePosition();
    this.debugEnsureChunks(p.x, p.z);
    this.mobs.spawn(type, p.x + dir.x * 3, p.y, p.z + dir.z * 3);
  }

  debugRain(on: boolean): void {
    this.weather = on ? 'rain' : 'clear';
    this.weatherTimer = 400;
  }

  debugSetWeather(w: Weather): void {
    this.weather = w;
    this.weatherTimer = 400;
  }

  debugCreativePalette(): string[] {
    return creativePalette();
  }

  /** Pasteable report from the camera trace, for diagnosing the view-jolt bug. */
  cameraTraceDump(): string {
    return this.cameraTrace.dump();
  }

  resetCameraTrace(): void {
    this.cameraTrace.reset();
  }

  debugInfo(): string[] {    const p = this.player.position;
    const biome = biomeById(this.world.biomeAt(Math.floor(p.x), Math.floor(p.z)));
    const t = this.target;
    const lines = [
      `CubeWorld debug`,
      `XYZ ${p.x.toFixed(2)} ${p.y.toFixed(2)} ${p.z.toFixed(2)}`,
      `Chunk ${Math.floor(p.x / 16)}, ${Math.floor(p.z / 16)}  seed ${this.world.seed}`,
      `Biome ${biome ? biome.display : '?'}  dim ${this.world.dimension}`,
      `Time ${this.renderer3d.sky.time.toFixed(3)}  weather ${this.weather}`,
      `Light sky ${this.world.getSkyLightAt(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z))} block ${this.world.getBlockLightAt(Math.floor(p.x), Math.floor(p.y + 1), Math.floor(p.z))}`,
      `Looking at ${t ? `${getBlock(t.id).display} @ ${t.x} ${t.y} ${t.z}` : 'nothing'}`,
      `Held ${this.inventory.held ? itemDisplay(this.inventory.held.item) : 'empty'}`,
    ];
    return lines;
  }

  setSkyTime(t: number): void {
    this.renderer3d.sky.setTime(t);
  }

  get skyTime(): number {
    return this.renderer3d.sky.time;
  }

  get isNight(): boolean {
    return (this.skyState?.dayFactor ?? 1) < 0.25;
  }

  get dayFactor(): number {
    return this.skyState?.dayFactor ?? 1;
  }

  get particleSystem(): Renderer['particles'] {
    return this.renderer3d.particles;
  }

  get settingsRef(): Settings {
    return this.settings;
  }

  updateSettings(s: Partial<Settings>): void {
    this.settings = { ...this.settings, ...s };
    saveSettings(this.settings);
    this.applySettings(this.settings);
  }

  resetSettings(): void {
    this.settings = { ...DEFAULT_SETTINGS };
    saveSettings(this.settings);
    this.applySettings(this.settings);
  }

  /** Exposed for the debug console. */
  get chunkManager(): typeof this.renderer3d.chunkManager {
    return this.renderer3d.chunkManager;
  }

  get itemStackOf(): typeof makeStack {
    return makeStack;
  }

  static readonly SEA_LEVEL = SEA_LEVEL;
  static readonly CHUNK_Y = CHUNK_Y;
  static readonly CHUNK_Z = CHUNK_Z;
}

/* ------------------------------------------------------------------ */

function containerKey(x: number, y: number, z: number): number {
  return ((x & 0xffff) << 24) | ((z & 0xffff) << 8) | (y & 0xff);
}

function unpackEditsInto(world: World, encoded: string): void {
  const edits = unpackEdits(encoded);
  for (const [key, m] of edits) world.edits.set(key, m);
}

function nextFrame(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

function applyEditsToChunk(world: World, chunk: Chunk): void {
  const m = world.edits.get(chunkKey(chunk.cx, chunk.cz));
  if (!m) return;
  for (const [index, id] of m) {
    if (index >= 0 && index < chunk.blocks.length) chunk.blocks[index] = id;
  }
}

export { applyEditsToChunk, blockIndex, CHUNK_Y as WORLD_HEIGHT };
