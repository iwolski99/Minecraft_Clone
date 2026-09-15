/**
 * Inventory, hotbar, crafting grids and the furnace container.
 *
 * The data model is completely independent of the UI: the UI only reads slots
 * and calls `click`-style operations, which is what makes drag/split/merge and
 * the crafting result behave consistently.
 */

import { ItemStack, makeStack, maxStack, itemDef } from './items.js';

export { makeStack, maxStack, itemDef };
export type { ItemStack };

export const HOTBAR_SIZE = 9;
export const MAIN_ROWS = 3;
export const MAIN_SIZE = MAIN_ROWS * 9;
export const TOTAL_SLOTS = HOTBAR_SIZE + MAIN_SIZE;

export type SlotArray = (ItemStack | null)[];

export function emptySlots(n: number): SlotArray {
  return new Array(n).fill(null);
}

/** Merge stacks in place; returns the leftover count that did not fit. */
export function mergeInto(slots: SlotArray, stack: ItemStack, from = 0, to = slots.length): number {
  let remaining = stack.count;
  const limit = maxStack(stack.item);
  // first pass: top up existing stacks
  for (let i = from; i < to && remaining > 0; i++) {
    const s = slots[i];
    if (!s || s.item !== stack.item) continue;
    if ((s.damage ?? 0) !== (stack.damage ?? 0)) continue;
    const space = limit - s.count;
    if (space <= 0) continue;
    const move = Math.min(space, remaining);
    s.count += move;
    remaining -= move;
  }
  // second pass: fill empty slots
  for (let i = from; i < to && remaining > 0; i++) {
    if (slots[i]) continue;
    const move = Math.min(limit, remaining);
    const copy = makeStack(stack.item, move);
    if (stack.damage !== undefined && itemDef(stack.item)?.durability) copy.damage = stack.damage;
    slots[i] = copy;
    remaining -= move;
  }
  return remaining;
}

export class Inventory {
  readonly slots: SlotArray = emptySlots(TOTAL_SLOTS);
  selected = 0;

  get held(): ItemStack | null {
    return this.slots[this.selected] ?? null;
  }

  setHeld(stack: ItemStack | null): void {
    this.slots[this.selected] = stack;
  }

  /** Returns the number of items that could not be stored. */
  add(stack: ItemStack): number {
    return mergeInto(this.slots, stack);
  }

  addItem(name: string, count = 1): number {
    return this.add(makeStack(name, count));
  }

  countOf(name: string): number {
    let n = 0;
    for (const s of this.slots) if (s && s.item === name) n += s.count;
    return n;
  }

  removeItem(name: string, count: number): boolean {
    if (this.countOf(name) < count) return false;
    let left = count;
    for (let i = 0; i < this.slots.length && left > 0; i++) {
      const s = this.slots[i];
      if (!s || s.item !== name) continue;
      const take = Math.min(s.count, left);
      s.count -= take;
      left -= take;
      if (s.count <= 0) this.slots[i] = null;
    }
    return true;
  }

  consumeHeld(n = 1): void {
    const s = this.slots[this.selected];
    if (!s) return;
    s.count -= n;
    if (s.count <= 0) this.slots[this.selected] = null;
  }

  /** Apply durability damage to the held tool; destroys it when exhausted. */
  damageHeld(amount = 1): void {
    const s = this.slots[this.selected];
    if (!s) return;
    const def = itemDef(s.item);
    if (!def || def.durability <= 0) return;
    s.damage = (s.damage ?? 0) + amount;
    if (s.damage >= def.durability) this.slots[this.selected] = null;
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) this.slots[i] = null;
  }

  serialize(): unknown {
    return {
      selected: this.selected,
      slots: this.slots.map((s) => (s ? [s.item, s.count, s.damage ?? 0] : null)),
    };
  }

  deserialize(data: unknown): void {
    this.clear();
    if (!data || typeof data !== 'object') return;
    const d = data as { selected?: number; slots?: unknown[] };
    if (typeof d.selected === 'number') this.selected = Math.max(0, Math.min(8, d.selected));
    if (!Array.isArray(d.slots)) return;
    for (let i = 0; i < Math.min(this.slots.length, d.slots.length); i++) {
      const entry = d.slots[i];
      if (!Array.isArray(entry) || entry.length < 2) continue;
      const [name, count, damage] = entry as [string, number, number];
      if (!itemDef(name)) continue;
      const stack = makeStack(name, count);
      if (damage) stack.damage = damage;
      this.slots[i] = stack;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Crafting grid                                                       */
/* ------------------------------------------------------------------ */

export class CraftingGrid {
  readonly size: number;
  readonly slots: SlotArray;

  constructor(size: 2 | 3) {
    this.size = size;
    this.slots = emptySlots(size * size);
  }

  at(x: number, y: number): ItemStack | null {
    return this.slots[y * this.size + x] ?? null;
  }

  set(x: number, y: number, stack: ItemStack | null): void {
    this.slots[y * this.size + x] = stack;
  }

  clear(): void {
    for (let i = 0; i < this.slots.length; i++) this.slots[i] = null;
  }

  isEmpty(): boolean {
    return this.slots.every((s) => !s);
  }

  /** Consume one of every non-empty slot (called when the result is taken). */
  consumeAll(): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      s.count--;
      if (s.count <= 0) this.slots[i] = null;
    }
  }

  /** Return everything to the inventory (when the screen is closed). */
  drainTo(inv: Inventory): void {
    for (let i = 0; i < this.slots.length; i++) {
      const s = this.slots[i];
      if (!s) continue;
      const left = inv.add(s);
      if (left > 0) s.count = left;
      else this.slots[i] = null;
    }
  }
}

/* ------------------------------------------------------------------ */
/* Furnace                                                             */
/* ------------------------------------------------------------------ */

export interface SmeltRecipe {
  input: string;
  output: string;
  time: number;
  count: number;
}

export class FurnaceState {
  input: ItemStack | null = null;
  fuel: ItemStack | null = null;
  output: ItemStack | null = null;
  /** seconds of burn remaining */
  burnTime = 0;
  burnTotal = 0;
  /** 0..1 progress on the current item */
  cookProgress = 0;
  cookTotal = 10;
  x = 0;
  y = 0;
  z = 0;

  serialize(): unknown {
    return {
      input: this.input ? [this.input.item, this.input.count] : null,
      fuel: this.fuel ? [this.fuel.item, this.fuel.count] : null,
      output: this.output ? [this.output.item, this.output.count] : null,
      burnTime: this.burnTime,
      burnTotal: this.burnTotal,
      cookProgress: this.cookProgress,
      x: this.x,
      y: this.y,
      z: this.z,
    };
  }

  static from(data: unknown): FurnaceState | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const f = new FurnaceState();
    const read = (v: unknown): ItemStack | null => {
      if (!Array.isArray(v) || v.length < 2) return null;
      const [name, count] = v as [string, number];
      if (!itemDef(name)) return null;
      return makeStack(name, count);
    };
    f.input = read(d.input);
    f.fuel = read(d.fuel);
    f.output = read(d.output);
    f.burnTime = Number(d.burnTime) || 0;
    f.burnTotal = Number(d.burnTotal) || 0;
    f.cookProgress = Number(d.cookProgress) || 0;
    f.x = Number(d.x) || 0;
    f.y = Number(d.y) || 0;
    f.z = Number(d.z) || 0;
    return f;
  }
}

/** Simple chest container. */
export class ChestState {
  readonly slots: SlotArray = emptySlots(27);
  x = 0;
  y = 0;
  z = 0;

  serialize(): unknown {
    return { x: this.x, y: this.y, z: this.z, slots: this.slots.map((s) => (s ? [s.item, s.count, s.damage ?? 0] : null)) };
  }

  static from(data: unknown): ChestState | null {
    if (!data || typeof data !== 'object') return null;
    const d = data as Record<string, unknown>;
    const c = new ChestState();
    c.x = Number(d.x) || 0;
    c.y = Number(d.y) || 0;
    c.z = Number(d.z) || 0;
    if (Array.isArray(d.slots)) {
      for (let i = 0; i < Math.min(27, d.slots.length); i++) {
        const e = d.slots[i];
        if (!Array.isArray(e) || e.length < 2) continue;
        const [name, count, dmg] = e as [string, number, number];
        if (!itemDef(name)) continue;
        const st = makeStack(name, count);
        if (dmg) st.damage = dmg;
        c.slots[i] = st;
      }
    }
    return c;
  }
}

/* ------------------------------------------------------------------ */
/* Slot interactions (shared by every container UI)                    */
/* ------------------------------------------------------------------ */

export type ClickButton = 'left' | 'right';

/**
 * Standard container click semantics:
 *  - left click on an empty cursor picks up the whole stack
 *  - left click with a cursor places/merges/swaps
 *  - right click with a cursor places exactly one
 *  - right click on a stack with an empty cursor splits it in half
 */
export function slotClick(slot: ItemStack | null, cursor: ItemStack | null, button: ClickButton): { slot: ItemStack | null; cursor: ItemStack | null } {
  if (button === 'right') {
    if (!cursor) {
      if (!slot) return { slot, cursor };
      const half = Math.ceil(slot.count / 2);
      const taken = makeStack(slot.item, half);
      taken.damage = slot.damage;
      const rest = slot.count - half > 0 ? { ...slot, count: slot.count - half } : null;
      return { slot: rest, cursor: taken };
    }
    if (!slot) {
      const one = makeStack(cursor.item, 1);
      one.damage = cursor.damage;
      return { slot: one, cursor: cursor.count > 1 ? { ...cursor, count: cursor.count - 1 } : null };
    }
    if (slot.item === cursor.item && (slot.damage ?? 0) === (cursor.damage ?? 0) && slot.count < maxStack(slot.item)) {
      return { slot: { ...slot, count: slot.count + 1 }, cursor: cursor.count > 1 ? { ...cursor, count: cursor.count - 1 } : null };
    }
    return { slot, cursor };
  }

  if (!cursor) {
    return { slot: null, cursor: slot };
  }
  if (!slot) {
    return { slot: cursor, cursor: null };
  }
  if (slot.item === cursor.item && (slot.damage ?? 0) === (cursor.damage ?? 0)) {
    const limit = maxStack(slot.item);
    const move = Math.min(limit - slot.count, cursor.count);
    if (move > 0) {
      const newSlot = { ...slot, count: slot.count + move };
      const newCursor = cursor.count - move > 0 ? { ...cursor, count: cursor.count - move } : null;
      return { slot: newSlot, cursor: newCursor };
    }
    return { slot, cursor };
  }
  return { slot: cursor, cursor: slot };
}
