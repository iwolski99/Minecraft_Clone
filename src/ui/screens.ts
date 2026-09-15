/**
 * Front-end screens: title, world creation, world list, settings, pause,
 * loading and death. All plain DOM with the pixel-art stylesheet, plus a
 * procedurally painted voxel panorama behind the title.
 */

import type { Atlas } from '../render/atlas.js';
import { SaveSystem, WorldMeta, GameModeName, newWorldId } from '../save/save.js';
import { seedFromString } from '../util/rng.js';

export interface Settings {
  renderDistance: number;
  fov: number;
  mouseSensitivity: number;
  masterVolume: number;
  sfxVolume: number;
  musicVolume: number;
  bobAmount: number;
  showFps: boolean;
  graphics: 'fast' | 'fancy';
}

const SETTINGS_KEY = 'cubeworld.settings.v1';

export const DEFAULT_SETTINGS: Settings = {
  renderDistance: 8,
  fov: 75,
  mouseSensitivity: 1,
  masterVolume: 0.7,
  sfxVolume: 0.9,
  musicVolume: 0.35,
  bobAmount: 0.6,
  showFps: true,
  graphics: 'fancy',
};

export function loadSettings(): Settings {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return { ...DEFAULT_SETTINGS };
    return { ...DEFAULT_SETTINGS, ...(JSON.parse(raw) as Partial<Settings>) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* storage unavailable - settings simply do not persist */
  }
}

/* ------------------------------------------------------------------ */
/* Panorama                                                            */
/* ------------------------------------------------------------------ */

/** A blocky landscape painted with the game's own palette. */
export function drawPanorama(canvas: HTMLCanvasElement, _atlas: Atlas): void {
  const W = canvas.width;
  const H = canvas.height;
  const ctx = canvas.getContext('2d')!;
  ctx.imageSmoothingEnabled = false;

  const sky = ctx.createLinearGradient(0, 0, 0, H * 0.72);
  sky.addColorStop(0, '#2a4a86');
  sky.addColorStop(0.55, '#6f9bd8');
  sky.addColorStop(1, '#e8b98a');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, W, H);

  // sun
  const sunX = W * 0.72;
  const sunY = H * 0.36;
  ctx.fillStyle = '#ffe9b0';
  ctx.fillRect(sunX - 26, sunY - 26, 52, 52);
  ctx.fillStyle = 'rgba(255,235,180,0.22)';
  ctx.fillRect(sunX - 60, sunY - 60, 120, 120);

  // blocky clouds
  const cloudSeed = 1337;
  let s = cloudSeed;
  const rnd = (): number => {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    return s / 0x7fffffff;
  };
  for (let i = 0; i < 26; i++) {
    const cx = rnd() * W;
    const cy = H * (0.08 + rnd() * 0.3);
    const w = 40 + rnd() * 130;
    const h = 12 + rnd() * 14;
    ctx.fillStyle = `rgba(255,255,255,${0.5 + rnd() * 0.35})`;
    ctx.fillRect(Math.round(cx), Math.round(cy), Math.round(w), Math.round(h));
    ctx.fillRect(Math.round(cx + w * 0.2), Math.round(cy - h * 0.7), Math.round(w * 0.5), Math.round(h * 0.7));
  }

  // layered blocky hills with atmospheric perspective
  const layers = [
    { y: 0.66, amp: 0.07, color: '#3c5f86', step: 18 },
    { y: 0.72, amp: 0.09, color: '#3f6b4a', step: 14 },
    { y: 0.79, amp: 0.1, color: '#417a3a', step: 11 },
    { y: 0.88, amp: 0.09, color: '#4c8a34', step: 9 },
  ];
  for (let li = 0; li < layers.length; li++) {
    const L = layers[li];
    ctx.fillStyle = L.color;
    for (let x = 0; x < W; x += L.step) {
      const n =
        Math.sin((x + li * 300) * 0.0031) * 0.5 +
        Math.sin((x + li * 90) * 0.0091) * 0.3 +
        Math.sin((x + li * 40) * 0.021) * 0.2;
      const top = H * L.y - n * H * L.amp;
      ctx.fillRect(x, Math.round(top), L.step, H - Math.round(top));
      // grass highlight on the top edge
      if (li >= 2) {
        ctx.fillStyle = li === 3 ? '#63a844' : '#4e8a3a';
        ctx.fillRect(x, Math.round(top), L.step, 6);
        ctx.fillStyle = L.color;
      }
    }
  }

  // a few foreground trees
  const trees = [0.12, 0.27, 0.44, 0.58, 0.81, 0.93];
  for (const tx of trees) {
    const x = Math.round(tx * W);
    const y = H * 0.86;
    ctx.fillStyle = '#4a3a22';
    ctx.fillRect(x, Math.round(y - 42), 8, 42);
    ctx.fillStyle = '#2f6b28';
    ctx.fillRect(x - 22, Math.round(y - 76), 52, 22);
    ctx.fillRect(x - 16, Math.round(y - 92), 40, 18);
    ctx.fillRect(x - 8, Math.round(y - 104), 24, 14);
    ctx.fillStyle = '#3d8232';
    ctx.fillRect(x - 22, Math.round(y - 76), 52, 6);
    ctx.fillRect(x - 16, Math.round(y - 92), 40, 5);
  }

  // foreground ground
  ctx.fillStyle = '#6b4a2c';
  ctx.fillRect(0, Math.round(H * 0.94), W, H);
  ctx.fillStyle = '#3f7a2c';
  ctx.fillRect(0, Math.round(H * 0.93), W, 8);

  // vignette
  const vg = ctx.createRadialGradient(W / 2, H / 2, Math.min(W, H) * 0.25, W / 2, H / 2, Math.max(W, H) * 0.75);
  vg.addColorStop(0, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(0,0,0,0.65)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, W, H);
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

export interface ScreenActions {
  onPlay: (meta: WorldMeta, mode: GameModeName) => void;
  onDelete: (id: string) => void;
  onSettingsChanged: (s: Settings) => void;
  onQuitToTitle: () => void;
  onResume: () => void;
  onSave: () => void;
  onSaveAndQuit: () => void;
  onRespawn: () => void;
}

export class Screens {
  private root: HTMLElement;
  private actions: ScreenActions;
  private atlas: Atlas;
  settings: Settings;
  private stack: string[] = [];
  private createdMode: GameModeName = 'survival';
  private current: HTMLElement | null = null;

  constructor(root: HTMLElement, atlas: Atlas, actions: ScreenActions) {
    this.root = root;
    this.atlas = atlas;
    this.actions = actions;
    this.settings = loadSettings();
  }

  /* ---------------------------------------------------------------- */

  private mount(html: string, cls = 'screen'): HTMLElement {
    this.unmount();
    const el = document.createElement('div');
    el.className = cls;
    el.innerHTML = html;
    this.root.appendChild(el);
    this.current = el;
    return el;
  }

  private unmount(): void {
    if (this.current && this.current.parentElement) this.current.parentElement.removeChild(this.current);
    this.current = null;
  }

  get isOpen(): boolean {
    return this.current !== null;
  }

  hideAll(): void {
    this.unmount();
  }

  /* ---------------------------------------------------------------- */
  /* Title                                                             */
  /* ---------------------------------------------------------------- */

  showTitle(): void {
    const el = this.mount(`
      <canvas id="panorama"></canvas>
      <div class="title-wrap">
        <div class="title-logo">
          <div class="title-text pixel-text">CUBEWORLD</div>
          <div class="title-sub">an original voxel survival sandbox</div>
        </div>
        <button class="btn" id="btn-single">Singleplayer</button>
        <button class="btn" id="btn-create">Create New World</button>
        <button class="btn" id="btn-settings">Settings</button>
      </div>
      <div class="version-tag pixel-text">CubeWorld 1.0 &middot; ${SaveSystem.available() ? 'saves enabled' : 'storage unavailable'}</div>
    `);
    const canvas = el.querySelector('#panorama') as HTMLCanvasElement;
    canvas.width = Math.min(1920, Math.max(960, window.innerWidth));
    canvas.height = Math.min(1080, Math.max(540, window.innerHeight));
    drawPanorama(canvas, this.atlas);

    (el.querySelector('#btn-single') as HTMLButtonElement).onclick = () => this.showWorldList();
    (el.querySelector('#btn-create') as HTMLButtonElement).onclick = () => this.showCreate();
    (el.querySelector('#btn-settings') as HTMLButtonElement).onclick = () => this.showSettings('title');
  }

  /* ---------------------------------------------------------------- */
  /* World list                                                        */
  /* ---------------------------------------------------------------- */

  showWorldList(): void {
    const worlds = SaveSystem.listWorlds();
    const rows = worlds.length
      ? worlds
          .map((w) => {
            const kb = Math.round(SaveSystem.estimateSize(w.id) / 1024);
            const date = new Date(w.lastPlayed).toLocaleDateString();
            return `<div class="world-entry" data-id="${w.id}">
              <span>${escapeHtml(w.name)}<br><span class="meta">${w.gameMode} &middot; seed ${w.seed} &middot; ${date} &middot; ${kb} KB</span></span>
              <button class="btn del" style="width:auto;padding:4px 10px;margin:0" data-del="${w.id}">Delete</button>
            </div>`;
          })
          .join('')
      : '<div class="world-entry"><span class="meta">No worlds yet - create one!</span></div>';

    const el = this.mount(`
      <div class="screen-panel">
        <h2 class="pixel-text">Select World</h2>
        <div class="world-list">${rows}</div>
        <button class="btn" id="back">Back</button>
      </div>
    `);
    el.querySelectorAll('.world-entry[data-id]').forEach((row) => {
      (row as HTMLElement).onclick = (e) => {
        if ((e.target as HTMLElement).dataset.del) return;
        const id = (row as HTMLElement).dataset.id!;
        const meta = SaveSystem.listWorlds().find((w) => w.id === id);
        if (meta) this.actions.onPlay(meta, meta.gameMode);
      };
    });
    el.querySelectorAll('[data-del]').forEach((btn) => {
      (btn as HTMLElement).onclick = (e) => {
        e.stopPropagation();
        const id = (btn as HTMLElement).dataset.del!;
        SaveSystem.delete(id);
        this.actions.onDelete(id);
        this.showWorldList();
      };
    });
    (el.querySelector('#back') as HTMLButtonElement).onclick = () => this.showTitle();
  }

  /* ---------------------------------------------------------------- */
  /* Create world                                                      */
  /* ---------------------------------------------------------------- */

  showCreate(): void {
    const el = this.mount(`
      <div class="screen-panel">
        <h2 class="pixel-text">Create New World</h2>
        <div class="field"><label>World Name</label><input type="text" id="w-name" value="New World" maxlength="32" /></div>
        <div class="field"><label>Seed</label><input type="text" id="w-seed" placeholder="leave blank for random" maxlength="24" /></div>
        <div class="field" style="display:block"><label style="display:block;margin-bottom:6px">Game Mode</label>
          <div class="mode-toggle">
            <button data-mode="survival" class="active">Survival</button>
            <button data-mode="creative">Creative</button>
          </div>
        </div>
        <div class="field"><label>Render Distance</label><input type="range" id="w-rd" min="4" max="16" step="1" value="${this.settings.renderDistance}" /><span id="w-rd-v">${this.settings.renderDistance}</span></div>
        <button class="btn" id="create">Create World</button>
        <button class="btn" id="back">Back</button>
        <div class="hint">Survival: gather, craft and fight. Creative: fly and build with every block.</div>
      </div>
    `);

    el.querySelectorAll('.mode-toggle button').forEach((b) => {
      (b as HTMLButtonElement).onclick = () => {
        el.querySelectorAll('.mode-toggle button').forEach((x) => x.classList.remove('active'));
        b.classList.add('active');
        this.createdMode = (b as HTMLElement).dataset.mode as GameModeName;
      };
    });
    const rd = el.querySelector('#w-rd') as HTMLInputElement;
    rd.oninput = () => {
      (el.querySelector('#w-rd-v') as HTMLElement).textContent = rd.value;
    };
    (el.querySelector('#back') as HTMLButtonElement).onclick = () => this.showTitle();
    (el.querySelector('#create') as HTMLButtonElement).onclick = () => {
      const name = (el.querySelector('#w-name') as HTMLInputElement).value.trim() || 'New World';
      const seedText = (el.querySelector('#w-seed') as HTMLInputElement).value.trim();
      const seed = seedFromString(seedText);
      this.settings.renderDistance = Number(rd.value);
      saveSettings(this.settings);
      const meta: WorldMeta = {
        id: newWorldId(seed),
        name,
        seed,
        gameMode: this.createdMode,
        createdAt: Date.now(),
        lastPlayed: Date.now(),
        playTime: 0,
      };
      SaveSystem.upsertMeta(meta);
      this.actions.onSettingsChanged(this.settings);
      this.actions.onPlay(meta, this.createdMode);
    };
  }

  /* ---------------------------------------------------------------- */
  /* Settings                                                          */
  /* ---------------------------------------------------------------- */

  showSettings(from: 'title' | 'pause' = 'title'): void {
    const s = this.settings;
    const el = this.mount(`
      <div class="screen-panel">
        <h2 class="pixel-text">Settings</h2>
        <div class="field"><label>Render Distance</label><input type="range" id="s-rd" min="4" max="16" step="1" value="${s.renderDistance}" /><span id="s-rd-v">${s.renderDistance}</span></div>
        <div class="field"><label>Field of View</label><input type="range" id="s-fov" min="55" max="100" step="1" value="${s.fov}" /><span id="s-fov-v">${s.fov}</span></div>
        <div class="field"><label>Sensitivity</label><input type="range" id="s-sens" min="0.2" max="3" step="0.05" value="${s.mouseSensitivity}" /><span id="s-sens-v">${s.mouseSensitivity.toFixed(2)}</span></div>
        <div class="field"><label>View Bobbing</label><input type="range" id="s-bob" min="0" max="1.5" step="0.05" value="${s.bobAmount}" /><span id="s-bob-v">${s.bobAmount.toFixed(2)}</span></div>
        <div class="field"><label>Master Volume</label><input type="range" id="s-master" min="0" max="1" step="0.05" value="${s.masterVolume}" /><span id="s-master-v">${Math.round(s.masterVolume * 100)}</span></div>
        <div class="field"><label>Sound Effects</label><input type="range" id="s-sfx" min="0" max="1" step="0.05" value="${s.sfxVolume}" /><span id="s-sfx-v">${Math.round(s.sfxVolume * 100)}</span></div>
        <div class="field"><label>Music</label><input type="range" id="s-music" min="0" max="1" step="0.05" value="${s.musicVolume}" /><span id="s-music-v">${Math.round(s.musicVolume * 100)}</span></div>
        <div class="field"><label>Show FPS</label><input type="checkbox" id="s-fps" ${s.showFps ? 'checked' : ''} style="flex:0" /></div>
        <div class="field"><label>Graphics</label>
          <select id="s-gfx">
            <option value="fancy" ${s.graphics === 'fancy' ? 'selected' : ''}>Fancy</option>
            <option value="fast" ${s.graphics === 'fast' ? 'selected' : ''}>Fast</option>
          </select>
        </div>
        <button class="btn" id="done">Done</button>
        <div class="hint">Controls: WASD move &middot; Space jump &middot; Shift sneak &middot; Ctrl sprint &middot; E inventory<br>
        Left click break/attack &middot; Right click place/use &middot; 1-9 or scroll to select &middot; F3 debug &middot; Esc pause</div>
      </div>
    `);

    const bind = (id: string, key: keyof Settings, fmt: (v: number) => string, scale = 1): void => {
      const input = el.querySelector(`#${id}`) as HTMLInputElement;
      const out = el.querySelector(`#${id}-v`) as HTMLElement | null;
      const apply = (): void => {
        const v = Number(input.value) * scale;
        (this.settings as unknown as Record<string, number>)[key as string] = v;
        if (out) out.textContent = fmt(v);
        saveSettings(this.settings);
        this.actions.onSettingsChanged(this.settings);
      };
      input.oninput = apply;
      input.onchange = apply;
    };
    bind('s-rd', 'renderDistance', (v) => String(v));
    bind('s-fov', 'fov', (v) => String(v));
    bind('s-sens', 'mouseSensitivity', (v) => v.toFixed(2));
    bind('s-bob', 'bobAmount', (v) => v.toFixed(2));
    bind('s-master', 'masterVolume', (v) => String(Math.round(v * 100)));
    bind('s-sfx', 'sfxVolume', (v) => String(Math.round(v * 100)));
    bind('s-music', 'musicVolume', (v) => String(Math.round(v * 100)));

    const fps = el.querySelector('#s-fps') as HTMLInputElement;
    fps.onchange = () => {
      this.settings.showFps = fps.checked;
      saveSettings(this.settings);
      this.actions.onSettingsChanged(this.settings);
    };
    const gfx = el.querySelector('#s-gfx') as HTMLSelectElement;
    gfx.onchange = () => {
      this.settings.graphics = gfx.value === 'fast' ? 'fast' : 'fancy';
      saveSettings(this.settings);
      this.actions.onSettingsChanged(this.settings);
    };
    (el.querySelector('#done') as HTMLButtonElement).onclick = () => {
      if (from === 'title') this.showTitle();
      else this.showPause();
    };
  }

  /* ---------------------------------------------------------------- */
  /* Pause                                                             */
  /* ---------------------------------------------------------------- */

  showPause(): void {
    const el = this.mount(`
      <div class="screen-panel" style="min-width:320px">
        <h2 class="pixel-text">Game Paused</h2>
        <button class="btn" id="resume">Back to Game</button>
        <button class="btn" id="settings">Settings</button>
        <button class="btn" id="save">Save World</button>
        <button class="btn" id="quit">Save and Quit to Title</button>
        <div class="hint" id="pause-hint">Autosaves every 60 seconds.</div>
      </div>
    `);
    (el.querySelector('#resume') as HTMLButtonElement).onclick = () => this.actions.onResume();
    (el.querySelector('#settings') as HTMLButtonElement).onclick = () => this.showSettings('pause');
    (el.querySelector('#save') as HTMLButtonElement).onclick = () => {
      this.actions.onSave();
      (el.querySelector('#pause-hint') as HTMLElement).textContent = 'World saved.';
    };
    (el.querySelector('#quit') as HTMLButtonElement).onclick = () => this.actions.onSaveAndQuit();
  }

  /* ---------------------------------------------------------------- */
  /* Loading                                                           */
  /* ---------------------------------------------------------------- */

  showLoading(title: string): HTMLElement {
    const el = this.mount(
      `<div class="loading-title pixel-text">${escapeHtml(title)}</div>
       <div class="progress-outer"><div class="progress-inner" id="bar"></div></div>
       <div class="loading-message" id="msg">Preparing...</div>`,
      'screen',
    );
    el.id = 'loading';
    return el;
  }

  setLoading(progress: number, message: string): void {
    if (!this.current) return;
    const bar = this.current.querySelector('#bar') as HTMLElement | null;
    const msg = this.current.querySelector('#msg') as HTMLElement | null;
    if (bar) bar.style.width = `${Math.round(Math.max(0, Math.min(1, progress)) * 100)}%`;
    if (msg && msg.textContent !== message) msg.textContent = message;
  }

  /* ---------------------------------------------------------------- */
  /* Death                                                             */
  /* ---------------------------------------------------------------- */

  showDeath(message = 'You Died!'): void {
    const el = this.mount(`
      <h1 class="pixel-text">${escapeHtml(message)}</h1>
      <button class="btn" id="respawn">Respawn</button>
      <div class="hint">Your items were dropped where you fell.</div>
    `);
    el.id = 'death-screen';
    (el.querySelector('#respawn') as HTMLButtonElement).onclick = () => this.actions.onRespawn();
  }

  push(id: string): void {
    this.stack.push(id);
  }

  /**
   * Visible runtime failure. Anything that throws inside the frame loop lands
   * here instead of leaving the player staring at a blank screen with no clue.
   */
  showError(message: string): void {
    if (this.errorShown) return;
    this.errorShown = true;
    const el = this.mount(
      `<div class="screen-panel" style="min-width:520px;max-width:80vw">
        <h2 class="pixel-text" style="color:#ff9a9a">Something went wrong</h2>
        <pre style="white-space:pre-wrap;font-size:12px;line-height:1.5;color:#ffd0d0;max-height:40vh;overflow:auto">${escapeHtml(message)}</pre>
        <button class="btn" id="dismiss">Dismiss</button>
        <div class="hint">Press F3 for the debug overlay. The browser console has the full trace.</div>
      </div>`,
    );
    (el.querySelector('#dismiss') as HTMLButtonElement).onclick = () => {
      this.errorShown = false;
      this.hideAll();
    };
  }

  private errorShown = false;

  dispose(): void {
    this.unmount();
  }
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string));
}
