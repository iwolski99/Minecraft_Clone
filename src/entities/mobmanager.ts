/**
 * Mob manager: spawning, ticking, animation, tinting, culling and queries.
 *
 * The manager owns the single `THREE.Group` every mob is attached to, so the
 * renderer only has to add one object to the scene regardless of how many
 * creatures are alive.
 *
 * Performance notes:
 *   - entities further than 48 blocks tick at a quarter rate; past 80 blocks
 *     they are frozen and hidden
 *   - meshes are built lazily, once a mob comes into visible range, which keeps
 *     a freshly generated world from stalling on mob construction
 *   - mob materials are shared per type, so the day/night + block light tint is
 *     computed per type per frame (from the darkest instance) instead of per
 *     mesh, and a slow-moving darkening filter keeps it from popping
 */

import * as THREE from 'three';
import { Entity, EntityHost } from './entity.js';
import {
  PASSIVE_TYPES,
  HOSTILE_TYPES,
  createMob,
  registerHostRegistry,
  unregisterHostRegistry,
  HostMobRegistry,
} from './mobs.js';
import { getBlock } from '../world/blocks.js';
import { flashOf } from './models.js';
import type { World } from '../world/world.js';
import { Rng } from '../util/rng.js';

/**
 * Population caps and spawn cadence, matched to the original.
 *
 * The values here were roughly six times too conservative on the cadence and
 * two and a half times too low on the cap, which is why hostiles were a rarity
 * and the world felt empty. For reference, the original runs a spawn cycle every
 * tick - 20 attempts a second - with a hostile cap of 70 per player and a
 * passive cap of 10, and despawns hostiles beyond 128 blocks.
 */
const MAX_HOSTILE = 70;
const MAX_PASSIVE = 26;
const MAX_PROJECTILE = 60;
/** Hostiles never appear closer than this to the player. */
const HOSTILE_MIN_DIST = 12;
/** Absolute ceiling on tracked entities, whatever their kind. */
const MAX_ENTITIES = 340;
/** Passive spawn attempts stay inside the simulated area. */
const PASSIVE_RADIUS = 34;
/** Seconds between spawn waves: 0.25 with 5 attempts is the original's 20/sec. */
const SPAWN_INTERVAL = 0.25;
const SPAWN_ATTEMPTS = 5;
/** Meshes are only built for mobs inside this range. */
const RENDER_SPAWN_RANGE = 74;
const TICK_RANGE = 80;
const THROTTLE_RANGE = 48;
/**
 * Hostiles that wander past this are candidates for natural despawn. The
 * original uses 128 blocks; the old 64 culled mobs well inside visual range, so
 * anything that spawned was liable to vanish before it could be seen.
 */
const DESPAWN_RANGE = 112;
/** How fast the shared material tint chases the true light level. */
const TINT_LERP = 0.35;

export interface EntityDropHandler {
  /** called once per entity whose loot should enter the world */
  (items: [string, number][], x: number, y: number, z: number): void;
}

export class MobManager implements HostMobRegistry {
  readonly entities: Entity[] = [];
  readonly group: THREE.Group;

  private readonly host: EntityHost;
  /** deterministic stream for spawn positions / types */
  private rng: Rng;
  private spawnTimer = SPAWN_INTERVAL;
  private disposed = false;
  /** last smoothed brightness per shared material */
  private readonly tintState = new Map<THREE.MeshBasicMaterial, number>();

  constructor(host: EntityHost) {
    this.host = host;
    this.group = new THREE.Group();
    this.group.name = 'mobs';
    this.rng = new Rng((Math.random() * 0xffffffff) >>> 0);
    // projectiles need a way back to the manager; register by host identity
    registerHostRegistry(host, this);
  }

  /* ---------------------------------------------------------------- */
  /* Main loop                                                         */
  /* ---------------------------------------------------------------- */

  /** called every frame; handles spawning, ticking, animation, culling and distance-based throttling */
  update(dt: number, playerX: number, playerY: number, playerZ: number): void {
    if (this.disposed) return;
    // a paused tab / long frame must not teleport every mob through the world
    const frame = Math.min(dt, 0.25);

    this.spawnTick(frame, playerX, playerY, playerZ);

    // One accumulator per mob type: every instance reports the light it needs
    // and the shared material is then darkened to satisfy the darkest of them.
    const wanted = new Map<THREE.MeshBasicMaterial, number>();

    for (let i = this.entities.length - 1; i >= 0; i--) {
      const e = this.entities[i];
      const dx = e.position.x - playerX;
      const dy = e.position.y - playerY;
      const dz = e.position.z - playerZ;
      const distSq = dx * dx + dy * dy + dz * dz;
      const inTickRange = distSq <= TICK_RANGE * TICK_RANGE;

      // Lazy mesh build. This must stay inside the range test: building a rig for
      // every mob in a busy world would allocate thousands of geometries. The
      // built root is stored back on the entity, otherwise it would be rebuilt
      // (and re-added to the group) on every single frame.
      if (!e.object3D && inTickRange && distSq < RENDER_SPAWN_RANGE * RENDER_SPAWN_RANGE) {
        const built = e.buildObject();
        built.visible = true;
        e.object3D = built;
        this.group.add(built);
      }

      const obj = e.object3D;
      if (!inTickRange) {
        if (obj) {
          obj.visible = false;
          obj.scale.setScalar(0.0001);
        }
      } else {
        if (obj) {
          obj.visible = true;
          if (obj.scale.x < 0.001) obj.scale.setScalar(1);
        }
        // entities beyond 48 blocks tick at a quarter rate
        e.accum += frame;
        if (distSq <= THROTTLE_RANGE * THROTTLE_RANGE || e.accum >= 0.25) {
          const step = e.accum;
          e.accum = 0;
          e.tick(step, this.host);
        }
        e.animate(frame, this.host);
        this.accumulateTint(e, wanted);
        /*
         * Damage flash. `Entity.hurt` already runs a 0.45 s `hurtTime` timer; all
         * that was missing was anything reading it. A mob's material is shared
         * per type, so one instance cannot be tinted on its own - the hit mob is
         * swapped onto the paired flash material and back when the timer runs
         * out. The swap only happens on the transition, not every frame.
         */
        const flashing = e.hurtTime > 0;
        if (flashing !== e.wasFlashing) {
          e.wasFlashing = flashing;
          const normalMat = e.object3D?.userData?.mobMaterial as THREE.Material | undefined;
          const flashMat = normalMat ? flashOf.get(normalMat) : undefined;
          if (normalMat && flashMat) {
            const want = flashing ? flashMat : normalMat;
            e.object3D?.traverse((o) => {
              const m = o as THREE.Mesh;
              if (m.isMesh) m.material = want;
            });
          }
        }
      }

      // culling: explicit removal, natural death, or a far-away despawn
      if (e.removeAt >= 0 || e.health <= 0 || this.shouldDespawn(e, distSq, frame)) {
        this.removeAt(i);
      }
    }

    for (const [mat, brightness] of wanted) {
      const prev = this.tintState.get(mat);
      const b = prev === undefined ? brightness : prev + (brightness - prev) * TINT_LERP;
      this.tintState.set(mat, b);
      // a faintly warm tint reads as sunlight rather than as flat white
      mat.color.setRGB(b, b * 0.98, b * 0.95);
      // The flash material has to track the ambient light too, or a mob hit at
      // night would flash full-bright. Red is left at full and green/blue pulled
      // well down, which reads as red without flattening the sprite.
      const fl = flashOf.get(mat);
      if (fl) fl.color.setRGB(b, b * 0.22, b * 0.2);
    }
  }

  /**
   * Distance-based despawn, checked a couple of times a second per mob.
   *
   * Hostiles that end up beyond 64 blocks lose interest and vanish, but only
   * once the population is comfortably under its cap - otherwise a player who
   * kites a crowd away from the spawn area would empty the world. Passives are
   * never despawned this way, they simply stop being simulated out at 80 blocks.
   */
  private shouldDespawn(e: Entity, distSq: number, dt: number): boolean {
    if (e.dead || e.kind !== 'hostile') return false;
    e.despawnTimer -= dt;
    if (e.despawnTimer > 0) return false;
    e.despawnTimer = 2;
    if (distSq < DESPAWN_RANGE * DESPAWN_RANGE) {
      e.despawnCount = 0; // came back into range: remember it exists
      return false;
    }
    // well past double the despawn range nothing is ever coming back
    if (distSq > DESPAWN_RANGE * DESPAWN_RANGE * 4) {
      e.removeAt = e.age;
      return true;
    }
    if (this.countKind('hostile') <= MAX_HOSTILE - 6) {
      e.removeAt = e.age;
      return true;
    }
    // over the soft cap: retire the ones that have been gone the longest
    e.despawnCount++;
    if (e.despawnCount > 4) {
      e.removeAt = e.age;
      return true;
    }
    return false;
  }

  /* ---------------------------------------------------------------- */
  /* Spawning                                                          */
  /* ---------------------------------------------------------------- */

  private spawnTick(dt: number, px: number, py: number, pz: number): void {
    this.spawnTimer -= dt;
    if (this.spawnTimer > 0) return;
    this.spawnTimer = SPAWN_INTERVAL;

    let hostiles = 0;
    let passives = 0;
    for (const e of this.entities) {
      if (e.kind === 'hostile') hostiles++;
      else if (e.kind === 'passive') passives++;
    }

    // Hostiles only appear at night on the surface; in caves/overhangs the
    // darkness test inside trySpawn lets them appear during the day.
    const wantHostile = this.host.difficulty > 0 && hostiles < MAX_HOSTILE;
    const wantPassive = passives < MAX_PASSIVE;

    for (let attempt = 0; attempt < SPAWN_ATTEMPTS; attempt++) {
      if (wantPassive && this.trySpawn(PASSIVE_TYPES, px, py, pz, false)) {
        passives++;
        continue;
      }
      if (wantHostile && this.trySpawn(HOSTILE_TYPES, px, py, pz, true)) {
        hostiles++;
        if (hostiles >= MAX_HOSTILE) break;
      }
    }
  }

  /**
   * One spawn attempt. Hostiles need darkness (block light < 8 and sky light < 8,
   * or night on the surface) and must appear at least 12 blocks away.
   */
  private trySpawn(types: string[], px: number, py: number, pz: number, hostile: boolean): boolean {
    if (this.entities.length >= MAX_ENTITIES) return false;
    const angle = this.rng.range(0, Math.PI * 2);
    const dist = hostile ? this.rng.range(HOSTILE_MIN_DIST, 44) : this.rng.range(8, PASSIVE_RADIUS);
    const x = Math.floor(px + Math.cos(angle) * dist);
    const z = Math.floor(pz + Math.sin(angle) * dist);
    if (!this.host.world.isLoadedAt(x, z)) return false;

    const y = this.findSpawnY(x, z, Math.floor(py));
    if (y < 0) return false;

    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const sky = this.host.world.getSkyLightAt(bx, y, bz);
    const block = this.host.world.getBlockLightAt(bx, y, bz);
    if (hostile) {
      const dark = block < 8 && sky < 8;
      const surfaceNight = this.host.isNight && sky < 12;
      if (!dark && !surfaceNight) return false;
      const ddx = x + 0.5 - px;
      const ddz = z + 0.5 - pz;
      if (ddx * ddx + ddz * ddz < HOSTILE_MIN_DIST * HOSTILE_MIN_DIST) return false;
    }

    const type = this.rng.pick(types);
    const e = createMob(type, x + 0.5, y, z + 0.5, this.rng);
    return this.addEntity(e);
  }

  /**
   * Walk down from just above the player to find the first spot with a solid
   * floor and two free blocks of head room above it.
   */
  private findSpawnY(x: number, z: number, referenceY: number): number {
    const bx = Math.floor(x);
    const bz = Math.floor(z);
    const world: World = this.host.world;
    const top = Math.min(world.maxY - 3, referenceY + 12);
    const bottom = Math.max(1, referenceY - 40);
    for (let y = top; y >= bottom; y--) {
      const below = world.getBlockAt(bx, y - 1, bz);
      if (below === 0) continue;
      const def = getBlock(below);
      if (!def.solid || def.liquid) continue;
      if (def.collision === null) continue;
      if (world.isLiquidAt(bx, y, bz) || world.isLiquidAt(bx, y + 1, bz)) continue;
      if (world.isSolidAt(bx, y, bz) || world.isSolidAt(bx, y + 1, bz)) continue;
      return y;
    }
    return -1;
  }

  /* ---------------------------------------------------------------- */
  /* Entity bookkeeping                                                */
  /* ---------------------------------------------------------------- */

  private addEntity(e: Entity): boolean {
    if (this.entities.length >= MAX_ENTITIES) return false;
    this.entities.push(e);
    // the mesh is built lazily in update() once the mob is in visible range
    return true;
  }

  private countKind(kind: string): number {
    let n = 0;
    for (const e of this.entities) if (e.kind === kind) n++;
    return n;
  }

  /** spawn(type, x, y, z) - returns null when the type is unknown or its cap is hit */
  spawn(type: string, x: number, y: number, z: number): Entity | null {
    let e: Entity;
    try {
      e = createMob(type, x, y, z, this.rng);
    } catch {
      return null;
    }
    if (e.kind !== 'projectile') {
      const cap = e.kind === 'hostile' ? MAX_HOSTILE : MAX_PASSIVE;
      if (this.countKind(e.kind) >= cap) return null;
    } else if (this.countKind('projectile') >= MAX_PROJECTILE) {
      return null;
    }
    if (!this.addEntity(e)) return null;

    // build immediately when it lands near the player so it does not pop in
    const p = this.host.player.position;
    if (e.distanceSqTo(p.x, p.y, p.z) < RENDER_SPAWN_RANGE * RENDER_SPAWN_RANGE) {
      e.object3D = e.buildObject();
      this.group.add(e.object3D);
    }
    return e;
  }

  /** Used by projectiles fired by mobs (implements HostMobRegistry). */
  spawnEntity(e: Entity): void {
    if (this.disposed) return;
    if (this.countKind('projectile') >= MAX_PROJECTILE) return;
    if (!this.addEntity(e)) return;
    e.object3D = e.buildObject();
    this.group.add(e.object3D);
  }

  remove(e: Entity): void {
    const i = this.entities.indexOf(e);
    if (i >= 0) this.removeAt(i);
  }

  /** Index-based removal (swap-with-last) used by the update loop. */
  private removeAt(index: number): void {
    const e = this.entities[index];
    if (!e) return;
    const last = this.entities.pop()!;
    if (last !== e) this.entities[index] = last;

    // loot only for a real death, never for a despawn or a sunset cull
    if (e.dead && e.kind !== 'projectile') {
      const handler = (this.host as EntityHost & { dropItems?: EntityDropHandler }).dropItems;
      if (typeof handler === 'function') {
        try {
          handler(e.drops(), e.position.x, e.position.y + e.height * 0.4, e.position.z);
        } catch {
          // a broken loot handler must never stall the mob loop
        }
      }
    }
    e.destroyObject();
  }

  /* ---------------------------------------------------------------- */
  /* Queries                                                           */
  /* ---------------------------------------------------------------- */

  /** returns the closest entity whose AABB the ray from origin along dir hits within maxDist, or null */
  raycast(
    ox: number, oy: number, oz: number,
    dx: number, dy: number, dz: number,
    maxDist: number,
  ): { entity: Entity; distance: number } | null {
    const len = Math.hypot(dx, dy, dz);
    if (len < 1e-6) return null;
    const nx = dx / len;
    const ny = dy / len;
    const nz = dz / len;

    let best: Entity | null = null;
    let bestT = maxDist;
    for (const e of this.entities) {
      if (e.dead) continue;
      const b = e.getBounds();
      const t = rayBox(ox, oy, oz, nx, ny, nz, b.minX, b.minY, b.minZ, b.maxX, b.maxY, b.maxZ, bestT);
      if (t >= 0 && t < bestT) {
        bestT = t;
        best = e;
      }
    }
    return best ? { entity: best, distance: bestT } : null;
  }

  /** every entity within radius of a point */
  near(x: number, y: number, z: number, radius: number): Entity[] {
    const out: Entity[] = [];
    const r2 = radius * radius;
    for (const e of this.entities) {
      if (e.distanceSqTo(x, y, z) <= r2) out.push(e);
    }
    return out;
  }

  /** Closest entity within `radius` (melee / projectile targeting helper). */
  closest(x: number, y: number, z: number, radius: number, skip?: Entity): Entity | null {
    let best: Entity | null = null;
    let bestD = radius * radius;
    for (const e of this.entities) {
      if (e.dead || e === skip) continue;
      const d = e.distanceSqTo(x, y, z);
      if (d <= bestD) {
        bestD = d;
        best = e;
      }
    }
    return best;
  }

  get count(): number {
    return this.entities.length;
  }

  /* ---------------------------------------------------------------- */
  /* Lighting tint                                                     */
  /* ---------------------------------------------------------------- */

  private accumulateTint(e: Entity, wanted: Map<THREE.MeshBasicMaterial, number>): void {
    const mat = e.object3D?.userData.mobMaterial as THREE.MeshBasicMaterial | undefined;
    if (!mat) return;
    const b = this.brightnessAt(e.position.x, e.position.y + e.height * 0.6, e.position.z);
    const cur = wanted.get(mat);
    if (cur === undefined || b < cur) wanted.set(mat, b);
  }

  /** Combined sky + block light as a single 0..1 scalar (the game has no lights). */
  private brightnessAt(x: number, y: number, z: number): number {
    const world = this.host.world;
    const bx = Math.floor(x);
    const by = Math.floor(y);
    const bz = Math.floor(z);
    const sky = world.getSkyLightAt(bx, by, bz) / 15;
    const block = world.getBlockLightAt(bx, by, bz) / 15;
    const day = this.host.dayFactor;
    const lit = Math.max(sky * Math.max(0.06, day), block * 0.94);
    const min = this.host.isNight ? 0.1 : 0.22;
    return Math.max(min, Math.min(1, 0.06 + lit * 0.94));
  }

  /* ---------------------------------------------------------------- */
  /* Persistence                                                       */
  /* ---------------------------------------------------------------- */

  serialize(): unknown[] {
    return this.entities.map((e) => {
      const rec: Record<string, unknown> = {
        type: e.typeName,
        x: e.position.x,
        y: e.position.y,
        z: e.position.z,
        yaw: e.yaw,
        health: e.health,
        age: e.age,
        vx: e.velocity.x,
        vy: e.velocity.y,
        vz: e.velocity.z,
      };
      const owner = (e as Entity & { ownerId?: number }).ownerId;
      if (typeof owner === 'number') rec.ownerId = owner;
      return rec;
    });
  }

  deserialize(data: unknown[]): void {
    for (let i = this.entities.length - 1; i >= 0; i--) this.removeAt(i);
    this.entities.length = 0;
    // a fresh population must not inherit the smoothed tint of the old one
    this.tintState.clear();
    if (!Array.isArray(data)) return;
    for (const raw of data) {
      if (!raw || typeof raw !== 'object') continue;
      const rec = raw as Record<string, unknown>;
      const type = typeof rec.type === 'string' ? rec.type : null;
      if (!type) continue;
      const x = num(rec.x, 0);
      const y = num(rec.y, 0);
      const z = num(rec.z, 0);
      let e: Entity;
      try {
        e = createMob(type, x, y, z, this.rng);
      } catch {
        continue;
      }
      e.yaw = num(rec.yaw, 0);
      e.age = num(rec.age, 0);
      e.health = Math.max(1, num(rec.health, e.maxHealth));
      e.velocity.set(num(rec.vx, 0), num(rec.vy, 0), num(rec.vz, 0));
      if (this.entities.length < MAX_ENTITIES) this.entities.push(e);
    }
  }

  /* ---------------------------------------------------------------- */
  /* Teardown                                                          */
  /* ---------------------------------------------------------------- */

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const e of this.entities) e.destroyObject();
    this.entities.length = 0;
    this.group.clear();
    this.tintState.clear();
    unregisterHostRegistry(this.host);
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function num(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

/**
 * Slab ray/AABB test. Returns the entry distance along the (already normalised)
 * ray, or -1 when it misses or the entry lies beyond `maxT`.
 */
function rayBox(
  ox: number, oy: number, oz: number,
  dx: number, dy: number, dz: number,
  minX: number, minY: number, minZ: number,
  maxX: number, maxY: number, maxZ: number,
  maxT: number,
): number {
  let tmin = 0;
  let tmax = maxT;

  const axes: [number, number, number, number][] = [
    [ox, dx, minX, maxX],
    [oy, dy, minY, maxY],
    [oz, dz, minZ, maxZ],
  ];
  for (const [origin, dir, lo, hi] of axes) {
    if (Math.abs(dir) < 1e-8) {
      if (origin < lo || origin > hi) return -1;
      continue;
    }
    const inv = 1 / dir;
    let t1 = (lo - origin) * inv;
    let t2 = (hi - origin) * inv;
    if (t1 > t2) {
      const tmp = t1;
      t1 = t2;
      t2 = tmp;
    }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return -1;
  }
  return tmin;
}
