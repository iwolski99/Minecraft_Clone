// Module load smoke test.
//
// Imports every compiled module exactly the way the browser will. Anything that
// throws at import time (a bad top-level statement, a missing export, a
// DOM/WebGL call outside a method) is caught here rather than in the browser.
// A tiny DOM shim is installed first so modules that touch `document` during
// construction can still be imported.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BUILD = path.resolve(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '.qa-build'));

/** Minimal stand-ins; modules must not use them at import time. */
function installShims() {
  const noop = () => undefined;
  const makeEl = () => {
    const el = {
      style: {},
      dataset: {},
      classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
      children: [],
      appendChild: (c) => c,
      removeChild: noop,
      insertBefore: noop,
      setAttribute: noop,
      getAttribute: () => null,
      addEventListener: noop,
      removeEventListener: noop,
      querySelector: () => null,
      querySelectorAll: () => [],
      getContext: () => null,
      focus: noop,
      blur: noop,
      remove: noop,
      innerHTML: '',
      textContent: '',
      width: 0,
      height: 0,
    };
    return el;
  };
  if (!globalThis.document) {
    globalThis.document = {
      createElement: makeEl,
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: () => [],
      addEventListener: noop,
      removeEventListener: noop,
      body: makeEl(),
      documentElement: makeEl(),
      readyState: 'complete',
      exitPointerLock: noop,
    };
  }
  if (!globalThis.window) {
    globalThis.window = {
      addEventListener: noop,
      removeEventListener: noop,
      innerWidth: 1280,
      innerHeight: 720,
      devicePixelRatio: 1,
      setInterval: () => 0,
      clearInterval: noop,
      requestAnimationFrame: (cb) => setTimeout(() => cb(0), 0),
    };
  }
  if (!globalThis.location) {
    globalThis.location = { href: 'http://127.0.0.1:5173/', search: '', hash: '' };
  }
  if (!globalThis.requestAnimationFrame) globalThis.requestAnimationFrame = (cb) => setTimeout(() => cb(0), 0);
  if (!globalThis.localStorage) {
    const store = new Map();
    globalThis.localStorage = {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k),
      clear: () => store.clear(),
    };
  }
  if (!globalThis.ImageData) {
    globalThis.ImageData = class {
      constructor(data, width, height) {
        this.data = data;
        this.width = width;
        this.height = height;
      }
    };
  }
}

export async function run() {
  installShims();
  const files = [];
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(BUILD);

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  // entry points self-boot and construct a Game, which needs a real WebGL
  // context; importing them here would only test the shim.
  const SELF_BOOTING = new Set(['src/main.js', 'src/diag.js']);
  for (const f of files.sort()) {
    const rel = path.relative(BUILD, f).replace(/\\/g, '/');
    if (SELF_BOOTING.has(rel)) {
      skipped++;
      continue;
    }
    try {
      await import(new URL(`file://${f.replace(/\\/g, '/')}`).href);
      ok++;
    } catch (e) {
      failed++;
      console.error(`  FAIL import ${rel}: ${e && e.message ? e.message : e}`);
    }
  }
  console.log(`modules: ${ok} imported, ${skipped} skipped, ${failed} failed`);
  if (failed) process.exit(1);
}
