/**
 * Player entity: movement, voxel collision, swimming, camera and survival stats.
 *
 * Collision uses a swept AABB resolved one axis at a time with exact snapping to
 * the blocking face, which avoids the clipping that naive "revert the move"
 * resolution produces when sliding along walls.
 */

import * as THREE from 'three';
import type { World } from '../world/world.js';
import { getBlock, B, isLiquid } from '../world/blocks.js';
import { CHUNK_Y, SEA_LEVEL } from '../world/chunk.js';

export type GameMode = 'survival' | 'creative';

const EPS = 1e-3;

/**
 * Upward impulse for a jump, in blocks per second.
 *
 * Against gravity 30 this clears 8.6^2 / 60 = 1.23 blocks, i.e. a one-block step
 * with a little headroom. The same impulse is reused to leave the water, so a
 * surface hop clears a bank by the same margin.
 */
const JUMP_SPEED = 8.6;

export interface PlayerInputState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
}

export class Player {
  readonly position = new THREE.Vector3(0, 80, 0);
  readonly velocity = new THREE.Vector3();
  yaw = 0;
  pitch = 0;

  width = 0.6;
  height = 1.8;
  eyeHeight = 1.62;
  reach = 4.5;

  onGround = false;
  inWater = false;
  headInWater = false;
  inLava = false;
  sneaking = false;
  sprinting = false;
  flying = false;

  gameMode: GameMode = 'survival';
  health = 20;
  maxHealth = 20;
  hunger = 20;
  saturation = 5;
  air = 300;
  maxAir = 300;
  dead = false;
  damageFlash = 0;
  invulnerable = 0;

  /** distance accumulated for camera bob / footsteps */
  walkDistance = 0;
  bobPhase = 0;

  /**
   * Whether the surface jump-out is available. Armed by being submerged, spent
   * by the hop, so skimming the surface cannot be turned into walking on it.
   */
  private waterHopArmed = false;

  /** Seconds left of a launch out of water, during which water does not brake. */
  private waterExitBoost = 0;
  private fallStartY = 0;
  private wasOnGround = false;

  /** swing animation state for the held item */
  swing = 0;
  swingActive = false;

  readonly spawnPoint = new THREE.Vector3();

  get eyeY(): number {
    return this.position.y + this.eyeHeight - (this.sneaking ? 0.22 : 0);
  }

  setSpawn(x: number, y: number, z: number): void {
    this.spawnPoint.set(x, y, z);
    this.position.set(x, y, z);
    this.velocity.set(0, 0, 0);
  }

  respawn(): void {
    this.position.copy(this.spawnPoint);
    this.velocity.set(0, 0, 0);
    this.health = this.maxHealth;
    this.hunger = 20;
    this.saturation = 5;
    this.air = this.maxAir;
    this.dead = false;
    this.invulnerable = 1.5;
  }

  /** seconds until the next cactus contact damage tick */
  private cactusTimer = 0;

  /**
   * True when the player's body is pressed against a cactus.
   *
   * Uses the player's half-width plus a hair, because block collision stops the
   * body exactly at 0.3 from the face - so testing the bare hitbox lands a
   * fraction of a millimetre outside the block and standing pressed against a
   * cactus would never hurt. The original damages on contact, and walking past
   * at any distance does not, which is what this reproduces.
   */
  private touchingCactus(world: World): boolean {
    const r = 0.3 + 0.02;
    const x0 = Math.floor(this.position.x - r);
    const x1 = Math.floor(this.position.x + r);
    const z0 = Math.floor(this.position.z - r);
    const z1 = Math.floor(this.position.z + r);
    const y0 = Math.floor(this.position.y + 0.05);
    const y1 = Math.floor(this.position.y + this.height - 0.05);
    for (let y = y0; y <= y1; y++) {
      for (let z = z0; z <= z1; z++) {
        for (let x = x0; x <= x1; x++) {
          if (world.getBlockAt(x, y, z) === B.cactus) return true;
        }
      }
    }
    return false;
  }

  damage(amount: number, sourceX = 0, sourceZ = 0, knockback = 0): void {
    if (this.dead || this.invulnerable > 0 || this.gameMode === 'creative') return;
    this.health = Math.max(0, this.health - amount);
    this.damageFlash = Math.min(1, this.damageFlash + 0.65);
    this.invulnerable = 0.4;
    if (knockback > 0) {
      const dx = this.position.x - sourceX;
      const dz = this.position.z - sourceZ;
      const len = Math.hypot(dx, dz) || 1;
      this.velocity.x += (dx / len) * knockback;
      this.velocity.z += (dz / len) * knockback;
      this.velocity.y = Math.max(this.velocity.y, 3.4);
    }
    if (this.health <= 0) this.dead = true;
  }

  /* ---------------------------------------------------------------- */
  /* Collision                                                         */
  /* ---------------------------------------------------------------- */

  private halfX(): number {
    return this.width / 2;
  }

  /** True when the player's AABB overlaps any solid block. */
  intersects(world: World, px = this.position.x, py = this.position.y, pz = this.position.z): boolean {
    const hw = this.halfX();
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
          if (!def.solid) continue;
          const col = def.collision;
          if (col === null) continue;
          if (col) {
            // boxes narrower than a full block need a real AABB test
            const bx0 = x + col[0];
            const bx1 = x + col[3];
            const by0 = y + col[1];
            const by1 = y + col[4];
            const bz0 = z + col[2];
            const bz1 = z + col[5];
            if (
              px + hw > bx0 && px - hw < bx1 &&
              py + this.height > by0 && py < by1 &&
              pz + hw > bz0 && pz - hw < bz1
            ) {
              return true;
            }
          } else {
            return true;
          }
        }
      }
    }
    return false;
  }

  private moveAxis(world: World, axis: 'x' | 'y' | 'z', amount: number): boolean {
    if (amount === 0) return false;
    const start = this.position[axis];
    let remaining = amount;
    let blocked = false;
    // sub-step to prevent tunnelling at high speed
    while (Math.abs(remaining) > 1e-6) {
      const step = Math.max(-0.4, Math.min(0.4, remaining));
      remaining -= step;
      const before = this.position[axis];
      this.position[axis] = before + step;
      if (this.intersects(world)) {
        if (axis === 'y') {
          if (step > 0) {
            this.position.y = Math.floor(this.position.y + this.height) - this.height - EPS;
          } else {
            this.position.y = Math.floor(this.position.y) + 1 + EPS;
          }
        } else {
          const hw = this.halfX();
          if (step > 0) {
            this.position[axis] = Math.floor(this.position[axis] + hw) - hw - EPS;
          } else {
            this.position[axis] = Math.floor(this.position[axis] - hw) + 1 + hw + EPS;
          }
        }
        blocked = true;
        break;
      }
    }
    if (blocked) {
      // give back any unspent motion on this axis
      this.position[axis] = this.position[axis];
    }
    void start;
    return blocked;
  }

  /* ---------------------------------------------------------------- */
  /* Update                                                            */
  /* ---------------------------------------------------------------- */

  update(world: World, input: PlayerInputState, dt: number): void {
    if (this.invulnerable > 0) this.invulnerable -= dt;
    if (this.damageFlash > 0) this.damageFlash = Math.max(0, this.damageFlash - dt * 1.6);

    const headBlock = world.getBlockAt(
      Math.floor(this.position.x),
      Math.floor(this.position.y + this.eyeHeight),
      Math.floor(this.position.z),
    );    const feetBlock = world.getBlockAt(Math.floor(this.position.x), Math.floor(this.position.y + 0.2), Math.floor(this.position.z));
    this.inWater = isLiquid(feetBlock) && getBlock(feetBlock).name === 'water';
    this.headInWater = getBlock(headBlock).name === 'water';
    this.inLava = getBlock(feetBlock).name === 'lava';

    this.sneaking = input.sneak && !this.flying;
    this.sprinting = input.sprint && (input.forward || input.back || input.left || input.right) && !this.sneaking;

    const speed = this.flying
      ? (input.sprint ? 22 : 11)
      : this.inWater
        ? 2.6
        : this.sneaking
          ? 1.35
          : this.sprinting
            ? 5.7
            : 4.3;

    // desired horizontal direction in world space
    let fx = 0;
    let fz = 0;
    if (input.forward) fz -= 1;
    if (input.back) fz += 1;
    if (input.left) fx -= 1;
    if (input.right) fx += 1;
    const len = Math.hypot(fx, fz);
    if (len > 0) {
      fx /= len;
      fz /= len;
    }
    // Convert the local move vector into world space.
    //   forward = (-sin(yaw), 0, -cos(yaw))   right = (cos(yaw), 0, -sin(yaw))
    // `fz` is -1 for forward and +1 for back, `fx` is +1 for right.
    const cos = Math.cos(this.yaw);
    const sin = Math.sin(this.yaw);
    const dirX = fx * cos + fz * sin;
    const dirZ = -fx * sin + fz * cos;

    const accel = this.onGround || this.flying ? 12 : 4;
    const targetX = dirX * speed;
    const targetZ = dirZ * speed;
    const blend = Math.min(1, accel * dt);
    this.velocity.x += (targetX - this.velocity.x) * blend;
    this.velocity.z += (targetZ - this.velocity.z) * blend;
    if (len === 0 && (this.onGround || this.flying)) {
      this.velocity.x *= Math.max(0, 1 - 14 * dt);
      this.velocity.z *= Math.max(0, 1 - 14 * dt);
    }

    if (this.flying) {
      const flySpeed = 8;
      this.velocity.y = 0;
      if (input.jump) this.velocity.y = flySpeed;
      else if (input.sneak) this.velocity.y = -flySpeed;
    } else if (this.inWater) {
      if (this.waterExitBoost > 0) {
        /*
         * Climbing out. The launch impulse takes several frames to lift the
         * player clear, and the water drag below is applied every one of them -
         * at 0.86 a frame it ate most of the impulse and left the player peaking
         * at 0.6 of a block, still short of the bank they were trying to reach.
         * The water you are leaving should not be braking you.
         */
        this.waterExitBoost -= dt;
      } else {
        this.velocity.y -= 8 * dt;
        this.velocity.y *= 0.86;
      }
      if (input.jump) {
        /*
         * Swimming up is deliberately gentle, but a gentle stroke can never get
         * the player out of the water: the old cap of 3.2 m/s against gravity 30
         * only lifts about 0.17 of a block, so a one-block bank was unclimbable
         * and the player just bobbed at the surface forever.
         *
         * At the surface - feet in water, the block above them clear - a full
         * jump impulse is applied instead, which is what lets you hop out onto
         * land. Underwater the gentle stroke is kept.
         *
         * Arming is by "there is a bank here", not by being submerged.
         *
         * Requiring the head to be under was too strict - a swimmer at the
         * surface, the exact position you climb out from, has their head in air,
         * so the hop could never fire and a bank became unclimbable again.
         * Gating on horizontal speed instead was not enough either: water drag
         * slows a skimmer below any threshold within a few frames and re-arms
         * them, so they still crossed the sea.
         *
         * What is actually true of climbing out is that there is something to
         * climb onto. In open water no horizontal neighbour is solid, so no
         * launch is offered and you swim; at a shore there is a block beside
         * you, so you can pull yourself up it.
         */
        const fx = Math.floor(this.position.x);
        const fz = Math.floor(this.position.z);
        const fy = Math.floor(this.position.y);
        let bank = false;
        for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as [number, number][]) {
          if (this.blocksMovement(world.getBlockAt(fx + dx, fy, fz + dz))) {
            bank = true;
            break;
          }
        }
        if (bank) this.waterHopArmed = true;
        const aboveFeet = world.getBlockAt(
          Math.floor(this.position.x),
          Math.floor(this.position.y + 1.2),
          Math.floor(this.position.z),
        );
        const atSurface = !isLiquid(aboveFeet) && getBlock(aboveFeet).name !== 'water';
        if (atSurface) {
          if (this.waterHopArmed) {
            this.waterHopArmed = false;
            this.waterExitBoost = 0.32;
            if (this.velocity.y < JUMP_SPEED) this.velocity.y = JUMP_SPEED;
          }
        } else {
          this.velocity.y = Math.min(3.2, this.velocity.y + 26 * dt);
        }
      }
      this.velocity.x *= 0.94;
      this.velocity.z *= 0.94;
    } else if (this.inLava) {
      this.velocity.y -= 6 * dt;
      this.velocity.y *= 0.72;
      if (input.jump) this.velocity.y = Math.min(1.6, this.velocity.y + 16 * dt);
    } else {
      this.velocity.y -= 30 * dt;
      if (this.velocity.y < -78) this.velocity.y = -78;
      if (input.jump && this.onGround) {
        this.velocity.y = JUMP_SPEED;
        this.onGround = false;
      }
    }

    // integrate with per-axis collision resolution
    const prevY = this.position.y;
    this.moveAxis(world, 'x', this.velocity.x * dt);
    this.moveAxis(world, 'z', this.velocity.z * dt);
    if (this.velocity.x !== 0 && this.intersects(world)) this.velocity.x = 0;
    this.moveAxis(world, 'y', this.velocity.y * dt);

    const wasFalling = this.velocity.y < 0;
    this.onGround = this.intersects(world, this.position.x, this.position.y - 0.02, this.position.z) && this.velocity.y <= 0.001;
    if (this.onGround) {
      this.velocity.y = 0;
      if (!this.wasOnGround) {
        // fallStartY tracks the highest point reached while airborne, so the
        // drop distance is peak minus landing height.
        const fall = this.fallStartY - this.position.y;
        if (wasFalling && fall > 3.2 && !this.inWater && this.gameMode === 'survival') {
          const dmg = Math.floor(fall - 3);
          if (dmg > 0) this.damage(dmg);
        }
      }
      this.fallStartY = this.position.y;
    } else {
      // airborne: remember the peak so the drop distance is measured correctly
      this.fallStartY = Math.max(this.fallStartY, this.position.y);
    }

    if (this.position.y < -8) {
      if (this.gameMode === 'survival') this.damage(4);
      else this.position.y = 90;
      if (this.position.y < -20) this.position.y = 90;
    }
    void prevY;

    // camera bob + footstep distance
    const horizSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.onGround && horizSpeed > 0.4) {
      this.walkDistance += horizSpeed * dt;
      this.bobPhase += horizSpeed * dt * 2.1;
    } else {
      this.bobPhase += dt * 0.6;
    }

    // survival: hunger, drowning, lava, regeneration
    if (this.gameMode === 'survival' && !this.dead) {
      this.hunger = Math.max(0, this.hunger - dt * (this.sprinting ? 0.045 : 0.018));
      if (this.headInWater) {
        this.air -= dt * 60;
        if (this.air < 0) {
          this.air = 0;
          if (Math.random() < dt * 1.6) this.damage(2);
        }
      } else {
        this.air = Math.min(this.maxAir, this.air + dt * 180);
      }
      /*
       * Cactus contact damage.
       *
       * The block was defined and generated but nothing ever checked whether the
       * player was standing against one, so walking into a cactus was harmless.
       * In the original it deals half a heart every half second on contact, and
       * only to a body actually overlapping it - the block's own collision box
       * is inset, so brushing past along a path does not hurt.
       */
      if (this.touchingCactus(world)) {
        this.cactusTimer -= dt;
        if (this.cactusTimer <= 0) {
          this.cactusTimer = 0.5;
          this.damage(1);
        }
      } else {
        this.cactusTimer = 0;
      }
      if (this.inLava) {
        if (Math.random() < dt * 5) this.damage(3);
      } else if (this.position.y > 0 && world.getBlockAt(Math.floor(this.position.x), Math.floor(this.position.y), Math.floor(this.position.z)) === B.lava) {
        if (Math.random() < dt * 5) this.damage(3);
      }
      // slow regeneration when well fed
      if (this.hunger > 16 && this.health < this.maxHealth) {
        if (Math.random() < dt * 0.25) {
          this.health = Math.min(this.maxHealth, this.health + 1);
          this.hunger = Math.max(0, this.hunger - 0.4);
        }
      }
      // starvation at zero hunger
      if (this.hunger <= 0 && this.health > 1 && Math.random() < dt * 0.12) {
        this.health = Math.max(1, this.health - 1);
      }
    }

    if (this.swingActive) {
      this.swing += dt * 4.6;
      if (this.swing >= 1) {
        this.swing = 0;
        this.swingActive = false;
      }
    }
    // last line of defence: never leave the camera buried inside a block
    this.unstick(world, dt);
    this.wasOnGround = this.onGround;
  }

  startSwing(): void {
    if (!this.swingActive) {
      this.swingActive = true;
      this.swing = 0;
    }
  }

  /** Direction the player is looking. */
  lookDir(out = new THREE.Vector3()): THREE.Vector3 {
    const cp = Math.cos(this.pitch);
    return out.set(-Math.sin(this.yaw) * cp, Math.sin(this.pitch), -Math.cos(this.yaw) * cp).normalize();
  }

  eyePosition(out = new THREE.Vector3()): THREE.Vector3 {
    return out.set(this.position.x, this.eyeY, this.position.z);
  }

  /**
   * Place the player on top of the terrain near (x, z).
   *
   * A naive "highest solid block" scan can drop the player inside a tree canopy,
   * a cliff overhang or deep water, which leaves the camera buried in geometry
   * and the whole screen dark. This spirals outward looking for a column that is
   * actually standable - solid ground with two blocks of clear air above it and
   * no liquid - and only falls back to carving if nothing is found.
   */
  placeOnGround(world: World, x: number, z: number): void {
    const baseX = Math.floor(x);
    const baseZ = Math.floor(z);
    for (let r = 0; r <= 8; r++) {
      const steps = r === 0 ? 1 : Math.max(8, r * 8);
      for (let i = 0; i < steps; i++) {
        const a = (i / steps) * Math.PI * 2;
        const tx = baseX + Math.round(Math.cos(a) * r);
        const tz = baseZ + Math.round(Math.sin(a) * r);
        const y = this.findStandableY(world, tx, tz);
        if (y < 0) continue;
        this.position.set(tx + 0.5, y + 0.02, tz + 0.5);
        this.velocity.set(0, 0, 0);
        this.fallStartY = this.position.y;
        this.onGround = true;
        return;
      }
    }
    // Nothing usable nearby (e.g. mid-ocean): float at the surface.
    this.position.set(baseX + 0.5, SEA_LEVEL + 3, baseZ + 0.5);
    this.velocity.set(0, 0, 0);
    this.fallStartY = this.position.y;
  }

  /**
   * The y a player can stand at in this column, or -1 when there is none.
   * Requires solid, non-liquid ground with two blocks of air above, and refuses
   * to stand on lava.
   */
  private findStandableY(world: World, x: number, z: number): number {
    for (let y = CHUNK_Y - 4; y > 1; y--) {
      const ground = world.getBlockAt(x, y, z);
      if (ground === 0) continue;
      const gdef = getBlock(ground);
      if (!gdef.solid || gdef.liquid) continue;
      if (gdef.name === 'lava' || gdef.name === 'magma') continue;
      const a1 = world.getBlockAt(x, y + 1, z);
      const a2 = world.getBlockAt(x, y + 2, z);
      if (this.blocksMovement(a1) || this.blocksMovement(a2)) continue;
      if (getBlock(a1).liquid || getBlock(a2).liquid) continue;
      return y + 1;
    }
    return -1;
  }

  private blocksMovement(id: number): boolean {
    if (id === 0) return false;
    const d = getBlock(id);
    if (!d.solid) return false;
    return d.collision !== null;
  }

  /**
   * Emergency rescue: if the camera ends up buried (a world edit, a bad spawn or
   * a teleport into rock), lift the player out instead of leaving them staring at
   * the inside of a block.
   */
  private unstick(world: World, dt: number): void {
    const ex = Math.floor(this.position.x);
    const ez = Math.floor(this.position.z);
    /*
     * Test the player's body against the blocks' collision boxes, not against
     * the cells they occupy.
     *
     * The old check asked whether the block in the player's cell blocks movement,
     * which is a different question. A fence's collider is only a quarter of a
     * block wide, so a player can stand inside the fence's cell without touching
     * it at all - and the check still reported "buried", lifting them 3.2 blocks
     * a second. That is why walking into a fence climbed it like a ladder.
     */
    const buried = this.bodyOverlapsBlock(world, ex, ez);
    if (!buried) {
      this.stuckTimer = 0;
      return;
    }
    this.stuckTimer += dt;
    // rise out of the block
    this.position.y += dt * 3.2;
    this.velocity.set(0, 0, 0);
    if (this.stuckTimer > 2.5) {
      this.stuckTimer = 0;
      const y = this.findStandableY(world, ex, ez);
      if (y > 0) this.position.set(ex + 0.5, y + 0.02, ez + 0.5);
      else this.placeOnGround(world, this.position.x, this.position.z);
    }
  }

  /**
   * True when the player's box actually intersects a collidable block.
   *
   * Sweeps the cells the body spans and intersects each against its own
   * collision box, so a thin collider the player is merely standing beside does
   * not count.
   */
  private bodyOverlapsBlock(world: World, cx: number, cz: number): boolean {
    const hw = 0.3;
    const y0 = this.position.y;
    const y1 = this.position.y + this.height;
    for (let y = Math.floor(y0); y <= Math.floor(y1 - 1e-4); y++) {
      for (let z = Math.floor(this.position.z - hw); z <= Math.floor(this.position.z + hw); z++) {
        for (let x = Math.floor(this.position.x - hw); x <= Math.floor(this.position.x + hw); x++) {
          const def = getBlock(world.getBlockAt(x, y, z));
          if (!def.solid) continue;
          // A null collision box means the full unit cube, which is how every
          // ordinary block is defined - skipping those was why a player buried
          // in stone was no longer rescued.
          const box = def.collision ?? [0, 0, 0, 1, 1, 1];
          const [bx0, by0, bz0, bx1, by1, bz1] = box;
          if (
            this.position.x + hw > x + bx0 &&
            this.position.x - hw < x + bx1 &&
            this.position.z + hw > z + bz0 &&
            this.position.z - hw < z + bz1 &&
            y1 > y + by0 &&
            y0 < y + by1
          ) {
            return true;
          }
        }
      }
    }
    void cx;
    void cz;
    return false;
  }

  private stuckTimer = 0;

  /**
   * Public entry point for the rescue above, used by the game right after a
   * spawn or a save load.
   */
  rescueIfBuried(world: World): boolean {
    const ex = Math.floor(this.position.x);
    const ez = Math.floor(this.position.z);
    const eyeBlock = world.getBlockAt(ex, Math.floor(this.eyeY), ez);
    const feetBlock = world.getBlockAt(ex, Math.floor(this.position.y + 0.1), ez);
    if (!this.blocksMovement(eyeBlock) && !this.blocksMovement(feetBlock)) return false;
    const y = this.findStandableY(world, ex, ez);
    if (y > 0) {
      this.position.set(ex + 0.5, y + 0.02, ez + 0.5);
      this.velocity.set(0, 0, 0);
      this.fallStartY = this.position.y;
      return true;
    }
    this.placeOnGround(world, this.position.x, this.position.z);
    return true;
  }
}
