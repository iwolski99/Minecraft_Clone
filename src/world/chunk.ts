/**
 * Chunk storage.
 *
 * 16 x 128 x 16 blocks per chunk, one flat byte array per data layer so the
 * mesher and lighting passes are cache friendly. Index order is y-major which
 * matches the mesher's column scans.
 */

export const CHUNK_X = 16;
export const CHUNK_Z = 16;
export const CHUNK_Y = 128;
export const CHUNK_AREA = CHUNK_X * CHUNK_Z;
export const CHUNK_VOLUME = CHUNK_X * CHUNK_Y * CHUNK_Z;

export const SEA_LEVEL = 62;

export type ChunkStage = 'empty' | 'terrain' | 'decorated' | 'lit' | 'meshed';

export function blockIndex(x: number, y: number, z: number): number {
  return (y << 8) | (z << 4) | x;
}

export function chunkKey(cx: number, cz: number): number {
  return ((cx & 0xffff) << 16) | (cz & 0xffff);
}

export class Chunk {
  readonly cx: number;
  readonly cz: number;
  readonly blocks = new Uint8Array(CHUNK_VOLUME);
  readonly skyLight = new Uint8Array(CHUNK_VOLUME);
  readonly blockLight = new Uint8Array(CHUNK_VOLUME);
  /** y of the highest opaque block per column, -1 when the column is empty. */
  readonly heightMap = new Int16Array(CHUNK_AREA);
  /** biome id per column */
  readonly biome = new Uint8Array(CHUNK_AREA);
  /** highest light-blocking y per column (used for skylight seeding) */
  readonly skyTop = new Int16Array(CHUNK_AREA);

  stage: ChunkStage = 'empty';
  /** needs a mesh rebuild */
  dirty = true;
  /** contains player edits and must be persisted */
  modified = false;
  /** frustum/ distance bookkeeping filled in by the renderer */
  visible = true;

  constructor(cx: number, cz: number) {
    this.cx = cx;
    this.cz = cz;
    this.heightMap.fill(-1);
  }

  get(x: number, y: number, z: number): number {
    if (y < 0 || y >= CHUNK_Y) return 0;
    return this.blocks[blockIndex(x, y, z)];
  }

  set(x: number, y: number, z: number, id: number): void {
    if (y < 0 || y >= CHUNK_Y) return;
    this.blocks[blockIndex(x, y, z)] = id;
  }

  worldX(x: number): number {
    return this.cx * CHUNK_X + x;
  }

  worldZ(z: number): number {
    return this.cz * CHUNK_Z + z;
  }
}
