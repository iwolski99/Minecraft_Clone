/**
 * Voxel raycasting (Amanatides & Woo grid traversal).
 * Used for block targeting - picking, breaking and placing - and for mob
 * line-of-sight checks.
 */

import type { World } from '../world/world.js';

export interface RayHit {
  /** the solid block that was hit */
  x: number;
  y: number;
  z: number;
  /** face normal of the hit block */
  nx: number;
  ny: number;
  nz: number;
  id: number;
  distance: number;
  /** the empty cell in front of the hit face (where a block would be placed) */
  px: number;
  py: number;
  pz: number;
}

export function raycastVoxels(
  world: World,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  hitTest: (id: number) => boolean,
): RayHit | null {
  let x = Math.floor(ox);
  let y = Math.floor(oy);
  let z = Math.floor(oz);

  const stepX = dx > 0 ? 1 : -1;
  const stepY = dy > 0 ? 1 : -1;
  const stepZ = dz > 0 ? 1 : -1;

  const tDeltaX = dx === 0 ? Infinity : Math.abs(1 / dx);
  const tDeltaY = dy === 0 ? Infinity : Math.abs(1 / dy);
  const tDeltaZ = dz === 0 ? Infinity : Math.abs(1 / dz);

  const xBound = dx > 0 ? x + 1 - ox : ox - x;
  const yBound = dy > 0 ? y + 1 - oy : oy - y;
  const zBound = dz > 0 ? z + 1 - oz : oz - z;

  let tMaxX = dx === 0 ? Infinity : xBound * tDeltaX;
  let tMaxY = dy === 0 ? Infinity : yBound * tDeltaY;
  let tMaxZ = dz === 0 ? Infinity : zBound * tDeltaZ;

  let nx = 0;
  let ny = 0;
  let nz = 0;
  let t = 0;

  // the origin cell counts as a hit when the camera is inside a block
  const startId = world.getBlockAt(x, y, z);
  if (startId !== 0 && hitTest(startId)) {
    return { x, y, z, nx: 0, ny: 1, nz: 0, id: startId, distance: 0, px: x, py: y, pz: z };
  }

  for (let i = 0; i < 512; i++) {
    if (tMaxX < tMaxY && tMaxX < tMaxZ) {
      x += stepX;
      t = tMaxX;
      tMaxX += tDeltaX;
      nx = -stepX;
      ny = 0;
      nz = 0;
    } else if (tMaxY < tMaxZ) {
      y += stepY;
      t = tMaxY;
      tMaxY += tDeltaY;
      nx = 0;
      ny = -stepY;
      nz = 0;
    } else {
      z += stepZ;
      t = tMaxZ;
      tMaxZ += tDeltaZ;
      nx = 0;
      ny = 0;
      nz = -stepZ;
    }
    if (t > maxDistance) return null;
    const id = world.getBlockAt(x, y, z);
    if (id !== 0 && hitTest(id)) {
      return { x, y, z, nx, ny, nz, id, distance: t, px: x + nx, py: y + ny, pz: z + nz };
    }
  }
  return null;
}
