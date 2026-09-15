/**
 * WebGL renderer: world, sky, weather, particles, block highlight and the held
 * item view model.
 */

import * as THREE from 'three';
import { Atlas } from './atlas.js';
import { createAtlasTexture, createTerrainMaterial, createTerrainUniforms, TerrainUniforms } from './materials.js';
import { Sky, SkyState } from './sky.js';
import { VoxelMesher } from './mesher.js';
import { ChunkManager } from '../world/chunkmanager.js';
import { World } from '../world/world.js';
import { ViewModel, BlockHighlight } from './viewmodel.js';
import { ParticleSystem } from './particles.js';
import { MaterialProbe } from './probe.js';
import { PixBuf, rgb } from './pixel.js';
import { paintTile } from './blockTextures.js';
import { hashInt } from '../util/rng.js';

export interface RenderSettings {
  fov: number;
  renderDistance: number;
  bobAmount: number;
  graphics: 'fast' | 'fancy';
  showFps: boolean;
}

export interface RenderStats {
  fps: number;
  drawCalls: number;
  triangles: number;
  entities: number;
}

export class Renderer {
  readonly renderer: THREE.WebGLRenderer;
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  readonly atlas: Atlas;
  readonly itemAtlas: Atlas;
  readonly uniforms: TerrainUniforms;
  readonly sky: Sky;
  readonly chunkManager: ChunkManager;
  readonly particles: ParticleSystem;
  readonly viewModel: ViewModel;
  readonly highlight: BlockHighlight;
  readonly stats: RenderStats = { fps: 0, drawCalls: 0, triangles: 0, entities: 0 };

  readonly blockTexture: THREE.DataTexture;
  readonly itemTexture: THREE.DataTexture;
  private opaqueMat: THREE.ShaderMaterial;
  private waterMat: THREE.ShaderMaterial;
  private fpsAccum = 0;
  private fpsFrames = 0;
  private timeAccum = 0;
  private fogNearBase = 70;
  private fogFarBase = 130;

  constructor(canvas: HTMLCanvasElement, blockAtlas: Atlas, itemAtlas: Atlas, world: World) {
    this.atlas = blockAtlas;
    this.itemAtlas = itemAtlas;

    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: false,
      alpha: false,
      powerPreference: 'high-performance',
      stencil: false,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5));
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;
    this.renderer.setClearColor(0x8fb4e0, 1);
    // The world pass owns the colour+depth buffers: it clears explicitly in
    // render(). Leaving autoClear on would make every *later* render() call
    // (the held-item view model) clear the colour buffer as well and wipe the
    // world off the screen.
    this.renderer.autoClear = false;
    // See the note in materials.ts - the game is authored in display space.
    THREE.ColorManagement.enabled = false;

    this.camera = new THREE.PerspectiveCamera(75, 1, 0.06, 1200);
    this.camera.rotation.order = 'YXZ';

    this.blockTexture = createAtlasTexture(blockAtlas);
    this.itemTexture = createAtlasTexture(itemAtlas);
    this.uniforms = createTerrainUniforms(this.blockTexture);

    /*
     * The opaque layer carries the cutout plants - tall grass, flowers,
     * saplings, dead bush - because they are cuboid/cross geometry rather than
     * the liquid/glass layer. Their tiles are mostly transparent, so with an
     * alpha test of 0 their empty texels were drawn as opaque black: the world
     * filled up with black X shapes.
     *
     * Every solid block tile is fully opaque (alpha 255), so testing the opaque
     * layer at 0.5 costs nothing there and correctly discards the plant cutouts.
     * Water keeps its own low threshold, which is why the two materials no
     * longer share one uniforms object - the shallow copy below shares every
     * other uniform *by reference*, so the per-frame light and fog updates still
     * reach both materials.
     */
    this.uniforms.uAlphaTest.value = 0.5;
    /*
     * Water gets its own opacity as well as its own alpha test.
     *
     * A water tile is painted at alpha ~220, so at the shared opacity of 1 the
     * surface came out ~86% opaque and the sea floor was effectively hidden: it
     * read as a flat blue slab rather than water you can see into. 0.6 lets
     * roughly 40% of what is behind show through, which is what makes depth
     * readable, while still being far too solid to vanish.
     */
    const waterUniforms = {
      ...this.uniforms,
      uAlphaTest: { value: 0.02 },
      uOpacity: { value: 0.6 },
    };

    this.opaqueMat = createTerrainMaterial(this.uniforms, { transparent: false });
    this.waterMat = createTerrainMaterial(waterUniforms, { transparent: true, water: true });

    const mesher = new VoxelMesher(blockAtlas);
    this.chunkManager = new ChunkManager(world, mesher, this.opaqueMat, this.waterMat);
    this.scene.add(this.chunkManager.group);

    this.sky = new Sky(this.scene);
    this.particles = new ParticleSystem(blockAtlas, 3000);
    this.scene.add(this.particles.object);

    this.highlight = new BlockHighlight(blockAtlas, this.buildCrackTexture());
    this.scene.add(this.highlight.group);

    this.viewModel = new ViewModel(blockAtlas, itemAtlas, this.blockTexture, this.itemTexture);
  }

  /** Repack the eight crack stages into one vertically stacked overlay texture. */
  private buildCrackTexture(): { width: number; height: number; data: Uint8ClampedArray } {
    const W = 16;
    const H = 16 * 8;
    const data = new Uint8ClampedArray(W * H * 4);
    for (let stage = 0; stage < 8; stage++) {
      const buf = paintTile(`destroy_stage_${stage}`);
      for (let y = 0; y < 16; y++) {
        for (let x = 0; x < 16; x++) {
          const src = (y * 16 + x) * 4;
          const dst = ((stage * 16 + y) * W + x) * 4;
          data[dst] = buf.data[src];
          data[dst + 1] = buf.data[src + 1];
          data[dst + 2] = buf.data[src + 2];
          data[dst + 3] = buf.data[src + 3];
        }
      }
    }
    return { width: W, height: H, data };
  }

  resize(width: number, height: number): void {
    this.renderer.setSize(width, height, false);
    this.camera.aspect = width / height;
    this.camera.updateProjectionMatrix();
    this.viewModel.camera.aspect = width / height;
    this.viewModel.camera.updateProjectionMatrix();
  }

  applySettings(s: RenderSettings, world: World): void {
    if (this.chunkManager.renderDistance !== s.renderDistance) {
      this.chunkManager.renderDistance = s.renderDistance;
      this.chunkManager.markAllDirty();
      this.chunkManager.setCentre(this.camera.position.x, this.camera.position.z);
    }
    this.camera.fov = s.fov;
    const far = Math.max(4, s.renderDistance) * 16;
    // base fog distances; `update` derives the per-frame values from these
    this.fogNearBase = far * 0.52;
    this.fogFarBase = far * 0.99;
    this.camera.far = Math.max(400, far * 2.4);
    this.camera.updateProjectionMatrix();
    void world;
  }

  /** Update every frame before rendering. */
  update(
    dt: number,
    world: World,
    skyState: SkyState,
    opts: { underwater: boolean; underground: boolean; bobAmount: number; light: THREE.Color },
  ): void {
    this.timeAccum += dt;
    this.uniforms.uTime.value = this.timeAccum;

    this.uniforms.uSkyLight.value.copy(skyState.skyLight);
    this.uniforms.uAmbient.value.copy(skyState.ambient);
    this.uniforms.uFogColor.value.copy(skyState.fogColor);
    this.uniforms.uUnderwater.value = opts.underwater ? 1 : 0;
    this.uniforms.uUnderwaterColor.value.setRGB(
      skyState.fogColor.r * 0.35 + 0.03,
      skyState.fogColor.g * 0.4 + 0.14,
      skyState.fogColor.b * 0.5 + 0.34,
    );

    // Fog is derived from the base distances every frame (never accumulated),
    // and tightened underground so long tunnels do not glow sky-coloured.
    let near = this.fogNearBase;
    let far = this.fogFarBase;
    if (opts.underground && !opts.underwater) {
      (this.uniforms.uFogColor.value as THREE.Color).multiplyScalar(0.17);
      near *= 0.6;
      far *= 0.7;
    }
    this.uniforms.uFogNear.value = near;
    this.uniforms.uFogFar.value = far;

    this.renderer.setClearColor(this.uniforms.uFogColor.value as THREE.Color, 1);
    this.chunkManager.update(this.camera.position.x, this.camera.position.z);
  }

  render(): void {
    // One explicit clear per frame. `renderer.render()` does not clear any more
    // (autoClear is off) so that the view-model pass can reuse the depth buffer
    // without erasing the world.
    this.renderer.clear();
    this.assertSceneGraph();
    this.renderer.render(this.scene, this.camera);
    // Capture the world pass's counters here: renderer.info is reset by every
    // render() call, and the held-item pass runs afterwards, so sampling later
    // (as the FPS meter used to) reports the view model's numbers, not the world.
    this.worldDrawCalls = this.renderer.info.render.calls;
    this.worldTriangles = this.renderer.info.render.triangles;
    this.scheduleSelfTest();
  }

  /** Draw calls and triangles submitted by the most recent world pass. */
  worldDrawCalls = 0;
  worldTriangles = 0;

  /**
   * Read the world pass's pixels straight from the default framebuffer.
   *
   * This must happen inside the same frame as the draw: the context is created
   * without `preserveDrawingBuffer`, so the buffer is undefined once the frame is
   * composited. It also has to read the *default* framebuffer - reading back a
   * WebGLRenderTarget produced all-clear images here and made the terrain
   * self-test report false failures.
   */
  private sampleDefaultFramebuffer(): { distinct: number; nonClear: number; total: number } {
    const gl = this.renderer.getContext();
    const w = gl.drawingBufferWidth;
    const h = gl.drawingBufferHeight;
    /*
     * ONE readPixels, not 768.
     *
     * This used to walk a 32x24 grid issuing a separate `readPixels` per sample.
     * Every one of those is a synchronous pipeline flush, so a single call could
     * stall the GPU for tens of milliseconds - a visible hitch to report
     * something that four hundred pixels describe just as well. Read a small
     * region once and analyse it on the CPU.
     */
    const SW = Math.min(32, w);
    const SH = Math.min(20, h);
    const buf = new Uint8Array(SW * SH * 4);
    gl.readPixels(0, 0, SW, SH, gl.RGBA, gl.UNSIGNED_BYTE, buf);

    const seen = new Set<number>();
    let nonClear = 0;
    for (let i = 0; i < SW * SH; i++) {
      const o = i * 4;
      const key = ((buf[o] >> 4) << 8) | ((buf[o + 1] >> 4) << 4) | (buf[o + 2] >> 4);
      seen.add(key);
      if (!(buf[o] === 255 && buf[o + 1] === 0 && buf[o + 2] === 255)) nonClear++;
    }
    return { distinct: seen.size, nonClear, total: SW * SH };
  }

  /* ---------------------------------------------------------------- */
  /* Render self-test + graceful downgrade                             */
  /* ---------------------------------------------------------------- */

  /** Populated by the passive frame sampler; surfaced in the debug overlay. */
  readonly renderDiagnostics = {
    selfTest: 'pending' as 'pending' | 'ok' | 'low-contrast',
    /** distinct colours seen in the frame that is actually on screen */
    distinctColours: 0,
    nonClearPixels: 0,
    sampledPixels: 0,
    note: '',
    tier1Colours: -1,
    tier2Colours: -1,
  };

  private selfTestFrames = 0;
  private selfTestDone = false;
  private downgradeTier = 0;
  /** `?safe=1` forces the plain textured path, bypassing the custom shader. */
  private forceSafeMode = false;

  setForceSafeMode(on: boolean): void {
    this.forceSafeMode = on;
    if (on) {
      this.renderDiagnostics.note = 'forced by ?safe=1';
      this.enableFallback();
      this.selfTestDone = true;
      this.renderDiagnostics.selfTest = 'ok';
    }
  }

  /** `?probe=1` draws the material swatch row over the frame. */
  enableProbe(cloudTexture: THREE.Texture | null): void {
    if (this.probe) return;
    this.probe = new MaterialProbe(this.blockTexture, this.itemTexture, cloudTexture);
  }

  private probe: MaterialProbe | null = null;

  private scheduleSelfTest(): void {
    if (this.selfTestDone) return;
    this.selfTestFrames++;
    if (this.selfTestFrames < 45) return;
    this.selfTestDone = true;
    /*
     * PASSIVE ONLY.
     *
     * This used to bisect the terrain material and silently downgrade the world
     * when it thought the terrain had drawn nothing. It was wrong: it sampled a
     * second, specially-cleared render and reported "1 colour" even for a tier
     * that was visibly drawing, so it forced the flat-colour material over a
     * perfectly good textured one and made a working build look broken.
     *
     * It now only measures the frame that is actually on screen, and never
     * changes a material. `?tier=0|1|2` remains for deliberate overrides.
     */
    try {
      const r = this.sampleDefaultFramebuffer();
      this.renderDiagnostics.distinctColours = r.distinct;
      this.renderDiagnostics.nonClearPixels = r.nonClear;
      this.renderDiagnostics.sampledPixels = r.total;
      this.renderDiagnostics.selfTest = r.distinct >= 6 ? 'ok' : 'low-contrast';
      this.renderDiagnostics.note =
        `frame shows ${r.distinct} distinct colours over ${r.total} sampled pixels (${r.nonClear} non-background)`;
    } catch (e) {
      this.renderDiagnostics.note = `frame sampling failed: ${e instanceof Error ? e.message : String(e)}`;
    }
  }

  /**
   * Tier 1: the built-in `MeshBasicMaterial` + the atlas.
   *
   * This exact combination is proven to render on the affected machine - the
   * `?probe=1` swatch labelled "2 basic+blocks" draws the atlas correctly - so it
   * is the safest textured fallback available. `alphaTest` is handled by
   * three.js's own shader chunk rather than by hand.
   */
  private enableFallback(): void {
    if (this.downgradeTier >= 1) return;
    this.downgradeTier = 1;
    console.warn('[cubeworld] terrain: switching to the plain textured material');
    const opaque = new THREE.MeshBasicMaterial({
      map: this.blockTexture,
      side: THREE.FrontSide,
      alphaTest: 0.5,
      fog: false,
    });
    opaque.name = 'terrain-fallback-opaque';
    const water = new THREE.MeshBasicMaterial({
      map: this.blockTexture,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.8,
      depthWrite: false,
      fog: false,
    });
    water.name = 'terrain-fallback-water';
    this.chunkManager.setMaterials(opaque, water);
  }

  /** `?tier=N` forces a specific terrain material. */
  setForcedTier(tier: number): void {
    this.selfTestDone = true;
    if (tier >= 2) {
      this.enableFallback();
      this.enableFlatFallback();
    } else if (tier === 1) {
      this.enableFallback();
    }
    this.renderDiagnostics.selfTest = 'ok';
    this.renderDiagnostics.note = `terrain material forced by ?tier=${tier}`;
  }

  /** Last resort: untextured, so a broken atlas upload cannot hide the world. */
  private enableFlatFallback(): void {
    if (this.downgradeTier >= 2) return;
    this.downgradeTier = 2;
    console.warn('[cubeworld] terrain: atlas texture produced no image - using flat colours');
    const opaque = new THREE.MeshBasicMaterial({ color: 0x8fae6a, side: THREE.FrontSide, fog: false });
    opaque.name = 'terrain-flat-opaque';
    const water = new THREE.MeshBasicMaterial({
      color: 0x3a63d8,
      side: THREE.DoubleSide,
      transparent: true,
      opacity: 0.78,
      depthWrite: false,
      fog: false,
    });
    water.name = 'terrain-flat-water';
    this.chunkManager.setMaterials(opaque, water);
  }

  /** 0 = custom shader, 1 = plain textured, 2 = flat colours. */
  get terrainTier(): number {
    return this.downgradeTier;
  }

  /** True when anything other than the custom shader is in use. */
  get usingFallbackTerrain(): boolean {
    return this.downgradeTier > 0;
  }

  /**
   * three.js walks `children` and dereferences every entry, so a single
   * `undefined` in any object's child list throws inside `updateMatrixWorld`
   * before a single draw call is issued - which shows up as a completely blank
   * canvas with no shader ever compiled. Prune anything that is not an Object3D
   * and name the parent so the real cause is visible rather than silent.
   *
   * This is a safety net for a fault that can only be introduced by a coding
   * mistake, not a per-frame invariant, so it runs on the first few frames and
   * then occasionally - walking 500+ objects across the whole scene graph every
   * frame was pure overhead.
   */
  private sceneGraphFrame = 0;

  private assertSceneGraph(): void {
    const f = this.sceneGraphFrame++;
    if (f > 3 && f % 600 !== 0) return;
    const stack: THREE.Object3D[] = [this.scene];
    let guard = 0;
    while (stack.length && guard++ < 20000) {
      const obj = stack.pop()!;
      const kids = obj.children;
      for (let i = kids.length - 1; i >= 0; i--) {
        const child = kids[i] as THREE.Object3D | undefined;
        if (!child || (child as { isObject3D?: boolean }).isObject3D !== true) {
          kids.splice(i, 1);
          if (this.invalidChildReports < 8) {
            this.invalidChildReports++;
            console.warn(
              `[cubeworld] dropped a non-Object3D child (${String(child)}) from "${obj.name || obj.type}" - this would have aborted the frame`,
            );
          }
          continue;
        }
        stack.push(child);
      }
    }
  }

  private invalidChildReports = 0;

  /** Draw the held item on top of the world. */
  renderViewModel(light: THREE.Color, swing: number, swingActive: boolean, bobPhase: number, bobAmount: number): void {
    this.viewModel.update(0, swing, swingActive, bobPhase, bobAmount, light, this.camera.aspect);
    this.viewModel.render(this.renderer);
    if (this.probe) this.probe.render(this.renderer);
  }

  /**
   * Frame timing, split so the bottleneck is identifiable from inside the game.
   *
   * `jsMs` is how long the JavaScript frame body took; `frameMs` is the wall-clock
   * gap between animation frames, which also contains the GPU's work and the
   * browser's compositing. When `jsMs` is close to `frameMs` the frame is
   * CPU-bound and optimising draw calls and meshing helps. When `jsMs` is a small
   * fraction of `frameMs` the CPU is waiting on the GPU, and no amount of
   * JavaScript work will raise the frame rate - the lever is fill rate, overdraw
   * and shader cost instead.
   */
  readonly frameStats = {
    jsMs: 0,
    frameMs: 0,
    jsMsMax: 0,
    frameMsMax: 0,
    /** jsMs / frameMs averaged; >0.7 means CPU-bound */
    cpuShare: 0,
  };

  private jsAccum = 0;
  private frameAccum = 0;
  private timingFrames = 0;
  private jsMaxWindow = 0;
  private frameMaxWindow = 0;

  /** Called by the game loop with the time the JS frame body took. */
  sampleFrame(jsMs: number, dt: number): void {
    this.jsAccum += jsMs;
    this.frameAccum += dt;
    this.timingFrames++;
    if (jsMs > this.jsMaxWindow) this.jsMaxWindow = jsMs;
    if (dt * 1000 > this.frameMaxWindow) this.frameMaxWindow = dt * 1000;
    if (this.timingFrames >= 30) {
      const f = this.frameStats;
      f.jsMs = this.jsAccum / this.timingFrames;
      f.frameMs = (this.frameAccum / this.timingFrames) * 1000;
      f.jsMsMax = this.jsMaxWindow;
      f.frameMsMax = this.frameMaxWindow;
      f.cpuShare = f.frameMs > 0 ? Math.min(1, f.jsMs / f.frameMs) : 0;
      this.jsAccum = 0;
      this.frameAccum = 0;
      this.timingFrames = 0;
      this.jsMaxWindow = 0;
      this.frameMaxWindow = 0;
    }
  }

  sampleFps(dt: number): void {
    this.fpsAccum += dt;
    this.fpsFrames++;
    if (this.fpsAccum >= 0.5) {
      this.stats.fps = this.fpsFrames / this.fpsAccum;
      this.fpsAccum = 0;
      this.fpsFrames = 0;
      const info = this.renderer.info.render;
      this.stats.drawCalls = info.calls;
      this.stats.triangles = info.triangles;
    }
  }

  dispose(): void {
    this.chunkManager.dispose();
    this.sky.dispose(this.scene);
    this.viewModel.scene.clear();
    this.highlight.dispose();
    this.particles.dispose();
    this.opaqueMat.dispose();
    this.waterMat.dispose();
    this.blockTexture.dispose();
    this.itemTexture.dispose();
    this.renderer.dispose();
  }
}

export { rgb, PixBuf, hashInt };
