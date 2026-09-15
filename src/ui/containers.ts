/**
 * Container screens: survival inventory (with 2x2 crafting), crafting table
 * (3x3), furnace and chest.
 *
 * All four share one implementation: the panel is described as a list of slot
 * references, and a single delegated click handler routes interactions through
 * `slotClick`, so drag/split/merge behaves identically everywhere.
 */

import type { Atlas } from '../render/atlas.js';
import { ChestState, CraftingGrid, FurnaceState, Inventory, ItemStack, slotClick, ClickButton, emptySlots } from '../items/inventory.js';
import { findRecipe } from '../items/recipes.js';
import { itemDef, itemDisplay, makeStack } from '../items/items.js';
import { makeIcon } from './icons.js';

export type SlotRef =
  | { kind: 'inv'; index: number }
  | { kind: 'craft'; index: number }
  | { kind: 'result' }
  | { kind: 'furnace'; part: 'input' | 'fuel' | 'output' }
  | { kind: 'chest'; index: number };

export type ContainerKind = 'inventory' | 'crafting_table' | 'furnace' | 'chest';

export interface ContainerContext {
  kind: ContainerKind;
  inventory: Inventory;
  crafting: CraftingGrid;
  furnace?: FurnaceState | null;
  chest?: ChestState | null;
}

export class ContainerUI {
  private root: HTMLElement;
  private blockAtlas: Atlas;
  private itemAtlas: Atlas;
  private panel!: HTMLElement;
  private cursorEl!: HTMLElement;
  private tooltipEl!: HTMLElement;
  private open_ = false;
  private ctx: ContainerContext | null = null;
  private cursor: ItemStack | null = null;
  private slotEls = new Map<string, HTMLElement>();
  private refs: SlotRef[] = [];
  private sigs = new Map<string, string>();
  private mouseX = 0;
  private mouseY = 0;
  private lastClickTime = 0;

  onClose: (() => void) | null = null;
  /** called whenever the crafting grid changes so the game can play a sound */
  onCraft: (() => void) | null = null;
  /**
   * Called with whatever was on the cursor when the screen closed and did not
   * fit in the inventory, so the game can drop it on the ground instead of
   * destroying it. Without a handler the overflow is discarded.
   */
  onDropCursor: ((stack: ItemStack) => void) | null = null;

  constructor(root: HTMLElement, blockAtlas: Atlas, itemAtlas: Atlas) {
    this.root = root;
    this.blockAtlas = blockAtlas;
    this.itemAtlas = itemAtlas;
    this.build();
  }

  get isOpen(): boolean {
    return this.open_;
  }

  private build(): void {
    this.root.innerHTML = `
      <div id="container-screen" class="hidden">
        <div class="container-panel" id="container-panel"></div>
      </div>
      <div id="cursor-stack"></div>
      <div class="tooltip hidden" id="ui-tooltip"></div>
    `;
    this.panel = this.root.querySelector('#container-panel') as HTMLElement;
    this.cursorEl = this.root.querySelector('#cursor-stack') as HTMLElement;
    this.tooltipEl = this.root.querySelector('#ui-tooltip') as HTMLElement;
    const screen = this.root.querySelector('#container-screen') as HTMLElement;

    screen.addEventListener('mousedown', (e) => this.onMouseDown(e as MouseEvent));
    screen.addEventListener('contextmenu', (e) => e.preventDefault());
    window.addEventListener('mousemove', (e) => {
      this.mouseX = e.clientX;
      this.mouseY = e.clientY;
      this.cursorEl.style.left = `${e.clientX}px`;
      this.cursorEl.style.top = `${e.clientY}px`;
      this.updateTooltip(e);
    });
  }

  private updateTooltip(e: MouseEvent): void {
    if (!this.open_) return;
    const target = (e.target as HTMLElement).closest('[data-slot]') as HTMLElement | null;
    if (!target) {
      this.tooltipEl.classList.add('hidden');
      return;
    }
    const ref = this.refs[Number(target.dataset.slot)];
    const stack = ref ? this.stackAt(ref) : null;
    if (!stack) {
      this.tooltipEl.classList.add('hidden');
      return;
    }
    const def = itemDef(stack.item);
    let text = itemDisplay(stack.item);
    if (def && def.durability > 0 && stack.damage) {
      text += `\nDurability ${def.durability - stack.damage} / ${def.durability}`;
    }
    if (def && def.toolClass !== 'none') text += `\n${def.toolClass} - tier ${def.tier}`;
    if (def && def.food) text += `\nFood +${def.food.hunger}`;
    this.tooltipEl.textContent = text;
    this.tooltipEl.classList.remove('hidden');
    this.tooltipEl.style.left = `${e.clientX + 14}px`;
    this.tooltipEl.style.top = `${e.clientY + 10}px`;
    this.tooltipEl.style.whiteSpace = 'pre';
  }

  /* ---------------------------------------------------------------- */

  open(ctx: ContainerContext): void {
    if (!ctx.furnace) ctx.furnace = null;
    if (!ctx.chest) ctx.chest = null;
    this.ctx = ctx;
    this.open_ = true;
    this.cursor = null;
    (this.root.querySelector('#container-screen') as HTMLElement).classList.remove('hidden');
    this.layout();
  }

  close(): void {
    if (!this.open_) return;
    // return the crafting grid and the cursor to the inventory
    if (this.ctx) {
      this.ctx.crafting.drainTo(this.ctx.inventory);
      if (this.cursor) {
        // `add` only reads the stack, so what did not fit is still known here
        const spilled = this.cursor;
        const left = this.ctx.inventory.add(spilled);
        if (left > 0) {
          const overflow = { ...spilled, count: left };
          // never destroy what the player is holding: the game turns it into
          // a real drop entity, and only an unhooked UI discards it
          if (this.onDropCursor) this.onDropCursor(overflow);
          else this.dropCursor(left);
        }
        this.cursor = null;
      }
    }
    this.open_ = false;
    this.ctx = null;
    (this.root.querySelector('#container-screen') as HTMLElement).classList.add('hidden');
    this.tooltipEl.classList.add('hidden');
    this.cursorEl.classList.remove('visible');
    if (this.onClose) this.onClose();
  }

  dropCursor(_left: number): void {
    // overflow is discarded; the game may hook this to spawn an item entity
  }

  /* ---------------------------------------------------------------- */

  private layout(): void {
    if (!this.ctx) return;
    this.slotEls.clear();
    this.refs = [];
    this.sigs.clear();
    const c = this.ctx;
    const html: string[] = [];

    const slot = (ref: SlotRef, extraClass = ''): string => {
      const id = this.refs.length;
      this.refs.push(ref);
      return `<div class="slot ${extraClass}" data-slot="${id}"></div>`;
    };

    if (c.kind === 'inventory' || c.kind === 'crafting_table') {
      const n = c.crafting.size;
      html.push(`<div class="container-title">${c.kind === 'inventory' ? 'Crafting' : 'Crafting Table'}</div>`);
      html.push('<div class="craft-area">');
      html.push(`<div class="slot-grid" style="grid-template-columns: repeat(${n}, var(--slot));">`);
      for (let i = 0; i < n * n; i++) html.push(slot({ kind: 'craft', index: i }));
      html.push('</div>');
      html.push('<div class="craft-arrow">&#10148;</div>');
      html.push(slot({ kind: 'result' }, 'result-slot'));
      html.push('</div>');
    } else if (c.kind === 'furnace') {
      html.push('<div class="container-title">Furnace</div>');
      html.push('<div class="furnace-row">');
      html.push('<div class="furnace-col">');
      html.push(slot({ kind: 'furnace', part: 'input' }));
      html.push('<div class="flame"><i id="furnace-flame" style="height:0%"></i></div>');
      html.push(slot({ kind: 'furnace', part: 'fuel' }));
      html.push('</div>');
      html.push('<div class="arrow-progress"><i id="furnace-progress" style="width:0%"></i></div>');
      html.push(slot({ kind: 'furnace', part: 'output' }, 'result-slot'));
      html.push('</div>');
    } else if (c.kind === 'chest') {
      html.push('<div class="container-title">Chest</div>');
      html.push('<div class="slot-grid" style="grid-template-columns: repeat(9, var(--slot));">');
      for (let i = 0; i < 27; i++) html.push(slot({ kind: 'chest', index: i }));
      html.push('</div>');
    }

    html.push('<div style="height:10px"></div>');
    html.push('<div class="container-title">Inventory</div>');
    html.push('<div class="slot-grid" style="grid-template-columns: repeat(9, var(--slot));">');
    for (let i = 9; i < 36; i++) html.push(slot({ kind: 'inv', index: i }));
    html.push('</div>');
    html.push('<div style="height:6px"></div>');
    html.push('<div class="slot-grid" style="grid-template-columns: repeat(9, var(--slot));">');
    for (let i = 0; i < 9; i++) html.push(slot({ kind: 'inv', index: i }));
    html.push('</div>');
    html.push(`<div class="hint" style="color:#4a4a4a;text-shadow:none;">Press E or Escape to close &middot; Shift+click to move a stack</div>`);

    this.panel.innerHTML = html.join('');
    for (let i = 0; i < this.refs.length; i++) {
      const el = this.panel.querySelector(`[data-slot="${i}"]`) as HTMLElement;
      if (el) this.slotEls.set(String(i), el);
    }
    this.refresh(true);
  }

  /* ---------------------------------------------------------------- */

  private stackAt(ref: SlotRef): ItemStack | null {
    const c = this.ctx;
    if (!c) return null;
    switch (ref.kind) {
      case 'inv':
        return c.inventory.slots[ref.index];
      case 'craft':
        return c.crafting.slots[ref.index] ?? null;
      case 'result': {
        const r = findRecipe(c.crafting);
        return r ? makeStack(r.output.item, r.output.count) : null;
      }
      case 'furnace': {
        const f = c.furnace;
        if (!f) return null;
        return ref.part === 'input' ? f.input : ref.part === 'fuel' ? f.fuel : f.output;
      }
      case 'chest':
        return c.chest ? c.chest.slots[ref.index] : null;
      default:
        return null;
    }
  }

  private setStack(ref: SlotRef, stack: ItemStack | null): void {
    const c = this.ctx;
    if (!c) return;
    switch (ref.kind) {
      case 'inv':
        c.inventory.slots[ref.index] = stack;
        break;
      case 'craft':
        c.crafting.slots[ref.index] = stack;
        break;
      case 'furnace': {
        const f = c.furnace;
        if (!f) break;
        if (ref.part === 'input') f.input = stack;
        else if (ref.part === 'fuel') f.fuel = stack;
        else f.output = stack;
        break;
      }
      case 'chest':
        if (c.chest) c.chest.slots[ref.index] = stack;
        break;
      default:
        break;
    }
  }

  private onMouseDown(e: MouseEvent): void {
    if (!this.open_ || !this.ctx) return;
    const target = (e.target as HTMLElement).closest('[data-slot]') as HTMLElement | null;
    if (!target) return;
    e.preventDefault();
    const ref = this.refs[Number(target.dataset.slot)];
    if (!ref) return;
    const button: ClickButton = e.button === 2 ? 'right' : 'left';
    const shift = e.shiftKey;
    const now = performance.now();
    const doubleClick = now - this.lastClickTime < 260;
    this.lastClickTime = now;

    if (ref.kind === 'result') {
      this.takeCraft(button, shift);
      return;
    }

    if (shift) {
      this.quickMove(ref);
      return;
    }

    const slot = this.stackAt(ref);
    const res = slotClick(slot, this.cursor, button);
    this.setStack(ref, res.slot);
    this.cursor = res.cursor;
    if (doubleClick && this.cursor && !slot) {
      // gather matching stacks into the cursor
      this.gatherSimilar(ref);
    }
    this.refresh(true);
  }

  private gatherSimilar(_ref: SlotRef): void {
    if (!this.ctx || !this.cursor) return;
    const limit = itemDef(this.cursor.item)?.stackSize ?? 64;
    const c = this.ctx;
    for (let i = 0; i < c.inventory.slots.length && this.cursor.count < limit; i++) {
      const s = c.inventory.slots[i];
      if (!s || s.item !== this.cursor!.item) continue;
      const move = Math.min(limit - this.cursor.count, s.count);
      this.cursor.count += move;
      s.count -= move;
      if (s.count <= 0) c.inventory.slots[i] = null;
    }
    for (let i = 0; i < c.crafting.slots.length && this.cursor.count < limit; i++) {
      const s = c.crafting.slots[i];
      if (!s || s.item !== this.cursor!.item) continue;
      const move = Math.min(limit - this.cursor.count, s.count);
      this.cursor.count += move;
      s.count -= move;
      if (s.count <= 0) c.crafting.slots[i] = null;
    }
  }

  private takeCraft(button: ClickButton, shift: boolean): void {
    const c = this.ctx;
    if (!c) return;
    const recipe = findRecipe(c.crafting);
    if (!recipe) return;
    const output = makeStack(recipe.output.item, recipe.output.count);
    const limit = itemDef(output.item)?.stackSize ?? 64;

    if (shift) {
      // craft as many as possible straight into the inventory
      let guard = 0;
      while (findRecipe(c.crafting) && guard++ < 64) {
        const r = findRecipe(c.crafting)!;
        const left = c.inventory.add(makeStack(r.output.item, r.output.count));
        if (left > 0) break;
        c.crafting.consumeAll();
      }
      if (this.onCraft) this.onCraft();
      this.refresh(true);
      return;
    }

    if (!this.cursor) {
      c.crafting.consumeAll();
      this.cursor = output;
    } else if (this.cursor.item === output.item && this.cursor.count + output.count <= limit) {
      c.crafting.consumeAll();
      this.cursor.count += output.count;
    } else {
      return;
    }
    if (this.onCraft) this.onCraft();
    this.refresh(true);
    void button;
  }

  private quickMove(ref: SlotRef): void {
    const c = this.ctx;
    if (!c) return;
    const stack = this.stackAt(ref);
    if (!stack) return;
    if (ref.kind === 'inv') {
      // hotbar <-> main, or into an open container
      const fromHotbar = ref.index < 9;
      if (c.kind === 'chest' && c.chest) {
        const moved = this.transfer(stack, c.chest.slots, 0, 27);
        if (moved === 0) return;
        if (stack.count <= 0) this.setStack(ref, null);
        this.refresh(true);
        return;
      }
      const moved = fromHotbar
        ? this.transfer(stack, c.inventory.slots, 9, 36)
        : this.transfer(stack, c.inventory.slots, 0, 9);
      if (moved > 0 && stack.count <= 0) this.setStack(ref, null);
      this.refresh(true);
      return;
    }
    if (ref.kind === 'craft' || ref.kind === 'furnace' || ref.kind === 'chest') {
      const moved = this.transfer(stack, c.inventory.slots, 0, 36);
      if (moved > 0 && stack.count <= 0) this.setStack(ref, null);
      this.refresh(true);
    }
  }

  private transfer(stack: ItemStack, target: (ItemStack | null)[], from: number, to: number): number {
    const limit = itemDef(stack.item)?.stackSize ?? 64;
    let remaining = stack.count;
    for (let i = from; i < to && remaining > 0; i++) {
      const s = target[i];
      if (!s || s.item !== stack.item) continue;
      const space = limit - s.count;
      if (space <= 0) continue;
      const move = Math.min(space, remaining);
      s.count += move;
      remaining -= move;
    }
    for (let i = from; i < to && remaining > 0; i++) {
      if (target[i]) continue;
      const move = Math.min(limit, remaining);
      target[i] = makeStack(stack.item, move);
      remaining -= move;
    }
    const moved = stack.count - remaining;
    stack.count = remaining;
    return moved;
  }

  /* ---------------------------------------------------------------- */

  /** Redraw icons. `force` rebuilds every slot; otherwise only changed ones. */
  refresh(force = false): void {
    if (!this.open_ || !this.ctx) return;
    for (let i = 0; i < this.refs.length; i++) {
      const el = this.slotEls.get(String(i));
      if (!el) continue;
      const stack = this.stackAt(this.refs[i]);
      const sig = stack ? `${stack.item}|${stack.count}|${stack.damage ?? 0}` : '';
      const key = String(i);
      if (!force && this.sigs.get(key) === sig) continue;
      this.sigs.set(key, sig);
      el.innerHTML = '';
      if (!stack) continue;
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

    // cursor stack
    if (this.cursor) {
      this.cursorEl.classList.add('visible');
      this.cursorEl.innerHTML = '';
      this.cursorEl.appendChild(makeIcon(this.blockAtlas, this.itemAtlas, this.cursor.item, 40));
      if (this.cursor.count > 1) {
        const c = document.createElement('span');
        c.className = 'slot-count';
        c.textContent = String(this.cursor.count);
        this.cursorEl.appendChild(c);
      }
    } else {
      this.cursorEl.classList.remove('visible');
    }

    // furnace gauges
    if (this.ctx.kind === 'furnace' && this.ctx.furnace) {
      const f = this.ctx.furnace;
      const flame = this.panel.querySelector('#furnace-flame') as HTMLElement | null;
      if (flame) flame.style.height = `${Math.max(0, Math.min(1, f.burnTime / Math.max(1, f.burnTotal))) * 100}%`;
      const prog = this.panel.querySelector('#furnace-progress') as HTMLElement | null;
      if (prog) prog.style.width = `${Math.max(0, Math.min(1, f.cookProgress / Math.max(1, f.cookTotal))) * 100}%`;
    }
    void this.mouseX;
    void this.mouseY;
  }

  dispose(): void {
    this.root.innerHTML = '';
  }
}

export { emptySlots };
