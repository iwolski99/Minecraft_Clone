/**
 * Held-item view model and the block selection / breaking overlay.
 *
 * Both live in their own scene that is drawn after the world with the depth
 * buffer cleared, so the held item can never intersect terrain.
 *
 * ## How the held item is built
 *
 * There is no hand-authored model per item. The held item is *generated from its
 * sprite*: every opaque texel of the 16x16 item sprite becomes a small box in a
 * shallow slab, faces that touch another solid texel are culled, the front plate
 * is chamfered, and the whole thing is flat-shaded per face direction exactly
 * like a block in the world.
 *
 * That gives real depth and visible side faces for a pickaxe, a stick, an apple
 * or a bucket without a single line of per-item data - the silhouette in the
 * sprite *is* the model. The side and back faces sample the same atlas texel the
 * front face does and are darkened through `aColor`, so an item's edge carries
 * the local material colour (wood grain on a handle, steel on a blade) rather
 * than one flat average tint.
 */

import * as THREE from 'three';
import type { Atlas } from './atlas.js';
import { getBlock } from '../world/blocks.js';
import { buildBlockIconGeometry, FACE_SHADE } from './blockicon.js';
import { ITEM_TILE } from './itemTextures.js';

const VIEW_VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec2 aLight;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vLight;
void main() {
  vUv = uv;
  vColor = aColor;
  vLight = aLight;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}
`;

/**
 * `vColor.rgb` carries the per-face shade (see `ITEM_FACE_SHADE`), so the front
 * face shows the sprite exactly as painted while the sides and the back come out
 * a step darker and the slab reads as a solid object instead of a decal.
 * `uLight` is the sky/block light at the player's eye, so the extrusion stays
 * legible in a cave (the game floors that light, never lets it reach zero).
 */
const VIEW_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uLight;
uniform float uAlphaTest;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vLight;
void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < uAlphaTest) discard;
  gl_FragColor = vec4(t.rgb * vColor.rgb * uLight, t.a);
}
`;

/* ------------------------------------------------------------------ */
/* Extruded-sprite geometry                                            */
/* ------------------------------------------------------------------ */

/**
 * Shade per face of the generated slab, applied through `aColor`.
 *
 * Index order matches `FACE_CORNERS` in blockicon.ts: +X, -X, +Y, -Y, +Z, -Z.
 * The front (+Z) stays at 1.0 so the sprite is shown exactly as painted, which
 * is the whole point of the texture work; the other five are darkened so the
 * silhouette has a lit side and a shadowed side. The relative steps follow the
 * mesher's `FACE_SHADE` ramp so a held block and a held pickaxe agree.
 */
export const ITEM_FACE_SHADE = [0.74, 0.60, 0.90, 0.48, 1.0, 0.62];

/** The mesher's own block ramp (blockicon.ts `FACE_SHADE`), reused for held blocks. */
export const BLOCK_FACE_SHADE = FACE_SHADE;

export interface ItemModelOptions {
  /** Size of the sprite's 16x16 cell, in world units. */
  size?: number;
  /** Slab thickness in sprite texels. The classic item is two texels thick. */
  thicknessTexels?: number;
  /** Chamfer width on the front edge, in sprite texels. 0 disables the bevel. */
  bevelTexels?: number;
  /** Alpha at or above which a texel counts as part of the silhouette. */
  alphaCutoff?: number;
}

interface Builder {
  positions: number[];
  uvs: number[];
  colors: number[];
  light: number[];
  indices: number[];
}

type Vec3 = readonly [number, number, number];
type Vec2 = readonly [number, number];

/**
 * Push a quad, forcing its winding to face `outward`.
 *
 * Getting winding right by hand for six different face orientations (and for a
 * chamfer that is not axis-aligned at all) is exactly the kind of thing that
 * silently renders an inside-out slab. Computing the normal and reversing the
 * order when it points the wrong way removes the guesswork.
 */
function pushQuad(
  b: Builder,
  p0: Vec3, p1: Vec3, p2: Vec3, p3: Vec3,
  t0: Vec2, t1: Vec2, t2: Vec2, t3: Vec2,
  shade: number,
  outward: Vec3,
): void {
  const ax = p1[0] - p0[0], ay = p1[1] - p0[1], az = p1[2] - p0[2];
  const bx = p2[0] - p0[0], by = p2[1] - p0[1], bz = p2[2] - p0[2];
  const nx = ay * bz - az * by;
  const ny = az * bx - ax * bz;
  const nz = ax * by - ay * bx;
  const face = nx * outward[0] + ny * outward[1] + nz * outward[2] >= 0;

  const base = b.positions.length / 3;
  const ps = face ? [p0, p1, p2, p3] : [p3, p2, p1, p0];
  const ts = face ? [t0, t1, t2, t3] : [t3, t2, t1, t0];
  for (let i = 0; i < 4; i++) {
    b.positions.push(ps[i][0], ps[i][1], ps[i][2]);
    b.uvs.push(ts[i][0], ts[i][1]);
    b.colors.push(shade, shade, shade, 1);
    b.light.push(1, 0);
  }
  b.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
}

/**
 * Build the held-item mesh from an item sprite.
 *
 * Every texel whose alpha clears `alphaCutoff` becomes a column of the slab;
 * only faces that actually border empty space (plus the front and back plates)
 * are emitted, so a 16x16 sprite costs a few hundred triangles, not thousands.
 */
export function buildItemViewGeometry(
  atlas: Atlas,
  itemName: string,
  opts: ItemModelOptions = {},
): THREE.BufferGeometry {
  const size = opts.size ?? 0.42;
  const thickness = Math.max(0.5, opts.thicknessTexels ?? 2);
  const cutoff = opts.alphaCutoff ?? 128;

  const n = ITEM_TILE;
  const t = size / n;
  const half = size / 2;

  // Slab is centred on z = 0 so the pose rotates about the middle of the item.
  const zFront = (thickness * t) / 2;
  const zBack = -zFront;
  // The chamfer may never eat more than 45% of a texel or single-texel features
  // (a sword's crossguard, a wheat stalk) would disappear into the bevel.
  const bevel = Math.max(0, Math.min(opts.bevelTexels ?? 0.34, 0.45)) * t;
  const zChamfer = Math.max(zBack, zFront - bevel);

  const slot = atlas.slot(itemName);
  const mask = new Uint8Array(n * n);
  let solid = 0;
  for (let y = 0; y < n; y++) {
    for (let x = 0; x < n; x++) {
      const c = atlas.texel(slot, x, y);
      if (c[3] >= cutoff) {
        mask[y * n + x] = 1;
        solid++;
      }
    }
  }
  /*
   * A sprite with no opaque texel would extrude to nothing and the hand would
   * look empty. Rather than vanish, fall back to extruding the whole cell: a
   * visible plate of whatever is in that atlas slot is far easier to diagnose
   * than a silently missing item.
   */
  if (solid === 0) mask.fill(1);

  const at = (x: number, y: number): number =>
    x < 0 || y < 0 || x >= n || y >= n ? 0 : mask[y * n + x];

  const tile = atlas.tile;
  const ax = (slot % atlas.cols) * tile;
  const ay = Math.floor(slot / atlas.cols) * tile;
  // Half-texel inset, the same convention `Atlas.uvSlot()` uses. The atlas rows
  // are flipped on upload and every UV in the project is canvas-ordered
  // (`v = 1 - row / height`); this follows that rule per texel.
  const e = 0.02;
  const insetU = e / atlas.width;
  const insetV = e / atlas.height;

  const b: Builder = { positions: [], uvs: [], colors: [], light: [], indices: [] };
  const bevelFrac = t > 0 ? bevel / t : 0;

  for (let ty = 0; ty < n; ty++) {
    for (let tx = 0; tx < n; tx++) {
      if (!mask[ty * n + tx]) continue;

      // world-space cell of this texel (sprite row 0 is the top row)
      const xL = -half + tx * t;
      const xR = xL + t;
      const yT = half - ty * t;
      const yB = yT - t;

      // atlas cell of this texel
      const uL = (ax + tx) / atlas.width + insetU;
      const uR = (ax + tx + 1) / atlas.width - insetU;
      const vT = 1 - ((ay + ty) / atlas.height + insetV);
      const vB = 1 - ((ay + ty + 1) / atlas.height - insetV);

      const openPX = !at(tx + 1, ty);
      const openNX = !at(tx - 1, ty);
      const openPY = !at(tx, ty - 1); // the texel above, i.e. +Y
      const openNY = !at(tx, ty + 1);

      /* --- front plate (always emitted; it is the face the player sees) --- */
      const ixL = xL + (openNX ? bevel : 0);
      const ixR = xR - (openPX ? bevel : 0);
      const iyT = yT - (openPY ? bevel : 0);
      const iyB = yB + (openNY ? bevel : 0);
      const du = (uR - uL) * bevelFrac;
      const dv = (vT - vB) * bevelFrac;
      pushQuad(
        b,
        [ixL, iyB, zFront], [ixR, iyB, zFront], [ixR, iyT, zFront], [ixL, iyT, zFront],
        [uL + (openNX ? du : 0), vB + (openNY ? dv : 0)],
        [uR - (openPX ? du : 0), vB + (openNY ? dv : 0)],
        [uR - (openPX ? du : 0), vT - (openPY ? dv : 0)],
        [uL + (openNX ? du : 0), vT - (openPY ? dv : 0)],
        ITEM_FACE_SHADE[4],
        [0, 0, 1],
      );

      /* --- back plate (seen when the swing rolls the item over) --- */
      pushQuad(
        b,
        [xL, yT, zBack], [xR, yT, zBack], [xR, yB, zBack], [xL, yB, zBack],
        [uR, vT], [uL, vT], [uL, vB], [uR, vB],
        ITEM_FACE_SHADE[5],
        [0, 0, -1],
      );

      /*
       * --- side walls + chamfers, only where the silhouette opens ---
       *
       * Each open edge gets two quads: a wall running back from zChamfer to the
       * back plate (full texel footprint), and a 45-degree chamfer turning that
       * footprint inwards to the inset front plate. Where the neighbour is solid
       * neither exists, so adjacent columns share a seamless front face.
       */
      const uv = { uL, uR, vB, vT };
      if (openPX) {
        sideWall(b, [xR, yB, zChamfer], [xR, yT, zChamfer], zBack, uv, ITEM_FACE_SHADE[0], [1, 0, 0]);
        sideChamfer(b, [xR, yB, zChamfer], [xR, yT, zChamfer], [ixR, iyT, zFront], [ixR, iyB, zFront], uv, ITEM_FACE_SHADE[0], [1, 0, 0]);
      }
      if (openNX) {
        sideWall(b, [xL, yT, zChamfer], [xL, yB, zChamfer], zBack, uv, ITEM_FACE_SHADE[1], [-1, 0, 0]);
        sideChamfer(b, [xL, yT, zChamfer], [xL, yB, zChamfer], [ixL, iyB, zFront], [ixL, iyT, zFront], uv, ITEM_FACE_SHADE[1], [-1, 0, 0]);
      }
      if (openPY) {
        sideWall(b, [xR, yT, zChamfer], [xL, yT, zChamfer], zBack, uv, ITEM_FACE_SHADE[2], [0, 1, 0]);
        sideChamfer(b, [xR, yT, zChamfer], [xL, yT, zChamfer], [ixL, iyT, zFront], [ixR, iyT, zFront], uv, ITEM_FACE_SHADE[2], [0, 1, 0]);
      }
      if (openNY) {
        sideWall(b, [xL, yB, zChamfer], [xR, yB, zChamfer], zBack, uv, ITEM_FACE_SHADE[3], [0, -1, 0]);
        sideChamfer(b, [xL, yB, zChamfer], [xR, yB, zChamfer], [ixR, iyB, zFront], [ixL, iyB, zFront], uv, ITEM_FACE_SHADE[3], [0, -1, 0]);
      }
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(b.positions, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(b.uvs, 2));
  geo.setAttribute('aColor', new THREE.Float32BufferAttribute(b.colors, 4));
  geo.setAttribute('aLight', new THREE.Float32BufferAttribute(b.light, 2));
  geo.setIndex(b.indices);
  geo.computeBoundingSphere();
  geo.computeBoundingBox();
  return geo;
}

/** The four atlas UVs a texel's faces all share. */
interface TexelUv {
  uL: number;
  uR: number;
  vB: number;
  vT: number;
}

/**
 * The straight part of a side face: the texel's full-width edge, run back from
 * where the chamfer starts to the back plate. `edgeA` and `edgeB` are the two
 * ends of that edge (both at `zChamfer`); `outward` is the direction the face
 * looks, which is what fixes its winding.
 */
function sideWall(
  b: Builder,
  edgeA: Vec3,
  edgeB: Vec3,
  zBack: number,
  uv: TexelUv,
  shade: number,
  outward: Vec3,
): void {
  pushQuad(
    b,
    edgeA, edgeB, [edgeB[0], edgeB[1], zBack], [edgeA[0], edgeA[1], zBack],
    [uv.uL, uv.vB], [uv.uR, uv.vB], [uv.uR, uv.vT], [uv.uL, uv.vT],
    shade,
    outward,
  );
}

/** The 45-degree lip that turns the full-size silhouette into the inset front plate. */
function sideChamfer(
  b: Builder,
  edgeA: Vec3,
  edgeB: Vec3,
  frontB: Vec3,
  frontA: Vec3,
  uv: TexelUv,
  shade: number,
  outward: Vec3,
): void {
  pushQuad(
    b,
    edgeA, edgeB, frontB, frontA,
    [uv.uL, uv.vB], [uv.uR, uv.vB], [uv.uR, uv.vT], [uv.uL, uv.vT],
    shade,
    outward,
  );
}

/* ------------------------------------------------------------------ */
/* Pose + animation                                                    */
/* ------------------------------------------------------------------ */

interface Pose {
  pos: THREE.Vector3;
  rot: THREE.Euler;
}

/**
 * Minecraft-ish first-person poses: the item sits low and right of centre, yawed
 * about 45 degrees so a face and an edge are both visible, with a little pitch
 * and roll. The block is turned corner-on so three faces show at once.
 */
const ITEM_POSE: Pose = {
  /*
   * Framing matters more than it looks. At z = -0.72 the visible half-height is
   * about 0.43 units, so the old position (0.52, -0.34) put an item whose own
   * height is 0.42 half off the bottom of the screen: the render showed a
   * pickaxe head with its handle cut away, which reads as a broken model rather
   * than a badly framed one. Sit it lower-right of centre without letting any
   * part of it leave the frame.
   */
  // Further right and lower. The old x sat the item close to the middle of the
  // screen with a wide empty margin to its right, which is exactly where it
  // should be held.
  pos: new THREE.Vector3(0.62, -0.30, -0.72),
  // enough yaw that the extruded side face is visible, not so much that a flat
  // slab is foreshortened away
  rot: new THREE.Euler(-0.06, -0.5, 0.1),
};

const BLOCK_POSE: Pose = {
  pos: new THREE.Vector3(0.50, -0.32, -0.74),
  rot: new THREE.Euler(0.2, -0.72, 0.05),
};

/**
 * Swing shape, 0 -> 1 across the animation.
 *
 * A short wind-up (negative, the item pulls back), then a strike that peaks at
 * ~38% of the return and eases back. The asymmetry is what makes the arc read as
 * a chop; a plain sine reads as a wobble.
 */
export function swingCurve(t: number): number {
  const wind = 0.18;
  if (t <= 0) return 0;
  if (t < wind) return -0.35 * Math.sin((t / wind) * Math.PI);
  const u = Math.min(1, (t - wind) / (1 - wind));
  return Math.sin(Math.pow(u, 0.72) * Math.PI);
}

/* ------------------------------------------------------------------ */
/* The view model                                                      */
/* ------------------------------------------------------------------ */

export class ViewModel {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.PerspectiveCamera;
  private blockMat: THREE.ShaderMaterial;
  private itemMat: THREE.ShaderMaterial;
  private holder = new THREE.Group();
  private blockMesh: THREE.Mesh | null = null;
  private itemMesh: THREE.Mesh | null = null;
  private currentKey = '';
  private pose: Pose = ITEM_POSE;
  private atlas: Atlas;
  private itemAtlas: Atlas;

  constructor(atlas: Atlas, itemAtlas: Atlas, blockTexture: THREE.Texture, itemTexture: THREE.Texture) {
    this.atlas = atlas;
    this.itemAtlas = itemAtlas;
    this.camera = new THREE.PerspectiveCamera(62, 1, 0.01, 12);
    this.blockMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: blockTexture },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uAlphaTest: { value: 0.5 },
      },
      vertexShader: VIEW_VERT,
      fragmentShader: VIEW_FRAG,
      transparent: false,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
    });
    // The item is a closed slab now rather than a single quad, so it no longer
    // needs double-sided blending: an opaque, front-side, depth-writing material
    // sorts correctly and cannot show its own back faces through the front.
    this.itemMat = new THREE.ShaderMaterial({
      uniforms: {
        uMap: { value: itemTexture },
        uLight: { value: new THREE.Color(1, 1, 1) },
        uAlphaTest: { value: 0.5 },
      },
      vertexShader: VIEW_VERT,
      fragmentShader: VIEW_FRAG,
      transparent: false,
      side: THREE.FrontSide,
      depthTest: true,
      depthWrite: true,
    });
    // Yaw outermost: the item is turned towards the camera *after* it is pitched
    // and rolled, which is the order the Minecraft item transform uses.
    this.holder.rotation.order = 'YXZ';
    this.holder.add(new THREE.AmbientLight(0xffffff, 1));
    this.scene.add(this.holder);
  }

  /** Show a block (blockId > 0) or an item sprite (itemName). */
  setHeld(blockId: number, itemName: string | null): void {
    const key = blockId > 0 ? `b${blockId}` : `i${itemName}`;
    if (key === this.currentKey) return;
    this.currentKey = key;
    if (this.blockMesh) {
      this.holder.remove(this.blockMesh);
      this.blockMesh.geometry.dispose();
      this.blockMesh = null;
    }
    if (this.itemMesh) {
      this.holder.remove(this.itemMesh);
      this.itemMesh.geometry.dispose();
      this.itemMesh = null;
    }
    if (blockId > 0) {
      const def = getBlock(blockId);
      // `shadeFaces` gives the held cube the same six-way ramp the mesher gives
      // a block in the world, so a held block and a placed one agree.
      const geo = buildBlockIconGeometry(this.atlas, def, 0.34, 1, BLOCK_FACE_SHADE);
      this.blockMesh = new THREE.Mesh(geo, this.blockMat);
      this.blockMesh.rotation.set(0, 0, 0);
      this.holder.add(this.blockMesh);
      this.blockMesh.visible = true;
      this.pose = BLOCK_POSE;
    } else if (itemName) {
      const geo = buildItemViewGeometry(this.itemAtlas, itemName, {
        // The extrusion follows the sprite's silhouette, so a pickaxe occupies
        // only its own ~13x13 texels where the old flat quad filled the whole
        // cell. Sized up to compensate, or an extruded tool reads smaller than
        // the flat sprite it replaced.
        size: 0.52,
        thicknessTexels: 2,
        bevelTexels: 0.3,
      });
      this.itemMesh = new THREE.Mesh(geo, this.itemMat);
      this.itemMesh.rotation.set(0, 0, 0);
      this.holder.add(this.itemMesh);
      this.pose = ITEM_POSE;
    }
  }

  /** The geometry currently on show, for the QA harness. */
  currentGeometry(): THREE.BufferGeometry | null {
    const mesh = this.blockMesh ?? this.itemMesh;
    return mesh ? mesh.geometry : null;
  }

  /** True when the held thing is the generated item slab rather than a cube. */
  get showingItem(): boolean {
    return this.itemMesh !== null;
  }

  get currentKeyName(): string {
    return this.currentKey;
  }

  update(
    dt: number,
    swing: number,
    swingActive: boolean,
    bobPhase: number,
    bobAmount: number,
    light: THREE.Color,
    aspect: number,
  ): void {
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    (this.blockMat.uniforms.uLight.value as THREE.Color).copy(light);
    (this.itemMat.uniforms.uLight.value as THREE.Color).copy(light);

    // subtle walk bob, plus a roll so the item rocks with the stride
    const bx = Math.sin(bobPhase) * 0.020 * bobAmount;
    const by = Math.abs(Math.cos(bobPhase)) * 0.018 * bobAmount;
    const roll = Math.sin(bobPhase) * 0.03 * bobAmount;
    // swing arc: wind up, sweep down and across, ease back
    const arc = swingActive ? swingCurve(swing) : 0;
    // a faster counter-oscillation so the strike snaps rather than floats
    const snap = swingActive ? Math.sin(Math.min(1, swing) * Math.PI * 2) : 0;

    const pose = this.pose;
    /*
     * The arc is carried mostly by rotation, the way a Minecraft swing is: the
     * item rolls through ~50 degrees and sweeps inwards while it dips and comes
     * towards the camera. A big *translation* reads as the item sliding off the
     * bottom of the screen instead of being swung.
     */
    this.holder.position.set(
      pose.pos.x + bx + arc * 0.16,
      pose.pos.y - by - arc * 0.10,
      pose.pos.z + arc * 0.10,
    );
    this.holder.rotation.set(
      pose.rot.x + arc * 0.55 + snap * 0.07,
      pose.rot.y - arc * 0.35,
      pose.rot.z + roll + arc * 0.85 + snap * 0.05,
    );
    void dt;
  }

  render(renderer: THREE.WebGLRenderer): void {
    // The renderer runs with autoClear = false, so this render() call adds the
    // held item to the frame that Renderer.render() already produced. Only the
    // depth buffer is reset (so the item can never intersect terrain); the
    // colour buffer must be left alone or the world would be wiped.
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }
}

/* ------------------------------------------------------------------ */
/* Block selection outline + breaking overlay                          */
/* ------------------------------------------------------------------ */

export class BlockHighlight {
  readonly group = new THREE.Group();
  private outline: THREE.LineSegments;
  private overlay: THREE.Mesh;
  private overlayMat: THREE.MeshBasicMaterial;
  private overlayTexture: THREE.DataTexture;

  constructor(atlas: Atlas, crackTiles: { width: number; height: number; data: Uint8ClampedArray }) {
    const box = new THREE.BoxGeometry(1.002, 1.002, 1.002);
    const edges = new THREE.EdgesGeometry(box, 1);
    const lineMat = new THREE.LineBasicMaterial({ color: 0x0a0a0a, transparent: true, opacity: 0.55, depthTest: true });
    this.outline = new THREE.LineSegments(edges, lineMat);
    this.outline.renderOrder = 5;
    box.dispose();

    this.overlayTexture = new THREE.DataTexture(
      new Uint8Array(crackTiles.data),
      crackTiles.width,
      crackTiles.height,
      THREE.RGBAFormat,
    );
    this.overlayTexture.magFilter = THREE.NearestFilter;
    this.overlayTexture.minFilter = THREE.NearestFilter;
    this.overlayTexture.generateMipmaps = false;
    this.overlayTexture.wrapS = THREE.ClampToEdgeWrapping;
    this.overlayTexture.wrapT = THREE.ClampToEdgeWrapping;
    this.overlayTexture.colorSpace = THREE.NoColorSpace;
    this.overlayTexture.repeat.set(1, 1 / 8);
    this.overlayTexture.needsUpdate = true;

    this.overlayMat = new THREE.MeshBasicMaterial({
      map: this.overlayTexture,
      transparent: true,
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      alphaTest: 0.02,
    });
    this.overlay = new THREE.Mesh(new THREE.BoxGeometry(1.008, 1.008, 1.008), this.overlayMat);
    this.overlay.renderOrder = 6;
    this.overlay.visible = false;
    this.group.add(this.outline);
    this.group.add(this.overlay);
    this.group.visible = false;
    void atlas;
  }

  show(x: number, y: number, z: number): void {
    this.group.visible = true;
    this.outline.position.set(x + 0.5, y + 0.5, z + 0.5);
    this.overlay.position.copy(this.outline.position);
  }

  hide(): void {
    this.group.visible = false;
    this.overlay.visible = false;
  }

  setProgress(progress: number): void {
    if (progress <= 0) {
      this.overlay.visible = false;
      return;
    }
    const stage = Math.min(7, Math.max(0, Math.floor(progress * 8)));
    this.overlay.visible = true;
    // DataTexture rows start at v = 0 (flipY is false) and `repeat.y` is 1/8,
    // so stage N lives in v = [N/8, (N+1)/8]: the offset has to select that
    // band directly. Inverting it showed the *most* cracked stage first.
    this.overlayTexture.offset.y = stage / 8;
  }

  dispose(): void {
    this.outline.geometry.dispose();
    (this.outline.material as THREE.Material).dispose();
    this.overlay.geometry.dispose();
    this.overlayMat.dispose();
    this.overlayTexture.dispose();
  }
}
