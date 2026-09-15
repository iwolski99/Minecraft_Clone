/**
 * Entity base class.
 *
 * Everything that lives in the world but is not the player (mobs, arrows, and
 * any future item/particle entity) derives from `Entity`. The class owns the
 * boring but critical parts so the mob implementations can stay about
 * *behaviour*:
 *
 *   - a swept, per-axis AABB-voxel collision solver that mirrors the player's
 *   - steering helpers (direct chase, 1-block step climbing, cliff avoidance)
 *   - a small, cached local A* used for actual navigation
 *
 * The manager (`mobmanager.ts`) drives `tick()` / `animate()` and owns the
 * three.js scene graph; entities never add themselves to the scene.
 */

import * as THREE from 'three';
import { World } from '../world/world.js';
import type { Player } from '../player/player.js';
import { getBlock, isLiquid } from '../world/blocks.js';
import { CHUNK_Y } from '../world/chunk.js';

export interface EntityHost {
  world: World;
  player: Player;
  /** play a sound by name (the audio engine is written by someone else; just call it) */
  playSound(name: string, volume?: number, pitch?: number, at?: THREE.Vector3): void;
  /** spawn a particle burst. kind is one of: 'damage' | 'smoke' | 'explosion' | 'splash' | 'crit' */
  spawnParticles(kind: string, x: number, y: number, z: number, count?: number): void;
  /**
   * Spawn the loot a killed mob leaves behind.
   *
   * Optional, and looked up structurally by the manager - but a host that omits
   * it gets no error and no loot, which is exactly how every species ended up
   * dropping nothing at all.
   */
  dropItems?(items: [string, number][], x: number, y: number, z: number): void;
  /** 0..1 where 0 = midnight, 0.5 = noon */
  dayFactor: number;
  isNight: boolean;
  difficulty: number;   // 0 peaceful .. 3 hard
  timeOfDay: number;
}

export type EntityKind = 'passive' | 'hostile' | 'projectile';

const EPS = 1e-3;
/** Largest single upward step a walking mob can climb without jumping. */
const STEP_HEIGHT = 0.6;
/** Cells higher than this below a cell are treated as a cliff (not walkable). */
const MAX_DROP = 3;
/** Cap on nodes expanded by one local A* search. */
const MAX_PATH_NODES = 3000;

/* ------------------------------------------------------------------ */
/* Small shared maths / world helpers                                  */
/* ------------------------------------------------------------------ */

/** Wrap an angle into [-PI, PI]. */
export function wrapAngle(a: number): number {
  let x = a;
  while (x > Math.PI) x -= Math.PI * 2;
  while (x < -Math.PI) x += Math.PI * 2;
  return x;
}

/** Rotate `from` towards `to` by at most `maxDelta` radians. */
export function turnToward(from: number, to: number, maxDelta: number): number {
  const d = wrapAngle(to - from);
  if (d > maxDelta) return from + maxDelta;
  if (d < -maxDelta) return from - maxDelta;
  return to;
}

/** True when the block id blocks movement. */
export function solidId(id: number): boolean {
  if (id === 0) return false;
  const d = getBlock(id);
  if (!d.solid) return false;
  return d.collision !== null;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Approximate combined light (0..1) at a world position using the same
 * sky/block/ambient model the terrain shader uses. Mobs have no realtime
 * lights, so the manager bakes this into their shared material tint.
 */
export function lightBrightness(host: EntityHost, x: number, y: number, z: number): number {
  const day = host.dayFactor;
  const bx = Math.floor(x);
  const by = Math.floor(y);
  const bz = Math.floor(z);
  const sky = host.world.getSkyLightAt(bx, by, bz) / 15;
  const block = host.world.getBlockLightAt(bx, by, bz) / 15;
  const skyTerm = sky * Math.max(0.06, day);
  const lit = Math.max(skyTerm, block * 0.94);
  const min = host.isNight ? 0.1 : 0.22;
  return clamp(0.06 + lit * 0.94, min, 1);
}

interface PathNode {
  x: number;
  y: number;
  z: number;
}

/** Tiny array-backed binary min-heap used by the local A*. */
class NodeHeap {
  private items: number[] = [];
  private keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  clear(): void {
    this.items.length = 0;
    this.keys.length = 0;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let i = this.items.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keys[p] <= this.keys[i]) break;
      this.swap(i, p);
      i = p;
    }
  }

  pop(): number {
    const top = this.items[0];
    const lastItem = this.items.pop()!;
    const lastKey = this.keys.pop()!;
    if (this.items.length > 0) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < this.items.length && this.keys[l] < this.keys[m]) m = l;
        if (r < this.items.length && this.keys[r] < this.keys[m]) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const ti = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = ti;
    const tk = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = tk;
  }
}

/* ------------------------------------------------------------------ */

export abstract class Entity {
  static nextId = 1;

  readonly id: number;
  readonly kind: EntityKind;
  readonly typeName: string;

  /** FEET position (the AABB runs from y to y + height). */
  readonly position = new THREE.Vector3();
  readonly velocity = new THREE.Vector3();
  yaw = 0;    // radians, 0 = facing -Z
  pitch = 0;
  width = 0.6;  // AABB width (x and z)
  height = 1.8; // AABB height
  health = 10;
  maxHealth = 10;
  dead = false;
  onGround = false;
  inWater = false;
  age = 0;
  /** counts down; used for the red damage flash and as the i-frame timer */
  hurtTime = 0;
  attackCooldown = 0;
  /** time since death, drives the fall-over animation */
  deathTime = 0;
  /** the three.js object returned by buildObject(); attached by the manager */
  object3D: THREE.Object3D | null = null;
  /** whether the flash material is currently applied, so the swap happens once */
  wasFlashing = false;
  /** -1, or elapsed time when this entity should be culled */
  removeAt = -1;
  /** scratch accumulator the manager uses for distance-based tick throttling */
  accum = 0;
  /** books kept for the manager's periodic despawn check */
  despawnTimer = 2;
  despawnCount = 0;

  /** per-entity RNG so spawn/despawn decisions do not disturb world generation */
  protected rng: { next(): number; range(a: number, b: number): number; int(a: number, b: number): number; chance(p: number): boolean; pick<T>(a: readonly T[]): T };

  /* local A* state (only touched by pathTo/computePath) */
  private path: PathNode[] = [];
  private pathIndex = 0;
  private pathTargetX = Infinity;
  private pathTargetY = Infinity;
  private pathTargetZ = Infinity;
  private pathTimer = 0;
  /** time since the last A* search, used to throttle the search itself */
  private sinceSearch = 1;
  private readonly heap = new NodeHeap();

  constructor(kind: EntityKind, typeName: string, x: number, y: number, z: number) {
    this.id = Entity.nextId++;
    this.kind = kind;
    this.typeName = typeName;
    this.position.set(x, y, z);
    // `createMob` always installs a deterministic Rng right after construction;
    // the Math.random fallback keeps direct `new Whatever()` usable.
    this.rng = {
      next: () => Math.random(),
      range: (a: number, b: number) => a + Math.random() * (b - a),
      int: (a: number, b: number) => a + Math.floor(Math.random() * (b - a + 1)),
      chance: (p: number) => Math.random() < p,
      pick: <T,>(a: readonly T[]): T => a[Math.floor(Math.random() * a.length) % a.length],
    };
  }

  /** Installs the deterministic per-entity RNG (called by the mob factory). */
  installRng(rng: Entity['rng']): void {
    this.rng = rng;
  }

  /* ---------------------------------------------------------------- */
  /* Required subclass surface                                         */
  /* ---------------------------------------------------------------- */

  /** Build the visual representation. Called once by the manager. */
  abstract buildObject(): THREE.Object3D;
  /** per-tick behaviour */
  abstract tick(dt: number, host: EntityHost): void;
  /** animation update; called every frame after tick */
  abstract animate(dt: number, host: EntityHost): void;
  /** item drops on death: [itemName, count] pairs */
  abstract drops(): [string, number][];

  /* ---------------------------------------------------------------- */
  /* Damage                                                            */
  /* ---------------------------------------------------------------- */

  /** apply damage + knockback; returns true when this hit killed the entity */
  hurt(amount: number, sourceX: number, sourceZ: number, host: EntityHost, knockback = 0.35): boolean {
    if (this.dead) return false;
    // brief invulnerability window so a fast attacker cannot chain-stun
    if (this.hurtTime > 0.28) return false;
    this.health -= amount;
    this.hurtTime = 0.45;
    const dx = this.position.x - sourceX;
    const dz = this.position.z - sourceZ;
    const len = Math.hypot(dx, dz);
    if (knockback > 0) {
      const nx = len > 1e-4 ? dx / len : this.rng.range(-1, 1);
      const nz = len > 1e-4 ? dz / len : this.rng.range(-1, 1);
      this.velocity.x += nx * knockback * 4;
      this.velocity.z += nz * knockback * 4;
      this.velocity.y = Math.max(this.velocity.y, 3.1);
    }
    host.spawnParticles('damage', this.position.x, this.position.y + this.height * 0.6, this.position.z, 6);
    host.playSound(this.typeName + '_hurt', 0.7, 0.9 + Math.random() * 0.2, this.position);
    if (this.health <= 0) {
      this.die(host);
      return true;
    }
    return false;
  }

  /** Kills the entity and starts the death animation / cull timer. */
  die(host: EntityHost): void {
    if (this.dead) return;
    this.dead = true;
    this.health = 0;
    this.velocity.y = Math.max(this.velocity.y, 1.4);
    host.playSound(this.typeName + '_death', 0.8, 0.9 + Math.random() * 0.15, this.position);
  }

  /* ---------------------------------------------------------------- */
  /* Geometry helpers                                                  */
  /* ---------------------------------------------------------------- */

  /** head/target height used for raycast hit tests */
  eyeY(): number {
    return this.position.y + this.height * 0.85;
  }

  /** axis-aligned bounds for hit tests */
  getBounds(): { minX: number; minY: number; minZ: number; maxX: number; maxY: number; maxZ: number } {
    const hw = this.width * 0.5;
    return {
      minX: this.position.x - hw,
      minY: this.position.y,
      minZ: this.position.z - hw,
      maxX: this.position.x + hw,
      maxY: this.position.y + this.height,
      maxZ: this.position.z + hw,
    };
  }

  /** Squared distance to a point (cheap range checks for AI). */
  distanceSqTo(x: number, y: number, z: number): number {
    const dx = this.position.x - x;
    const dy = this.position.y - y;
    const dz = this.position.z - z;
    return dx * dx + dy * dy + dz * dz;
  }

  /** Is the entity's AABB overlapping a solid block at this position? */
  protected intersects(world: World, px = this.position.x, py = this.position.y, pz = this.position.z, pad = 0): boolean {
    const hw = this.width * 0.5 + pad;
    const x0 = Math.floor(px - hw + EPS);
    const x1 = Math.floor(px + hw - EPS);
    const y0 = Math.floor(py + EPS);
    const y1 = Math.floor(py + this.height - EPS);
    const z0 = Math.floor(pz - hw + EPS);
    const z1 = Math.floor(pz + hw - EPS);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          const id = world.getBlockAt(x, y, z);
          if (id === 0) continue;
          const def = getBlock(id);
          if (!def.solid || def.collision === null) continue;
          const col = def.collision;
          if (!col) return true; // full cube
          if (
            px + hw > x + col[0] && px - hw < x + col[3] &&
            py + this.height > y + col[1] && py < y + col[4] &&
            pz + hw > z + col[2] && pz - hw < z + col[5]
          ) {
            return true;
          }
        }
      }
    }
    return false;
  }

  /** True when there is a collision surface within `depth` below the feet. */
  protected groundBelow(world: World, depth = 0.08, x = this.position.x, z = this.position.z): boolean {
    return this.intersects(world, x, this.position.y - depth, z);
  }

  /** True when the entity can stand on the block below (x, groundY, z). */
  protected canStandAt(world: World, x: number, groundY: number, z: number): boolean {
    if (groundY < 1 || groundY >= CHUNK_Y - 2) return false;
    if (!solidId(world.getBlockAt(Math.floor(x), groundY - 1, Math.floor(z)))) return false;
    if (this.intersects(world, x, groundY, z)) return false;
    return true;
  }

  /** Nearest standable surface y at a column, searching around `guessY`. */
  protected surfaceY(world: World, x: number, z: number, guessY: number, search = 5): number {
    const xi = Math.floor(x);
    const zi = Math.floor(z);
    const from = Math.max(0, Math.round(guessY) - search);
    const to = Math.min(CHUNK_Y - 2, Math.round(guessY) + search);
    let best = -1;
    let bestDist = Infinity;
    for (let y = from; y <= to; y++) {
      if (!this.canStandAt(world, x, y, z)) continue;
      const d = Math.abs(y - guessY);
      if (d < bestDist) {
        bestDist = d;
        best = y;
      }
    }
    // fall back to a solid surface even when the mob is currently too fat for it
    if (best < 0) {
      for (let y = from; y <= to; y++) {
        if (solidId(world.getBlockAt(xi, y - 1, zi))) return y;
      }
    }
    return best;
  }

  /** Liquid type at the feet: 0 = dry, 1 = water, 2 = lava. */
  protected liquidKind(world: World): number {
    const id = world.getBlockAt(Math.floor(this.position.x), Math.floor(this.position.y + 0.2), Math.floor(this.position.z));
    if (!isLiquid(id)) return 0;
    return getBlock(id).name === 'lava' ? 2 : 1;
  }

  /* ---------------------------------------------------------------- */
  /* Movement + collision                                              */
  /* ---------------------------------------------------------------- */

  private tryMoveAxis(world: World, axis: 'x' | 'y' | 'z', next: number): boolean {
    const blocked = axis === 'x'
      ? this.intersects(world, next, this.position.y, this.position.z)
      : axis === 'y'
        ? this.intersects(world, this.position.x, next, this.position.z)
        : this.intersects(world, this.position.x, this.position.y, next);
    if (!blocked) {
      this.position[axis] = next;
      return false;
    }
    const hw = this.width * 0.5;
    if (axis === 'y') {
      this.position.y = next > this.position.y
        ? Math.floor(next + this.height) - this.height - EPS
        : Math.floor(next) + 1 + EPS;
    } else if (next > this.position[axis]) {
      this.position[axis] = Math.floor(next + hw) - hw - EPS;
    } else {
      this.position[axis] = Math.floor(next - hw) + 1 + hw + EPS;
    }
    return true;
  }

  /** Moves one axis with a swept AABB, snapping exactly onto the blocking face. */
  private moveAxis(world: World, axis: 'x' | 'y' | 'z', amount: number): boolean {
    if (amount === 0) return false;
    let remaining = amount;
    while (Math.abs(remaining) > 1e-6) {
      const step = clamp(remaining, -0.4, 0.4);
      remaining -= step;
      if (this.tryMoveAxis(world, axis, this.position[axis] + step)) return true;
    }
    return false;
  }

  /** shared movement + voxel collision, identical in spirit to the player's */
  protected moveWithCollision(dt: number, world: World): void {
    const liquid = this.liquidKind(world);
    this.inWater = liquid === 1;

    if (liquid === 1) {
      // buoyant, heavily damped swimming
      this.velocity.y -= 5.5 * dt;
      this.velocity.y *= 0.86;
      if (this.velocity.y < -3.2) this.velocity.y = -3.2;
      this.velocity.x *= 0.965;
      this.velocity.z *= 0.965;
    } else if (liquid === 2) {
      this.velocity.y -= 7 * dt;
      this.velocity.y *= 0.8;
      this.velocity.x *= 0.8;
      this.velocity.z *= 0.8;
    } else {
      this.velocity.y -= 30 * dt;
      if (this.velocity.y < -70) this.velocity.y = -70;
    }

    // Steer clear of cliffs *after* the caller has set the desired velocity and
    // *before* the move is integrated, so every movement path is covered.
    if (liquid === 0) this.avoidCliff(world);

    this.moveAxis(world, 'x', this.velocity.x * dt);
    this.moveAxis(world, 'z', this.velocity.z * dt);

    // Step up onto a *one block* ledge. The extra head-room probe is what keeps
    // this from becoming a wall hack: a two-block wall has no free cell at
    // feet + 1, so no lift is applied and the mob stays blocked.
    if (this.onGround && liquid === 0) {
      const dirX = Math.abs(this.velocity.x) > 0.35 ? Math.sign(this.velocity.x) : 0;
      const dirZ = Math.abs(this.velocity.z) > 0.35 ? Math.sign(this.velocity.z) : 0;
      if (dirX !== 0 || dirZ !== 0) {
        const hw = this.width * 0.5;
        const ax = dirX * (hw + 0.08);
        const az = dirZ * (hw + 0.08);
        const feet = Math.floor(this.position.y + 0.08);
        // sample the cells the move is actually blocked by (diagonals: both sides)
        const probes: [number, number][] = [];
        if (dirX !== 0) probes.push([Math.floor(this.position.x + ax), Math.floor(this.position.z)]);
        if (dirZ !== 0) probes.push([Math.floor(this.position.x), Math.floor(this.position.z + az)]);
        if (dirX !== 0 && dirZ !== 0) probes.push([Math.floor(this.position.x + ax), Math.floor(this.position.z + az)]);
        // only step up when *every* blocked direction is a genuine one-block ledge
        const blocked = probes.length > 0 && probes.every(([bx, bz]) => solidId(world.getBlockAt(bx, feet, bz)));
        if (blocked) {
          const freeAbove = probes.every(([bx, bz]) => !solidId(world.getBlockAt(bx, feet + 1, bz)));
          if (freeAbove) {
            const landed = this.surfaceY(world, this.position.x, this.position.z, this.position.y + 1.05, 2);
            if (landed > this.position.y + 0.4 && landed <= this.position.y + STEP_HEIGHT + 0.05) {
              this.position.y = landed + 0.02;
              if (this.velocity.y < 0) this.velocity.y = 0;
            }
          }
        }
      }
    }

    this.moveAxis(world, 'y', this.velocity.y * dt);

    const grounded = this.groundBelow(world) && this.velocity.y <= 0.001;
    this.onGround = grounded;
    if (grounded && this.velocity.y < 0) this.velocity.y = 0;

    if (this.position.y < -6) {
      this.position.y = -6;
      this.velocity.y = 0;
    }
  }

  /* ---------------------------------------------------------------- */
  /* Steering helpers                                                  */
  /* ---------------------------------------------------------------- */

  /** Sets horizontal velocity toward a point and faces the entity that way. */
  protected steerTowards(dt: number, speed: number, tx: number, tz: number): void {
    const dx = tx - this.position.x;
    const dz = tz - this.position.z;
    const len = Math.hypot(dx, dz);
    if (len < 1e-4) {
      this.velocity.x *= Math.max(0, 1 - 6 * dt);
      this.velocity.z *= Math.max(0, 1 - 6 * dt);
      return;
    }
    const nx = dx / len;
    const nz = dz / len;
    const accel = this.onGround ? 10 : 3.5;
    const blend = Math.min(1, accel * dt);
    this.velocity.x += (nx * speed - this.velocity.x) * blend;
    this.velocity.z += (nz * speed - this.velocity.z) * blend;
    this.faceTowards(dt, nx, nz);
  }

  /** Smoothly turns the body yaw toward a direction vector (yaw 0 = -Z). */
  protected faceTowards(dt: number, nx: number, nz: number, rate = 7): void {
    const want = Math.atan2(-nx, -nz);
    this.yaw = turnToward(this.yaw, want, rate * dt);
  }

  /**
   * Steer one step toward a target point, jumping over 1-block obstacles.
   * Cliff avoidance happens later, inside `moveWithCollision`, so that direct
   * callers cannot walk mobs over a ledge.
   */
  protected steerTo(dt: number, world: World, tx: number, tz: number, speed: number): void {
    const wasGround = this.onGround;
    this.steerTowards(dt, speed, tx, tz);

    if (wasGround && this.onGround && speed > 0.4) {
      const dx = tx - this.position.x;
      const dz = tz - this.position.z;
      const len = Math.hypot(dx, dz);
      if (len > 1e-4) this.jumpIfBlocked(world, dx / len, dz / len);
    }
  }

  /**
   * Redirects or cancels the horizontal velocity when it would carry the mob
   * over a drop deeper than MAX_DROP, so wanderers hug cliff edges instead of
   * marching into pits. Cheap: three columns, and only while walking on ground.
   */
  private avoidCliff(world: World): void {
    const horiz = Math.hypot(this.velocity.x, this.velocity.z);
    if (!this.onGround || horiz <= 0.2) return;
    const nx = this.velocity.x / horiz;
    const nz = this.velocity.z / horiz;
    // a mob standing at position.y = 41.0 stands ON block 40
    const feet = Math.round(this.position.y - 0.02);
    if (!this.edgeAhead(world, nx, nz, feet)) return;

    const t1x = -nz;
    const t1z = nx;
    const t2x = nz;
    const t2z = -nx;
    const ok1 = !this.edgeAhead(world, t1x, t1z, feet);
    const ok2 = !this.edgeAhead(world, t2x, t2z, feet);
    let sx = 0;
    let sz = 0;
    if (ok1 && !ok2) {
      sx = t1x;
      sz = t1z;
    } else if (ok2 && !ok1) {
      sx = t2x;
      sz = t2z;
    } else if (ok1 && ok2) {
      // both ways open: bias towards the one that still closes on the target
      const gx = this.pathTargetX - this.position.x;
      const gz = this.pathTargetZ - this.position.z;
      const d1 = gx * t1x + gz * t1z;
      const d2 = gx * t2x + gz * t2z;
      sx = d1 >= d2 ? t1x : t2x;
      sz = d1 >= d2 ? t1z : t2z;
    } else {
      // dead end: stop dead rather than walk over the edge
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const speed = Math.max(horiz, 0.35);
    this.velocity.x = sx * speed;
    this.velocity.z = sz * speed;
  }

  /**
   * True when walking in (nx,nz) would leave a drop deeper than MAX_DROP.
   * Samples several distances so fast mobs cannot step over the lip between
   * two checks. `feet` is the block coordinate the mob is standing on.
   */
  private edgeAhead(world: World, nx: number, nz: number, feet: number): boolean {
    const reach = Math.max(0.9, this.width * 0.5 + 0.6);
    for (const d of [0.55, reach, reach + 0.5]) {
      const px = Math.floor(this.position.x + nx * d);
      const pz = Math.floor(this.position.z + nz * d);
      let supported = false;
      for (let drop = 0; drop <= MAX_DROP; drop++) {
        if (solidId(world.getBlockAt(px, feet - drop, pz))) {
          supported = true;
          break;
        }
      }
      if (!supported) return true;
    }
    return false;
  }

  /** Jumps when a solid block sits directly in front at foot/body height. */
  protected jumpIfBlocked(world: World, nx: number, nz: number): void {    if (!this.onGround) return;
    const fx = Math.floor(this.position.x + nx * 0.62);
    const fz = Math.floor(this.position.z + nz * 0.62);
    const feet = Math.floor(this.position.y + 0.1);
    const body = Math.floor(this.position.y + this.height * 0.6);
    const blocked = solidId(world.getBlockAt(fx, feet, fz)) || solidId(world.getBlockAt(fx, body, fz));
    if (!blocked) return;
    const headClear = !solidId(world.getBlockAt(fx, feet + 1, fz)) && !solidId(world.getBlockAt(fx, feet + 2, fz));
    if (!headClear) return;
    this.velocity.y = 8.2;
    this.onGround = false;
  }

  /* ---------------------------------------------------------------- */
  /* Local A*                                                          */
  /* ---------------------------------------------------------------- */

  /**
   * Navigate toward a target using a lightweight local A* over a 16x16x8 cell
   * window (stride 1). Results are cached per entity and recomputed at most a
   * few times per second, or when the target has moved more than two blocks.
   * Falls back to direct steering whenever no path exists.
   */
  protected pathTo(dt: number, world: World, tx: number, ty: number, tz: number, speed: number): void {
    const sx = Math.floor(this.position.x);
    const sy = Math.floor(this.position.y);
    const sz = Math.floor(this.position.z);
    const gx = Math.floor(tx);
    const gy = Math.floor(ty);
    const gz = Math.floor(tz);

    this.pathTimer -= dt;
    const targetMoved =
      Math.abs(tx - this.pathTargetX) > 2 ||
      Math.abs(tz - this.pathTargetZ) > 2 ||
      Math.abs(ty - this.pathTargetY) > 3;
    // Throttle the search: at most ~5/s normally, and never more than once per
    // 0.05s even when the caller ticks an entity several times in one frame.
    this.sinceSearch += dt;
    const canSearch = this.sinceSearch >= 0.05;
    if (canSearch && (targetMoved || this.pathTimer <= 0)) {
      this.pathTimer = 0.22;
      this.sinceSearch = 0;
      this.pathTargetX = tx;
      this.pathTargetY = ty;
      this.pathTargetZ = tz;
      this.path = this.computePath(world, sx, sy, sz, gx, gy, gz);
      this.pathIndex = 0;
    }

    // advance past reached waypoints
    while (this.pathIndex < this.path.length) {
      const wp = this.path[this.pathIndex];
      const dx = wp.x - this.position.x;
      const dz = wp.z - this.position.z;
      if (dx * dx + dz * dz < 0.3) this.pathIndex++;
      else break;
    }
    // A path starts at the mob's own cell and includes every cell it still has
    // to cross. Drop waypoints the mob has already walked past; stepping back
    // to one of those makes the mob pace on the spot.
    while (this.pathIndex < this.path.length && this.isBehind(this.path[this.pathIndex])) {
      this.pathIndex++;
    }

    const next = this.pathIndex < this.path.length ? this.path[this.pathIndex] : null;
    if (!next) {
      const dist = Math.hypot(tx - this.position.x, tz - this.position.z);
      // Stop short of the goal so mobs do not shove each other into the player.
      if (dist <= 1.4) {
        this.velocity.x *= Math.max(0, 1 - 8 * dt);
        this.velocity.z *= Math.max(0, 1 - 8 * dt);
        return;
      }
      // No usable path: pick the nearby walkable cell that makes the most
      // progress toward the goal. This is what keeps mobs hugging cliff edges
      // and slipping past obstacles the A* window cannot route through.
      const step = this.bestLocalStep(world, tx, tz);
      if (step) this.steerTo(dt, world, step.x, step.z, speed);
      else this.steerTo(dt, world, tx, tz, speed);
      return;
    }
    this.steerTo(dt, world, next.x, next.z, speed);
  }

  /**
   * True when a cached waypoint lies behind the entity along its own path,
   * judged by comparing cell indices in the row-major order A* used. Diagonal
   * moves make this approximate, which is fine: it only ever drops a waypoint
   * the entity has visibly already walked past.
   */
  private isBehind(wp: PathNode): boolean {
    const here = Math.floor(this.position.x) + Math.floor(this.position.z) * 256;
    const there = Math.floor(wp.x) + Math.floor(wp.z) * 256;
    return there < here;
  }

  /**
   * Greedy fallback used when A* returns nothing: score the walkable cells in a
   * small neighbourhood by "distance closed towards the goal" and return the
   * best one, or null when nothing improves on standing still.
   */
  private bestLocalStep(world: World, tx: number, tz: number): { x: number; z: number } | null {
    const sx = this.position.x;
    const sz = this.position.z;
    const feet = Math.round(this.position.y - 0.02);
    const goalDist = Math.hypot(tx - sx, tz - sz);
    let bestX = 0;
    let bestZ = 0;
    let bestScore = 0;
    for (let dz = -3; dz <= 3; dz++) {
      for (let dx = -3; dx <= 3; dx++) {
        if (dx === 0 && dz === 0) continue;
        const cx = Math.floor(sx) + dx;
        const cz = Math.floor(sz) + dz;
        let standY = -1;
        for (let dy = -2; dy <= 2; dy++) {
          const y = feet + dy;
          if (this.canStandAt(world, cx + 0.5, y, cz + 0.5)) {
            standY = y;
            break;
          }
        }
        if (standY < 0) continue;
        const px = cx + 0.5;
        const pz = cz + 0.5;
        const d = Math.hypot(tx - px, tz - pz);
        // must actually reduce the distance, otherwise the mob jitters in place
        const score = goalDist - d - Math.hypot(px - sx, pz - sz) * 0.35;
        if (score > bestScore) {
          bestScore = score;
          bestX = px;
          bestZ = pz;
        }
      }
    }
    return bestScore > 0.15 ? { x: bestX, z: bestZ } : null;
  }

  /** A* over the local window. Returns an empty array when the goal is unreachable. */
  private computePath(world: World, sx: number, sy: number, sz: number, gx: number, gy: number, gz: number): PathNode[] {
    const W = 16;
    const H = 8;
    // The window is always centred on the mob so the start cell is guaranteed to
    // be inside it; a distant goal simply falls on the window edge, which still
    // yields steady forward progress.
    const ox = Math.floor(sx - W / 2);
    const oz = Math.floor(sz - W / 2);
    const oy = Math.floor(clamp(sy, 1, CHUNK_Y - H - 1) - H / 2);

    const spanX = W;
    const spanZ = W;
    const volume = spanX * H * spanZ;
    const gScore = new Float32Array(volume);
    gScore.fill(Infinity);
    const cameFrom = new Int32Array(volume);
    cameFrom.fill(-1);
    const closed = new Uint8Array(volume);
    const index = (x: number, y: number, z: number): number => ((y - oy) * spanZ + (z - oz)) * spanX + (x - ox);

    const start = index(sx, sy, sz);
    if (start < 0 || start >= volume) return [];

    // Resolve the goal to a cell that is actually walkable *and close to the
    // requested target*. Without this the search happily "succeeds" at some
    // unrelated walkable cell (often one behind the mob) and the entity just
    // paces on the spot instead of making progress.
    let aimX = clamp(gx, ox, ox + spanX - 1);
    let aimZ = clamp(gz, oz, oz + spanZ - 1);
    const gyClamped = clamp(gy, oy, oy + H - 1);
    let aimY = gyClamped;
    if (!this.canStandAt(world, aimX, aimY, aimZ)) {
      let found = false;
      for (let r = 0; r <= 4 && !found; r++) {
        for (let dz = -r; dz <= r && !found; dz++) {
          for (let dx = -r; dx <= r && !found; dx++) {
            if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
            const cx = clamp(gx + dx, ox, ox + spanX - 1);
            const cz = clamp(gz + dz, oz, oz + spanZ - 1);
            // prefer a cell at the target's own height, then look up/down a bit
            for (let dy = 0; dy <= 3 && !found; dy++) {
              for (const y of dy === 0 ? [gyClamped] : [gyClamped + dy, gyClamped - dy]) {
                if (y < oy || y >= oy + H) continue;
                if (!this.canStandAt(world, cx, y, cz)) continue;
                aimX = cx;
                aimZ = cz;
                aimY = y;
                found = true;
              }
            }
          }
        }
      }
      if (!found) return []; // nothing walkable nearby: the caller steers directly
    }
    let goalIdx = index(aimX, aimY, aimZ);
    if (goalIdx < 0 || goalIdx >= volume) return [];
    const gyi = aimY;

    const heap = this.heap;
    heap.clear();
    gScore[start] = 0;
    let startH = Math.abs(aimX - sx) + Math.abs(aimZ - sz) + Math.abs(gyi - sy);
    heap.push(start, startH);

    // Track the closest node we ever reached. When the exact goal is walled off
    // (very common: the goal is "the player", and the player may be behind a
    // wall or inside a pit) we still return a path to the *nearest reachable
    // point*, so the mob keeps making progress instead of stopping dead.
    let bestNode = start;
    let bestH = startH;
    let expanded = 0;
    let found = false;
    while (heap.size > 0 && expanded < MAX_PATH_NODES) {
      const cur = heap.pop();
      if (closed[cur]) continue;
      closed[cur] = 1;
      expanded++;
      if (cur === goalIdx) {
        found = true;
        bestNode = cur;
        break;
      }
      const cx = (cur % spanX) + ox;
      const cz = (Math.floor(cur / spanX) % spanZ) + oz;
      const cy = Math.floor(cur / (spanX * spanZ)) + oy;
      const ch = Math.abs(cx - aimX) + Math.abs(cz - aimZ) + Math.abs(cy - gyi);
      if (ch < bestH) {
        bestH = ch;
        bestNode = cur;
      }

      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = cx + dx;
          const nz = cz + dz;
          // no corner cutting through a diagonal gap
          if (dx !== 0 && dz !== 0) {
            if (!this.canStandAt(world, nx, cy, cz) || !this.canStandAt(world, cx, cy, nz)) continue;
          }
          for (let dy = 2; dy >= -MAX_DROP; dy--) {
            const ny = cy + dy;
            if (ny < oy || ny >= oy + H) continue;
            if (!this.canStandAt(world, nx, ny, nz)) continue;
            const stepCost = (dx !== 0 && dz !== 0 ? 1.42 : 1) + Math.abs(dy) * 0.45;
            const ni = index(nx, ny, nz);
            const tentative = gScore[cur] + stepCost;
            if (tentative < gScore[ni]) {
              gScore[ni] = tentative;
              cameFrom[ni] = cur;
              const h = Math.abs(nx - aimX) + Math.abs(nz - aimZ) + Math.abs(ny - gyi) * 0.6;
              heap.push(ni, tentative + h);
            }
            break; // only the cheapest landing spot per column
          }
        }
      }
    }

    // No path at all: fall back to the closest reachable cell.
    if (!found) {
      if (bestNode === start) return [];
      goalIdx = bestNode;
    }

    const raw: PathNode[] = [];
    let node = goalIdx;
    let guard = 0;
    while (node !== start && node !== -1 && guard++ < volume) {
      const i = (node % spanX) + ox;
      const j = (Math.floor(node / spanX) % spanZ) + oz;
      const k = Math.floor(node / (spanX * spanZ)) + oy;
      raw.push({ x: i + 0.5, y: k, z: j + 0.5 });
      node = cameFrom[node];
    }
    raw.reverse();
    return raw;
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  /** Detach from the scene and release per-instance GPU resources. */
  destroyObject(): void {
    const obj = this.object3D;
    if (!obj) return;
    obj.parent?.remove(obj);
    obj.traverse((child) => {
      const mesh = child as THREE.Mesh;
      if (mesh.isMesh && mesh.geometry) mesh.geometry.dispose();
    });
    this.object3D = null;
  }
}
