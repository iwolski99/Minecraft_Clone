/**
 * Pooled voxel particle system.
 *
 * Design
 * ------
 * - ONE `THREE.Points` object with a fixed preallocated pool (default 3000).
 *   Nothing is allocated during `update()`; the typed arrays are created once.
 * - Particles are square pixels: an 8x8 generated white `DataTexture` with
 *   `NearestFilter` and `sizeAttenuation`, tinted per particle through the
 *   `color` vertex attribute.
 * - Live particles always occupy slots `[0, live)`. Expired particles are
 *   compacted away in a single pass (survivor N is written back to slot M<=N),
 *   so the drawn range stays tight and recycling needs no free list.
 * - Beyond the live range every slot gets `size = 0` / `alpha = 0` and is left
 *   out of the draw range, so an empty pool costs nothing at all.
 * - Block colours are sampled straight out of the texture atlas, so breaking a
 *   block spits out that block's own palette.
 */

import * as THREE from 'three';
import { Atlas } from './atlas.js';
import { BLOCKS } from '../world/blocks.js';
import { Rng } from '../util/rng.js';

/* ------------------------------------------------------------------ */
/* Tunables                                                            */
/* ------------------------------------------------------------------ */

const DEFAULT_MAX = 3000;
/** Refuse to spawn anything further than this from the camera. */
const CULL_DISTANCE = 64;
const CULL_DISTANCE_SQ = CULL_DISTANCE * CULL_DISTANCE;
/** Once outside this box around the camera a particle is retired early. */
const HARD_CULL_DISTANCE_SQ = 96 * 96;
/** Base on-screen size, in world units at 1 m from the camera. */
const BASE_SIZE = 0.16;
/** Safety clamp so a stray dt can never teleport particles across the world. */
const MAX_STEP = 1 / 20;

type Kind = number;

const KIND_SMOKE: Kind = 0;
const KIND_FLAME: Kind = 1;
const KIND_SPARK: Kind = 2;
const KIND_WATER: Kind = 3;

/** Per-kind motion and fade profile. */
interface KindProfile {
  gravity: number;
  drag: number;
  /** initial multiplicative fade-in, seconds (0 = no fade-in) */
  fadeIn: number;
  /** multiplicative size ramp: -1 shrink, +1 grow, 0 constant */
  grow: number;
  /** how far (0..1 of the lifetime) the colour drifts towards the target tint */
  drift: number;
  driftR: number;
  driftG: number;
  driftB: number;
}

const PROFILES: readonly KindProfile[] = [
  { gravity: -1.1, drag: 1.4, fadeIn: 0.12, grow: 1.6, drift: 0.6, driftR: 0.22, driftG: 0.22, driftB: 0.25 },
  { gravity: -2.6, drag: 2.6, fadeIn: 0.04, grow: -0.5, drift: 0.35, driftR: -0.9, driftG: -0.55, driftB: -0.4 },
  { gravity: 22, drag: 0.25, fadeIn: 0, grow: 0, drift: 0, driftR: 0, driftG: 0, driftB: 0 },
  { gravity: 24, drag: 0.6, fadeIn: 0, grow: 0, drift: 0, driftR: 0, driftG: 0, driftB: 0 },
];

function profileOf(kind: Kind): KindProfile {
  return PROFILES[kind] ?? PROFILES[KIND_SPARK];
}

/* ------------------------------------------------------------------ */
/* Shaders                                                             */
/* ------------------------------------------------------------------ */

const PARTICLE_VERT = /* glsl */ `
attribute float size;
attribute float alpha;
uniform float uSize;
uniform float uScale;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;

void main() {
  vColor = color;
  vAlpha = alpha;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  float s = uSize * max(size, 0.0);
  // hide culled/dead particles completely rather than drawing a 1px dot
  gl_PointSize = s <= 0.0 ? 0.0 : max(1.0, s * uScale / max(0.35, -mv.z));
  gl_Position = projectionMatrix * mv;
}
`;

const PARTICLE_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
varying vec3 vColor;
varying float vAlpha;
varying float vDepth;

void main() {
  if (vAlpha <= 0.001) discard;
  vec4 t = texture2D(uMap, gl_PointCoord);
  if (t.a < 0.4) discard;
  vec3 c = vColor * t.rgb;
  float fog = clamp((vDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  fog = fog * fog * (3.0 - 2.0 * fog);
  c = mix(c, uFogColor, fog);
  gl_FragColor = vec4(c, vAlpha);
}
`;

/* ------------------------------------------------------------------ */
/* System                                                              */
/* ------------------------------------------------------------------ */

export class ParticleSystem {
  /** Add this to your scene once. */
  readonly object: THREE.Object3D;

  private readonly cap: number;
  private readonly rng = new Rng(0x5eed1234);

  private readonly px: Float32Array;
  private readonly py: Float32Array;
  private readonly pz: Float32Array;
  private readonly vx: Float32Array;
  private readonly vy: Float32Array;
  private readonly vz: Float32Array;
  private readonly life: Float32Array;
  private readonly maxLife: Float32Array;
  /** base sprite scale, multiplied by the per-frame ramp */
  private readonly size0: Float32Array;
  /** gravity multiplier relative to the profile */
  private readonly gravity: Float32Array;
  /** per-particle air drag factor (0 = none, 1 = strong) */
  private readonly drag: Float32Array;
  private readonly cr: Float32Array;
  private readonly cg: Float32Array;
  private readonly cb: Float32Array;
  /** kind id per live slot (indexes `PROFILES`) */
  private readonly kind: Uint8Array;

  private readonly posAttr: THREE.BufferAttribute;
  private readonly colAttr: THREE.BufferAttribute;
  private readonly sizeAttr: THREE.BufferAttribute;
  private readonly alphaAttr: THREE.BufferAttribute;
  private readonly geometry: THREE.BufferGeometry;
  private readonly material: THREE.ShaderMaterial;
  private readonly points: THREE.Points;
  private readonly texture: THREE.DataTexture;
  private readonly atlas: Atlas;

  private live = 0;
  private posDirty = false;
  private colDirty = false;
  private rainAccum = 0;
  private snowAccum = 0;
  /** last camera position handed to `update`, used to reject distant spawns */
  private camX = 0;
  private camY = 0;
  private camZ = 0;
  private haveCam = false;
  /** cached scene fog, so the uniforms are only written when it changes */
  private fogNear = 60;
  private fogFar = 130;
  private fogHex = 0x9ec2f0;

  /** blockId -> texture name used for particle colouring ('' when unknown) */
  private readonly blockTex: string[];
  /** blockId -> cached palette sampled from the atlas */
  private readonly paletteCache: Array<number[] | null>;

  constructor(atlas: Atlas, maxParticles = DEFAULT_MAX) {
    this.atlas = atlas;
    this.cap = Math.max(1, Math.floor(maxParticles) || DEFAULT_MAX);

    const cap = this.cap;
    this.px = new Float32Array(cap);
    this.py = new Float32Array(cap);
    this.pz = new Float32Array(cap);
    this.vx = new Float32Array(cap);
    this.vy = new Float32Array(cap);
    this.vz = new Float32Array(cap);
    this.life = new Float32Array(cap);
    this.maxLife = new Float32Array(cap);
    this.size0 = new Float32Array(cap);
    this.gravity = new Float32Array(cap);
    this.drag = new Float32Array(cap);
    this.cr = new Float32Array(cap);
    this.cg = new Float32Array(cap);
    this.cb = new Float32Array(cap);
    this.kind = new Uint8Array(cap);

    /* ---------------- geometry ---------------- */
    const positions = new Float32Array(cap * 3);
    const colors = new Float32Array(cap * 3);
    const sizes = new Float32Array(cap);
    const alphas = new Float32Array(cap);
    // park every unused slot far below the world and invisible
    for (let i = 0; i < cap; i++) {
      positions[i * 3 + 1] = -10000;
      sizes[i] = 0;
      alphas[i] = 0;
    }

    this.geometry = new THREE.BufferGeometry();
    this.posAttr = new THREE.BufferAttribute(positions, 3);
    this.colAttr = new THREE.BufferAttribute(colors, 3);
    this.sizeAttr = new THREE.BufferAttribute(sizes, 1);
    this.alphaAttr = new THREE.BufferAttribute(alphas, 1);
    this.posAttr.setUsage(THREE.DynamicDrawUsage);
    this.colAttr.setUsage(THREE.DynamicDrawUsage);
    this.sizeAttr.setUsage(THREE.DynamicDrawUsage);
    this.alphaAttr.setUsage(THREE.DynamicDrawUsage);
    this.geometry.setAttribute('position', this.posAttr);
    this.geometry.setAttribute('color', this.colAttr);
    this.geometry.setAttribute('size', this.sizeAttr);
    this.geometry.setAttribute('alpha', this.alphaAttr);
    // start with an empty draw range; it grows as particles spawn
    this.geometry.setDrawRange(0, 0);

    this.texture = makePixelTexture();

    this.material = new THREE.ShaderMaterial({
      uniforms: THREE.UniformsUtils.merge([
        THREE.UniformsLib.fog,
        {
          uMap: { value: this.texture },
          uSize: { value: BASE_SIZE },
          uScale: { value: 512 },
          uFogColor: { value: new THREE.Color(0.62, 0.76, 0.94) },
          uFogNear: { value: 60 },
          uFogFar: { value: 130 },
        },
      ]),
      vertexShader: PARTICLE_VERT,
      fragmentShader: PARTICLE_FRAG,
      transparent: true,
      depthWrite: false,
      depthTest: true,
      vertexColors: true,
      fog: true,
    });
    this.material.name = 'particles';

    this.points = new THREE.Points(this.geometry, this.material);
    this.points.frustumCulled = false; // the pool spans a wide volume by design
    this.points.renderOrder = 20;
    this.object = this.points;

    /* ---------------- block lookup tables ---------------- */
    const defs = BLOCKS;
    this.blockTex = new Array<string>(defs.length).fill('');
    this.paletteCache = new Array<number[] | null>(defs.length).fill(null);
    for (let id = 0; id < defs.length; id++) {
      const b = defs[id];
      const name = b.tex.all ?? b.tex.side ?? b.tex.top ?? b.tex.sprite ?? '';
      this.blockTex[id] = name;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Public spawn API                                                  */
  /* ---------------------------------------------------------------- */

  /** Block destruction: a burst of the block's own texture colours. */
  blockBreak(x: number, y: number, z: number, blockId: number, count = 24): void {
    this.emitBlockBurst(x, y, z, blockId, count, 3.4, 1.15, 0.45, 0.85);
  }

  /** Block placement: a small puff kicked out around the placed block. */
  blockPlace(x: number, y: number, z: number, blockId: number): void {
    this.emitBlockBurst(x, y, z, blockId, 7, 1.9, 0.9, 0.5, 0.7);
  }

  /** Mining chip: a couple of fragments fly off the face being hit. */
  blockHit(x: number, y: number, z: number, blockId: number, count = 5): void {
    this.emitBlockBurst(x, y, z, blockId, count, 4.4, 0.75, 0.3, 0.5);
  }

  /** Generic damage splatter. */
  damage(x: number, y: number, z: number, count = 10, color = 0xc03028): void {
    const r = ((color >> 16) & 255) / 255;
    const g = ((color >> 8) & 255) / 255;
    const b = (color & 255) / 255;
    const n = this.scale(count);
    for (let i = 0; i < n; i++) {
      const s = this.spawn(
        x + this.rng.range(-0.28, 0.28),
        y + this.rng.range(-0.15, 0.5),
        z + this.rng.range(-0.28, 0.28),
        this.rng.range(-2.1, 2.1),
        this.rng.range(0.6, 3.4),
        this.rng.range(-2.1, 2.1),
        0.42 + this.rng.next() * 0.5,
        KIND_SPARK,
        this.rng.range(0.55, 1.0),
        1,
        this.rng.range(0.55, 0.95),
      );
      if (s < 0) break;
      // blood-ish particles do not need a per-particle palette entry
      this.setColor(s, r * this.rng.range(0.75, 1.05), g * this.rng.range(0.75, 1.05), b * this.rng.range(0.75, 1.05));
    }
  }

  /** Soft rising smoke column. */
  smoke(x: number, y: number, z: number, count = 6): void {
    const n = this.scale(count);
    for (let i = 0; i < n; i++) {
      const shade = this.rng.range(0.42, 0.66);
      const s = this.spawn(
        x + this.rng.range(-0.16, 0.16),
        y + this.rng.range(0.0, 0.22),
        z + this.rng.range(-0.16, 0.16),
        this.rng.range(-0.35, 0.35),
        this.rng.range(0.5, 1.1),
        this.rng.range(-0.35, 0.35),
        1.1 + this.rng.next() * 1.4,
        KIND_SMOKE,
        this.rng.range(1.2, 2.1),
        1,
        this.rng.range(0.75, 1.25),
      );
      if (s < 0) break;
      this.setColor(s, shade, shade, shade * 0.98);
    }
  }

  /** A fire tongue: bright, short lived, shrinking. */
  flame(x: number, y: number, z: number): void {
    const s = this.spawn(
      x + this.rng.range(-0.1, 0.1),
      y + this.rng.range(0.0, 0.12),
      z + this.rng.range(-0.1, 0.1),
      this.rng.range(-0.22, 0.22),
      this.rng.range(0.5, 1.2),
      this.rng.range(-0.22, 0.22),
      0.75 + this.rng.next() * 0.8,
      KIND_FLAME,
      this.rng.range(0.3, 0.65),
      1,
      this.rng.range(0.7, 1.3),
    );
    if (s < 0) return;
    this.setColor(s, 1, this.rng.range(0.55, 0.85), this.rng.range(0.1, 0.3));
  }

  /** Radial blast: fire, smoke and debris in one call. */
  explosion(x: number, y: number, z: number, power = 1): void {
    const p = Math.max(0.2, Math.min(6, power));
    const core = this.scale(Math.round(30 * p));
    for (let i = 0; i < core; i++) {
      this.randomDir();
      const sp = this.rng.range(2.5, 9.5) * p;
      const s = this.spawn(
        x + this.rng.range(-0.3, 0.3),
        y + this.rng.range(-0.3, 0.3),
        z + this.rng.range(-0.3, 0.3),
        this.dirX * sp,
        Math.abs(this.dirY) * sp * 0.9 + this.rng.range(0.5, 2.5),
        this.dirZ * sp,
        1.1 + this.rng.next() * 1.5,
        KIND_FLAME,
        this.rng.range(0.45, 1.05),
        1,
        this.rng.range(0.8, 1.4),
      );
      if (s < 0) break;
      this.setColor(s, 1, this.rng.range(0.45, 0.9), this.rng.range(0.06, 0.3));
    }

    const puff = this.scale(Math.round(22 * p));
    for (let i = 0; i < puff; i++) {
      this.randomDir();
      const sp = this.rng.range(1.2, 4.5) * p;
      const shade = this.rng.range(0.24, 0.52);
      const s = this.spawn(
        x + this.rng.range(-1, 1) * p * 0.5,
        y + this.rng.range(-0.5, 1.0) * p * 0.5,
        z + this.rng.range(-1, 1) * p * 0.5,
        this.dirX * sp,
        Math.abs(this.dirY) * sp * 0.7 + this.rng.range(0.3, 1.6),
        this.dirZ * sp,
        1.6 + this.rng.next() * 2.2,
        KIND_SMOKE,
        this.rng.range(1.4, 2.8),
        1,
        this.rng.range(0.7, 1.3),
      );
      if (s < 0) break;
      this.setColor(s, shade, shade, shade);
    }
  }

  /** Cool blue droplets thrown up from a water impact. */
  splash(x: number, y: number, z: number, count = 18): void {
    const n = this.scale(count);
    for (let i = 0; i < n; i++) {
      const a = this.rng.next() * Math.PI * 2;
      const r = this.rng.range(0.4, 2.3);
      const s = this.spawn(
        x + this.rng.range(-0.25, 0.25),
        y + this.rng.range(0.0, 0.2),
        z + this.rng.range(-0.25, 0.25),
        Math.cos(a) * r,
        this.rng.range(2.2, 5.2),
        Math.sin(a) * r,
        0.36 + this.rng.next() * 0.4,
        KIND_WATER,
        this.rng.range(0.55, 1.15),
        1,
        this.rng.range(0.8, 1.25),
      );
      if (s < 0) break;
      const t = this.rng.next();
      this.setColor(s, 0.42 + t * 0.2, 0.6 + t * 0.22, 1.0);
    }
  }

  /**
   * Rain/snow. Spawns inside a ~24x24x16 volume centred on the given point and
   * relies on `update` to age it, so the weather system can just call this every
   * frame with the camera position.
   */
  weather(x: number, y: number, z: number, kind: 'rain' | 'snow', dt: number): void {
    const step = clamp(dt, 0, MAX_STEP);
    if (step <= 0) return;

    if (kind === 'rain') {
      this.rainAccum += step * 72;
      let n = Math.floor(this.rainAccum);
      if (n <= 0) return;
      this.rainAccum -= n;
      n = this.scale(n);
      for (let i = 0; i < n; i++) {
        const s = this.spawn(
          x + this.rng.range(-12, 12),
          y + this.rng.range(2, 14),
          z + this.rng.range(-12, 12),
          this.rng.range(-0.6, 0.6),
          this.rng.range(-19, -13),
          this.rng.range(-0.6, 0.6),
          0.32 + this.rng.next() * 0.26,
          KIND_WATER,
          this.rng.range(0.9, 1.6),
          1,
          this.rng.range(0.9, 1.1),
        );
        if (s < 0) break;
        const t = this.rng.next() * 0.12;
        this.setColor(s, 0.66 + t, 0.75 + t, 0.94 + t);
      }
      return;
    }

    this.snowAccum += step * 26;
    let n = Math.floor(this.snowAccum);
    if (n <= 0) return;
    this.snowAccum -= n;
    n = this.scale(n);
    for (let i = 0; i < n; i++) {
      const s = this.spawn(
        x + this.rng.range(-12, 12),
        y + this.rng.range(4, 16),
        z + this.rng.range(-12, 12),
        this.rng.range(-0.5, 0.5),
        this.rng.range(-1.6, -0.8),
        this.rng.range(-0.5, 0.5),
        0.4 + this.rng.next() * 0.36,
        KIND_SMOKE,
        this.rng.range(5, 9),
        1,
        this.rng.range(0.8, 1.2),
      );
      if (s < 0) break;
      const t = this.rng.range(0.86, 1.0);
      this.setColor(s, t, t, Math.min(1, t + 0.02));
    }
  }

  /* ---------------------------------------------------------------- */
  /* Update                                                            */
  /* ---------------------------------------------------------------- */

  update(dt: number, camX: number, camY: number, camZ: number): void {
    const step = clamp(dt, 0, MAX_STEP);
    this.camX = camX;
    this.camY = camY;
    this.camZ = camZ;
    this.haveCam = true;
    this.syncFog();

    if (this.live === 0 || step <= 0) {
      if (this.posDirty || this.colDirty) {
        this.posDirty = false;
        this.colDirty = false;
        this.upload();
      }
      return;
    }


    const pos = this.posAttr.array as Float32Array;    const col = this.colAttr.array as Float32Array;
    const sizes = this.sizeAttr.array as Float32Array;
    const alphas = this.alphaAttr.array as Float32Array;

    // Single-pass simulation + compaction. Dead cells are overwritten by the
    // next survivor (or by a later cell that is already updated in place), so
    // there is never an out-of-range read or a half-copied particle.
    let live = 0;
    for (let i = 0; i < this.live; i++) {
      const lifeLeft = this.life[i] - step;
      const maxLife = this.maxLife[i];
      const age = maxLife - lifeLeft;

      if (lifeLeft <= 0 || !(maxLife > 0)) continue;

      const p = profileOf(this.kind[i]);
      const idx = i * 3;

      // Integrate with exponential drag: no sqrt, no per-frame allocation.
      const g = p.gravity * this.gravity[i];
      const damp = Math.exp(-p.drag * this.drag[i] * step);
      let vx = this.vx[i];
      let vy = this.vy[i] + g * step;
      let vz = this.vz[i];
      vx *= damp;
      vy *= damp;
      vz *= damp;

      const nx = this.px[i] + vx * step;
      const ny = this.py[i] + vy * step;
      const nz = this.pz[i] + vz * step;

      // ignore anything that has drifted absurdly far from the viewer
      const dx = nx - camX;
      const dy = ny - camY;
      const dz = nz - camZ;
      if (dx * dx + dy * dy + dz * dz > HARD_CULL_DISTANCE_SQ) continue;

      const t = age / maxLife; // 0 at spawn, 1 at death
      // smooth fade out, preceded by a short fade in so spawns do not pop
      let a = 1 - t * t * (3 - 2 * t);
      if (p.fadeIn > 0 && age < p.fadeIn) a *= age / p.fadeIn;

      let scale = 1;
      if (p.grow > 0) scale = 1 + p.grow * t;
      else if (p.grow < 0) scale = Math.max(0.05, 1 + p.grow * t);

      let r = this.cr[i];
      let gg = this.cg[i];
      let b = this.cb[i];
      if (p.drift > 0) {
        const k = Math.min(1, p.drift * t);
        r = clamp01(r + p.driftR * k);
        gg = clamp01(gg + p.driftG * k);
        b = clamp01(b + p.driftB * k);
      }

      if (live !== i) {
        // move the survivor into its new, compacted slot
        const d = live * 3;
        this.px[live] = nx;
        this.py[live] = ny;
        this.pz[live] = nz;
        this.vx[live] = vx;
        this.vy[live] = vy;
        this.vz[live] = vz;
        this.life[live] = lifeLeft;
        this.maxLife[live] = maxLife;
        this.size0[live] = this.size0[i];
        this.gravity[live] = this.gravity[i];
        this.drag[live] = this.drag[i];
        this.cr[live] = this.cr[i];
        this.cg[live] = this.cg[i];
        this.cb[live] = this.cb[i];
        this.kind[live] = this.kind[i];
        pos[d] = nx;
        pos[d + 1] = ny;
        pos[d + 2] = nz;
      } else {
        this.life[i] = lifeLeft;
        this.vx[i] = vx;
        this.vy[i] = vy;
        this.vz[i] = vz;
        pos[idx] = nx;
        pos[idx + 1] = ny;
        pos[idx + 2] = nz;
      }

      const c = live * 3;
      col[c] = r;
      col[c + 1] = gg;
      col[c + 2] = b;
      sizes[live] = this.size0[live] * scale;
      alphas[live] = clamp01(a);
      live++;
    }

    this.live = live;
    // compacting already dropped every dead cell; the draw range below means
    // the vacated tail is never submitted to the GPU at all.

    this.posDirty = false;
    this.colDirty = false;
    this.upload();
  }

  clear(): void {
    const sizes = this.sizeAttr.array as Float32Array;
    const alphas = this.alphaAttr.array as Float32Array;
    const pos = this.posAttr.array as Float32Array;
    for (let i = 0; i < this.live; i++) {
      pos[i * 3 + 1] = -10000;
      sizes[i] = 0;
      alphas[i] = 0;
    }
    this.live = 0;
    this.rainAccum = 0;
    this.snowAccum = 0;
    this.geometry.setDrawRange(0, 0);
    this.posDirty = false;
    this.colDirty = false;
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
  }

  get activeCount(): number {
    return this.live;
  }

  dispose(): void {
    this.clear();
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
    this.points.removeFromParent();
  }

  /* ---------------------------------------------------------------- */
  /* Internals                                                         */
  /* ---------------------------------------------------------------- */

  /**
   * Reserve a slot and initialise it. Returns the slot index, or -1 when the
   * pool is full or the particle would spawn beyond the cull radius.
   */
  private spawn(
    x: number,
    y: number,
    z: number,
    vx: number,
    vy: number,
    vz: number,
    size: number,
    kind: Kind,
    life: number,
    gravity: number,
    drag: number,
  ): number {
    if (this.live >= this.cap) return -1;
    if (this.haveCam) {
      const dx = x - this.camX;
      const dy = y - this.camY;
      const dz = z - this.camZ;
      if (dx * dx + dy * dy + dz * dz > CULL_DISTANCE_SQ) return -1;
    }
    const i = this.live++;

    this.px[i] = x;
    this.py[i] = y;
    this.pz[i] = z;
    this.vx[i] = vx;
    this.vy[i] = vy;
    this.vz[i] = vz;
    this.life[i] = life;
    this.maxLife[i] = life;
    this.size0[i] = size;
    this.gravity[i] = gravity;
    this.drag[i] = drag;
    this.cr[i] = 1;
    this.cg[i] = 1;
    this.cb[i] = 1;
    this.kind[i] = kind;

    const pos = this.posAttr.array as Float32Array;
    const col = this.colAttr.array as Float32Array;
    const sizes = this.sizeAttr.array as Float32Array;
    const alphas = this.alphaAttr.array as Float32Array;
    const idx = i * 3;
    pos[idx] = x;
    pos[idx + 1] = y;
    pos[idx + 2] = z;
    col[idx] = 1;
    col[idx + 1] = 1;
    col[idx + 2] = 1;
    sizes[i] = size;
    alphas[i] = 1;

    this.posDirty = true;
    this.colDirty = true;
    this.syncDrawRange();
    return i;
  }

  private setColor(i: number, r: number, g: number, b: number): void {
    this.cr[i] = clamp01(r);
    this.cg[i] = clamp01(g);
    this.cb[i] = clamp01(b);
    const col = this.colAttr.array as Float32Array;
    const idx = i * 3;
    col[idx] = this.cr[i];
    col[idx + 1] = this.cg[i];
    col[idx + 2] = this.cb[i];
    this.colDirty = true;
  }

  /** Clamp a requested count to what the pool can still accept. */
  private scale(count: number): number {
    const room = this.cap - this.live;
    if (room <= 0) return 0;
    const n = Math.floor(count);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.min(n, room);
  }

  /** Fragments coloured from the block's atlas tile. */
  private emitBlockBurst(
    x: number,
    y: number,
    z: number,
    blockId: number,
    count: number,
    speed: number,
    upBias: number,
    lifeMin: number,
    lifeMax: number,
  ): void {
    const n = this.scale(count);
    if (n <= 0) return;
    const palette = this.palette(blockId);
    const paletteLen = Math.max(1, Math.floor(palette.length / 3));
    for (let i = 0; i < n; i++) {
      const pick = this.rng.int(0, paletteLen - 1);
      const shade = this.rng.range(0.72, 1.08);
      const s = this.spawn(
        x + this.rng.range(-0.42, 0.42),
        y + this.rng.range(-0.42, 0.42),
        z + this.rng.range(-0.42, 0.42),
        this.rng.range(-speed, speed) * 0.6,
        this.rng.range(0.2, 1.0) * speed * upBias,
        this.rng.range(-speed, speed) * 0.6,
        this.rng.range(0.34, 0.78),
        KIND_SPARK,
        this.rng.range(lifeMin, lifeMax),
        1,
        this.rng.range(0.1, 0.45),
      );
      if (s < 0) break;
      this.setColor(s, palette[pick * 3] * shade, palette[pick * 3 + 1] * shade, palette[pick * 3 + 2] * shade);
    }
  }

  /**
   * Sample a handful of texels from the block's tile once, then reuse them.
   * Falls back to the tile average, then to a neutral grey for unknown blocks.
   */
  private palette(blockId: number): number[] {
    const id = blockId | 0;
    const cached = id >= 0 && id < this.paletteCache.length ? this.paletteCache[id] : null;
    if (cached) return cached;

    const out: number[] = [];
    const texName = id >= 0 && id < this.blockTex.length ? this.blockTex[id] : '';
    if (texName) {
      const slot = this.atlas.slot(texName);
      const samples = 6;
      for (let i = 0; i < samples; i++) {
        const tx = this.rng.int(0, 15);
        const ty = this.rng.int(0, 15);
        const c = this.atlas.texel(slot, tx, ty);
        if (c[3] < 40) continue;
        out.push(c[0] / 255, c[1] / 255, c[2] / 255);
      }
      if (out.length === 0) {
        const avg = this.atlas.averageColor(slot);
        out.push(avg[0] / 255, avg[1] / 255, avg[2] / 255);
      }
    }
    if (out.length === 0) out.push(0.62, 0.6, 0.56);

    if (id >= 0 && id < this.paletteCache.length) this.paletteCache[id] = out;
    return out;
  }

  /** Scratch outputs for `randomDir`, so blasts allocate nothing. */
  private dirX = 0;
  private dirY = 0;
  private dirZ = 0;

  private randomDir(): void {
    // uniform-ish direction on the unit sphere
    const u = this.rng.next() * 2 - 1;
    const a = this.rng.next() * Math.PI * 2;
    const r = Math.sqrt(Math.max(0, 1 - u * u));
    this.dirX = Math.cos(a) * r;
    this.dirY = u;
    this.dirZ = Math.sin(a) * r;
  }

  /** Mirror the scene fog into the particle shader when it actually changes. */
  private syncFog(): void {
    const scene = this.points.parent as (THREE.Object3D & { fog?: THREE.Fog | THREE.FogExp2 | null }) | null;
    const fog = scene?.fog;
    if (!fog) return;
    const near = (fog as THREE.Fog).near ?? this.fogNear;
    const far = (fog as THREE.Fog).far ?? this.fogFar;
    const color = (fog as THREE.Fog).color;
    if (near === this.fogNear && far === this.fogFar && (!color || color.getHex() === this.fogHex)) return;

    this.fogNear = near;
    this.fogFar = far;
    const u = this.material.uniforms;
    if (color) {
      this.fogHex = color.getHex();
      const c = u.uFogColor?.value as THREE.Color | undefined;
      if (c) c.copy(color);
    }
    if (u.uFogNear) u.uFogNear.value = near;
    if (u.uFogFar) u.uFogFar.value = far;
  }

  private upload(): void {
    this.posAttr.needsUpdate = true;
    this.colAttr.needsUpdate = true;
    this.sizeAttr.needsUpdate = true;
    this.alphaAttr.needsUpdate = true;
    this.syncDrawRange();
  }

  /**
   * Grow (or shrink) the submitted range so it always covers exactly the live
   * slots. Spawns grow it immediately, because a burst can be drawn before the
   * next `update()` ever runs.
   */
  private syncDrawRange(): void {
    const range = this.live * 3;
    if (this.geometry.drawRange.count !== range) this.geometry.setDrawRange(0, range);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

function clamp(v: number, lo: number, hi: number): number {
  if (!Number.isFinite(v)) return lo;
  return v < lo ? lo : v > hi ? hi : v;
}

/** An 8x8 fully opaque white tile: the classic square pixel, nothing more. */
function makePixelTexture(): THREE.DataTexture {
  const size = 8;
  const data = new Uint8Array(size * size * 4);
  for (let i = 0; i < size * size; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 255;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  const tex = new THREE.DataTexture(data, size, size, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}
