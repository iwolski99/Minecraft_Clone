/**
 * Persistence.
 *
 * Only the world seed plus the *deviation* from procedural generation is stored:
 * every block the player changed is kept as a compact (index, id) pair per
 * chunk, base64 encoded. Regenerating from the seed reproduces everything else
 * byte for byte, which keeps saves tiny.
 */

export const SAVE_VERSION = 3;
const INDEX_KEY = 'cubeworld.worlds.v3';
const WORLD_PREFIX = 'cubeworld.world.';

export type GameModeName = 'survival' | 'creative';

export interface WorldMeta {
  id: string;
  name: string;
  seed: number;
  gameMode: GameModeName;
  createdAt: number;
  lastPlayed: number;
  playTime: number;
}

export interface PlayerSave {
  x: number;
  y: number;
  z: number;
  yaw: number;
  pitch: number;
  health: number;
  hunger: number;
  air: number;
  flying: boolean;
  spawnX: number;
  spawnY: number;
  spawnZ: number;
}

export interface WorldSaveData {
  version: number;
  id: string;
  name: string;
  seed: number;
  gameMode: GameModeName;
  dimension: number;
  time: number;
  player: PlayerSave;
  inventory: unknown;
  /** base64 packed voxel edits */
  edits: string;
  furnaces: unknown[];
  chests: unknown[];
  mobs: unknown[];
}

/* ------------------------------------------------------------------ */
/* Voxel edit packing                                                  */
/* ------------------------------------------------------------------ */

/**
 * Layout: for each chunk -> [chunkKey i32][count u16][ (index u16, id u8) * count ]
 * Everything is little endian.
 */
export function packEdits(edits: Map<number, Map<number, number>>): string {
  let total = 0;
  for (const m of edits.values()) total += 6 + m.size * 3;
  if (total === 0) return '';
  const buf = new Uint8Array(total);
  let o = 0;
  const view = new DataView(buf.buffer);
  for (const [key, m] of edits) {
    if (m.size === 0) continue;
    view.setInt32(o, key, true);
    o += 4;
    view.setUint16(o, Math.min(65535, m.size), true);
    o += 2;
    for (const [index, id] of m) {
      view.setUint16(o, index, true);
      o += 2;
      buf[o++] = id & 0xff;
    }
  }
  return bytesToBase64(buf.subarray(0, o));
}

export function unpackEdits(str: string): Map<number, Map<number, number>> {
  const out = new Map<number, Map<number, number>>();
  if (!str) return out;
  const buf = base64ToBytes(str);
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let o = 0;
  while (o + 6 <= buf.length) {
    const key = view.getInt32(o, true);
    o += 4;
    const count = view.getUint16(o, true);
    o += 2;
    const m = new Map<number, number>();
    for (let i = 0; i < count && o + 3 <= buf.length; i++) {
      const index = view.getUint16(o, true);
      o += 2;
      const id = buf[o++];
      m.set(index, id);
    }
    out.set(key, m);
  }
  return out;
}

function bytesToBase64(bytes: Uint8Array): string {
  let s = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode.apply(null, Array.from(bytes.subarray(i, i + chunk)) as unknown as number[]);
  }
  return btoa(s);
}

function base64ToBytes(str: string): Uint8Array {
  const bin = atob(str);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ------------------------------------------------------------------ */
/* Storage                                                             */
/* ------------------------------------------------------------------ */

export class SaveSystem {
  static available(): boolean {
    try {
      const k = '__cwtest__';
      localStorage.setItem(k, '1');
      localStorage.removeItem(k);
      return true;
    } catch {
      return false;
    }
  }

  static listWorlds(): WorldMeta[] {
    try {
      const raw = localStorage.getItem(INDEX_KEY);
      if (!raw) return [];
      const list = JSON.parse(raw) as WorldMeta[];
      if (!Array.isArray(list)) return [];
      return list.filter((w) => w && typeof w.id === 'string').sort((a, b) => b.lastPlayed - a.lastPlayed);
    } catch {
      return [];
    }
  }

  private static writeIndex(list: WorldMeta[]): void {
    localStorage.setItem(INDEX_KEY, JSON.stringify(list));
  }

  static upsertMeta(meta: WorldMeta): void {
    const list = this.listWorlds();
    const i = list.findIndex((w) => w.id === meta.id);
    if (i >= 0) list[i] = meta;
    else list.push(meta);
    this.writeIndex(list);
  }

  static save(data: WorldSaveData): { ok: boolean; error?: string } {
    try {
      const payload = JSON.stringify(data);
      localStorage.setItem(WORLD_PREFIX + data.id, payload);
      const meta = this.listWorlds().find((w) => w.id === data.id);
      if (meta) {
        meta.lastPlayed = Date.now();
        this.upsertMeta(meta);
      }
      return { ok: true };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return { ok: false, error: msg.includes('Quota') || msg.includes('quota') ? 'Storage is full - delete an old world.' : msg };
    }
  }

  static load(id: string): WorldSaveData | null {
    try {
      const raw = localStorage.getItem(WORLD_PREFIX + id);
      if (!raw) return null;
      const data = JSON.parse(raw) as WorldSaveData;
      if (!data || typeof data.seed !== 'number') return null;
      if (data.version !== SAVE_VERSION) {
        // incompatible save: keep the seed and metadata, discard the rest
        return {
          version: SAVE_VERSION,
          id: data.id ?? id,
          name: data.name ?? 'Recovered World',
          seed: data.seed,
          gameMode: data.gameMode === 'creative' ? 'creative' : 'survival',
          dimension: 0,
          time: 0.28,
          player: defaultPlayer(),
          inventory: null,
          edits: '',
          furnaces: [],
          chests: [],
          mobs: [],
        };
      }
      return data;
    } catch {
      return null;
    }
  }

  static delete(id: string): void {
    localStorage.removeItem(WORLD_PREFIX + id);
    this.writeIndex(this.listWorlds().filter((w) => w.id !== id));
  }

  static estimateSize(id: string): number {
    try {
      return (localStorage.getItem(WORLD_PREFIX + id) ?? '').length;
    } catch {
      return 0;
    }
  }
}

export function defaultPlayer(): PlayerSave {
  return {
    x: 0,
    y: 80,
    z: 0,
    yaw: 0,
    pitch: 0,
    health: 20,
    hunger: 20,
    air: 300,
    flying: false,
    spawnX: 0,
    spawnY: 80,
    spawnZ: 0,
  };
}

export function newWorldId(seed: number): string {
  return `w${seed.toString(36)}${Date.now().toString(36)}`;
}
