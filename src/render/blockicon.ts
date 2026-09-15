/**
 * Small standalone geometry builder for a single block.
 *
 * Used by the held-item view model and by the inventory icon renderer. It emits
 * the same vertex attributes the terrain shader expects so a block preview looks
 * exactly like the block does in the world.
 */

import * as THREE from 'three';
import type { Atlas } from './atlas.js';
import type { BlockDef } from '../world/blocks.js';

/** +X, -X, +Y, -Y, +Z, -Z, bottom-left first, counter-clockwise from outside. */
const FACE_CORNERS: [number, number, number][][] = [
  [[1, 0, 1], [1, 0, 0], [1, 1, 0], [1, 1, 1]],
  [[0, 0, 0], [0, 0, 1], [0, 1, 1], [0, 1, 0]],
  [[0, 1, 1], [1, 1, 1], [1, 1, 0], [0, 1, 0]],
  [[0, 0, 0], [1, 0, 0], [1, 0, 1], [0, 0, 1]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  [[1, 0, 0], [0, 0, 0], [0, 1, 0], [1, 1, 0]],
];

function faceTexture(def: BlockDef, faceIndex: number): string {
  const t = def.tex;
  if (faceIndex === 2) return t.top ?? t.all ?? t.side ?? t.sprite ?? 'stone';
  if (faceIndex === 3) return t.bottom ?? t.all ?? t.side ?? t.sprite ?? 'stone';
  if (faceIndex === 5) return t.north ?? t.side ?? t.all ?? t.sprite ?? 'stone';
  if (faceIndex === 4) return t.south ?? t.side ?? t.all ?? t.sprite ?? 'stone';
  if (faceIndex === 0) return t.east ?? t.side ?? t.all ?? t.sprite ?? 'stone';
  return t.west ?? t.side ?? t.all ?? t.sprite ?? 'stone';
}

/**
 * Per-face brightness ramp, indexed the same way as `FACE_CORNERS`
 * (+X, -X, +Y, -Y, +Z, -Z). This is the mesher's own `FACE_SHADE`, so a cube
 * built here can be given exactly the shading it would have in the world.
 */
export const FACE_SHADE = [0.62, 0.62, 1.0, 0.5, 0.82, 0.82];

export function buildBlockIconGeometry(
  atlas: Atlas,
  def: BlockDef,
  size = 1,
  brightness = 1,
  /**
   * Optional six-entry per-face shade ramp. Omitting it keeps the original
   * behaviour (every face at `brightness`), which is what the dropped-item
   * entities and the diagnostic tooling rely on.
   */
  faceShade?: readonly number[] | null,
): THREE.BufferGeometry {
  const positions: number[] = [];
  const uvs: number[] = [];
  const colors: number[] = [];
  const light: number[] = [];
  const indices: number[] = [];
  const h = size / 2;
  const boxes = def.render === 'box' && def.box ? def.box : null;

  for (let f = 0; f < 6; f++) {
    const rect = atlas.uv(faceTexture(def, f));
    // Indexed defensively rather than with `?? 1`: a ramp that is too short would
    // otherwise be a "right operand is never nullish" type error.
    const faceLight = faceShade && f < faceShade.length ? faceShade[f] : 1;
    const shade = faceShade ? brightness * faceLight : brightness;
    const base = positions.length / 3;
    const corners = FACE_CORNERS[f];
    for (let c = 0; c < 4; c++) {
      let [cx, cy, cz] = corners[c];
      let px = (cx - 0.5) * size;
      let py = (cy - 0.5) * size;
      let pz = (cz - 0.5) * size;
      if (boxes) {
        px = ((cx === 0 ? boxes[0] : boxes[3]) - 0.5) * size;
        py = ((cy === 0 ? boxes[1] : boxes[4]) - 0.5) * size;
        pz = ((cz === 0 ? boxes[2] : boxes[5]) - 0.5) * size;
      }
      positions.push(px, py, pz);
      uvs.push(c === 0 || c === 3 ? rect.u0 : rect.u1, c === 0 || c === 1 ? rect.v0 : rect.v1);
      colors.push(shade, shade, shade, 1);
      light.push(1, 0);
    }
    indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  }
  void h;

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(colors, 4));
  geo.setAttribute('aLight', new THREE.Float32BufferAttribute(light, 2));
  geo.setIndex(indices);
  geo.computeBoundingSphere();
  return geo;
}
