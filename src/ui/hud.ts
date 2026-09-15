/**
 * In-game HUD: crosshair, hotbar, health/hunger/air bars, item name toast,
 * damage flash, underwater tint and the F3 debug overlay.
 *
 * Icons are drawn procedurally as pixel patterns so no image files are needed.
 */

import type { Atlas } from '../render/atlas.js';
import { Inventory, HOTBAR_SIZE } from '../items/inventory.js';
import { itemDisplay, itemDef } from '../items/items.js';
import { makeIcon } from './icons.js';

type Pattern = string[];

const HEART: Pattern = [
  '.oo..oo..',
  'ohhoorro.',
  'ohrroRRRo',
  'orrrrrrro',
  'orrrrrrro',
  '.orrrrro.',
  '..orrro..',
  '...oro...',
  '....o....',
];
const HEART_EMPTY: Pattern = [
  '.oo..oo..',
  'oeeooeeo.',
  'oeeeeeeeo',
  'oeeeeeeeo',
  'oeeeeeeeo',
  '.oeeeeeo.',
  '..oeeeo..',
  '...oeo...',
  '....o....',
];
const HUNGER: Pattern = [
  '..ooo....',
  '.ottto...',
  'ottttto..',
  'ottttto..',
  'ottttoo..',
  '.ottoooo.',
  '..oobbbbo',
  '...obbbbo',
  '....oooo.',
];
const HUNGER_EMPTY: Pattern = [
  '..ooo....',
  '.oeeeo...',
  'oeeeeeo..',
  'oeeeeeo..',
  'oeeeeoo..',
  '.oeoooo..',
  '..oo....',
  '........',
  '........',
];
const BUBBLE: Pattern = [
  '..oooo..',
  '.obbbbo.',
  'obwbbbeo',
  'obbbbeeo',
  'obbbbeeo',
  'obbbeeeo',
  '.obeeeo.',
  '..oooo..',
];

const COLORS: Record<string, string> = {
  o: '#1a0a0a',
  r: '#d43a2f',
  R: '#ff6a5a',
  h: '#ff9a8a',
  e: '#4a4a4a',
  t: '#a9642c',
  b: '#efe6d0',
  w: '#ffffff',
  '.': 'transparent',
};

function patternCanvas(pattern: Pattern, overrides: Record<string, string> = {}): HTMLCanvasElement {
  const h = pattern.length;
  const w = pattern[0].length;
  const scale = 2;
  const c = document.createElement('canvas');
  c.width = w * scale;
  c.height = h * scale;
  c.className = 'bar-icon';
  const ctx = c.getContext('2d')!;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const ch = pattern[y][x];
      if (ch === '.') continue;
      ctx.fillStyle = overrides[ch] ?? COLORS[ch] ?? '#f0f';
      ctx.fillRect(x * scale, y * scale, scale, scale);
    }
  }
  return c;
}

/** Half-filled variant: only the left half of the pattern is drawn. */
function halfCanvas(pattern: Pattern): HTMLCanvasElement {
  const c = patternCanvas(pattern);
  const ctx = c.getContext('2d')!;
  const half = Math.floor(c.width / 2);
  ctx.clearRect(half, 0, c.width - half, c.height);
  const outline = patternCanvas(pattern);
  // keep the outline on the right half so the shape stays readable
  ctx.drawImage(outline, half, 0, c.width - half, c.height, half, 0, c.width - half, c.height);
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(outline, 0, 0);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

export interface HudState {
  debugVisible: boolean;
  debugText: string;
  damageFlash: number;
  underwater: boolean;
}

export class Hud {
  private root: HTMLElement;
  private crosshair: HTMLElement;
  private hotbar: HTMLElement;
  private healthRow: HTMLElement;
  private hungerRow: HTMLElement;
  private airRow: HTMLElement;
  private itemNameEl: HTMLElement;
  private debugEl: HTMLElement | null;
  private damageEl: HTMLElement;
  private waterEl: HTMLElement;
  private toastEl: HTMLElement;
  private clickHint: HTMLElement;
  private blockAtlas: Atlas;
  private itemAtlas: Atlas;

  private icons = {
    heart: patternCanvas(HEART),
    heartHalf: halfCanvas(HEART),
    heartEmpty: patternCanvas(HEART_EMPTY),
    hunger: patternCanvas(HUNGER),
    hungerHalf: halfCanvas(HUNGER),
    hungerEmpty: patternCanvas(HUNGER_EMPTY),
    bubble: patternCanvas(BUBBLE),
  };

  private slotEls: HTMLElement[] = [];
  private slotSig: string[] = new Array(HOTBAR_SIZE).fill('\u0000');
  private healthSig = -1;
  private hungerSig = -1;
  private airSig = -1;
  private nameTimer = 0;
  private toastTimer = 0;
  private flash = 0;

  constructor(root: HTMLElement, blockAtlas: Atlas, itemAtlas: Atlas) {
    this.blockAtlas = blockAtlas;
    this.itemAtlas = itemAtlas;
    this.root = root;

    root.innerHTML = `
      <div id="vignette"></div>
      <div id="water-overlay"></div>
      <div id="damage-flash"></div>
      <div id="crosshair"></div>
      <div id="click-hint" class="hidden">Click to play</div>
      <div id="toast"></div>
      <div id="bottom-hud">
        <div id="air-row"></div>
        <div id="stats-bars">
          <div class="bar-row" id="health-row"></div>
          <div class="bar-row" id="hunger-row"></div>
        </div>
        <div id="item-name"></div>
        <div id="hotbar"></div>
      </div>
    `;

    this.crosshair = root.querySelector('#crosshair') as HTMLElement;
    this.hotbar = root.querySelector('#hotbar') as HTMLElement;
    this.healthRow = root.querySelector('#health-row') as HTMLElement;
    this.hungerRow = root.querySelector('#hunger-row') as HTMLElement;
    this.airRow = root.querySelector('#air-row') as HTMLElement;
    this.itemNameEl = root.querySelector('#item-name') as HTMLElement;
    this.debugEl = root.querySelector('#debug') as HTMLElement | null;
    this.damageEl = root.querySelector('#damage-flash') as HTMLElement;
    this.waterEl = root.querySelector('#water-overlay') as HTMLElement;
    this.toastEl = root.querySelector('#toast') as HTMLElement;
    this.clickHint = root.querySelector('#click-hint') as HTMLElement;

    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const el = document.createElement('div');
      el.className = 'hotbar-slot';
      el.dataset.slot = String(i);
      this.hotbar.appendChild(el);
      this.slotEls.push(el);
    }
    for (let i = 0; i < 10; i++) {
      this.healthRow.appendChild(this.icons.heart.cloneNode(true) as HTMLCanvasElement);
      this.hungerRow.appendChild(this.icons.hunger.cloneNode(true) as HTMLCanvasElement);
    }
    for (let i = 0; i < 10; i++) {
      const b = this.icons.bubble.cloneNode(true) as HTMLCanvasElement;
      b.style.display = 'none';
      this.airRow.appendChild(b);
    }
  }

  setCrosshairVisible(v: boolean): void {
    this.crosshair.style.display = v ? '' : 'none';
  }

  /** Shown when the game is running but the pointer is not captured. */
  setClickHint(visible: boolean): void {
    this.clickHint.classList.toggle('hidden', !visible);
  }

  showItemName(name: string): void {
    this.itemNameEl.textContent = name;
    this.itemNameEl.classList.add('show');
    this.nameTimer = 2;
  }

  showToast(message: string, seconds = 3): void {
    this.toastEl.textContent = message;
    this.toastEl.classList.add('show');
    this.toastTimer = seconds;
  }

  private updateHotbar(inv: Inventory): void {
    for (let i = 0; i < HOTBAR_SIZE; i++) {
      const stack = inv.slots[i];
      const el = this.slotEls[i];
      const sig = stack ? `${stack.item}:${stack.count}:${stack.damage ?? 0}` : '';
      el.classList.toggle('selected', i === inv.selected);
      if (sig === this.slotSig[i]) continue;
      this.slotSig[i] = sig;
      el.innerHTML = '';
      if (stack) {
        const icon = makeIcon(this.blockAtlas, this.itemAtlas, stack.item, 34);
        el.appendChild(icon);
        if (stack.count > 1) {
          const c = document.createElement('span');
          c.className = 'slot-count';
          c.textContent = String(stack.count);
          el.appendChild(c);
        }
        const def = itemDef(stack.item);
        if (def && def.durability > 0 && stack.damage) {
          const bar = document.createElement('div');
          bar.className = 'durability';
          const inner = document.createElement('i');
          const frac = Math.max(0, 1 - stack.damage / def.durability);
          inner.style.width = `${frac * 100}%`;
          inner.style.background = frac > 0.5 ? '#4ee04e' : frac > 0.25 ? '#e0d24e' : '#e04e4e';
          bar.appendChild(inner);
          el.appendChild(bar);
        }
      }
    }
  }

  private updateBars(row: HTMLElement, value: number, full: HTMLCanvasElement, half: HTMLCanvasElement, empty: HTMLCanvasElement): void {
    const ten = value / 2;
    for (let i = 0; i < 10; i++) {
      const el = row.children[i] as HTMLCanvasElement;
      const src = ten >= i + 1 ? full : ten > i ? half : empty;
      if (el.dataset.state !== src.dataset.state) {
        el.dataset.state = src.dataset.state ?? String(i);
      }
      // cheap: replace the bitmap only when the state changes
      const state = ten >= i + 1 ? 'f' : ten > i ? 'h' : 'e';
      if (el.dataset.k !== state) {
        el.dataset.k = state;
        const ctx = el.getContext('2d');
        if (ctx) {
          ctx.clearRect(0, 0, el.width, el.height);
          ctx.drawImage(src, 0, 0);
        }
      }
    }
  }

  update(dt: number, inv: Inventory, opts: HudState, extra: { health: number; hunger: number; air: number; maxAir: number; survival: boolean }): void {
    this.updateHotbar(inv);

    const health = Math.round(extra.health);
    if (health !== this.healthSig) {
      this.healthSig = health;
      this.updateBars(this.healthRow, health, this.icons.heart, this.icons.heartHalf, this.icons.heartEmpty);
    }
    const hunger = Math.round(extra.hunger);
    if (hunger !== this.hungerSig) {
      this.hungerSig = hunger;
      this.updateBars(this.hungerRow, hunger, this.icons.hunger, this.icons.hungerHalf, this.icons.hungerEmpty);
    }
    this.healthRow.style.display = extra.survival ? '' : 'none';
    this.hungerRow.style.display = extra.survival ? '' : 'none';

    const bubbles = extra.survival && extra.air < extra.maxAir ? Math.ceil((extra.air / extra.maxAir) * 10) : 0;
    if (bubbles !== this.airSig) {
      this.airSig = bubbles;
      for (let i = 0; i < 10; i++) {
        (this.airRow.children[i] as HTMLElement).style.display = i < bubbles ? '' : 'none';
      }
    }

    if (this.nameTimer > 0) {
      this.nameTimer -= dt;
      if (this.nameTimer <= 0) this.itemNameEl.classList.remove('show');
    }
    if (this.toastTimer > 0) {
      this.toastTimer -= dt;
      if (this.toastTimer <= 0) this.toastEl.classList.remove('show');
    }

    if (opts.damageFlash > 0) this.flash = Math.max(this.flash, opts.damageFlash);
    this.flash = Math.max(0, this.flash - dt * 1.4);
    this.damageEl.style.opacity = String(Math.min(1, this.flash));

    this.waterEl.style.opacity = opts.underwater ? '1' : '0';
    void opts.debugText;
    void opts.debugVisible;
  }

  setHeldName(name: string | null): void {
    this.showItemName(name ? itemDisplay(name) : '');
  }
}
