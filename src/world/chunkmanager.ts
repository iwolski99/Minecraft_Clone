/**
 * Chunk streaming.
 *
 * Chunks move through three stages - generated, lit, meshed - and the manager
 * advances them in nearest-first order inside a per-frame time budget so that
 * walking across a border never produces a multi-hundred-millisecond hitch.
 */

import * as THREE from 'three';
import { CHUNK_X, CHUNK_Y, CHUNK_Z, Chunk, chunkKey } from './chunk.js';
import type { World } from './world.js';
import type { VoxelMesher } from '../render/mesher.js';

export interface ChunkMeshes {
  opaque: THREE.Mesh | null;
  transparent: THREE.Mesh | null;
}

export interface StreamStats {
  loaded: number;
  meshed: number;
  pending: number;
  faces: number;
  drawCalls: number;
  genMs: number;
  meshMs: number;
}

export class ChunkManager {
  readonly group = new THREE.Group();
  readonly stats: StreamStats = { loaded: 0, meshed: 0, pending: 0, faces: 0, drawCalls: 0, genMs: 0, meshMs: 0 };

  renderDistance = 8;
  /** per-frame budgets in milliseconds */
  genBudget = 6;
  meshBudget = 5;
  /**
   * While false, `update()` is a no-op.
   *
   * This matters a lot: the streamer follows the render camera, and during world
   * loading that camera is still at the origin. Without this guard, the first
   * frame after `setCentre()` re-centred streaming on (0,0) and unloaded every
   * preloaded chunk, so the player was placed into empty space and the world then
   * streamed in around - and on top of - them.
   */
  enabled = true;

  private meshes = new Map<number, ChunkMeshes>();
  private pending: { cx: number; cz: number; d: number }[] = [];
  private lastCx = NaN;
  private lastCz = NaN;
  private world: World;
  private mesher: VoxelMesher;
  private opaqueMat: THREE.Material;
  private waterMat: THREE.Material;
  private unloadList: number[] = [];
  /** hook used to re-apply saved player edits to freshly generated chunks */
  onChunkGenerated: ((chunk: Chunk) => void) | null = null;

  constructor(world: World, mesher: VoxelMesher, opaqueMat: THREE.Material, waterMat: THREE.Material) {
    this.world = world;
    this.mesher = mesher;
    this.opaqueMat = opaqueMat;
    this.waterMat = waterMat;
    this.group.name = 'chunks';
  }

  /* ---------------------------------------------------------------- */

  private rebuildPending(pcx: number, pcz: number, radius: number): void {
    const list: { cx: number; cz: number; d: number }[] = [];
    for (let dz = -radius; dz <= radius; dz++) {
      for (let dx = -radius; dx <= radius; dx++) {
        const d = dx * dx + dz * dz;
        if (d > radius * radius + radius) continue;
        list.push({ cx: pcx + dx, cz: pcz + dz, d });
      }
    }
    list.sort((a, b) => a.d - b.d);
    this.pending = list;
  }

  private neighboursReady(cx: number, cz: number, stage: 'terrain' | 'lit'): boolean {
    const need = stage === 'terrain' ? 1 : 1;
    for (let dz = -need; dz <= need; dz++) {
      for (let dx = -need; dx <= need; dx++) {
        if (dx === 0 && dz === 0) continue;
        const n = this.world.getChunk(cx + dx, cz + dz);
        if (!n) return false;
        if (stage === 'lit' && n.stage === 'empty') return false;
        if (stage === 'lit' && n.stage === 'terrain' && (dx === 0 || dz === 0)) return false;
      }
    }
    return true;
  }

  /** Advance every chunk by at most one stage, nearest first. */
  private process(pcx: number, pcz: number, genBudget: number, meshBudget: number): void {
    const t0 = now();
    let genSpent = 0;
    let meshSpent = 0;
    for (const p of this.pending) {
      if (genSpent > genBudget && meshSpent > meshBudget) break;
      const c = this.world.getChunk(p.cx, p.cz);
      if (!c) {
        if (genSpent > genBudget) continue;
        const s = now();
        const nc = this.world.createChunk(p.cx, p.cz);
        this.world.generator.generateChunk(nc);
        if (this.onChunkGenerated) this.onChunkGenerated(nc);
        nc.stage = 'terrain';
        genSpent += now() - s;
        continue;
      }
      if (c.stage === 'terrain') {
        if (genSpent > genBudget) continue;
        if (!this.neighboursReady(p.cx, p.cz, 'terrain')) continue;
        const s = now();
        this.world.light.initialLight(c);
        c.stage = 'lit';
        /*
         * Lighting a chunk also corrects its neighbours' borders (see
         * `initialLight`), so their meshes now hold stale vertex light and must
         * be rebuilt - otherwise the seam simply moves rather than closing.
         */
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
          const n = this.world.getChunk(p.cx + dx, p.cz + dz);
          if (n && n.stage === 'lit') n.dirty = true;
        }
        genSpent += now() - s;
        continue;
      }
      if (c.dirty) {
        if (meshSpent > meshBudget) continue;
        if (!this.neighboursReady(p.cx, p.cz, 'lit')) continue;
        const s = now();
        this.buildMesh(c);
        meshSpent += now() - s;
      }
    }
    this.stats.genMs = genSpent;
    this.stats.meshMs = meshSpent;
    void t0;
  }

  /* ---------------------------------------------------------------- */

  private buildMesh(chunk: Chunk): void {
    const key = chunkKey(chunk.cx, chunk.cz);
    const result = this.mesher.build(this.world, chunk);
    let entry = this.meshes.get(key);
    if (!entry) {
      entry = { opaque: null, transparent: null };
      this.meshes.set(key, entry);
    }
    const ox = chunk.cx * CHUNK_X;
    const oz = chunk.cz * CHUNK_Z;

    entry.opaque = this.swapMesh(entry.opaque, result.opaque, this.opaqueMat, ox, oz, 0);
    entry.transparent = this.swapMesh(entry.transparent, result.transparent, this.waterMat, ox, oz, 10);

    chunk.dirty = false;
    chunk.stage = 'meshed';
    this.stats.faces = this.stats.faces; // recomputed in refreshStats
    void result.faceCount;
  }

  private swapMesh(
    existing: THREE.Mesh | null,
    data: {
      positions: Float32Array;
      uvs: Uint16Array;
      colors: Uint8Array;
      light: Uint8Array;
      indices: Uint16Array | Uint32Array;
    } | null,
    material: THREE.Material,
    ox: number,
    oz: number,
    renderOrder: number,
  ): THREE.Mesh | null {
    if (existing) {
      this.group.remove(existing);
      existing.geometry.dispose();
    }
    if (!data) return null;
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(data.positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(data.uvs, 2, true));
    geo.setAttribute('aColor', new THREE.BufferAttribute(data.colors, 4, true));
    // normalised: both are integer attributes the shader wants as 0..1
    geo.setAttribute('aLight', new THREE.BufferAttribute(data.light, 2, true));
    geo.setIndex(new THREE.BufferAttribute(data.indices, 1));
    geo.computeBoundingSphere();
    const mesh = new THREE.Mesh(geo, material);
    mesh.position.set(ox, 0, oz);
    mesh.matrixAutoUpdate = false;
    mesh.updateMatrix();
    mesh.renderOrder = renderOrder;
    mesh.frustumCulled = true;
    this.group.add(mesh);
    return mesh;
  }

  private disposeChunkChunk(chunk: Chunk): void {
    const key = chunkKey(chunk.cx, chunk.cz);
    const entry = this.meshes.get(key);
    if (entry) {
      for (const m of [entry.opaque, entry.transparent]) {
        if (m) {
          this.group.remove(m);
          m.geometry.dispose();
        }
      }
      this.meshes.delete(key);
    }
  }

  /* ---------------------------------------------------------------- */

  update(px: number, pz: number, dtScale = 1): void {
    if (!this.enabled) return;
    const pcx = Math.floor(px / CHUNK_X);
    const pcz = Math.floor(pz / CHUNK_Z);
    if (pcx !== this.lastCx || pcz !== this.lastCz) {
      this.lastCx = pcx;
      this.lastCz = pcz;
      this.rebuildPending(pcx, pcz, this.renderDistance + 1);
      this.scheduleUnload(pcx, pcz);
    }
    this.process(pcx, pcz, this.genBudget * dtScale, this.meshBudget * dtScale);
    this.refreshStats();
  }

  private scheduleUnload(pcx: number, pcz: number): void {
    const limit = (this.renderDistance + 3) * (this.renderDistance + 3);
    this.unloadList.length = 0;
    for (const c of this.world.chunks.values()) {
      const dx = c.cx - pcx;
      const dz = c.cz - pcz;
      if (dx * dx + dz * dz > limit) this.unloadList.push(chunkKey(c.cx, c.cz));
    }
    for (const key of this.unloadList) {
      const c = this.world.chunks.get(key);
      if (c) {
        this.disposeChunkChunk(c);
        this.world.removeChunk(c.cx, c.cz);
      }
    }
  }

  /** Force a re-mesh of every loaded chunk (render distance / settings change). */
  markAllDirty(): void {
    for (const c of this.world.chunks.values()) c.dirty = true;
  }

  /**
   * Swap the materials used by every chunk mesh.
   *
   * Used by the renderer's graceful-downgrade path: if the custom terrain shader
   * fails to produce an image, the whole world is re-pointed at a plain textured
   * material instead of leaving the player staring at a black screen.
   */
  setMaterials(opaque: THREE.Material, water: THREE.Material): void {
    this.opaqueMat = opaque;
    this.waterMat = water;
    for (const entry of this.meshes.values()) {
      if (entry.opaque) entry.opaque.material = opaque;
      if (entry.transparent) entry.transparent.material = water;
    }
  }

  get meshedCount(): number {
    let n = 0;
    for (const m of this.meshes.values()) if (m.opaque || m.transparent) n++;
    return n;
  }

  get pendingCount(): number {
    let n = 0;
    for (const p of this.pending) {
      const c = this.world.getChunk(p.cx, p.cz);
      if (!c || c.dirty) n++;
    }
    return n;
  }

  private refreshStats(): void {
    this.stats.loaded = this.world.loadedCount;
    this.stats.meshed = 0;
    this.stats.faces = 0;
    this.stats.drawCalls = 0;
    for (const m of this.meshes.values()) {
      if (m.opaque) {
        this.stats.meshed++;
        this.stats.drawCalls++;
        this.stats.faces += (m.opaque.geometry.getIndex()?.count ?? 0) / 6;
      }
      if (m.transparent) {
        this.stats.drawCalls++;
        this.stats.faces += (m.transparent.geometry.getIndex()?.count ?? 0) / 6;
      }
    }
    this.stats.pending = this.pendingCount;
  }

  dispose(): void {
    for (const c of [...this.world.chunks.values()]) this.disposeChunkChunk(c);
    this.meshes.clear();
  }

  /* ---------------------------------------------------------------- */
  /* Initial load                                                      */
  /* ---------------------------------------------------------------- */

  /**
   * Generate + light + mesh the chunks immediately around a spawn point.
   * Runs a bounded amount of work per call so the caller can show progress.
   */
  preloadStep(state: { radius: number; pass: number; index: number }, msBudget: number): number {
    const t0 = now();
    const R = state.radius;
    const total = (2 * R + 1) * (2 * R + 1);
    while (state.pass < 3) {
      if (now() - t0 > msBudget) break;
      if (state.index >= total) {
        state.pass++;
        state.index = 0;
        continue;
      }
      const i = state.index++;
      const dx = (i % (2 * R + 1)) - R;
      const dz = Math.floor(i / (2 * R + 1)) - R;
      const cx = this.lastCx + dx;
      const cz = this.lastCz + dz;
      const c = this.world.getChunk(cx, cz);
      if (state.pass === 0) {
        if (!c) {
          const nc = this.world.createChunk(cx, cz);
          this.world.generator.generateChunk(nc);
          if (this.onChunkGenerated) this.onChunkGenerated(nc);
          nc.stage = 'terrain';
        }
      } else if (state.pass === 1) {
        if (c && c.stage === 'terrain') {
          this.world.light.initialLight(c);
          c.stage = 'lit';
        }
      } else if (c && c.dirty && c.stage === 'lit') {
        this.buildMesh(c);
      }
    }
    this.refreshStats();
    const done = state.pass >= 3;
    return done ? 1 : (state.pass + state.index / total) / 3;
  }

  /** Centre the streaming window on a spawn position without generating. */
  setCentre(px: number, pz: number): void {
    this.lastCx = Math.floor(px / CHUNK_X);
    this.lastCz = Math.floor(pz / CHUNK_Z);
    this.rebuildPending(this.lastCx, this.lastCz, this.renderDistance + 1);
  }

  get centre(): [number, number] {
    return [this.lastCx, this.lastCz];
  }
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

export { CHUNK_Y, CHUNK_Z };
