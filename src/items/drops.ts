/**
 * Dropped item entities.
 *
 * Small spinning block previews (or sprite billboards for non-block items) that
 * fall under gravity, bob on the ground, merge with nearby identical stacks and
 * are collected when the player walks over them.
 */

import * as THREE from 'three';
import type { Atlas } from '../render/atlas.js';
import { getBlock } from '../world/blocks.js';
import { buildBlockIconGeometry } from '../render/blockicon.js';
import type { World } from '../world/world.js';
import type { Player } from '../player/player.js';
import { ItemStack, makeStack } from './inventory.js';
import { blockIdOf } from './items.js';

const DROP_VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec2 aLight;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vUv = uv;
  vColor = aColor;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

const DROP_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec4 vColor;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < uAlphaTest) discard;
  gl_FragColor = vec4(t.rgb * vColor.rgb * uLight, t.a);
}
`;

interface Drop {
  stack: ItemStack;
  mesh: THREE.Mesh;
  pos: THREE.Vector3;
  vel: THREE.Vector3;
  age: number;
  pickupDelay: number;
  onGround: boolean;
  spin: number;
}

export class ItemDropManager {
  readonly group = new THREE.Group();
  private drops: Drop[] = [];
  private atlas: Atlas;
  private itemAtlas: Atlas;
  private blockMat: THREE.ShaderMaterial;
  private itemMat: THREE.ShaderMaterial;
  private blockGeo = new Map<number, THREE.BufferGeometry>();
  private itemGeo = new Map<string, THREE.BufferGeometry>();
  private light = new THREE.Color(1, 1, 1);
  /**
   * Called when a stack is walked over. It must return how many items of the
   * stack could NOT be stored: only that part stays in the world, so a full
   * inventory never destroys the drop.
   */
  onCollect: ((stack: ItemStack) => number) | null = null;
  maxDrops = 320;

  constructor(atlas: Atlas, itemAtlas: Atlas, blockTexture: THREE.Texture, itemTexture: THREE.Texture) {
    this.atlas = atlas;
    this.itemAtlas = itemAtlas;
    this.group.name = 'item-drops';
    this.blockMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: blockTexture }, uLight: { value: this.light }, uAlphaTest: { value: 0.5 } },
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      side: THREE.FrontSide,
    });
    this.itemMat = new THREE.ShaderMaterial({
      uniforms: { uMap: { value: itemTexture }, uLight: { value: this.light }, uAlphaTest: { value: 0.4 } },
      vertexShader: DROP_VERT,
      fragmentShader: DROP_FRAG,
      side: THREE.DoubleSide,
      transparent: true,
      depthWrite: false,
    });
  }

  private geometryFor(item: string): { geo: THREE.BufferGeometry; mat: THREE.Material } | null {
    const def = getBlock(0);
    void def;
    const blockId = blockIdFor(item);
    if (blockId > 0) {
      let geo = this.blockGeo.get(blockId);
      if (!geo) {
        geo = buildBlockIconGeometry(this.atlas, getBlock(blockId), 0.28, 1);
        this.blockGeo.set(blockId, geo);
      }
      return { geo, mat: this.blockMat };
    }
    let geo = this.itemGeo.get(item);
    if (!geo) {
      const g = new THREE.PlaneGeometry(0.32, 0.32);
      const rect = this.itemAtlas.uv(item);
      const uv = g.getAttribute('uv') as THREE.BufferAttribute;
      for (let i = 0; i < uv.count; i++) {
        const u = uv.getX(i);
        const v = uv.getY(i);
        uv.setXY(i, rect.u0 + (rect.u1 - rect.u0) * u, rect.v0 + (rect.v1 - rect.v0) * v);
      }
      uv.needsUpdate = true;
      const colors = new Float32Array(uv.count * 4).fill(1);
      const light = new Float32Array(uv.count * 2).fill(1);
      g.setAttribute('aColor', new THREE.BufferAttribute(colors, 4));
      g.setAttribute('aLight', new THREE.BufferAttribute(light, 2));
      geo = g;
      this.itemGeo.set(item, geo);
    }
    return { geo, mat: this.itemMat };
  }

  spawn(item: string, count: number, x: number, y: number, z: number, spread = 0.12): void {
    if (this.drops.length >= this.maxDrops) this.removeOldest();
    const built = this.geometryFor(item);
    if (!built) return;
    const mesh = new THREE.Mesh(built.geo, built.mat);
    mesh.position.set(x, y, z);
    this.group.add(mesh);
    this.drops.push({
      stack: makeStack(item, count),
      mesh,
      pos: new THREE.Vector3(x, y, z),
      vel: new THREE.Vector3((Math.random() - 0.5) * spread * 4, 1.9 + Math.random() * 0.6, (Math.random() - 0.5) * spread * 4),
      age: 0,
      pickupDelay: 0.5,
      onGround: false,
      spin: Math.random() * Math.PI * 2,
    });
  }

  private removeOldest(): void {
    const d = this.drops.shift();
    if (d) this.group.remove(d.mesh);
  }

  update(dt: number, world: World, player: Player, light: THREE.Color, time: number): void {
    this.light.copy(light);
    for (let i = this.drops.length - 1; i >= 0; i--) {
      const d = this.drops[i];
      d.age += dt;
      d.pickupDelay = Math.max(0, d.pickupDelay - dt);

      // gravity + simple terrain collision
      d.vel.y -= 24 * dt;
      const nx = d.pos.x + d.vel.x * dt;
      const ny = d.pos.y + d.vel.y * dt;
      const nz = d.pos.z + d.vel.z * dt;
      if (solidAt(world, nx, d.pos.y + 0.1, d.pos.z)) {
        d.vel.x = 0;
      } else {
        d.pos.x = nx;
      }
      if (solidAt(world, d.pos.x, d.pos.y + 0.1, nz)) {
        d.vel.z = 0;
      } else {
        d.pos.z = nz;
      }
      if (solidAt(world, d.pos.x, ny + 0.1, d.pos.z)) {
        if (d.vel.y < 0) {
          d.onGround = true;
          d.vel.y = 0;
        } else {
          d.vel.y = 0;
        }
      } else {
        d.pos.y = ny;
        d.onGround = false;
      }
      d.vel.x *= 1 - Math.min(1, 6 * dt);
      d.vel.z *= 1 - Math.min(1, 6 * dt);

      // merge with nearby identical drops
      if (d.age < 6) {
        for (let j = i - 1; j >= 0; j--) {
          const o = this.drops[j];
          if (o.stack.item !== d.stack.item) continue;
          if (d.pos.distanceToSquared(o.pos) > 0.7) continue;
          const limit = 64;
          const move = Math.min(limit - o.stack.count, d.stack.count);
          if (move <= 0) continue;
          o.stack.count += move;
          d.stack.count -= move;
          if (d.stack.count <= 0) break;
        }
      }

      // pickup
      const dx = player.position.x - d.pos.x;
      const dy = player.position.y + 0.9 - d.pos.y;
      const dz = player.position.z - d.pos.z;
      const dist2 = dx * dx + dy * dy + dz * dz;
      if (d.pickupDelay <= 0 && dist2 < 2.0) {
        // gentle magnet so pickups feel responsive
        const dist = Math.sqrt(dist2) || 1;
        d.pos.x += (dx / dist) * dt * 5.5;
        d.pos.y += (dy / dist) * dt * 5.5;
        d.pos.z += (dz / dist) * dt * 5.5;
      }
      if (d.pickupDelay <= 0 && dist2 < 0.85 && !player.dead) {
        // Collect first, remove second: the entity may only leave the world
        // once the stack is actually in the inventory. Whatever did not fit
        // (a full inventory, or no handler installed at all) stays on the
        // ground and is retried after a short delay.
        const leftover = this.onCollect ? this.onCollect(d.stack) : d.stack.count;
        if (leftover <= 0) {
          this.group.remove(d.mesh);
          this.drops.splice(i, 1);
          continue;
        }
        d.stack.count = leftover;
        d.pickupDelay = 0.75;
      }

      if (d.stack.count <= 0 || d.age > 300) {
        this.group.remove(d.mesh);
        this.drops.splice(i, 1);
        continue;
      }

      d.spin += dt * 1.6;
      const bob = Math.sin(time * 2.4 + d.pos.x * 0.7 + d.pos.z * 0.4) * 0.045;
      d.mesh.position.set(d.pos.x, d.pos.y + 0.18 + bob, d.pos.z);
      d.mesh.rotation.y = d.spin;
    }
  }

  /** All drops as [item, count] for the save file. */
  serialize(): unknown[] {
    return this.drops.slice(0, 200).map((d) => [d.stack.item, d.stack.count, d.pos.x, d.pos.y, d.pos.z]);
  }

  deserialize(data: unknown[]): void {
    if (!Array.isArray(data)) return;
    for (const entry of data) {
      if (!Array.isArray(entry) || entry.length < 5) continue;
      const [item, count, x, y, z] = entry as [string, number, number, number, number];
      this.spawn(item, count, x, y, z, 0);
    }
  }

  /** Remove every dropped item (used when switching worlds). */
  clear(): void {
    for (const d of this.drops) this.group.remove(d.mesh);
    this.drops.length = 0;
  }

  get count(): number {
    return this.drops.length;
  }
}

function solidAt(world: World, x: number, y: number, z: number): boolean {
  return world.isSolidAt(Math.floor(x), Math.floor(y), Math.floor(z));
}

function blockIdFor(item: string): number {
  return blockIdOf(item);
}
