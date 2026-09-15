/**
 * Concrete mobs.
 *
 * Mobs come from a *species table* (stats, hitbox, drops, movement style) plus a
 * small class hierarchy for the genuinely different behaviours:
 *
 *   Mob
 *   ├─ PassiveMob   wander / idle / flee after being hurt
 *   ├─ HostileMob   chase + melee, ranged kiting, or the creeper's fuse
 *   └─ ArrowMob     the skeleton projectile
 *
 * The visual side lives in `models.ts` (box rigs + procedural pixel atlases);
 * this file owns stats, AI and the procedural animation that drives the rigs.
 */

import * as THREE from 'three';
import { World } from '../world/world.js';
import { getBlock } from '../world/blocks.js';
import { CHUNK_Y } from '../world/chunk.js';
import { Rng } from '../util/rng.js';
import { Entity, EntityHost, EntityKind, solidId } from './entity.js';
import { buildMobRig } from './models.js';

/* ------------------------------------------------------------------ */
/* Species table                                                       */
/* ------------------------------------------------------------------ */

export type MovementStyle = 'passive' | 'hostile';
export type AttackStyle = 'none' | 'melee' | 'ranged' | 'explode';

export interface MobSpec {
  type: string;
  /** rig/tile key in models.ts (defaults to `type`) */
  model: string;
  kind: EntityKind;
  movement: MovementStyle;
  attack: AttackStyle;
  width: number;
  height: number;
  health: number;
  /** blocks per second while wandering */
  speed: number;
  /** blocks per second while chasing / fleeing (defaults to speed * 1.35) */
  chaseSpeed?: number;
  drops: [string, number][];
  /** melee / projectile damage */
  damage: number;
  attackCooldown: number;
  /** hostile: distance at which the mob gives up */
  followRange: number;
  /** ranged: preferred stand-off distance window */
  keepMin?: number;
  keepMax?: number;
  /** ranged: projectile speed in blocks/second */
  arrowSpeed?: number;
  /** explosion parameters (creeper) */
  fuse?: number;
  blastRadius?: number;
  /** damage per second while standing in direct daylight */
  daylightDamage?: number;
}

export const SPECS: Record<string, MobSpec> = {
  /* ---- passive ---- */
  pig: {
    type: 'pig', model: 'pig', kind: 'passive', movement: 'passive', attack: 'none',
    width: 0.9, height: 0.9, health: 10, speed: 1.15, drops: [['porkchop', 1]],
    damage: 0, attackCooldown: 1, followRange: 0,
  },
  cow: {
    type: 'cow', model: 'cow', kind: 'passive', movement: 'passive', attack: 'none',
    width: 0.9, height: 1.4, health: 10, speed: 1.05, drops: [['beef', 1], ['leather', 1]],
    damage: 0, attackCooldown: 1, followRange: 0,
  },
  sheep: {
    type: 'sheep', model: 'sheep', kind: 'passive', movement: 'passive', attack: 'none',
    width: 0.9, height: 1.3, health: 8, speed: 1.15, drops: [['mutton', 1], ['white_wool', 1]],
    damage: 0, attackCooldown: 1, followRange: 0,
  },
  chicken: {
    type: 'chicken', model: 'chicken', kind: 'passive', movement: 'passive', attack: 'none',
    width: 0.4, height: 0.7, health: 4, speed: 0.95, drops: [['chicken', 1], ['feather', 1]],
    damage: 0, attackCooldown: 1, followRange: 0,
  },

  /* ---- hostile ---- */
  zombie: {
    type: 'zombie', model: 'zombie', kind: 'hostile', movement: 'hostile', attack: 'melee',
    width: 0.6, height: 1.95, health: 20, speed: 1.1, chaseSpeed: 2.45,
    drops: [['rotten_flesh', 1]], damage: 3, attackCooldown: 1.0, followRange: 24,
    daylightDamage: 1.0,
  },
  skeleton: {
    type: 'skeleton', model: 'skeleton', kind: 'hostile', movement: 'hostile', attack: 'ranged',
    width: 0.6, height: 1.95, health: 20, speed: 1.1, chaseSpeed: 2.3,
    drops: [['bone', 2], ['arrow', 2]], damage: 4, attackCooldown: 2.0, followRange: 26,
    keepMin: 6, keepMax: 10, arrowSpeed: 22, daylightDamage: 1.0,
  },
  spider: {
    type: 'spider', model: 'spider', kind: 'hostile', movement: 'hostile', attack: 'melee',
    width: 1.4, height: 0.9, health: 16, speed: 1.6, chaseSpeed: 4.5,
    drops: [['string', 1]], damage: 2, attackCooldown: 1.0, followRange: 22,
  },
  creeper: {
    type: 'creeper', model: 'creeper', kind: 'hostile', movement: 'hostile', attack: 'explode',
    width: 0.6, height: 1.7, health: 20, speed: 1.0, chaseSpeed: 2.4,
    drops: [['gunpowder', 1]], damage: 0, attackCooldown: 1.0, followRange: 26,
    fuse: 1.5, blastRadius: 3,
  },
};

export const PASSIVE_TYPES: string[] = Object.keys(SPECS).filter((k) => SPECS[k].kind === 'passive');
export const HOSTILE_TYPES: string[] = Object.keys(SPECS).filter((k) => SPECS[k].kind === 'hostile');

/* ------------------------------------------------------------------ */
/* Host-scoped registry                                                */
/* ------------------------------------------------------------------ */

/**
 * Entities only ever receive an `EntityHost`, but a skeleton needs to *add* an
 * arrow and every projectile needs to collide with the other entities. The
 * manager registers itself against the host identity here, which keeps
 * `mobs.ts` free of a circular import back to `mobmanager.ts`.
 */
export interface HostMobRegistry {
  near(x: number, y: number, z: number, radius: number): Entity[];
  spawnEntity(e: Entity): void;
}

const hostRegistry = new Map<EntityHost, HostMobRegistry>();

export function registerHostRegistry(host: EntityHost, registry: HostMobRegistry): void {
  hostRegistry.set(host, registry);
}

export function unregisterHostRegistry(host: EntityHost): void {
  hostRegistry.delete(host);
}

/** Look up the manager registered for a host (also used by `mobmanager.ts`). */
export function registryFor(host: EntityHost): HostMobRegistry | undefined {
  return hostRegistry.get(host);
}

/* ------------------------------------------------------------------ */
/* Shared mob behaviour                                                */
/* ------------------------------------------------------------------ */

interface RigAnim {
  parts: Map<string, THREE.Object3D>;
  /** leg pivots, each swung about X by its own phase */
  legs: THREE.Object3D[];
  legPhase: number[];
  /** spider shin pivots, swung with the same phase as their parent leg */
  legBones: { bone: THREE.Object3D; phase: number }[];
  arms: THREE.Object3D[];
  head: THREE.Object3D | null;
  wings: THREE.Object3D[];
  walkPhase: number;
  idleTime: number;
  /** cached "is this a spider-style splayed leg" flag per leg */
  splayed: boolean;
}

export abstract class Mob extends Entity {
  readonly spec: MobSpec;
  /** 0..1 "make it flash" signal; the manager consumes it while tinting */
  hurtFlash = 0;

  protected anim: RigAnim | null = null;

  /** peak downward speed since leaving the ground, for fall damage */
  private fallPeak = 0;
  private wasOnGround = true;
  private lavaTimer = 0;
  private sunTimer = 0;
  private lastSunlit = false;

  /* navigation bookkeeping shared by both archetypes */
  protected targetX = 0;
  protected targetY = 0;
  protected targetZ = 0;
  protected hasTarget = false;

  constructor(spec: MobSpec, x: number, y: number, z: number) {
    super(spec.kind, spec.type, x, y, z);
    this.spec = spec;
    this.width = spec.width;
    this.height = spec.height;
    this.health = spec.health;
    this.maxHealth = spec.health;
  }

  override drops(): [string, number][] {
    return this.spec.drops;
  }

  buildObject(): THREE.Object3D {
    const rig = buildMobRig(this.spec.model);
    this.anim = this.describeRig(rig.parts);
    rig.root.position.copy(this.position);
    rig.root.rotation.y = this.yaw;
    // the manager reads these back to tint / batch without walking the graph
    rig.root.userData.mobMaterial = rig.material;
    rig.root.userData.mobType = this.spec.model;
    return rig.root;
  }

  /** Caches the animated joints of the generated rig. */
  protected describeRig(parts: Map<string, THREE.Object3D>): RigAnim {
    const legs: THREE.Object3D[] = [];
    const legPhase: number[] = [];
    const arms: THREE.Object3D[] = [];
    const wings: THREE.Object3D[] = [];
    const legBones: { bone: THREE.Object3D; phase: number }[] = [];
    let splayed = false;

    // four-legged diagonal gait: front-right with back-left, etc.
    const quad: [string, number][] = [['legFR', 0], ['legFL', Math.PI], ['legBR', Math.PI], ['legBL', 0]];
    for (const [n, phase] of quad) {
      const p = parts.get(n);
      if (!p) continue;
      legs.push(p);
      legPhase.push(phase + this.rng.range(0, 0.6));
    }
    // bipeds
    for (const [n, phase] of [['legR', 0], ['legL', Math.PI]] as [string, number][]) {
      const p = parts.get(n);
      if (!p) continue;
      legs.push(p);
      legPhase.push(phase);
    }
    // spiders: eight two-segment legs, phasing row by row so the body ripples
    for (let i = 0; i < 4; i++) {
      for (const suffix of ['R', 'L']) {
        const upper = parts.get(`leg${i}${suffix}`);
        if (!upper) continue;
        const sign = suffix === 'R' ? 1 : -1;
        const phase = (i % 2 === 0 ? 0 : Math.PI) + (sign > 0 ? 0 : Math.PI);
        upper.rotation.z = sign * 0.95;   // splay outwards
        legs.push(upper);
        legPhase.push(phase);
        splayed = true;
        const lower = parts.get(`shin${i}${suffix}`);
        if (lower) {
          lower.rotation.z = -sign * 0.85; // knee bend
          legBones.push({ bone: lower, phase });
        }
      }
    }
    for (const n of ['armR', 'armL']) {
      const p = parts.get(n);
      if (p) arms.push(p);
    }
    for (const n of ['wingR', 'wingL']) {
      const p = parts.get(n);
      if (p) wings.push(p);
    }

    return {
      parts,
      legs,
      legPhase,
      legBones,
      arms,
      head: parts.get('head') ?? null,
      wings,
      walkPhase: this.rng.range(0, Math.PI * 2),
      idleTime: this.rng.range(0, 10),
      splayed,
    };
  }

  /* ---------------------------------------------------------------- */
  /* Tick plumbing                                                     */
  /* ---------------------------------------------------------------- */

  override tick(dt: number, host: EntityHost): void {
    this.age += dt;
    if (this.hurtTime > 0) this.hurtTime -= dt;
    if (this.attackCooldown > 0) this.attackCooldown -= dt;
    if (this.hurtFlash > 0) this.hurtFlash = Math.max(0, this.hurtFlash - dt * 3.2);

    if (this.dead) {
      this.deathTime += dt;
      this.velocity.x *= 0.82;
      this.velocity.z *= 0.82;
      this.moveWithCollision(dt, host.world);
      if (this.deathTime > 1.15 && this.removeAt < 0) this.removeAt = this.age;
      return;
    }

    this.environmentTick(dt, host);
    if (this.dead) return;
    this.think(dt, host);
    if (this.dead) return;
    this.moveWithCollision(dt, host.world);
    this.fallTick(host);
  }

  /** Subclass behaviour hook; runs before movement integration. */
  protected abstract think(dt: number, host: EntityHost): void;

  /** Shared environment effects: lava, daylight burning. */
  protected environmentTick(dt: number, host: EntityHost): void {
    const feet = getBlock(host.world.getBlockAt(
      Math.floor(this.position.x),
      Math.floor(this.position.y + 0.2),
      Math.floor(this.position.z),
    ));
    if (feet.name === 'lava') {
      this.lavaTimer += dt;
      if (this.lavaTimer > 0.5) {
        this.lavaTimer = 0;
        this.rawDamage(2, host);
        if (this.dead) return;
      }
    } else {
      this.lavaTimer = 0;
    }

    const lit = this.spec.daylightDamage ? this.exposedToSky(host.world, host) : false;
    if (lit) {
      if (!this.lastSunlit) host.playSound(this.spec.type + '_burn', 0.4, 1, this.position);
      this.sunTimer += dt * (this.spec.daylightDamage ?? 1);
      if (this.sunTimer >= 1) {
        this.sunTimer -= 1;
        host.spawnParticles('smoke', this.position.x, this.position.y + this.height * 0.8, this.position.z, 4);
        // sunlight is lethal but never drops loot: cull instead of dying
        if (this.health <= 1.5) this.removeAt = this.age;
        else this.rawDamage(1, host);
      }
    } else {
      this.sunTimer = 0;
    }
    this.lastSunlit = lit;
  }

  /** Damage that ignores knockback (environmental sources). */
  protected rawDamage(amount: number, host: EntityHost): void {
    if (this.dead) return;
    this.health -= amount;
    this.hurtFlash = Math.max(this.hurtFlash, 0.8);
    host.spawnParticles('damage', this.position.x, this.position.y + this.height * 0.6, this.position.z, 3);
    if (this.health <= 0) this.die(host);
  }

  /** Looks straight up for an unobstructed sky column (used for daylight burns). */
  protected exposedToSky(world: World, host: EntityHost): boolean {
    if (host.isNight || host.dayFactor < 0.6) return false;
    const x = Math.floor(this.position.x);
    const z = Math.floor(this.position.z);
    for (let y = Math.floor(this.position.y + this.height); y < CHUNK_Y; y++) {
      const id = world.getBlockAt(x, y, z);
      if (id === 0) continue;
      const def = getBlock(id);
      if (def.opaque) return false;
      if (def.name === 'water') return false;
    }
    return true;
  }

  private fallTick(host: EntityHost): void {
    if (this.onGround) {
      if (!this.wasOnGround && this.fallPeak > 13) {
        const dmg = Math.floor((this.fallPeak - 13) / 4);
        if (dmg > 0 && !this.dead) this.rawDamage(dmg, host);
      }
      this.fallPeak = 0;
    } else if (this.velocity.y < 0) {
      this.fallPeak = Math.max(this.fallPeak, -this.velocity.y);
    }
    this.wasOnGround = this.onGround;
  }

  /* ---------------------------------------------------------------- */
  /* Targeting helpers                                                 */
  /* ---------------------------------------------------------------- */

  protected playerDistance(host: EntityHost): number {
    const p = host.player.position;
    const dx = p.x - this.position.x;
    const dz = p.z - this.position.z;
    const dy = (p.y + 1 - this.position.y) * 0.5;
    return Math.hypot(dx, dy, dz);
  }

  protected startFlee(sourceX: number, sourceZ: number, seconds: number): void {
    this.hasTarget = true;
    this.targetX = this.position.x + (this.position.x - sourceX) * 3;
    this.targetY = this.position.y;
    this.targetZ = this.position.z + (this.position.z - sourceZ) * 3;
    this.fleeTimer = seconds;
  }

  protected fleeTimer = 0;

  override hurt(amount: number, sourceX: number, sourceZ: number, host: EntityHost, knockback = 0.35): boolean {
    const killed = super.hurt(amount, sourceX, sourceZ, host, knockback);
    if (!this.dead) {
      this.hurtFlash = 1;
      this.startFlee(sourceX, sourceZ, 3.2);
    }
    return killed;
  }

  /* ---------------------------------------------------------------- */
  /* Procedural animation                                              */
  /* ---------------------------------------------------------------- */

  override animate(dt: number, host: EntityHost): void {
    void host;
    const rig = this.anim;
    const obj = this.object3D;
    if (!rig || !obj) return;

    obj.position.copy(this.position);

    if (this.dead) {
      // fall over: tip onto the side, then shrink out
      const t = Math.min(1, this.deathTime / 0.7);
      const eased = 1 - (1 - t) * (1 - t);
      obj.rotation.set(eased * (Math.PI / 2) * 0.92, this.yaw, 0);
      obj.position.y = this.position.y - eased * this.height * 0.3;
      const sink = this.deathTime > 0.95 ? Math.max(0.15, 1 - (this.deathTime - 0.95) / 0.35) : 1;
      obj.scale.setScalar(sink);
      return;
    }

    obj.rotation.set(0, this.yaw, 0);
    obj.scale.setScalar(1);

    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    rig.idleTime += dt;
    if (speed > 0.05) rig.walkPhase += dt * (1.9 + speed * 2.2);

    const amp = Math.min(0.95, speed * 0.34);
    for (let i = 0; i < rig.legs.length; i++) {
      const swing = Math.sin(rig.walkPhase + rig.legPhase[i]) * amp;
      // spider legs keep their splay in Z; everything else swings flat in X
      rig.legs[i].rotation.x = swing * (rig.splayed ? 0.8 : 1);
    }
    for (const b of rig.legBones) {
      b.bone.rotation.x = Math.sin(rig.walkPhase + b.phase + 0.6) * amp * 0.7;
    }
    for (const arm of rig.arms) {
      arm.rotation.x = this.armAngle() + Math.sin(rig.walkPhase * 0.5) * 0.05 * (amp + 0.2);
    }
    for (const w of rig.wings) {
      const flap = speed < 0.5 ? 0.08 : 0.8;
      w.rotation.z = Math.sin(rig.walkPhase * 6.5) * flap;
    }
    if (rig.head) {
      rig.head.rotation.y = Math.sin(rig.idleTime * 0.6) * 0.12;
      rig.head.rotation.x = Math.sin(rig.idleTime * 0.43 + 1.3) * 0.05 + this.headPitch();
    }
  }

  /** Resting arm angle for bipeds (zombies reach forward). */
  protected armAngle(): number {
    return 0;
  }

  /** Extra head pitch while aiming. */
  protected headPitch(): number {
    return 0;
  }

  protected stopMoving(dt: number): void {
    this.velocity.x *= Math.max(0, 1 - 9 * dt);
    this.velocity.z *= Math.max(0, 1 - 9 * dt);
  }
}

/* ------------------------------------------------------------------ */
/* Passive mobs                                                        */
/* ------------------------------------------------------------------ */

export class PassiveMob extends Mob {
  private wanderTimer = 0;

  protected think(dt: number, host: EntityHost): void {
    const speed = this.spec.speed;

    if (this.fleeTimer > 0) {
      this.fleeTimer -= dt;
      this.pathTo(dt, host.world, this.targetX, this.targetY, this.targetZ, speed * 1.9);
      return;
    }

    this.wanderTimer -= dt;
    const reached = this.hasTarget &&
      Math.hypot(this.targetX - this.position.x, this.targetZ - this.position.z) < 0.9;

    if (this.wanderTimer <= 0 || !this.hasTarget || reached) {
      if (this.rng.chance(0.28)) {
        // stand and graze for a moment
        this.hasTarget = false;
        this.wanderTimer = this.rng.range(1.5, 3.5);
      } else {
        const angle = this.rng.range(0, Math.PI * 2);
        const radius = this.rng.range(3, 9);
        const tx = this.position.x + Math.cos(angle) * radius;
        const tz = this.position.z + Math.sin(angle) * radius;
        const gy = this.surfaceY(host.world, tx, tz, this.position.y, 5);
        this.targetX = tx;
        this.targetY = gy >= 0 ? gy : this.position.y;
        this.targetZ = tz;
        this.hasTarget = true;
        this.wanderTimer = this.rng.range(3, 7);
      }
    }

    if (!this.hasTarget) {
      this.stopMoving(dt);
      return;
    }
    this.pathTo(dt, host.world, this.targetX, this.targetY, this.targetZ, speed);
  }
}

/* ------------------------------------------------------------------ */
/* Hostile mobs                                                        */
/* ------------------------------------------------------------------ */

export class HostileMob extends Mob {
  private fuse = -1;
  private fusePointX = 0;
  private fusePointZ = 0;
  private wanderTimer = 0;
  private armSwing = 0;
  private aimPitch = 0;
  private strafeDir = 1;
  private strafeTimer = 0;
  private lostTimer = 0;

  protected think(dt: number, host: EntityHost): void {
    const player = host.player;

    // a creeper mid-fuse commits to exploding
    if (this.fuse >= 0) {
      this.fuse -= dt;
      this.hurtFlash = Math.max(this.hurtFlash, this.fuse % 0.3 < 0.15 ? 1 : 0.2);
      if (this.fuse <= 0) {
        this.explode(host);
        return;
      }
      const moved = Math.hypot(player.position.x - this.fusePointX, player.position.z - this.fusePointZ);
      if (moved > 6) this.fuse = -1; // the player escaped: disarm
      else {
        const speed = this.spec.chaseSpeed ?? this.spec.speed * 1.35;
        this.pathTo(dt, host.world, player.position.x, player.position.y, player.position.z, speed);
        if (this.armSwing > 0) this.armSwing -= dt;
        return;
      }
    }

    const dist = this.playerDistance(host);
    if (host.difficulty === 0 || dist > this.spec.followRange) {
      // out of interest range: go back to wandering
      this.lostTimer -= dt;
      this.wander(dt, host);
      return;
    }
    this.lostTimer = 3;

    switch (this.spec.attack) {
      case 'ranged':
        this.rangedAttack(dt, host, dist);
        break;
      case 'explode':
        this.creeperApproach(dt, host, dist);
        break;
      default:
        this.meleeAttack(dt, host, dist);
        break;
    }
    if (this.armSwing > 0) this.armSwing -= dt;
  }

  protected override armAngle(): number {
    const lunge = this.armSwing > 0 ? this.armSwing / 0.35 : 0;
    if (this.spec.type === 'zombie') return -1.42 - lunge * 0.5;
    if (this.spec.attack === 'ranged') return -1.5 + (1 - lunge) * 0.6;
    return -0.7 * lunge;
  }

  protected override headPitch(): number {
    return this.spec.attack === 'ranged' ? -this.aimPitch * 0.6 : 0;
  }

  /** Fuse progress 0..1, or -1 when no fuse is lit (used by the manager). */
  get fuseProgress(): number {
    const total = this.spec.fuse ?? 1.5;
    return this.fuse < 0 ? -1 : 1 - this.fuse / total;
  }

  private wander(dt: number, host: EntityHost): void {
    this.wanderTimer -= dt;
    if (this.wanderTimer <= 0 || !this.hasTarget) {
      const angle = this.rng.range(0, Math.PI * 2);
      const radius = this.rng.range(2, 7);
      const tx = this.position.x + Math.cos(angle) * radius;
      const tz = this.position.z + Math.sin(angle) * radius;
      const gy = this.surfaceY(host.world, tx, tz, this.position.y, 5);
      this.targetX = tx;
      this.targetY = gy >= 0 ? gy : this.position.y;
      this.targetZ = tz;
      this.hasTarget = true;
      this.wanderTimer = this.rng.range(2, 5);
    }
    this.pathTo(dt, host.world, this.targetX, this.targetY, this.targetZ, this.spec.speed);
  }

  private meleeAttack(dt: number, host: EntityHost, dist: number): void {
    const player = host.player;
    const speed = this.spec.chaseSpeed ?? this.spec.speed * 1.35;
    this.pathTo(dt, host.world, player.position.x, player.position.y, player.position.z, speed);

    // the AABB of a mob and the player may touch but not overlap, so the melee
    // reach is "edge of my box" + "edge of the player's box" + a small margin
    const reach = 1.0 + this.width * 0.5 + 0.45;
    if (dist <= reach && this.attackCooldown <= 0 && Math.abs(player.position.y - this.position.y) < 2.4 && !player.dead) {
      player.damage(this.spec.damage, this.position.x, this.position.z, 0.4);
      host.playSound('player_hurt', 0.6, 1, player.position);
      this.attackCooldown = this.spec.attackCooldown;
      this.armSwing = 0.35;
    }
  }

  private rangedAttack(dt: number, host: EntityHost, dist: number): void {
    const player = host.player;
    const keepMin = this.spec.keepMin ?? 6;
    const keepMax = this.spec.keepMax ?? 10;
    const speed = this.spec.chaseSpeed ?? this.spec.speed * 1.35;

    if (dist < keepMin) {
      const dx = this.position.x - player.position.x;
      const dz = this.position.z - player.position.z;
      const len = Math.hypot(dx, dz) || 1;
      this.steerTo(dt, host.world, this.position.x + (dx / len) * 3, this.position.z + (dz / len) * 3, speed);
    } else if (dist > keepMax) {
      this.pathTo(dt, host.world, player.position.x, player.position.y, player.position.z, speed);
    } else {
      this.stopMoving(dt);
      this.strafeTimer -= dt;
      if (this.strafeTimer <= 0) {
        this.strafeDir = this.rng.chance(0.5) ? 1 : -1;
        this.strafeTimer = this.rng.range(1, 2.5);
      }
      const dx = player.position.x - this.position.x;
      const dz = player.position.z - this.position.z;
      const len = Math.hypot(dx, dz) || 1;
      // sidestep so the skeleton is not a static target
      this.velocity.x += (-dz / len) * this.strafeDir * 0.6;
      this.velocity.z += (dx / len) * this.strafeDir * 0.6;
      this.faceTowards(dt, dx / len, dz / len, 6);
    }

    const aimY = player.position.y + player.eyeHeight - 0.25;
    this.aimPitch = this.aimAt(player.position.x, aimY, player.position.z);
    if (this.attackCooldown <= 0 && dist <= keepMax + 2 && dist >= keepMin - 3) {
      this.fireArrow(host, player.position.x, aimY, player.position.z);
      this.attackCooldown = this.spec.attackCooldown;
      this.armSwing = 0.35;
    }
  }

  /** Launch angle (radians) needed to hit a point with the species projectile speed. */
  protected aimAt(tx: number, ty: number, tz: number): number {
    const speed = this.spec.arrowSpeed ?? 22;
    const dy = ty - this.eyeY();
    const horiz = Math.max(0.4, Math.hypot(tx - this.position.x, tz - this.position.z));
    const g = 22;
    const v2 = speed * speed;
    const root = v2 * v2 - g * (g * horiz * horiz + 2 * dy * v2);
    if (root < 0) return Math.atan2(dy, horiz); // out of range: just aim straight
    return Math.atan((v2 - Math.sqrt(root)) / (g * horiz));
  }

  protected fireArrow(host: EntityHost, tx: number, ty: number, tz: number): void {
    const speed = this.spec.arrowSpeed ?? 22;
    const ox = this.position.x;
    const oy = this.eyeY() - 0.15;
    const oz = this.position.z;
    const pitch = this.aimAt(tx, ty, tz);
    const horiz = Math.hypot(tx - ox, tz - oz) || 1;
    const nx = (tx - ox) / horiz;
    const nz = (tz - oz) / horiz;

    const arrow = new ArrowMob(ox + nx * 0.6, oy, oz + nz * 0.6, this.spec.damage, this.id);
    arrow.velocity.set(
      nx * Math.cos(pitch) * speed,
      Math.sin(pitch) * speed,
      nz * Math.cos(pitch) * speed,
    );
    arrow.yaw = this.yaw;
    arrow.buildObject();
    const registry = registryFor(host);
    if (registry) registry.spawnEntity(arrow);
    host.playSound('arrow_shoot', 0.55, 1.1, this.position);
  }

  /* ---- creeper ---- */

  private creeperApproach(dt: number, host: EntityHost, dist: number): void {
    const player = host.player;
    const speed = this.spec.chaseSpeed ?? this.spec.speed * 1.35;
    if (dist > 2.2) {
      this.pathTo(dt, host.world, player.position.x, player.position.y, player.position.z, speed);
      return;
    }
    if (this.fuse < 0) {
      this.fuse = this.spec.fuse ?? 1.5;
      this.fusePointX = player.position.x;
      this.fusePointZ = player.position.z;
      host.playSound('creeper_hiss', 0.9, 1, this.position);
    }
    this.stopMoving(dt);
    this.faceTowards(dt, player.position.x - this.position.x, player.position.z - this.position.z, 6);
  }

  private explode(host: EntityHost): void {
    const radius = this.spec.blastRadius ?? 3;
    const world = host.world;
    const originX = this.position.x;
    const originY = this.position.y + this.height * 0.4;
    const originZ = this.position.z;
    const cx = Math.floor(originX);
    const cy = Math.floor(originY);
    const cz = Math.floor(originZ);
    const r2 = radius * radius;
    const inner = (radius - 1.1) * (radius - 1.1);

    for (let y = cy - radius; y <= cy + radius; y++) {
      for (let z = cz - radius; z <= cz + radius; z++) {
        for (let x = cx - radius; x <= cx + radius; x++) {
          const dx = x + 0.5 - originX;
          const dy = y + 0.5 - originY;
          const dz = z + 0.5 - originZ;
          const d2 = dx * dx + dy * dy + dz * dz;
          if (d2 > r2) continue;
          const id = world.getBlockAt(x, y, z);
          if (id === 0) continue;
          const def = getBlock(id);
          // bedrock / portal frames survive, liquids are left alone
          if (def.hardness < 0 || def.liquid) continue;
          // ragged shell instead of a perfect sphere
          if (d2 > inner && this.rng.chance(0.35)) continue;
          world.setBlock(x, y, z, 0);
        }
      }
    }

    host.spawnParticles('explosion', originX, originY, originZ, 26);
    host.playSound('explosion', 1, 1, this.position);

    const player = host.player;
    const pd = Math.hypot(
      player.position.x - originX,
      player.position.y + 0.9 - originY,
      player.position.z - originZ,
    );
    const blastReach = radius * 2.4;
    if (pd < blastReach && !player.dead) {
      const dmg = Math.max(1, Math.round((1 - pd / blastReach) * 14));
      player.damage(dmg, originX, originZ, 1.1);
      host.playSound('player_hurt', 0.7, 1, player.position);
    }

    // the shockwave also shoves nearby mobs around
    const registry = registryFor(host);
    if (registry) {
      for (const other of registry.near(originX, originY, originZ, blastReach)) {
        if (other === this || other.dead) continue;
        const od = Math.hypot(other.position.x - originX, other.position.z - originZ);
        if (od > blastReach) continue;
        other.hurt(Math.max(1, Math.round((1 - od / blastReach) * 9)), originX, originZ, host, 0.9);
      }
    }

    this.health = 0;
    this.dead = true;
    this.deathTime = 0;
    this.fuse = -1;
    this.removeAt = this.age;
    host.spawnParticles('smoke', originX, originY, originZ, 12);
  }
}

/* ------------------------------------------------------------------ */
/* Skeleton arrow                                                      */
/* ------------------------------------------------------------------ */

/** Spawn delay before an arrow can hit anything (stops it shooting itself). */
const ARROW_ARM_TIME = 0.05;

/** Skeleton projectile: 4 damage, gravity, despawns after 4s or on impact. */
export class ArrowMob extends Entity {
  readonly damage: number;
  readonly ownerId: number;
  private life = 0;
  private stuck = false;
  private stuckTimer = 0;

  constructor(x: number, y: number, z: number, damage = 4, ownerId = 0) {
    super('projectile', 'arrow', x, y, z);
    this.damage = damage;
    this.ownerId = ownerId;
    this.width = 0.2;
    this.height = 0.2;
    this.health = 1;
    this.maxHealth = 1;
  }

  override drops(): [string, number][] {
    return [['arrow', 1]];
  }

  buildObject(): THREE.Object3D {
    const rig = buildMobRig('arrow');
    rig.root.position.copy(this.position);
    rig.root.userData.mobMaterial = rig.material;
    rig.root.userData.mobType = 'arrow';
    return rig.root;
  }

  override tick(dt: number, host: EntityHost): void {
    this.age += dt;
    this.life += dt;

    if (this.stuck) {
      this.stuckTimer += dt;
      if (this.stuckTimer > 1.5 || this.life > 4) this.removeAt = this.age;
      return;
    }
    if (this.life > 4) {
      this.removeAt = this.age;
      return;
    }

    this.pitch = Math.atan2(-this.velocity.y, Math.hypot(this.velocity.x, this.velocity.z));

    // Integrate manually rather than through moveWithCollision: an arrow should
    // stop dead in the block it hits and stay there, not slide along the face.
    const nx = this.position.x + this.velocity.x * dt;
    const ny = this.position.y + this.velocity.y * dt;
    const nz = this.position.z + this.velocity.z * dt;
    if (
      this.blocksAt(host.world, nx, this.position.y, this.position.z) ||
      this.blocksAt(host.world, this.position.x, ny, this.position.z) ||
      this.blocksAt(host.world, this.position.x, this.position.y, nz)
    ) {
      this.stuck = true;
      this.velocity.set(0, 0, 0);
      return;
    }
    this.position.set(nx, ny, nz);
    this.yaw = Math.atan2(-this.velocity.x, -this.velocity.z);

    if (this.life > ARROW_ARM_TIME) {
      if (this.hitPlayer(host, nx, ny, nz)) return;
      if (this.hitEntities(host, nx, ny, nz)) return;
    }

    this.velocity.y -= 22 * dt;
    if (this.velocity.y < -60) this.velocity.y = -60;
  }

  private blocksAt(world: World, x: number, y: number, z: number): boolean {
    return solidId(world.getBlockAt(Math.floor(x), Math.floor(y), Math.floor(z)));
  }

  private hitPlayer(host: EntityHost, x: number, y: number, z: number): boolean {
    const p = host.player;
    if (p.dead || p.gameMode === 'creative') return false;
    const px = p.position.x;
    const py = p.position.y + p.height * 0.5;
    const pz = p.position.z;
    if (Math.hypot(x - px, y - py, z - pz) > 0.8) return false;
    p.damage(this.damage, this.position.x - this.velocity.x, this.position.z - this.velocity.z, 0.3);
    host.playSound('player_hurt', 0.7, 1, p.position);
    this.removeAt = this.age;
    host.spawnParticles('crit', x, y, z, 4);
    return true;
  }

  private hitEntities(host: EntityHost, x: number, y: number, z: number): boolean {
    const registry = registryFor(host);
    if (!registry) return false;
    for (const e of registry.near(x, y, z, 1.5)) {
      if (e.dead || e.id === this.ownerId || e.kind === 'projectile') continue;
      const b = e.getBounds();
      if (x < b.minX - 0.25 || x > b.maxX + 0.25) continue;
      if (y < b.minY - 0.25 || y > b.maxY + 0.25) continue;
      if (z < b.minZ - 0.25 || z > b.maxZ + 0.25) continue;
      e.hurt(this.damage, this.position.x, this.position.z, host, 0.3);
      this.removeAt = this.age;
      host.spawnParticles('crit', x, y, z, 4);
      return true;
    }
    return false;
  }

  override animate(dt: number, host: EntityHost): void {
    void dt;
    void host;
    const obj = this.object3D;
    if (!obj) return;
    obj.position.copy(this.position);
    // arrow geometry points along -Z, so yaw then pitch orients it along the shot
    obj.rotation.set(0, this.yaw, 0);
    obj.rotateX(this.pitch);
  }
}

/* ------------------------------------------------------------------ */
/* Factory                                                             */
/* ------------------------------------------------------------------ */

export function createMob(type: string, x: number, y: number, z: number, rng?: Rng): Entity {
  const spec = SPECS[type];
  if (!spec) throw new Error(`unknown mob type "${type}"`);
  const mob: Mob = spec.kind === 'passive'
    ? new PassiveMob(spec, x, y, z)
    : new HostileMob(spec, x, y, z);
  mob.installRng(rng ?? new Rng((Math.random() * 0xffffffff) >>> 0));
  return mob;
}

/** Item drops for a type without instantiating it. */
export function dropsForType(type: string): [string, number][] {
  return SPECS[type]?.drops ?? [];
}
