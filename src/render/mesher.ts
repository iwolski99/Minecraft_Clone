/**
 * Chunk mesher.
 *
 * Produces two draw layers per chunk:
 *   - opaque:  solid blocks plus alpha-tested cutouts (leaves, plants, torches)
 *   - transparent: water, ice and glass, rendered with blending
 *
 * Only visible faces are emitted. Per-vertex ambient occlusion and smooth voxel
 * lighting are baked into vertex attributes so the whole world renders with one
 * cheap shader and no realtime lights.
 *
 * Performance notes: block properties are flattened into typed lookup tables and
 * the output buffers are preallocated typed arrays written through a cursor, so
 * the hot loop performs no allocation and no string or Map work.
 */

import { CHUNK_Y, Chunk } from '../world/chunk.js';
import type { World } from '../world/world.js';
import { CHUNK_X, CHUNK_Z } from '../world/chunk.js';
import { BLOCKS, getBlock } from '../world/blocks.js';
import { biomeById } from '../worldgen/biomes.js';
import type { Atlas, UvRect } from './atlas.js';

export const PAD = 1;
const PW = CHUNK_X + PAD * 2;
const PD = CHUNK_Z + PAD * 2;
const PAD_VOLUME = PW * PD * CHUNK_Y;

function padIndex(x: number, y: number, z: number): number {
  return (y * PD + (z + PAD)) * PW + (x + PAD);
}

/** Directional face shading - the classic "cube readability" ramp. */
const FACE_SHADE = [0.62, 0.62, 1.0, 0.5, 0.82, 0.82];

/** AO levels 0..3 mapped to brightness. */
const AO_LEVEL = [0.52, 0.7, 0.86, 1.0];

/* ------------------------------------------------------------------ */
/* Flat property tables                                                */
/* ------------------------------------------------------------------ */

const MAX_ID = 256;
/** per block id: per-face uv (u0,v0,u1,v1) for the six faces */
const FACE_UV = new Float32Array(MAX_ID * 6 * 4);
const IS_OPAQUE = new Uint8Array(MAX_ID);
const IS_LIQUID = new Uint8Array(MAX_ID);
/** 0 = none, 1 = grass, 2 = foliage */
const TINT_KIND = new Uint8Array(MAX_ID);
/** render kind per block */
const RENDER_KIND = new Uint8Array(MAX_ID);
const MERGE_SAME = new Uint8Array(MAX_ID);
/** blocks drawn in the blended layer (water, ice, glass, portals) */
const TRANSPARENT_LAYER = new Uint8Array(MAX_ID);

export const RENDER_NONE = 0;
export const RENDER_CUBE = 1;
export const RENDER_CROSS = 2;
export const RENDER_BOX = 3;
export const RENDER_LIQUID = 4;
export const RENDER_FENCE = 5;

let tablesReady = false;
function buildTables(atlas: Atlas): void {
  const uvCache = new Map<string, UvRect>();
  const rect = (name: string): UvRect => {
    let r = uvCache.get(name);
    if (!r) {
      r = atlas.uv(name);
      uvCache.set(name, r);
    }
    return r;
  };

  for (const def of BLOCKS) {
    const id = def.id;
    if (id >= MAX_ID) continue;
    IS_OPAQUE[id] = def.opaque ? 1 : 0;
    IS_LIQUID[id] = def.liquid ? 1 : 0;
    TINT_KIND[id] = def.tint === 'grass' ? 1 : def.tint === 'foliage' ? 2 : 0;
    RENDER_KIND[id] =
      def.render === 'cube' ? RENDER_CUBE
      : def.render === 'fence' ? RENDER_FENCE
    : def.render === 'cross' ? RENDER_CROSS
      : def.render === 'box' ? RENDER_BOX
      : def.render === 'liquid' ? RENDER_LIQUID
      : RENDER_NONE;
    const t = def.tex;
    const names = [
      t.east ?? t.side ?? t.all ?? t.sprite ?? 'stone',
      t.west ?? t.side ?? t.all ?? t.sprite ?? 'stone',
      t.top ?? t.all ?? t.side ?? t.sprite ?? 'stone',
      t.bottom ?? t.all ?? t.side ?? t.sprite ?? 'stone',
      t.south ?? t.side ?? t.all ?? t.sprite ?? 'stone',
      t.north ?? t.side ?? t.all ?? t.sprite ?? 'stone',
    ];
    for (let f = 0; f < 6; f++) {
      const r = rect(names[f]);
      const base = (id * 6 + f) * 4;
      FACE_UV[base] = r.u0;
      FACE_UV[base + 1] = r.v0;
      FACE_UV[base + 2] = r.u1;
      FACE_UV[base + 3] = r.v1;
    }
    const n = def.name;
    MERGE_SAME[id] = def.liquid || n === 'glass' || n === 'ice' ? 1 : 0;
    TRANSPARENT_LAYER[id] = def.liquid || n === 'glass' || n === 'ice' || n === 'portal' ? 1 : 0;
  }
  tablesReady = true;
}

/* ------------------------------------------------------------------ */
/* Face geometry                                                       */
/* ------------------------------------------------------------------ */

interface FaceDef {
  corners: [number, number, number][];
  u: [number, number, number];
  v: [number, number, number];
  normal: [number, number, number];
}

const FACES: FaceDef[] = [
  { corners: [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]], u: [0, 0, -1], v: [0, 1, 0], normal: [1, 0, 0] },
  { corners: [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]], u: [0, 0, 1], v: [0, 1, 0], normal: [-1, 0, 0] },
  { corners: [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]], u: [1, 0, 0], v: [0, 0, -1], normal: [0, 1, 0] },
  { corners: [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]], u: [1, 0, 0], v: [0, 0, 1], normal: [0, -1, 0] },
  { corners: [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]], u: [1, 0, 0], v: [0, 1, 0], normal: [0, 0, 1] },
  { corners: [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]], u: [-1, 0, 0], v: [0, 1, 0], normal: [0, 0, -1] },
];

const CORNER_OFF: [number, number][] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/* ------------------------------------------------------------------ */
/* Output buffers                                                      */
/* ------------------------------------------------------------------ */

export interface GeometryData {
  positions: Float32Array;
  /**
   * Texture coordinates as normalised 16-bit integers.
   *
   * The atlas is 256 texels across, so 1/65535 is far finer than one texel and
   * the shader cannot tell the difference - but it halves this attribute's
   * traffic, and the game is GPU-bound on vertex bandwidth.
   */
  uvs: Uint16Array;
  colors: Uint8Array;
  /**
   * Sky and block light as two normalised bytes rather than two floats.
   *
   * Light is a 0..15 level scaled to 0..255 for the shader, so a byte holds it
   * exactly where a float was spending four bytes to express 256 values. This is
   * the largest single saving in the vertex format after positions.
   */
  light: Uint8Array;
  /**
   * 16-bit where possible. A chunk mesh's vertex count is bounded by its visible
   * faces, and the largest at render distance 10 is ~37k - comfortably inside
   * 65,535 - so almost every chunk can halve its index traffic. A chunk that
   * does exceed it falls back to 32-bit.
   */
  indices: Uint16Array | Uint32Array;
}

/**
 * Typed-array stores wrap modulo 256 instead of clamping, and the mesher
 * multiplies 0..1 shading by biome tints that reach 1.06 (`l * tr * 255` is
 * 270 there). Without this, the green channel of a fully lit grass top in a
 * desert/plains/savanna biome wraps to ~14 and the block renders almost black.
 * Non-finite values (NaN from a bad tint) collapse to 0.
 */
function clamp01(v: number): number {
  return v > 0 ? (v < 1 ? v : 1) : 0;
}

/**
 * Texture coordinates pack into 16 bits and are normalised on the GPU, so the
 * 0..1 value is scaled here. The atlas is 256 texels across, so this resolves 1
 * part in 65535 - a quarter of a texel - where the float it replaces was
 * spending four bytes to be needlessly exact.
 */
function clampU16(v: number): number {
  if (!(v > 0)) return 0;
  return v >= 1 ? 65535 : Math.round(v * 65535);
}

function clamp255(v: number): number {
  if (!(v > 0)) return 0;
  return v > 255 ? 255 : v;
}

class MeshBuffers {
  pos: Float32Array;
  uv: Uint16Array;
  col: Uint8Array;
  lit: Uint8Array;
  idx: Uint32Array;
  vCount = 0;
  iCount = 0;

  constructor(vertexCapacity = 4096) {
    this.pos = new Float32Array(vertexCapacity * 3);
    this.uv = new Uint16Array(vertexCapacity * 2);
    this.col = new Uint8Array(vertexCapacity * 4);
    this.lit = new Uint8Array(vertexCapacity * 2);
    this.idx = new Uint32Array(vertexCapacity * 3);
  }

  reserve(extraVerts: number): void {
    if (this.vCount + extraVerts <= this.pos.length / 3) return;
    let cap = this.pos.length / 3;
    while (cap < this.vCount + extraVerts) cap *= 2;
    const pos = new Float32Array(cap * 3);
    pos.set(this.pos);
    this.pos = pos;
    const uv = new Uint16Array(cap * 2);
    uv.set(this.uv);
    this.uv = uv;
    const col = new Uint8Array(cap * 4);
    col.set(this.col);
    this.col = col;
    const lit = new Uint8Array(cap * 2);
    lit.set(this.lit);
    this.lit = lit;
  }

  vertex(x: number, y: number, z: number, u: number, v: number, r: number, g: number, b: number, sky: number, blk: number): void {
    if (this.vCount + 1 > this.pos.length / 3) this.reserve(64);
    const vi = this.vCount;
    this.pos[vi * 3] = x;
    this.pos[vi * 3 + 1] = y;
    this.pos[vi * 3 + 2] = z;
    this.uv[vi * 2] = clampU16(u);
    this.uv[vi * 2 + 1] = clampU16(v);
    this.col[vi * 4] = clamp255(r);
    this.col[vi * 4 + 1] = clamp255(g);
    this.col[vi * 4 + 2] = clamp255(b);
    this.col[vi * 4 + 3] = 255;
    // 0..1 floats: no normalisation ambiguity on the GPU side
    this.lit[vi * 2] = clamp255(sky);
    this.lit[vi * 2 + 1] = clamp255(blk);
    this.vCount++;
  }

  quad(a: number, b: number, c: number, d: number, flip: boolean): void {
    this.pushQuad(a, b, c, d, flip);
  }

  /**
   * Emit a quad with both windings. Cross-shaped plants are single flat planes,
   * so without this they would vanish from one side under front-face culling.
   */
  quadDouble(a: number, b: number, c: number, d: number, flip: boolean): void {
    this.pushQuad(a, b, c, d, flip);
    this.pushQuad(d, c, b, a, flip);
  }

  private pushQuad(a: number, b: number, c: number, d: number, flip: boolean): void {
    if (this.iCount + 6 > this.idx.length) {
      let cap = this.idx.length;
      while (cap < this.iCount + 6) cap *= 2;
      const idx = new Uint32Array(cap);
      idx.set(this.idx);
      this.idx = idx;
    }
    const i = this.iCount;
    if (flip) {
      // rotated diagonal: keeps the darkest corner from pinching
      this.idx[i] = b;
      this.idx[i + 1] = c;
      this.idx[i + 2] = d;
      this.idx[i + 3] = b;
      this.idx[i + 4] = d;
      this.idx[i + 5] = a;
    } else {
      this.idx[i] = a;
      this.idx[i + 1] = b;
      this.idx[i + 2] = c;
      this.idx[i + 3] = a;
      this.idx[i + 4] = c;
      this.idx[i + 5] = d;
    }
    this.iCount += 6;
  }

  get isEmpty(): boolean {
    return this.iCount === 0;
  }

  toData(): GeometryData {
    const count = this.iCount;
    // 16-bit indices halve the index bandwidth, and an index is 12 bytes of
    // every triangle's traffic. One copy of a few thousand entries per chunk
    // build costs far less than what it saves on every frame that chunk draws.
    const indices =
      this.vCount <= 65535 ? Uint16Array.from(this.idx.subarray(0, count)) : this.idx.slice(0, count);
    return {
      positions: this.pos.slice(0, this.vCount * 3),
      uvs: this.uv.slice(0, this.vCount * 2),
      colors: this.col.slice(0, this.vCount * 4),
      light: this.lit.slice(0, this.vCount * 2),
      indices,
    };
  }
}

export interface ChunkMeshResult {
  opaque: GeometryData | null;
  transparent: GeometryData | null;
  faceCount: number;
}

/* ------------------------------------------------------------------ */

export class VoxelMesher {
  private atlas: Atlas;
  private blocks = new Uint8Array(PAD_VOLUME);
  private sky = new Uint8Array(PAD_VOLUME);
  private blk = new Uint8Array(PAD_VOLUME);
  private currentBiome = new Uint8Array(256);
  private opaqueBuf = new MeshBuffers(12288);
  private transBuf = new MeshBuffers(2048);
  /** graphics setting: skip leaf faces hidden between adjacent leaves */
  fastLeaves = false;

  constructor(atlas: Atlas) {
    this.atlas = atlas;
    if (!tablesReady) buildTables(atlas);
  }

  /* ---------------------------------------------------------------- */

  private loadPadded(world: World, chunk: Chunk): void {
    const baseX = chunk.cx * CHUNK_X;
    const baseZ = chunk.cz * CHUNK_Z;
    const blocks = this.blocks;
    const sky = this.sky;
    const blk = this.blk;

    blocks.fill(0);
    sky.fill(0);
    blk.fill(0);

    // interior: straight typed-array copy
    for (let y = 0; y < CHUNK_Y; y++) {
      const srcRow = y << 8;
      const dstRow = y * PD * PW;
      for (let z = 0; z < CHUNK_Z; z++) {
        const src = srcRow | (z << 4);
        const dst = dstRow + (z + PAD) * PW + PAD;
        for (let x = 0; x < CHUNK_X; x++) {
          blocks[dst + x] = chunk.blocks[src + x];
          sky[dst + x] = chunk.skyLight[src + x];
          blk[dst + x] = chunk.blockLight[src + x];
        }
      }
    }
    // one-block margin from the neighbours, so AO and lighting do not seam
    for (let y = 0; y < CHUNK_Y; y++) {
      for (let z = -PAD; z < CHUNK_Z + PAD; z++) {
        for (let x = -PAD; x < CHUNK_X + PAD; x++) {
          if (x >= 0 && x < CHUNK_X && z >= 0 && z < CHUNK_Z) continue;
          const wx = baseX + x;
          const wz = baseZ + z;
          const pi = padIndex(x, y, z);
          blocks[pi] = world.getBlockAt(wx, y, wz);
          sky[pi] = world.getSkyLightAt(wx, y, wz);
          blk[pi] = world.getBlockLightAt(wx, y, wz);
        }
      }
    }
  }

  build(world: World, chunk: Chunk): ChunkMeshResult {
    this.loadPadded(world, chunk);
    this.currentBiome = chunk.biome;
    const opaque = this.opaqueBuf;
    const trans = this.transBuf;
    opaque.vCount = 0;
    opaque.iCount = 0;
    trans.vCount = 0;
    trans.iCount = 0;

    const blocks = this.blocks;
    for (let y = 0; y < CHUNK_Y; y++) {
      for (let z = 0; z < CHUNK_Z; z++) {
        for (let x = 0; x < CHUNK_X; x++) {
          const id = blocks[padIndex(x, y, z)];
          if (id === 0) continue;
          const kind = RENDER_KIND[id];
          if (kind === RENDER_NONE) continue;
          if (kind === RENDER_CUBE) this.emitCube(x, y, z, id, TRANSPARENT_LAYER[id] === 1);
          else if (kind === RENDER_LIQUID) this.emitLiquid(x, y, z, id);
          else if (kind === RENDER_CROSS) this.emitCross(x, y, z, id);
          else if (kind === RENDER_FENCE) this.emitFence(x, y, z, id);
          else this.emitBox(x, y, z, id);        }
      }
    }

    const faceCount = (opaque.iCount + trans.iCount) / 6;
    return {
      opaque: opaque.isEmpty ? null : opaque.toData(),
      transparent: trans.isEmpty ? null : trans.toData(),
      faceCount,
    };
  }

  /* ---------------------------------------------------------------- */

  private opaqueAt(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_Y) return 0;
    return IS_OPAQUE[this.blocks[padIndex(x, y, z)]];
  }

  private emitCube(x: number, y: number, z: number, id: number, transparent: boolean): void {
    const buf = transparent ? this.transBuf : this.opaqueBuf;
    const blocks = this.blocks;
    const sky = this.sky;
    const blk = this.blk;
    const tintKind = TINT_KIND[id];
    const biome = tintKind ? biomeById(this.currentBiome[(z << 4) | x]) : null;
    const mergeSame = MERGE_SAME[id];
    const leaf = this.fastLeaves && (id === LEAF_IDS[0] || id === LEAF_IDS[1] || id === LEAF_IDS[2]);

    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const nx = x + face.normal[0];
      const ny = y + face.normal[1];
      const nz = z + face.normal[2];
      const neighbour = ny < 0 || ny >= CHUNK_Y ? 0 : blocks[padIndex(nx, ny, nz)];
      if (IS_OPAQUE[neighbour]) continue;
      if (neighbour === id && (mergeSame || leaf)) continue;

      const uvBase = (id * 6 + f) * 4;
      const u0 = FACE_UV[uvBase];
      const v0 = FACE_UV[uvBase + 1];
      const u1 = FACE_UV[uvBase + 2];
      const v1 = FACE_UV[uvBase + 3];
      const shade = FACE_SHADE[f];

      let tr = 1;
      let tg = 1;
      let tb = 1;
      if (biome) {
        if (tintKind === 2) {
          tr = biome.foliageTint[0];
          tg = biome.foliageTint[1];
          tb = biome.foliageTint[2];
        } else if (f === 2) {
          tr = biome.grassTint[0];
          tg = biome.grassTint[1];
          tb = biome.grassTint[2];
        }
      }

      buf.reserve(4);
      const base = buf.vCount;
      let ao0 = 1;
      let ao1 = 1;
      let ao2 = 1;
      let ao3 = 1;

      for (let c = 0; c < 4; c++) {
        const corner = face.corners[c];
        const du = CORNER_OFF[c][0];
        const dv = CORNER_OFF[c][1];
        const ux = face.u[0] * du;
        const uy = face.u[1] * du;
        const uz = face.u[2] * du;
        const vx = face.v[0] * dv;
        const vy = face.v[1] * dv;
        const vz = face.v[2] * dv;

        const s1 = this.opaqueAt(nx + ux, ny + uy, nz + uz);
        const s2 = this.opaqueAt(nx + vx, ny + vy, nz + vz);
        const co = this.opaqueAt(nx + ux + vx, ny + uy + vy, nz + uz + vz);
        const ao = s1 && s2 ? 0 : 3 - (s1 + s2 + co);
        const aoF = AO_LEVEL[ao];
        if (c === 0) ao0 = aoF;
        else if (c === 1) ao1 = aoF;
        else if (c === 2) ao2 = aoF;
        else ao3 = aoF;

        // smooth light: average the non-opaque cells touching this corner
        let sumSky = 0;
        let sumBlk = 0;
        let n = 0;
        for (let k = 0; k < 4; k++) {
          const ox = k === 0 ? 0 : k === 1 ? ux : k === 2 ? vx : ux + vx;
          const oy = k === 0 ? 0 : k === 1 ? uy : k === 2 ? vy : uy + vy;
          const oz = k === 0 ? 0 : k === 1 ? uz : k === 2 ? vz : uz + vz;
          const cx = nx + ox;
          const cy = ny + oy;
          const cz = nz + oz;
          if (k > 0 && this.opaqueAt(cx, cy, cz)) continue;
          if (cy < 0) {
            n++;
            continue;
          }
          if (cy >= CHUNK_Y) {
            sumSky += 15;
            n++;
            continue;
          }
          const p = padIndex(cx, cy, cz);
          sumSky += sky[p];
          sumBlk += blk[p];
          n++;
        }
        if (n === 0) n = 1;

        const l = aoF * shade;
        buf.vertex(
          x + corner[0], y + corner[1], z + corner[2],
          c === 0 || c === 3 ? u0 : u1,
          c === 0 || c === 1 ? v0 : v1,
          l * tr * 255,
          l * tg * 255,
          l * tb * 255,
          (sumSky / n) * 17,
          (sumBlk / n) * 17,
        );
      }
      buf.quad(base, base + 1, base + 2, base + 3, ao0 + ao2 > ao1 + ao3);
    }
  }

  /** Water and other liquids: a cube with a slightly lowered top surface. */
  private emitLiquid(x: number, y: number, z: number, id: number): void {
    const buf = this.transBuf;
    const blocks = this.blocks;
    const above = y + 1 < CHUNK_Y ? blocks[padIndex(x, y + 1, z)] : 0;
    const drop = above === id ? 1 : 0.875;
    const sky = this.sky;
    const blk = this.blk;

    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const nx = x + face.normal[0];
      const ny = y + face.normal[1];
      const nz = z + face.normal[2];
      const neighbour = ny < 0 || ny >= CHUNK_Y ? 0 : blocks[padIndex(nx, ny, nz)];
      if (IS_OPAQUE[neighbour]) continue;
      if (IS_LIQUID[neighbour]) continue;

      const uvBase = (id * 6 + f) * 4;
      const u0 = FACE_UV[uvBase];
      const v0 = FACE_UV[uvBase + 1];
      const u1 = FACE_UV[uvBase + 2];
      const v1 = FACE_UV[uvBase + 3];
      const shade = FACE_SHADE[f];
      const p = padIndex(nx, Math.max(0, Math.min(CHUNK_Y - 1, ny)), nz);
      const s = Math.min(255, sky[p] * 17);
      const b = Math.min(255, blk[p] * 17);
      const l = shade * 255;

      buf.reserve(4);
      const base = buf.vCount;
      for (let c = 0; c < 4; c++) {
        const corner = face.corners[c];
        const py = corner[1] === 1 ? drop : corner[1];
        buf.vertex(
          x + corner[0], y + py, z + corner[2],
          c === 0 || c === 3 ? u0 : u1,
          c === 0 || c === 1 ? v0 : v1,
          l, l, l, s, b,
        );
      }
      buf.quad(base, base + 1, base + 2, base + 3, false);
    }
  }

  private emitCross(x: number, y: number, z: number, id: number): void {
    const buf = this.opaqueBuf;
    const p = padIndex(x, y, z);
    const sky = Math.min(255, this.sky[p] * 17);
    const blk = Math.min(255, this.blk[p] * 17);
    const tintKind = TINT_KIND[id];
    const biome = tintKind ? biomeById(this.currentBiome[(z << 4) | x]) : null;
    let tr = 1;
    let tg = 1;
    let tb = 1;
    if (biome) {
      const tn = tintKind === 1 ? biome.grassTint : biome.foliageTint;
      tr = tn[0];
      tg = tn[1];
      tb = tn[2];
    }
    const uvBase = (id * 6 + 2) * 4;
    const u0 = FACE_UV[uvBase];
    const v0 = FACE_UV[uvBase + 1];
    const u1 = FACE_UV[uvBase + 2];
    const v1 = FACE_UV[uvBase + 3];
    const l = 0.94;
    const r = l * tr * 255;
    const g = l * tg * 255;
    const b = l * tb * 255;

    const planes: [number, number, number, number][] = [
      [0.06, 0.06, 0.94, 0.94],
      [0.94, 0.06, 0.06, 0.94],
    ];
    for (const pl of planes) {
      const ax = pl[0];
      const az = pl[1];
      const bx = pl[2];
      const bz = pl[3];
      buf.reserve(4);
      const base = buf.vCount;
      buf.vertex(x + ax, y, z + az, u0, v0, r, g, b, sky, blk);
      buf.vertex(x + bx, y, z + bz, u1, v0, r, g, b, sky, blk);
      buf.vertex(x + bx, y + 1, z + bz, u1, v1, r, g, b, sky, blk);
      buf.vertex(x + ax, y + 1, z + az, u0, v1, r, g, b, sky, blk);
      buf.quadDouble(base, base + 1, base + 2, base + 3, true);
    }
  }

  private emitBox(x: number, y: number, z: number, id: number): void {
    const def = getBlock(id);
    this.emitBoxWith(x, y, z, id, def.box ?? [0, 0, 0, 1, 1, 1]);
  }

  /** Emit one box shape with the block's textures, culling hidden faces. */
  private emitBoxWith(
    x: number, y: number, z: number, id: number,
    box: readonly number[],
  ): void {
    const buf = this.opaqueBuf;
    const def = getBlock(id);
    const p = padIndex(x, y, z);
    const sky = Math.min(255, this.sky[p] * 17);
    const blk = Math.min(255, this.blk[p] * 17);
    const blocks = this.blocks;

    for (let f = 0; f < 6; f++) {
      const face = FACES[f];
      const nx = x + face.normal[0];
      const ny = y + face.normal[1];
      const nz = z + face.normal[2];
      const neighbour = ny < 0 || ny >= CHUNK_Y ? 0 : blocks[padIndex(nx, ny, nz)];
      if (IS_OPAQUE[neighbour]) continue;
      if (def.name === 'torch' && f === 3 && neighbour !== 0) continue;

      const uvBase = (id * 6 + f) * 4;
      const u0 = FACE_UV[uvBase];
      const v0 = FACE_UV[uvBase + 1];
      const u1 = FACE_UV[uvBase + 2];
      const v1 = FACE_UV[uvBase + 3];
      const l = Math.min(255, FACE_SHADE[f] * 255);
      buf.reserve(4);
      const base = buf.vCount;
      for (let c = 0; c < 4; c++) {
        const corner = face.corners[c];
        buf.vertex(
          x + (corner[0] === 0 ? box[0] : box[3]),
          y + (corner[1] === 0 ? box[1] : box[4]),
          z + (corner[2] === 0 ? box[2] : box[5]),
          c === 0 || c === 3 ? u0 : u1,
          c === 0 || c === 1 ? v0 : v1,
          l, l, l, sky, blk,
        );
      }
      buf.quad(base, base + 1, base + 2, base + 3, false);
    }
  }

  /**
   * A fence post, plus rails toward whatever it connects to.
   *
   * The block used to render as a single free-standing post, so a line of them
   * looked like separate columns rather than one fence. A fence joins an
   * adjacent fence, and also a full solid block, which is the rule the original
   * uses - so a fence run meets a wall instead of stopping short of it.
   */
  private emitFence(x: number, y: number, z: number, id: number): void {
    // the post: quarter of a block across, taller than a full block
    this.emitBoxWith(x, y, z, id, [0.375, 0, 0.375, 0.625, 1.5, 0.625]);

    // rails sit at two heights, matching the original's proportions
    const rails: [number, number][] = [
      [0.375, 0.5625],
      [0.75, 0.9375],
    ];
    const arm = (dx: number, dz: number) => {
      for (const [ry0, ry1] of rails) {
        if (dx !== 0) {
          // running along x, thin in z
          const x0 = dx > 0 ? 0.625 : 0;
          const x1 = dx > 0 ? 1 : 0.375;
          this.emitBoxWith(x, y, z, id, [x0, ry0, 0.4375, x1, ry1, 0.5625]);
        } else {
          const z0 = dz > 0 ? 0.625 : 0;
          const z1 = dz > 0 ? 1 : 0.375;
          this.emitBoxWith(x, y, z, id, [0.4375, ry0, z0, 0.5625, ry1, z1]);
        }
      }
    };

    if (this.fenceConnects(x + 1, y, z)) arm(1, 0);
    if (this.fenceConnects(x - 1, y, z)) arm(-1, 0);
    if (this.fenceConnects(x, y, z + 1)) arm(0, 1);
    if (this.fenceConnects(x, y, z - 1)) arm(0, -1);
  }

  /** Whether a fence at this cell should join the neighbour at the given offset. */
  private fenceConnects(x: number, y: number, z: number): boolean {
    if (y < 0 || y >= CHUNK_Y) return false;
    const n = this.blocks[padIndex(x, y, z)];
    if (n === 0) return false;
    // another fence, or any full solid cube - the same rule the original uses
    return FENCE_IDS.has(n) || IS_OPAQUE[n] === 1;
  }
}

/** Leaf block ids, resolved once from the registry. */
const LEAF_IDS: number[] = [
  BLOCKS.find((b) => b.name === 'oak_leaves')?.id ?? -1,
  BLOCKS.find((b) => b.name === 'birch_leaves')?.id ?? -1,
  BLOCKS.find((b) => b.name === 'spruce_leaves')?.id ?? -1,
];

/** Fence block ids, resolved once from the registry. */
const FENCE_IDS = new Set(BLOCKS.filter((b) => b.render === 'fence').map((b) => b.id));

export { BLOCKS };
