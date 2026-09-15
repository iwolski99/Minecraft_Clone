/**
 * Procedural voxel creature models.
 *
 * Every mob is a rig of boxes (body / head / legs / ears / snout / horns /
 * beak / wings ...) built from `THREE.BoxGeometry`, textured with a procedural
 * pixel atlas painted at runtime with `PixBuf`. No art files, no smooth
 * gradients: the palettes are short and deliberately quantised so the creatures
 * read as the same "material" as the block world.
 *
 * One atlas + one material + one `MeshBasicMaterial` are built *per mob type*
 * and shared by every instance of that type; only the geometry is per instance.
 * The material carries no realtime lights (`MeshBasicMaterial`), so the manager
 * writes the day/night + block-light tint straight into `material.color`.
 */

import * as THREE from 'three';
import { PixBuf, RGBA, rgb, noiseFill, speckle, edgeDarken, flipRowsInPlace } from '../render/pixel.js';
import { Rng } from '../util/rng.js';

/* ------------------------------------------------------------------ */
/* Atlas layout                                                        */
/* ------------------------------------------------------------------ */

/** Tiles are 16x16 and laid out in a 4x4 grid -> one 64x64 texture per mob. */
const TILE = 16;
const COLS = 4;
const ROWS = 4;
const ATLAS_W = COLS * TILE;
const ATLAS_H = ROWS * TILE;

/** face order used by the box UV writer: +x, -x, +y, -y, +z, -z */
type FaceKey = 'px' | 'nx' | 'py' | 'ny' | 'pz' | 'nz';
const FACES: FaceKey[] = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];

export interface TileSet {
  all?: string;
  side?: string;
  top?: string;
  bottom?: string;
  px?: string;
  nx?: string;
  py?: string;
  ny?: string;
  pz?: string;
  nz?: string;
  /** tile painted on the -Z face (the classic "mob face") */
  face?: string;
}

/** Resolved tile name per face; falls back to `all` then to the first key. */
function tileFor(ts: TileSet, face: FaceKey): string {
  const key = face === 'px' ? 'px' : face === 'nx' ? 'nx' : face === 'py' ? 'py' : face === 'ny' ? 'ny' : face === 'pz' ? 'pz' : 'nz';
  if (face === 'nz' && ts.face) return ts.face;
  if (face === 'py' && ts.top) return ts.top;
  if (face === 'ny' && ts.bottom) return ts.bottom;
  const direct = ts[key];
  if (direct) return direct;
  if (face !== 'py' && face !== 'ny' && ts.side) return ts.side;
  return ts.all ?? ts.side ?? ts.top ?? 'body';
}

/* ------------------------------------------------------------------ */
/* Painting helpers                                                    */
/* ------------------------------------------------------------------ */

type TilePainter = (b: PixBuf) => void;
const painters = new Map<string, TilePainter>();

function tile(name: string, fn: TilePainter): void {
  painters.set(name, fn);
}

/** Wraps a painter with the signature the map expects. */
function paint(name: string, b: PixBuf): void {
  const fn = painters.get(name);
  if (fn) fn(b);
}

/**
 * Flat "hide/wool/feather" tile: two-tone noise, optional pixel accents, and
 * optional blocky patches (cattle markings) that read from a distance where
 * single-pixel speckle would just blur away.
 */
function coat(
  base: readonly RGBA[],
  seed: number,
  accent?: RGBA,
  accentChance = 0.05,
  border = 0.8,
  patches?: { color: RGBA; count: number; outline?: RGBA },
): TilePainter {
  return (b: PixBuf) => {
    noiseFill(b, base, seed, 3, 2);
    if (accent) speckle(b, accent, accentChance);
    if (patches) {
      const rng = new Rng(seed * 977 + 13);
      for (let i = 0; i < patches.count; i++) {
        const w = rng.int(3, 6);
        const h = rng.int(3, 5);
        const px = rng.int(1, b.w - w - 2);
        const py = rng.int(1, b.h - h - 2);
        if (patches.outline) b.rect(px - 1, py - 1, w + 2, h + 2, patches.outline);
        b.rect(px, py, w, h, patches.color);
        // nibble a corner so the marking is not a perfect rectangle
        const nx = rng.chance(0.5) ? px : px + w - 2;
        const ny = rng.chance(0.5) ? py : py + h - 2;
        b.rect(nx, ny, 2, 2, base[0]);
      }
    }
    edgeDarken(b, border);
  };
}

/** Mottled skin (creeper / spider): chaotic single pixels over a mid tone. */
function mottle(base: RGBA, dark: RGBA, light: RGBA, seed: number): TilePainter {
  return (b: PixBuf) => {
    b.fill(base);
    const rng = new Rng(seed);
    for (let y = 0; y < b.h; y++) {
      for (let x = 0; x < b.w; x++) {
        const r = rng.next();
        if (r < 0.3) b.set(x, y, dark);
        else if (r < 0.48) b.set(x, y, light);
      }
    }
    // a few small clusters keep it from looking like TV static
    for (let i = 0; i < 5; i++) {
      const cx = rng.range(2, b.w - 3);
      const cy = rng.range(2, b.h - 3);
      const c = rng.chance(0.5) ? dark : light;
      const w = rng.int(2, 4);
      const h = rng.int(2, 3);
      for (let y = cy; y < cy + h; y++) for (let x = cx; x < cx + w; x++) b.set(x, y, c);
    }
    edgeDarken(b, 0.82);
  };
}

/** Vertical cloth/limb tile with a slightly darker end band. */
function limb(base: readonly RGBA[], seed: number, band = 0.86): TilePainter {
  return (b: PixBuf) => {
    noiseFill(b, base, seed, 2, 2);
    for (let x = 0; x < b.w; x++) {
      b.shade(x, 0, band);
      b.shade(x, 1, band);
    }
    edgeDarken(b, 0.88);
  };
}

/** Draws the classic angry/dot eyes + mouth slit on a head tile. */
function face(base: readonly RGBA[], eye: RGBA, seed: number, mouth = true, browTint?: RGBA): TilePainter {
  return (b: PixBuf) => {
    noiseFill(b, base, seed, 3, 2);
    // eyes at y=5..6, split around the centre so the face reads from the front
    b.rect(3, 5, 3, 2, eye);
    b.rect(10, 5, 3, 2, eye);
    if (browTint) {
      b.rect(3, 4, 3, 1, browTint);
      b.rect(10, 4, 3, 1, browTint);
    }
    if (mouth) {
      b.rect(6, 10, 4, 1, eye);
      b.set(5, 10, eye);
      b.set(10, 10, eye);
    }
    edgeDarken(b, 0.84);
  };
}

/** Skull: hollow sockets and a tooth row. */
function skull(seed: number): TilePainter {
  return (b: PixBuf) => {
    noiseFill(b, [rgb(0xe2e0d2), rgb(0xd6d3c2), rgb(0xc9c6b3)], seed, 3, 2);
    b.rect(3, 5, 3, 3, rgb(0x1b1b20));
    b.rect(10, 5, 3, 3, rgb(0x1b1b20));
    b.rect(4, 6, 1, 1, rgb(0x3a3a44));
    b.rect(11, 6, 1, 1, rgb(0x3a3a44));
    b.rect(6, 10, 4, 1, rgb(0x4a4a52));
    for (let x = 6; x < 10; x += 2) b.set(x, 9, rgb(0x4a4a52));
    edgeDarken(b, 0.86);
  };
}

/* ------------------------------------------------------------------ */
/* Tile painters                                                       */
/* ------------------------------------------------------------------ */

/* --- pig --- */
tile('pig_body', coat([rgb(0xe8a3a0), rgb(0xe09a97), rgb(0xd58c8a)], 11, rgb(0xf4bdb9), 0.06));
tile('pig_head', face([rgb(0xe8a3a0), rgb(0xe09a97), rgb(0xd58c8a)], rgb(0x241619), 12, false));
tile('pig_snout', (b) => {
  noiseFill(b, [rgb(0xde8f8d), rgb(0xd48583)], 13, 2, 2);
  b.rect(3, 6, 2, 2, rgb(0x6b3a3a));
  b.rect(11, 6, 2, 2, rgb(0x6b3a3a));
  edgeDarken(b, 0.85);
});
tile('pig_ear', coat([rgb(0xd58c8a), rgb(0xcb807e)], 14, rgb(0xb87371), 0.08));
tile('pig_leg', limb([rgb(0xe09a97), rgb(0xd58c8a)], 15, 0.8));
tile('pig_hoof', (b) => {
  noiseFill(b, [rgb(0x4a3236), rgb(0x3d282b)], 16, 2, 2);
  b.rect(5, 7, 6, 1, rgb(0x2a1a1c));
  edgeDarken(b, 0.82);
});

/* --- cow --- */
tile('cow_body', coat(
  [rgb(0x2f2722), rgb(0x372d27), rgb(0x463a32)],
  21,
  rgb(0xe8e4d8),
  0.03,
  0.82,
  { color: rgb(0xece8dc), count: 4, outline: rgb(0x241d1a) },
));
tile('cow_head', face([rgb(0x2f2722), rgb(0x372d27)], rgb(0x181314), 22, false));
tile('cow_snout', (b) => {
  noiseFill(b, [rgb(0xd9cfc0), rgb(0xcbbfae)], 23, 3, 2);
  b.rect(4, 6, 2, 2, rgb(0x4a3f3a));
  b.rect(10, 6, 2, 2, rgb(0x4a3f3a));
  edgeDarken(b, 0.86);
});
tile('cow_horn', (b) => {
  noiseFill(b, [rgb(0xe9e3d2), rgb(0xdbd4c0), rgb(0xc9c1a9)], 24, 2, 2);
  b.rect(0, 0, 16, 3, rgb(0xf2ecdc));
  edgeDarken(b, 0.86);
});
tile('cow_leg', coat([rgb(0x2f2722), rgb(0x39302a)], 25, rgb(0xe8e4d8), 0.05, 0.82));
tile('cow_hoof', (b) => {
  noiseFill(b, [rgb(0x3a2f2a), rgb(0x2c2422)], 26, 2, 2);
  b.rect(5, 7, 6, 1, rgb(0x1d1716));
  edgeDarken(b, 0.82);
});
tile('cow_udder', coat([rgb(0xd8a79c), rgb(0xcb9a90)], 27));

/* --- sheep --- */
tile('sheep_wool', coat([rgb(0xeeeae0), rgb(0xe3ded2), rgb(0xd5cfc1)], 31, rgb(0xf6f3ec), 0.1, 0.84, {
  color: rgb(0xf7f4ee), count: 3, outline: rgb(0xc9c3b4),
}));
tile('sheep_head', face([rgb(0xdcd6c6), rgb(0xcec8b7)], rgb(0x2a2622), 32, false));
tile('sheep_face', (b) => {
  noiseFill(b, [rgb(0xdcd6c6), rgb(0xcec8b7)], 33, 3, 2);
  b.rect(4, 5, 2, 2, rgb(0x2a2622));
  b.rect(10, 5, 2, 2, rgb(0x2a2622));
  b.rect(6, 9, 4, 1, rgb(0x8a8378));
  b.rect(6, 11, 4, 1, rgb(0x8a8378));
  edgeDarken(b, 0.86);
});
tile('sheep_leg', limb([rgb(0xcfc8b8), rgb(0xc2bbaa)], 34, 0.8));
tile('sheep_hoof', (b) => {
  noiseFill(b, [rgb(0x3f3830), rgb(0x332d27)], 35, 2, 2);
  edgeDarken(b, 0.82);
});

/* --- chicken --- */
tile('chicken_body', coat([rgb(0xf2efe4), rgb(0xe8e4d6), rgb(0xdcd7c6)], 41, rgb(0xfbf9f2), 0.08));
tile('chicken_head', face([rgb(0xf2efe4), rgb(0xe8e4d6)], rgb(0x241f1c), 42, false));
tile('chicken_beak', (b) => {
  noiseFill(b, [rgb(0xe8a13a), rgb(0xd8912c), rgb(0xc27f22)], 43, 2, 2);
  b.rect(0, 7, 16, 1, rgb(0xb3741d));
  edgeDarken(b, 0.86);
});
tile('chicken_wattle', (b) => {
  noiseFill(b, [rgb(0xd23f3a), rgb(0xbd332f)], 44, 2, 2);
  edgeDarken(b, 0.84);
});
tile('chicken_wing', coat([rgb(0xe4dfd0), rgb(0xd8d2c1)], 45, rgb(0xc6bfae), 0.1));
tile('chicken_leg', (b) => {
  b.fill(rgb(0xe8a13a));
  speckle(b, rgb(0xc27f22), 0.16);
  edgeDarken(b, 0.82);
});
tile('chicken_foot', (b) => {
  b.fill(rgb(0xd8912c));
  b.rect(0, 10, 16, 2, rgb(0xb3741d));
  edgeDarken(b, 0.82);
});

/* --- zombie --- */
tile('zombie_body', (b) => {
  noiseFill(b, [rgb(0x3e6b57), rgb(0x35594a)], 51, 3, 2);
  // tattered shirt hem reads as cloth rather than skin
  b.rect(0, 12, 16, 4, rgb(0x2f4a3e));
  b.rect(3, 13, 2, 3, rgb(0x3e6b57));
  b.rect(9, 13, 3, 2, rgb(0x3e6b57));
  edgeDarken(b, 0.84);
});
tile('zombie_head', (b) => {
  face([rgb(0x4c7d66), rgb(0x416f5a)], rgb(0x101a15), 52, true, rgb(0x2f4a3e))(b);
  b.rect(4, 12, 3, 1, rgb(0x2a4438));
});
tile('zombie_arm', limb([rgb(0x4c7d66), rgb(0x43705c)], 53, 0.8));
tile('zombie_leg', limb([rgb(0x33528c), rgb(0x2c477a)], 54, 0.8));

/* --- skeleton --- */
tile('skeleton_body', (b) => {
  noiseFill(b, [rgb(0xd9d5c4), rgb(0xccc8b6)], 61, 3, 2);
  // rib bands
  for (let y = 4; y <= 12; y += 3) b.rect(2, y, 12, 1, rgb(0xa8a491));
  b.rect(6, 1, 4, 14, rgb(0xbfbba8));
  edgeDarken(b, 0.86);
});
tile('skeleton_head', skull(62));
tile('skeleton_arm', (b) => {
  noiseFill(b, [rgb(0xd9d5c4), rgb(0xcac6b3)], 63, 2, 2);
  for (let y = 3; y < 15; y += 4) b.rect(6, y, 4, 1, rgb(0xaeaa97));
  edgeDarken(b, 0.86);
});
tile('skeleton_leg', (b) => {
  noiseFill(b, [rgb(0xd2cebb), rgb(0xc4c0ad)], 64, 2, 2);
  b.rect(6, 2, 4, 11, rgb(0xe0dccb));
  edgeDarken(b, 0.86);
});
tile('bow', (b) => {
  b.fill(rgb(0xf0ece0));
  speckle(b, rgb(0xd8d2be), 0.2);
  edgeDarken(b, 0.8);
});

/* --- spider --- */
tile('spider_abdomen', mottle(rgb(0x332a26), rgb(0x241d1a), rgb(0x463a33), 71));
tile('spider_thorax', mottle(rgb(0x2c2421), rgb(0x1e1917), rgb(0x3d332c), 72));
tile('spider_head', (b) => {
  mottle(rgb(0x2c2421), rgb(0x1e1917), rgb(0x3d332c), 73)(b);
  b.rect(2, 6, 3, 2, rgb(0xc23a2c));
  b.rect(6, 5, 2, 2, rgb(0xd4483a));
  b.rect(9, 5, 2, 2, rgb(0xd4483a));
  b.rect(12, 6, 2, 2, rgb(0xc23a2c));
});
tile('spider_leg', mottle(rgb(0x1c1715), rgb(0x120f0e), rgb(0x2b2420), 74));

/* --- creeper --- */
tile('creeper_body', mottle(rgb(0x4f8a3c), rgb(0x3c6b2d), rgb(0x63a44b), 81));
tile('creeper_head', (b) => {
  mottle(rgb(0x4f8a3c), rgb(0x3c6b2d), rgb(0x63a44b), 82)(b);
  // hollow eyes + the wide mouth
  b.rect(3, 4, 3, 3, rgb(0x0e120c));
  b.rect(10, 4, 3, 3, rgb(0x0e120c));
  b.rect(6, 8, 4, 3, rgb(0x0e120c));
  b.rect(5, 10, 6, 3, rgb(0x0e120c));
  b.set(4, 11, rgb(0x0e120c));
  b.set(11, 11, rgb(0x0e120c));
});
tile('creeper_leg', mottle(rgb(0x477e36), rgb(0x355f28), rgb(0x5b9845), 83));

/* --- arrow projectile (its own tiny atlas, reused by every arrow) --- */
tile('arrow_shaft', limb([rgb(0x6b4a2a), rgb(0x5c3f23)], 91, 0.9));
tile('arrow_head', (b) => {
  noiseFill(b, [rgb(0xcfd3d8), rgb(0xb9bdc2), rgb(0xa3a7ac)], 92, 2, 2);
  edgeDarken(b, 0.85);
});
tile('arrow_fletch', (b) => {
  b.fill(rgb(0xf0ece2));
  speckle(b, rgb(0xd6d2c6), 0.2);
  b.rect(0, 0, 16, 2, rgb(0xd8d2c4));
  edgeDarken(b, 0.86);
});

/* Fallback so a typo can never produce a missing tile. */
tile('body', coat([rgb(0xb59a86), rgb(0xa88e7b)], 1));

/* ------------------------------------------------------------------ */
/* Atlas building (cached per mob type)                                */
/* ------------------------------------------------------------------ */

export interface MobAtlas {
  texture: THREE.DataTexture;
  material: THREE.MeshBasicMaterial;
  /** paired material that tints the sprite red for the damage flash */
  flashMaterial: THREE.MeshBasicMaterial;
  /** atlas tile index by name */
  slots: Map<string, number>;
}

const atlasCache = new Map<string, MobAtlas>();

/**
 * The damage-flash material paired with a mob's normal one, if it has one.
 *
 * Kept beside the atlas so the per-frame tint pass can keep the flash colour in
 * step with the ambient light without knowing anything about mob types.
 */
export const flashOf = new Map<THREE.Material, THREE.MeshBasicMaterial>();

function buildAtlas(key: string, names: string[]): MobAtlas {
  const buf = new PixBuf(ATLAS_W, ATLAS_H, 1337);
  buf.fill(rgb(0x000000, 0));
  const slots = new Map<string, number>();
  const used: string[] = [];
  for (const n of names) {
    if (slots.has(n)) continue;
    const i = used.length;
    if (i >= COLS * ROWS) break;
    const cx = (i % COLS) * TILE;
    const cy = Math.floor(i / COLS) * TILE;
    const part = new PixBuf(TILE, TILE, 900 + i * 17);
    paint(n, part);
    for (let y = 0; y < TILE; y++) {
      for (let x = 0; x < TILE; x++) {
        buf.set(cx + x, cy + y, part.get(x, y));
      }
    }
    slots.set(n, i);
    used.push(n);
  }

  // copy out of the (possibly SharedArrayBuffer-backed) clamped view so the
  // texture owns a plain ArrayBuffer, exactly like the block atlas does.
  // The rows are flipped on the way to the GPU: `uvRect()` below builds UVs in
  // canvas order (row 0 = top), but a DataTexture is sampled bottom-up, so
  // without this every mob face sampled the mirrored - empty - half of the
  // atlas and `MeshBasicMaterial` painted it solid black.
  const data = Uint8Array.from(buf.data);
  flipRowsInPlace(data, ATLAS_W, ATLAS_H);
  const texture = new THREE.DataTexture(data, ATLAS_W, ATLAS_H, THREE.RGBAFormat);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.wrapS = THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.colorSpace = THREE.NoColorSpace;
  texture.needsUpdate = true;
  texture.name = 'mob-' + key;

  const material = new THREE.MeshBasicMaterial({ map: texture, color: 0xffffff });
  material.name = 'mob-mat-' + key;
  /*
   * A second material per mob type for the damage flash.
   *
   * It shares the atlas texture and only differs in colour, so swapping a hit
   * mob onto it tints the sprite red without hiding it - the body turns red the
   * way it does in the original, with the texture still readable underneath.
   * A material is per type, so a shared one cannot flash one instance; the
   * manager swaps the hit mob's meshes onto this and back when it wears off.
   */
  const flashMaterial = new THREE.MeshBasicMaterial({ map: texture, color: 0xff4a4a });
  flashMaterial.name = 'mob-flash-' + key;
  flashOf.set(material, flashMaterial);
  return { texture, material, flashMaterial, slots };
}

/** Build (or fetch) the shared atlas for a mob type. */
export function mobAtlas(key: string, tileNames: string[]): MobAtlas {
  let a = atlasCache.get(key);
  if (!a) {
    a = buildAtlas(key, tileNames);
    atlasCache.set(key, a);
  }
  return a;
}

/** Half-texel inset guards against bleeding between atlas tiles. */
function uvRect(slot: number, out: { u0: number; v0: number; u1: number; v1: number }): void {
  const e = 0.02;
  const x = (slot % COLS) * TILE;
  const y = Math.floor(slot / COLS) * TILE;
  out.u0 = (x + e) / ATLAS_W;
  out.v0 = 1 - (y + TILE - e) / ATLAS_H;
  out.u1 = (x + TILE - e) / ATLAS_W;
  out.v1 = 1 - (y + e) / ATLAS_H;
}

/* ------------------------------------------------------------------ */
/* Rig construction                                                    */
/* ------------------------------------------------------------------ */

export interface BoxSpec {
  /** unique part name, also used to look the pivot up for animation */
  name: string;
  /** parent part name (must appear earlier in the list) */
  parent?: string;
  w: number;
  h: number;
  d: number;
  /** mesh centre relative to the parent pivot */
  x: number;
  y: number;
  z: number;
  /** pivot offset from the parent pivot; defaults to (0,0,0) */
  px?: number;
  py?: number;
  pz?: number;
  /** mirror the geometry across x (left limbs reuse the right-side texture) */
  mirror?: boolean;
  tiles: TileSet;
}

function writeBoxUvs(geo: THREE.BoxGeometry, atlas: MobAtlas, ts: TileSet): void {
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  const r = { u0: 0, v0: 0, u1: 0, v1: 0 };
  for (let f = 0; f < FACES.length; f++) {
    const slot = atlas.slots.get(tileFor(ts, FACES[f])) ?? 0;
    uvRect(slot, r);
    // BoxGeometry face order: +x, -x, +y, -y, +z, -z, four vertices each.
    const o = f * 4;
    uv.setXY(o + 0, r.u0, r.v1);
    uv.setXY(o + 1, r.u1, r.v1);
    uv.setXY(o + 2, r.u0, r.v0);
    uv.setXY(o + 3, r.u1, r.v0);
  }
  uv.needsUpdate = true;
  // UVs stay in [0,1] after flipping the mirrored meshes, so a default sphere is fine
  geo.computeBoundingSphere();
}

/** Clones a box geometry mirrored across x, fixing winding so faces stay front-facing. */
function mirrorGeometry(src: THREE.BufferGeometry): THREE.BufferGeometry {
  const geo = src.clone();
  const pos = geo.attributes.position as THREE.BufferAttribute;
  const nor = geo.attributes.normal as THREE.BufferAttribute;
  for (let i = 0; i < pos.count; i++) pos.setX(i, -pos.getX(i));
  for (let i = 0; i < nor.count; i++) nor.setX(i, -nor.getX(i));
  // flip the triangle winding so the mirrored box is not inside-out
  const flip = (attr: THREE.BufferAttribute, itemSize: number): void => {
    const arr = attr.array as Float32Array;
    for (let v = 0; v < attr.count; v += 3) {
      for (let k = 0; k < itemSize; k++) {
        const a = arr[v * itemSize + k];
        arr[v * itemSize + k] = arr[(v + 2) * itemSize + k];
        arr[(v + 2) * itemSize + k] = a;
      }
    }
    attr.needsUpdate = true;
  };
  const uv = geo.attributes.uv as THREE.BufferAttribute;
  flip(pos, 3);
  flip(nor, 3);
  flip(uv, 2);
  pos.needsUpdate = true;
  nor.needsUpdate = true;
  geo.computeBoundingSphere();
  return geo;
}

export interface BuiltRig {
  root: THREE.Group;
  parts: Map<string, THREE.Object3D>;
  material: THREE.MeshBasicMaterial;
  atlas: MobAtlas;
}

/**
 * Turns a list of box specs into a rig.
 *
 * Each part becomes a pivot `Group` (positioned at the joint) holding a mesh
 * offset by the box centre, which is what makes procedural limb animation
 * behave: rotate the pivot, the limb swings about its joint.
 */
export function buildRig(atlas: MobAtlas, specs: BoxSpec[]): BuiltRig {
  const root = new THREE.Group();
  root.name = 'mob-rig';
  const parts = new Map<string, THREE.Object3D>();

  for (const s of specs) {
    const pivot = new THREE.Group();
    pivot.name = s.name;
    if (s.px || s.py || s.pz) pivot.position.set(s.px ?? 0, s.py ?? 0, s.pz ?? 0);
    const parent = s.parent ? parts.get(s.parent) : undefined;
    (parent ?? root).add(pivot);

    const base = new THREE.BoxGeometry(s.w, s.h, s.d);
    writeBoxUvs(base, atlas, s.tiles);
    const geo = s.mirror ? mirrorGeometry(base) : base;
    if (s.mirror) base.dispose();

    const mesh = new THREE.Mesh(geo, atlas.material);
    mesh.position.set(s.x, s.y, s.z);
    mesh.frustumCulled = true;
    pivot.add(mesh);
    parts.set(s.name, pivot);
  }

  return { root, parts, material: atlas.material, atlas };
}

/* ------------------------------------------------------------------ */
/* Per-mob rig definitions                                             */
/* ------------------------------------------------------------------ */

/* Shared tile name lists keep the atlas small: only the tiles a mob needs are
 * painted, so the 4x4 grid is never overflowed. */

export const RIG_TILES: Record<string, string[]> = {
  pig: ['pig_body', 'pig_head', 'pig_snout', 'pig_ear', 'pig_leg', 'pig_hoof'],
  cow: ['cow_body', 'cow_head', 'cow_snout', 'cow_horn', 'cow_leg', 'cow_hoof', 'cow_udder'],
  sheep: ['sheep_wool', 'sheep_head', 'sheep_face', 'sheep_leg', 'sheep_hoof'],
  chicken: ['chicken_body', 'chicken_head', 'chicken_beak', 'chicken_wattle', 'chicken_wing', 'chicken_leg', 'chicken_foot'],
  zombie: ['zombie_body', 'zombie_head', 'zombie_arm', 'zombie_leg'],
  skeleton: ['skeleton_body', 'skeleton_head', 'skeleton_arm', 'skeleton_leg', 'bow'],
  spider: ['spider_abdomen', 'spider_thorax', 'spider_head', 'spider_leg'],
  creeper: ['creeper_body', 'creeper_head', 'creeper_leg'],
  arrow: ['arrow_shaft', 'arrow_head', 'arrow_fletch'],
};

/** Four legs at the corners of a body box. */
function quadrupedLegs(bodyW: number, bodyD: number, legH: number, legW: number, legD: number, tiles: TileSet): BoxSpec[] {
  const out: BoxSpec[] = [];
  const x = bodyW / 2 - legW / 2 + 0.01;
  const zFront = -(bodyD / 2) + legD / 2 + 0.01;
  const zBack = bodyD / 2 - legD / 2 - 0.01;
  const defs: [string, number, number][] = [
    ['legFR', x, zFront],
    ['legFL', -x, zFront],
    ['legBR', x, zBack],
    ['legBL', -x, zBack],
  ];
  for (const [name, lx, lz] of defs) {
    const mirror = lx < 0;
    out.push({
      name, px: lx, py: legH, pz: lz,
      w: legW, h: legH, d: legD, x: 0, y: -legH / 2, z: 0,
      mirror,
      tiles,
    });
  }
  return out;
}

/** Pig: 0.9 x 0.9. Body 0.56 tall, head 0.5 with a small snout and floppy ears. */
function pigSpecs(): BoxSpec[] {
  const legH = 0.34;
  return [
    {
      name: 'body', w: 0.56, h: 0.56, d: 0.9, x: 0, y: legH + 0.28, z: 0.02,
      tiles: { all: 'pig_body', top: 'pig_body', bottom: 'pig_body' },
    },
    {
      name: 'head', parent: 'body', px: 0, py: 0.2, pz: -0.46,
      w: 0.5, h: 0.5, d: 0.44, x: 0, y: 0.24, z: -0.2,
      tiles: { all: 'pig_head', face: 'pig_head', top: 'pig_ear', bottom: 'pig_head' },
    },
    {
      name: 'snout', parent: 'head', px: 0, py: 0.16, pz: -0.42,
      w: 0.24, h: 0.16, d: 0.12, x: 0, y: 0.08, z: -0.06,
      tiles: { all: 'pig_snout' },
    },
    {
      name: 'earR', parent: 'head', px: 0.16, py: 0.42, pz: 0.04,
      w: 0.1, h: 0.12, d: 0.06, x: 0, y: 0.05, z: 0,
      tiles: { all: 'pig_ear' },
    },
    {
      name: 'earL', parent: 'head', px: -0.16, py: 0.42, pz: 0.04, mirror: true,
      w: 0.1, h: 0.12, d: 0.06, x: 0, y: 0.05, z: 0,
      tiles: { all: 'pig_ear' },
    },
    ...quadrupedLegs(0.5, 0.84, legH, 0.16, 0.16, { all: 'pig_leg', bottom: 'pig_hoof' }),
  ];
}

/** Cow: 0.9 x 1.4. Longer body + head, horns, white patches in the hide tile. */
function cowSpecs(): BoxSpec[] {
  const legH = 0.58;
  return [
    {
      name: 'body', w: 0.6, h: 0.58, d: 1.0, x: 0, y: legH + 0.29, z: 0.03,
      tiles: { all: 'cow_body', top: 'cow_body', bottom: 'cow_udder' },
    },
    {
      name: 'head', parent: 'body', px: 0, py: 0.24, pz: -0.5,
      w: 0.46, h: 0.46, d: 0.46, x: 0, y: 0.23, z: -0.21,
      tiles: { all: 'cow_head', face: 'cow_head', top: 'cow_head' },
    },
    {
      name: 'snout', parent: 'head', px: 0, py: 0.12, pz: -0.44,
      w: 0.26, h: 0.16, d: 0.14, x: 0, y: 0.08, z: -0.07,
      tiles: { all: 'cow_snout' },
    },
    {
      name: 'hornR', parent: 'head', px: 0.2, py: 0.44, pz: 0.02,
      w: 0.09, h: 0.09, d: 0.12, x: 0, y: 0.04, z: 0,
      tiles: { all: 'cow_horn' },
    },
    {
      name: 'hornL', parent: 'head', px: -0.2, py: 0.44, pz: 0.02, mirror: true,
      w: 0.09, h: 0.09, d: 0.12, x: 0, y: 0.04, z: 0,
      tiles: { all: 'cow_horn' },
    },
    {
      name: 'earR', parent: 'head', px: 0.24, py: 0.3, pz: 0.08,
      w: 0.1, h: 0.1, d: 0.05, x: 0, y: 0, z: 0,
      tiles: { all: 'cow_head' },
    },
    {
      name: 'earL', parent: 'head', px: -0.24, py: 0.3, pz: 0.08, mirror: true,
      w: 0.1, h: 0.1, d: 0.05, x: 0, y: 0, z: 0,
      tiles: { all: 'cow_head' },
    },
    ...quadrupedLegs(0.54, 0.94, legH, 0.17, 0.17, { all: 'cow_leg', bottom: 'cow_hoof' }),
  ];
}

/** Sheep: 0.9 x 1.3 with a big wool fleece box. */
function sheepSpecs(): BoxSpec[] {
  const legH = 0.52;
  return [
    {
      name: 'body', w: 0.56, h: 0.54, d: 0.88, x: 0, y: legH + 0.27, z: 0.02,
      tiles: { all: 'sheep_wool', top: 'sheep_wool', bottom: 'sheep_wool' },
    },
    {
      // The fleece wraps the body box, so it has to be centred on it exactly
      // like the body mesh is. Without the `y` offset the parent-relative
      // placement dropped a second body-sized box at the sheep's feet - the
      // "inverted clone underneath" that made sheep look like two animals.
      name: 'wool', parent: 'body', w: 0.68, h: 0.52, d: 0.98, x: 0, y: legH + 0.27, z: 0.02,
      tiles: { all: 'sheep_wool' },
    },
    {
      name: 'head', parent: 'body', px: 0, py: 0.22, pz: -0.46,
      w: 0.42, h: 0.42, d: 0.42, x: 0, y: 0.21, z: -0.2,
      tiles: { all: 'sheep_head', face: 'sheep_face', top: 'sheep_wool' },
    },
    {
      name: 'earR', parent: 'head', px: 0.21, py: 0.12, pz: 0.04,
      w: 0.08, h: 0.06, d: 0.12, x: 0, y: 0, z: 0,
      tiles: { all: 'sheep_head' },
    },
    {
      name: 'earL', parent: 'head', px: -0.21, py: 0.12, pz: 0.04, mirror: true,
      w: 0.08, h: 0.06, d: 0.12, x: 0, y: 0, z: 0,
      tiles: { all: 'sheep_head' },
    },
    ...quadrupedLegs(0.48, 0.82, legH, 0.15, 0.15, { all: 'sheep_leg', bottom: 'sheep_hoof' }),
  ];
}

/** Chicken: 0.4 x 0.7 with flapping wings, beak and wattle. */
function chickenSpecs(): BoxSpec[] {
  const legH = 0.2;
  return [
    {
      name: 'body', w: 0.28, h: 0.3, d: 0.36, x: 0, y: legH + 0.15, z: 0,
      tiles: { all: 'chicken_body', top: 'chicken_body' },
    },
    {
      name: 'head', parent: 'body', px: 0, py: 0.26, pz: -0.12,
      w: 0.2, h: 0.2, d: 0.2, x: 0, y: 0.1, z: -0.09,
      tiles: { all: 'chicken_head', face: 'chicken_head', top: 'chicken_wattle' },
    },
    {
      name: 'beak', parent: 'head', px: 0, py: 0.06, pz: -0.2,
      w: 0.09, h: 0.07, d: 0.1, x: 0, y: 0.03, z: -0.05,
      tiles: { all: 'chicken_beak' },
    },
    {
      name: 'wattle', parent: 'head', px: 0, py: -0.02, pz: -0.18,
      w: 0.06, h: 0.07, d: 0.05, x: 0, y: -0.03, z: -0.02,
      tiles: { all: 'chicken_wattle' },
    },
    {
      name: 'wingR', parent: 'body', px: 0.14, py: 0.24, pz: 0,
      w: 0.04, h: 0.2, d: 0.3, x: 0.02, y: -0.1, z: 0,
      tiles: { all: 'chicken_wing' },
    },
    {
      name: 'wingL', parent: 'body', px: -0.14, py: 0.24, pz: 0, mirror: true,
      w: 0.04, h: 0.2, d: 0.3, x: 0.02, y: -0.1, z: 0,
      tiles: { all: 'chicken_wing' },
    },
    {
      name: 'legR', px: 0.06, py: legH, pz: 0.02,
      w: 0.05, h: legH, d: 0.05, x: 0, y: -legH / 2, z: 0,
      tiles: { all: 'chicken_leg' },
    },
    {
      name: 'legL', px: -0.06, py: legH, pz: 0.02, mirror: true,
      w: 0.05, h: legH, d: 0.05, x: 0, y: -legH / 2, z: 0,
      tiles: { all: 'chicken_leg' },
    },
    {
      name: 'footR', parent: 'legR', px: 0, py: -legH, pz: -0.01,
      w: 0.06, h: 0.04, d: 0.12, x: 0, y: 0.02, z: -0.03,
      tiles: { all: 'chicken_foot' },
    },
    {
      name: 'footL', parent: 'legL', px: 0, py: -legH, pz: -0.01, mirror: true,
      w: 0.06, h: 0.04, d: 0.12, x: 0, y: 0.02, z: -0.03,
      tiles: { all: 'chicken_foot' },
    },
  ];
}

/** Zombie: 0.6 x 1.95, arms held straight out. */
function zombieSpecs(): BoxSpec[] {
  const legH = 0.72;
  return [
    {
      name: 'body', w: 0.5, h: 0.72, d: 0.26, x: 0, y: legH + 0.36, z: 0,
      tiles: { all: 'zombie_body' },
    },
    {
      name: 'head', parent: 'body', px: 0, py: 0.72, pz: 0,
      w: 0.45, h: 0.45, d: 0.45, x: 0, y: 0.24, z: 0,
      tiles: { all: 'zombie_head', face: 'zombie_head', top: 'zombie_head' },
    },
    {
      name: 'armR', parent: 'body', px: 0.31, py: 0.66, pz: 0,
      w: 0.16, h: 0.66, d: 0.16, x: 0, y: -0.33, z: 0,
      tiles: { all: 'zombie_arm' },
    },
    {
      name: 'armL', parent: 'body', px: -0.31, py: 0.66, pz: 0, mirror: true,
      w: 0.16, h: 0.66, d: 0.16, x: 0, y: -0.33, z: 0,
      tiles: { all: 'zombie_arm' },
    },
    {
      name: 'legR', px: 0.13, py: legH, pz: 0,
      w: 0.18, h: legH, d: 0.18, x: 0, y: -legH / 2, z: 0,
      tiles: { all: 'zombie_leg' },
    },
    {
      name: 'legL', px: -0.13, py: legH, pz: 0, mirror: true,
      w: 0.18, h: legH, d: 0.18, x: 0, y: -legH / 2, z: 0,
      tiles: { all: 'zombie_leg' },
    },
  ];
}

/** Skeleton: 0.6 x 1.95, thinner limbs plus a bow on the left arm. */
function skeletonSpecs(): BoxSpec[] {
  const legH = 0.72;
  return [
    {
      name: 'body', w: 0.44, h: 0.72, d: 0.22, x: 0, y: legH + 0.36, z: 0,
      tiles: { all: 'skeleton_body' },
    },
    {
      name: 'head', parent: 'body', px: 0, py: 0.72, pz: 0,
      w: 0.44, h: 0.44, d: 0.44, x: 0, y: 0.23, z: 0,
      tiles: { all: 'skeleton_head', face: 'skeleton_head', top: 'skeleton_head' },
    },
    {
      name: 'armR', parent: 'body', px: 0.28, py: 0.66, pz: 0,
      w: 0.12, h: 0.66, d: 0.12, x: 0, y: -0.33, z: 0,
      tiles: { all: 'skeleton_arm' },
    },
    {
      name: 'armL', parent: 'body', px: -0.28, py: 0.66, pz: 0, mirror: true,
      w: 0.12, h: 0.66, d: 0.12, x: 0, y: -0.33, z: 0,
      tiles: { all: 'skeleton_arm' },
    },
    {
      // the bow rides along with the left arm so aiming the arm aims the bow
      name: 'bow', parent: 'armL', px: 0, py: -0.62, pz: -0.02,
      w: 0.05, h: 0.62, d: 0.05, x: 0, y: 0.31, z: -0.04,
      tiles: { all: 'bow' },
    },
    {
      name: 'legR', px: 0.12, py: legH, pz: 0,
      w: 0.14, h: legH, d: 0.14, x: 0, y: -legH / 2, z: 0,
      tiles: { all: 'skeleton_leg' },
    },
    {
      name: 'legL', px: -0.12, py: legH, pz: 0, mirror: true,
      w: 0.14, h: legH, d: 0.14, x: 0, y: -legH / 2, z: 0,
      tiles: { all: 'skeleton_leg' },
    },
  ];
}

/**
 * Spider: 1.4 x 0.9.
 * Eight two-segment legs are generated around the thorax; the upper segment is
 * rolled outward and the lower one bent down, which reads as the classic
 * angular spider stance and animates well.
 */
function spiderSpecs(): BoxSpec[] {
  const out: BoxSpec[] = [];
  const rowZ = [-0.28, -0.06, 0.1, 0.3];
  // Shoulder pivot height. The two leg segments together drop from here to the
  // ground, so the feet land on y = 0. The value is tuned against qa-models,
  // which measures the built rig's bounding box (the pivot chain picks up a
  // small offset relative to a naive hand calculation).
  const SHOULDER = 0.256;
  const SEG = 0.16;
  for (let i = 0; i < 4; i++) {
    const z = rowZ[i];
    for (const side of [1, -1] as const) {
      const suffix = side > 0 ? 'R' : 'L';
      const mirror = side < 0;
      const upper = `leg${i}${suffix}`;
      const lower = `shin${i}${suffix}`;
      out.push({
        name: upper,
        // splayed outside the 0.56-wide thorax so the legs stay visible
        px: side * 0.42, py: SHOULDER, pz: z,
        w: 0.09, h: SEG, d: 0.09,
        x: 0, y: -SEG / 2, z: 0,
        mirror,
        tiles: { all: 'spider_leg' },
      });
      out.push({
        name: lower,
        parent: upper,
        px: 0, py: -SEG, pz: 0,
        w: 0.075, h: SEG, d: 0.075,
        x: 0, y: -SEG / 2, z: 0,
        mirror,
        tiles: { all: 'spider_leg' },
      });
    }
  }
  return [
    // abdomen sits at the back (+Z), thorax and head at the front (-Z)
    {
      name: 'abdomen', w: 0.62, h: 0.54, d: 0.66, x: 0, y: 0.46, z: 0.34,
      tiles: { all: 'spider_abdomen' },
    },
    {
      name: 'thorax', w: 0.56, h: 0.46, d: 0.46, x: 0, y: 0.42, z: -0.1,
      tiles: { all: 'spider_thorax' },
    },
    {
      // `parent` links the head to the thorax for animation, but a pivot is
      // positioned relative to its parent *pivot* - and the thorax has no parent,
      // so its pivot is the root origin. The head therefore has to carry the
      // thorax's height itself, or it lands at y = 0 and buries its face in the
      // block it is standing on.
      name: 'head', parent: 'thorax', w: 0.4, h: 0.36, d: 0.36, x: 0, y: 0.42, z: -0.36,
      tiles: { all: 'spider_head', face: 'spider_head' },
    },
    ...out,
  ];
}

/** Creeper: 0.6 x 1.7, four stubby legs and a tall torso. */
function creeperSpecs(): BoxSpec[] {
  const legH = 0.36;
  const legs: BoxSpec[] = [];
  for (const [name, lx, lz] of [
    ['legFR', 0.15, -0.14],
    ['legFL', -0.15, -0.14],
    ['legBR', 0.15, 0.14],
    ['legBL', -0.15, 0.14],
  ] as [string, number, number][]) {
    legs.push({
      name, px: lx, py: legH, pz: lz,
      w: 0.22, h: legH, d: 0.22, x: 0, y: -legH / 2, z: 0,
      mirror: lx < 0,
      tiles: { all: 'creeper_leg' },
    });
  }
  return [
    {
      name: 'body', w: 0.46, h: 0.82, d: 0.28, x: 0, y: legH + 0.41, z: 0,
      tiles: { all: 'creeper_body' },
    },
    {
      name: 'head', parent: 'body', px: 0, py: 0.82, pz: 0,
      w: 0.46, h: 0.46, d: 0.46, x: 0, y: 0.24, z: 0,
      tiles: { all: 'creeper_head', face: 'creeper_head', top: 'creeper_head' },
    },
    ...legs,
  ];
}

/** Arrow: a thin shaft along -Z with a head and fletching. */
function arrowSpecs(): BoxSpec[] {
  return [
    { name: 'shaft', w: 0.05, h: 0.05, d: 0.62, x: 0, y: 0, z: 0, tiles: { all: 'arrow_shaft' } },
    { name: 'head', w: 0.07, h: 0.07, d: 0.12, x: 0, y: 0, z: -0.34, tiles: { all: 'arrow_head' } },
    { name: 'fletch', w: 0.09, h: 0.09, d: 0.14, x: 0, y: 0, z: 0.3, tiles: { all: 'arrow_fletch' } },
  ];
}

const RIG_BUILDERS: Record<string, () => BoxSpec[]> = {
  pig: pigSpecs,
  cow: cowSpecs,
  sheep: sheepSpecs,
  chicken: chickenSpecs,
  zombie: zombieSpecs,
  skeleton: skeletonSpecs,
  spider: spiderSpecs,
  creeper: creeperSpecs,
  arrow: arrowSpecs,
};

/** Build (or fetch) the shared rig description for a mob type. */
export function buildMobRig(typeName: string): BuiltRig {
  const key = RIG_TILES[typeName] ? typeName : 'pig';
  const atlas = mobAtlas(key, RIG_TILES[key]);
  const builder = RIG_BUILDERS[key];
  const specs = builder ? builder() : pigSpecs();
  return buildRig(atlas, specs);
}

/**
 * The declared box list for a mob type, without building any geometry. Used by
 * the model QA suite to check that a rig contains exactly the parts it claims.
 */
export function mobPartSpecs(typeName: string): BoxSpec[] | null {
  if (!RIG_TILES[typeName]) return null;
  const builder = RIG_BUILDERS[typeName];
  return builder ? builder() : pigSpecs();
}

/** Look up a shared mob material (used by the manager to batch tints). */
export function mobMaterial(typeName: string): THREE.MeshBasicMaterial | null {
  const key = RIG_TILES[typeName] ? typeName : null;
  if (!key) return null;
  return atlasCache.get(key)?.material ?? null;
}
