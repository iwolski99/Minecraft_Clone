/**
 * Inventory icon generation.
 *
 * Icons are derived from the same procedurally generated textures the world
 * uses: block items get an isometric cube preview, everything else uses its
 * 16x16 item sprite. Nothing is loaded from disk.
 */

import type { Atlas } from '../render/atlas.js';
import { getBlock } from '../world/blocks.js';
import { itemDef, itemDisplay } from '../items/items.js';

interface Rel {
  blockId: number;
  sprite: boolean;
}

const tileCache = new Map<string, HTMLCanvasElement>();
const iconCache = new Map<string, HTMLCanvasElement>();

function tileCanvas(atlas: Atlas, name: string, tile: number): HTMLCanvasElement {
  const key = `${tile}:${name}`;
  const hit = tileCache.get(key);
  if (hit) return hit;
  const slot = atlas.slot(name);
  const c = document.createElement('canvas');
  c.width = atlas.tile;
  c.height = atlas.tile;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(atlas.tile, atlas.tile);
  const sx = (slot % atlas.cols) * atlas.tile;
  const sy = Math.floor(slot / atlas.cols) * atlas.tile;
  for (let y = 0; y < atlas.tile; y++) {
    for (let x = 0; x < atlas.tile; x++) {
      const src = ((sy + y) * atlas.width + (sx + x)) * 4;
      const dst = (y * atlas.tile + x) * 4;
      img.data[dst] = atlas.data[src];
      img.data[dst + 1] = atlas.data[src + 1];
      img.data[dst + 2] = atlas.data[src + 2];
      img.data[dst + 3] = atlas.data[src + 3];
    }
  }
  ctx.putImageData(img, 0, 0);
  tileCache.set(key, c);
  return c;
}

function faceTile(def: ReturnType<typeof getBlock>, face: 'top' | 'side' | 'front'): string {
  const t = def.tex;
  if (face === 'top') return t.top ?? t.all ?? t.side ?? t.sprite ?? 'stone';
  if (face === 'front') return t.north ?? t.side ?? t.all ?? t.sprite ?? 'stone';
  return t.side ?? t.all ?? t.top ?? t.sprite ?? 'stone';
}

/**
 * Draw an isometric cube preview of a block onto a canvas.
 * The three visible faces are affine-mapped parallelograms, matching the
 * in-world face shading so icons and world read as the same material.
 */
export function drawBlockIcon(canvas: HTMLCanvasElement, atlas: Atlas, blockId: number): void {
  const ctx = canvas.getContext('2d')!;
  const S = canvas.width;
  const def = getBlock(blockId);
  ctx.clearRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = false;

  const topName = faceTile(def, 'top');
  const sideName = faceTile(def, 'side');
  const frontName = faceTile(def, 'front');

  const A: [number, number] = [S * 0.5, S * 0.02];
  const B: [number, number] = [S * 0.98, S * 0.26];
  const C: [number, number] = [S * 0.5, S * 0.5];
  const D: [number, number] = [S * 0.02, S * 0.26];

  const L0: [number, number] = [S * 0.02, S * 0.26];
  const L1: [number, number] = [S * 0.5, S * 0.5];
  const L2: [number, number] = [S * 0.5, S * 0.98];
  const L3: [number, number] = [S * 0.02, S * 0.74];

  const R0: [number, number] = [S * 0.5, S * 0.5];
  const R1: [number, number] = [S * 0.98, S * 0.26];
  const R2: [number, number] = [S * 0.98, S * 0.74];
  const R3: [number, number] = [S * 0.5, S * 0.98];

  const drawFace = (
    tileName: string,
    o: [number, number],
    u: [number, number],
    v: [number, number],
    shade: number,
    p: [number, number][],
  ): void => {
    const tile = tileCanvas(atlas, tileName, atlas.slot(tileName));
    ctx.save();
    ctx.beginPath();
    ctx.moveTo(p[0][0], p[0][1]);
    for (let i = 1; i < 4; i++) ctx.lineTo(p[i][0], p[i][1]);
    ctx.closePath();
    ctx.clip();
    ctx.setTransform(u[0] / 16, u[1] / 16, v[0] / 16, v[1] / 16, o[0], o[1]);
    ctx.drawImage(tile, 0, 0);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    if (shade < 1) {
      ctx.fillStyle = `rgba(0,0,0,${1 - shade})`;
      ctx.fill();
    }
    ctx.restore();
  };

  // top face: origin A, u toward B, v toward D
  drawFace(topName, A, [B[0] - A[0], B[1] - A[1]], [D[0] - A[0], D[1] - A[1]], 1.0, [A, B, C, D]);
  // left face: origin L0, u toward L1, v toward L3
  drawFace(sideName, L0, [L1[0] - L0[0], L1[1] - L0[1]], [L3[0] - L0[0], L3[1] - L0[1]], 0.72, [L0, L1, L2, L3]);
  // right face: origin R0, u toward R1, v toward R3
  drawFace(frontName, R0, [R1[0] - R0[0], R1[1] - R0[1]], [R3[0] - R0[0], R3[1] - R0[1]], 0.87, [R0, R1, R2, R3]);
}

export function drawItemSprite(canvas: HTMLCanvasElement, atlas: Atlas, itemName: string): void {
  const ctx = canvas.getContext('2d')!;
  const S = canvas.width;
  ctx.clearRect(0, 0, S, S);
  ctx.imageSmoothingEnabled = false;
  const slot = atlas.slot(itemName);
  if (!atlas.has(itemName)) {
    ctx.fillStyle = '#c020c0';
    ctx.fillRect(S * 0.1, S * 0.1, S * 0.8, S * 0.8);
    return;
  }
  const sx = (slot % atlas.cols) * atlas.tile;
  const sy = Math.floor(slot / atlas.cols) * atlas.tile;
  const src = tileCanvasByName(atlas, sx, sy);
  // sprite occupies most of the icon but keeps a small margin
  const inset = S * 0.08;
  ctx.drawImage(src, inset, inset, S - inset * 2, S - inset * 2);
}

const rawTileCache = new Map<number, HTMLCanvasElement>();
function tileCanvasByName(atlas: Atlas, sx: number, sy: number): HTMLCanvasElement {
  const key = sx * 100000 + sy;
  const hit = rawTileCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = 16;
  c.height = 16;
  const ctx = c.getContext('2d')!;
  const img = ctx.createImageData(16, 16);
  for (let y = 0; y < 16; y++) {
    for (let x = 0; x < 16; x++) {
      const src = ((sy + y) * atlas.width + sx + x) * 4;
      const dst = (y * 16 + x) * 4;
      img.data[dst] = atlas.data[src];
      img.data[dst + 1] = atlas.data[src + 1];
      img.data[dst + 2] = atlas.data[src + 2];
      img.data[dst + 3] = atlas.data[src + 3];
    }
  }
  ctx.putImageData(img, 0, 0);
  rawTileCache.set(key, c);
  return c;
}

/**
 * Hand out a private copy of a finished icon.
 *
 * This is the whole reason the cache stores templates rather than the elements
 * it returns: a DOM node lives in exactly one parent, so returning the cached
 * canvas itself means the *second* slot that draws an item moves that canvas
 * out of the first one. The HUD hotbar and the open inventory screen both draw
 * 34px icons of the same items, which is how moving a stack around made hotbar
 * icons disappear.
 */
function copyCanvas(template: HTMLCanvasElement, size: number): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  canvas.className = 'icon';
  const ctx = canvas.getContext('2d');
  if (ctx) {
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(template, 0, 0);
  }
  return canvas;
}

export function makeIcon(blockAtlas: Atlas, itemAtlas: Atlas, itemName: string, size = 40): HTMLCanvasElement {
  const key = `${itemName}@${size}`;
  let template = iconCache.get(key);
  if (!template) {
    template = document.createElement('canvas');
    template.width = size;
    template.height = size;
    const def = itemDef(itemName);
    if (def && def.blockId > 0) {
      drawBlockIcon(template, blockAtlas, def.blockId);
    } else {
      drawItemSprite(template, itemAtlas, itemName);
    }
    iconCache.set(key, template);
  }
  return copyCanvas(template, size);
}

/** Icon for a raw block id (used by debug tooling). */
export function makeBlockIcon(blockAtlas: Atlas, blockId: number, size = 40): HTMLCanvasElement {
  const key = `block:${blockId}@${size}`;
  let template = iconCache.get(key);
  if (!template) {
    template = document.createElement('canvas');
    template.width = size;
    template.height = size;
    drawBlockIcon(template, blockAtlas, blockId);
    iconCache.set(key, template);
  }
  return copyCanvas(template, size);
}

export function clearIconCache(): void {
  iconCache.clear();
  tileCache.clear();
  rawTileCache.clear();
}

export { itemDisplay };
