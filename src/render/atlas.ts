/**
 * Texture atlas assembly.
 *
 * Tiles are painted into a fixed grid, then uploaded as a single texture with
 * nearest-neighbour filtering. UV lookups inset by a fraction of a texel so
 * that adjacent atlas cells can never bleed into each other.
 */

import { PixBuf, RGBA } from './pixel.js';
import { TILE, paintTile, tileNames } from './blockTextures.js';
import { ITEM_TILE, paintItem, itemNames } from './itemTextures.js';

/** Tile names referenced by the block registry that alias another painter. */
const ALIASES: Record<string, string> = {
  snow_side: 'snowy_grass_side',
};

export interface UvRect {
  u0: number;
  v0: number;
  u1: number;
  v1: number;
}

export class Atlas {
  readonly cols: number;
  readonly rows: number;
  readonly tile: number;
  readonly width: number;
  readonly height: number;
  readonly data: Uint8ClampedArray;
  private index = new Map<string, number>();
  private names: string[] = [];

  constructor(cols: number, rows: number, tile: number) {
    this.cols = cols;
    this.rows = rows;
    this.tile = tile;
    this.width = cols * tile;
    this.height = rows * tile;
    this.data = new Uint8ClampedArray(this.width * this.height * 4);
  }

  add(name: string, buf: PixBuf): number {
    const i = this.names.length;
    if (i >= this.cols * this.rows) throw new Error(`atlas overflow adding "${name}"`);
    const cx = (i % this.cols) * this.tile;
    const cy = Math.floor(i / this.cols) * this.tile;
    for (let y = 0; y < this.tile; y++) {
      const src = y * this.tile * 4;
      const dst = ((cy + y) * this.width + cx) * 4;
      this.data.set(buf.data.subarray(src, src + this.tile * 4), dst);
    }
    this.index.set(name, i);
    this.names.push(name);
    return i;
  }

  has(name: string): boolean {
    return this.index.has(name) || this.index.has(ALIASES[name] ?? '');
  }

  /** Atlas slot for a tile name; 0 when unknown. */
  slot(name: string): number {
    const direct = this.index.get(name);
    if (direct !== undefined) return direct;
    const alias = ALIASES[name];
    if (alias !== undefined) {
      const a = this.index.get(alias);
      if (a !== undefined) return a;
    }
    return 0;
  }

  uv(name: string): UvRect {
    return this.uvSlot(this.slot(name));
  }

  uvSlot(i: number): UvRect {
    const t = this.tile;
    const x = (i % this.cols) * t;
    const y = Math.floor(i / this.cols) * t;
    // half-texel inset guards against linear/edge bleeding at grazing angles
    const e = 0.02;
    return {
      u0: (x + e) / this.width,
      v0: 1 - (y + t - e) / this.height,
      u1: (x + t - e) / this.width,
      v1: 1 - (y + e) / this.height,
    };
  }

  /** Read a texel (used for particles and minimap colours). */
  texel(i: number, x: number, y: number): RGBA {
    const cx = ((i % this.cols) * this.tile + (x & (this.tile - 1))) | 0;
    const cy = (Math.floor(i / this.cols) * this.tile + (y & (this.tile - 1))) | 0;
    const o = (cy * this.width + cx) * 4;
    return [this.data[o], this.data[o + 1], this.data[o + 2], this.data[o + 3]];
  }

  /** Average colour of a tile, ignoring transparent texels. */
  averageColor(i: number): RGBA {
    let r = 0;
    let g = 0;
    let b = 0;
    let n = 0;
    for (let y = 0; y < this.tile; y++) {
      for (let x = 0; x < this.tile; x++) {
        const c = this.texel(i, x, y);
        if (c[3] < 40) continue;
        r += c[0];
        g += c[1];
        b += c[2];
        n++;
      }
    }
    if (!n) return [255, 0, 255, 255];
    return [r / n, g / n, b / n, 255];
  }

  get count(): number {
    return this.names.length;
  }

  toImageData(): ImageData {
    return new ImageData(new Uint8ClampedArray(this.data), this.width, this.height);
  }

  toCanvas(): HTMLCanvasElement {
    const c = document.createElement('canvas');
    c.width = this.width;
    c.height = this.height;
    const ctx = c.getContext('2d')!;
    ctx.putImageData(this.toImageData(), 0, 0);
    return c;
  }

  /** Padded copy used by the hand-held item renderer (keeps edges crisp). */
  cloneCanvasScaled(scale: number): HTMLCanvasElement {
    const src = this.toCanvas();
    const c = document.createElement('canvas');
    c.width = this.width * scale;
    c.height = this.height * scale;
    const ctx = c.getContext('2d')!;
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(src, 0, 0, c.width, c.height);
    return c;
  }
}

export function buildBlockAtlas(): Atlas {
  const names = tileNames().sort();
  // 16x16 grid of 16px tiles = 256x256, comfortably fits every tile plus room
  const atlas = new Atlas(16, 16, TILE);
  for (const n of names) atlas.add(n, paintTile(n));
  return atlas;
}

export function buildItemAtlas(): Atlas {
  const names = itemNames().sort();
  const cols = 8;
  const rows = Math.max(4, Math.ceil((names.length + 8) / cols));
  const atlas = new Atlas(cols, rows, ITEM_TILE);
  for (const n of names) atlas.add(n, paintItem(n));
  return atlas;
}

/** Report tile names the block registry asks for but nobody painted. */
export function missingPainters(required: Iterable<string>): string[] {
  const have = new Set(tileNames());
  const out: string[] = [];
  for (const r of required) {
    if (!have.has(r) && !(r in ALIASES) && !have.has(ALIASES[r] ?? '')) out.push(r);
  }
  return out;
}
