// Inventory / item-pickup regression tests (headless).
//
// Two bugs were reported from play and are pinned here:
//
//   1. "items would disappear when I walked over them but not go in my hotbar"
//      - the drop entity was removed from the world while nothing was ever
//        added to the inventory: `ItemDropManager.onCollect` was declared and
//        called, but the game never installed a handler, so collection was a
//        silent delete.
//   2. "moving items around made their icons disappear from the hotbar"
//      - `makeIcon` handed every caller the *same* cached canvas element. A DOM
//        node lives in exactly one parent, so the second slot to draw an item
//        (the open inventory screen, which shows the hotbar row too) moved the
//        canvas out of the first one (the HUD hotbar).
//
// It then walks the whole early-game chain with the real Game, the real
// ContainerUI click handling and the real recipe tables:
//
//   tree log block -> break -> right drop -> pickup -> 4 planks from 1 log
//   -> 4 sticks from 2 planks -> crafting table from 4 planks -> place it
//   -> 3x3 grid opens -> wooden pickaxe from 3 planks + 2 sticks
//   -> tool in the inventory with full durability
//
// Finally it pins the same "never destroy an item" rule for a full inventory:
// a drop that does not fit stays on the ground, and whatever was on the cursor
// when a screen closed is dropped rather than deleted.
//
// The harness boots the real Game class with a stub WebGL context (Browsers
// cannot be launched here) and a DOM whose `appendChild` has real single-parent
// semantics - that is precisely the behaviour the icon bug depended on, and the
// loose DOM stubs used elsewhere in this repo deliberately do not model it.

/* ------------------------------------------------------------------ */
/* Pixel canvas                                                        */
/* ------------------------------------------------------------------ */

const clampByte = (v) => (v < 0 ? 0 : v > 255 ? 255 : v | 0);

function parseColor(css) {
  if (typeof css !== 'string') return null;
  const s = css.trim().toLowerCase();
  if (s === 'transparent') return [0, 0, 0, 0];
  let m = /^#([0-9a-f]{3})$/.exec(s);
  if (m) {
    const [r, g, b] = [...m[1]].map((c) => parseInt(c + c, 16));
    return [r, g, b, 255];
  }
  m = /^#([0-9a-f]{6})$/.exec(s);
  if (m) {
    const n = parseInt(m[1], 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
  }
  m = /^rgba?\(([^)]+)\)$/.exec(s);
  if (m) {
    const parts = m[1].split(',').map((p) => Number(p.trim()));
    const a = parts.length > 3 ? Math.round(parts[3] * 255) : 255;
    return [clampByte(parts[0]), clampByte(parts[1]), clampByte(parts[2]), clampByte(a)];
  }
  return null;
}

function srcPixels(src) {
  if (!src) return null;
  if (src.__isCanvas) return { data: src._buf, w: src.__w, h: src.__h };
  if (src.data && typeof src.width === 'number' && typeof src.height === 'number') {
    return { data: src.data, w: src.width, h: src.height };
  }
  return null;
}

function blendPx(canvas, x, y, r, g, b, a) {
  const W = canvas.__w;
  const H = canvas.__h;
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const o = (y * W + x) * 4;
  const buf = canvas._buf;
  const sa = a / 255;
  if (sa >= 1) {
    buf[o] = r;
    buf[o + 1] = g;
    buf[o + 2] = b;
    buf[o + 3] = 255;
    return;
  }
  const da = buf[o + 3] / 255;
  const oa = sa + da * (1 - sa);
  if (oa <= 0) {
    buf[o] = buf[o + 1] = buf[o + 2] = buf[o + 3] = 0;
    return;
  }
  buf[o] = clampByte((r * sa + buf[o] * da * (1 - sa)) / oa);
  buf[o + 1] = clampByte((g * sa + buf[o + 1] * da * (1 - sa)) / oa);
  buf[o + 2] = clampByte((b * sa + buf[o + 2] * da * (1 - sa)) / oa);
  buf[o + 3] = clampByte(oa * 255);
}

function make2d(canvas) {
  const noop = () => undefined;
  const gradient = () => {
    const g = { __stops: [], addColorStop: (p, c) => g.__stops.push([p, c]) };
    return g;
  };
  const fill = (x, y, w, h, style) => {
    const col = parseColor(style) ?? (style && style.__stops && style.__stops.length
      ? parseColor(style.__stops[style.__stops.length - 1][1])
      : null) ?? [0, 0, 0, 255];
    const x0 = Math.round(Math.min(x, x + w));
    const y0 = Math.round(Math.min(y, y + h));
    const x1 = Math.round(Math.max(x, x + w));
    const y1 = Math.round(Math.max(y, y + h));
    for (let py = y0; py < y1; py++) {
      for (let px = x0; px < x1; px++) blendPx(canvas, px, py, col[0], col[1], col[2], col[3]);
    }
  };
  const ctx = {
    canvas,
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false,
    font: '10px sans-serif',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    filter: 'none',
    lineWidth: 1,
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    resetTransform: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    rect: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    setLineDash: noop,
    fillText: noop,
    strokeText: noop,
    measureText: (t) => ({ width: String(t).length * 6 }),
    createLinearGradient: gradient,
    createRadialGradient: gradient,
    createPattern: () => null,
    clearRect: (x, y, w, h) => {
      const x0 = Math.max(0, Math.round(Math.min(x, x + w)));
      const y0 = Math.max(0, Math.round(Math.min(y, y + h)));
      const x1 = Math.min(canvas.__w, Math.round(Math.max(x, x + w)));
      const y1 = Math.min(canvas.__h, Math.round(Math.max(y, y + h)));
      for (let py = y0; py < y1; py++) {
        for (let px = x0; px < x1; px++) {
          const o = (py * canvas.__w + px) * 4;
          canvas._buf[o] = canvas._buf[o + 1] = canvas._buf[o + 2] = canvas._buf[o + 3] = 0;
        }
      }
    },
    fillRect: (x, y, w, h) => fill(x, y, w, h, ctx.fillStyle),
    strokeRect: (x, y, w, h) => fill(x, y, w, h, ctx.strokeStyle),
    createImageData: (w, h) =>
      w && typeof w === 'object'
        ? new ImageData(new Uint8ClampedArray(w.data), w.width, w.height)
        : new ImageData(new Uint8ClampedArray(w * h * 4), w, h),
    getImageData: (x, y, w, h) => {
      const out = new ImageData(new Uint8ClampedArray(w * h * 4), w, h);
      for (let py = 0; py < h; py++) {
        for (let px = 0; px < w; px++) {
          const sx = Math.round(x) + px;
          const sy = Math.round(y) + py;
          if (sx < 0 || sy < 0 || sx >= canvas.__w || sy >= canvas.__h) continue;
          const so = (sy * canvas.__w + sx) * 4;
          const dofs = (py * w + px) * 4;
          out.data[dofs] = canvas._buf[so];
          out.data[dofs + 1] = canvas._buf[so + 1];
          out.data[dofs + 2] = canvas._buf[so + 2];
          out.data[dofs + 3] = canvas._buf[so + 3];
        }
      }
      return out;
    },
    putImageData: (img, dx, dy) => {
      const s = srcPixels(img);
      if (!s) return;
      for (let y = 0; y < s.h; y++) {
        for (let x = 0; x < s.w; x++) {
          const px = Math.round(dx) + x;
          const py = Math.round(dy) + y;
          if (px < 0 || py < 0 || px >= canvas.__w || py >= canvas.__h) continue;
          const so = (y * s.w + x) * 4;
          const dofs = (py * canvas.__w + px) * 4;
          canvas._buf[dofs] = s.data[so];
          canvas._buf[dofs + 1] = s.data[so + 1];
          canvas._buf[dofs + 2] = s.data[so + 2];
          canvas._buf[dofs + 3] = s.data[so + 3];
        }
      }
    },
    // nearest-neighbour blit; transforms are ignored (this harness checks where
    // icons are *mounted*, not how the sprite art is projected)
    drawImage: (src, ...a) => {
      const s = srcPixels(src);
      if (!s) return;
      let sx = 0;
      let sy = 0;
      let sw = s.w;
      let sh = s.h;
      let dx = 0;
      let dy = 0;
      let dw = sw;
      let dh = sh;
      if (a.length === 2) {
        dx = a[0];
        dy = a[1];
      } else if (a.length === 4) {
        dx = a[0];
        dy = a[1];
        dw = a[2];
        dh = a[3];
      } else if (a.length === 8) {
        sx = a[0];
        sy = a[1];
        sw = a[2];
        sh = a[3];
        dx = a[4];
        dy = a[5];
        dw = a[6];
        dh = a[7];
      } else {
        return;
      }
      if (sw <= 0 || sh <= 0 || dw <= 0 || dh <= 0) return;
      for (let y = 0; y < dh; y++) {
        const syy = Math.floor(sy + ((y + 0.5) * sh) / dh);
        for (let x = 0; x < dw; x++) {
          const sxx = Math.floor(sx + ((x + 0.5) * sw) / dw);
          if (sxx < 0 || syy < 0 || sxx >= s.w || syy >= s.h) continue;
          const o = (syy * s.w + sxx) * 4;
          blendPx(canvas, Math.round(dx) + x, Math.round(dy) + y, s.data[o], s.data[o + 1], s.data[o + 2], s.data[o + 3]);
        }
      }
    },
  };
  return ctx;
}

/** Count pixels the icon actually painted (alpha > 0). */
function paintedPixels(canvas) {
  const buf = canvas._buf;
  let n = 0;
  for (let i = 3; i < buf.length; i += 4) if (buf[i] > 0) n++;
  return n;
}

/* ------------------------------------------------------------------ */
/* Tiny DOM: elements, html parsing, selectors                         */
/* ------------------------------------------------------------------ */

const VOID_TAGS = new Set(['input', 'br', 'img', 'hr', 'meta', 'link', 'source', 'area', 'col']);

function decodeEntities(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, body) => {
    if (body[0] === '#') {
      const hex = body[1] === 'x' || body[1] === 'X';
      const n = parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0', middot: '\u00b7' };
    return named[body] ?? all;
  });
}

function parseAttributes(el, text) {
  const re = /([A-Za-z_:][-A-Za-z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(text))) {
    const name = m[1];
    const value = decodeEntities(m[2] ?? m[3] ?? m[4] ?? '');
    if (!el.attrs.has(name)) el.attrs.set(name, value);
  }
}

class Style {
  constructor() {
    Object.defineProperty(this, 'cssText', {
      enumerable: true,
      set: (v) => {
        for (const decl of String(v).split(';')) {
          const i = decl.indexOf(':');
          if (i <= 0) continue;
          const key = decl.slice(0, i).trim().replace(/-([a-z])/g, (_, c) => c.toUpperCase());
          this[key] = decl.slice(i + 1).trim();
        }
      },
      get: () => '',
    });
  }
}

class El {
  constructor(tag) {
    this.__isCanvas = String(tag).toLowerCase() === 'canvas';
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentElement = null;
    this.attrs = new Map();
    this.textRuns = [];
    this.style = new Style();
    this.__listeners = new Map();
    this.__w = 0;
    this.__h = 0;
    this._buf = new Uint8ClampedArray(0);
    this._ctx2 = null;
    this._gl = null;
    this.value = '';
    this.checked = false;
  }

  /* --- geometry / pixels (canvas only) --- */
  get width() {
    return this.__w;
  }
  set width(v) {
    this.__w = Math.max(0, v | 0);
    if (this.__isCanvas) this._buf = new Uint8ClampedArray(this.__w * this.__h * 4);
  }
  get height() {
    return this.__h;
  }
  set height(v) {
    this.__h = Math.max(0, v | 0);
    if (this.__isCanvas) this._buf = new Uint8ClampedArray(this.__w * this.__h * 4);
  }
  get clientWidth() {
    return this.__w || 1280;
  }
  get clientHeight() {
    return this.__h || 720;
  }

  getContext(type) {
    if (type === '2d') {
      if (!this._ctx2) this._ctx2 = make2d(this);
      return this._ctx2;
    }
    if (type === 'webgl2' || type === 'webgl' || type === 'experimental-webgl') {
      if (!this._gl) this._gl = makeGl(this);
      return this._gl;
    }
    return null;
  }

  toDataURL() {
    return 'data:,';
  }

  /* --- attributes --- */
  setAttribute(name, value) {
    this.attrs.set(name, String(value));
    if (name === 'value') this.value = String(value);
    if (name === 'checked') this.checked = true;
  }
  getAttribute(name) {
    return this.attrs.has(name) ? this.attrs.get(name) : null;
  }
  hasAttribute(name) {
    return this.attrs.has(name);
  }
  removeAttribute(name) {
    this.attrs.delete(name);
  }
  get id() {
    return this.attrs.get('id') ?? '';
  }
  set id(v) {
    this.attrs.set('id', String(v));
  }
  get className() {
    return this.attrs.get('class') ?? '';
  }
  set className(v) {
    this.attrs.set('class', String(v));
  }
  get classList() {
    const self = this;
    const list = () => (self.className ? self.className.split(/\s+/).filter(Boolean) : []);
    return {
      add: (...c) => {
        const set = new Set(list());
        for (const x of c) set.add(x);
        self.className = [...set].join(' ');
      },
      remove: (...c) => {
        const set = new Set(list());
        for (const x of c) set.delete(x);
        self.className = [...set].join(' ');
      },
      toggle: (c, on) => {
        const set = new Set(list());
        const want = on === undefined ? !set.has(c) : !!on;
        if (want) set.add(c);
        else set.delete(c);
        self.className = [...set].join(' ');
        return want;
      },
      contains: (c) => list().includes(c),
    };
  }
  get dataset() {
    const self = this;
    const keyOf = (k) => `data-${String(k).replace(/[A-Z]/g, (m) => `-${m.toLowerCase()}`)}`;
    return new Proxy(
      {},
      {
        get: (_t, k) => (typeof k === 'string' ? self.attrs.get(keyOf(k)) : undefined),
        set: (_t, k, v) => {
          self.attrs.set(keyOf(k), String(v));
          return true;
        },
        has: (_t, k) => self.attrs.has(keyOf(k)),
        ownKeys: () => [...self.attrs.keys()].filter((k) => k.startsWith('data-')),
        getOwnPropertyDescriptor: () => ({ enumerable: true, configurable: true }),
      },
    );
  }

  /* --- tree --- */
  appendChild(child) {
    if (!child) return child;
    if (child.parentElement) child.parentElement.removeChild(child);
    this.children.push(child);
    child.parentElement = this;
    return child;
  }
  removeChild(child) {
    const i = this.children.indexOf(child);
    if (i >= 0) this.children.splice(i, 1);
    if (child) child.parentElement = null;
    return child;
  }
  insertBefore(child, ref) {
    if (!ref) return this.appendChild(child);
    if (child.parentElement) child.parentElement.removeChild(child);
    const i = this.children.indexOf(ref);
    this.children.splice(i < 0 ? this.children.length : i, 0, child);
    child.parentElement = this;
    return child;
  }
  remove() {
    if (this.parentElement) this.parentElement.removeChild(this);
  }
  get firstChild() {
    return this.children[0] ?? null;
  }

  get innerHTML() {
    return this.__html ?? '';
  }
  set innerHTML(html) {
    this.__html = String(html);
    this.children = [];
    this.textRuns = [];
    const parsed = parseHtml(this.__html);
    // slice(): appendChild detaches the node from `parsed`, so iterating the
    // live array would skip every other child
    for (const node of parsed.children.slice()) this.appendChild(node);
    this.textRuns = parsed.textRuns;
  }

  get textContent() {
    let out = this.textRuns.join('');
    for (const c of this.children) out += c.textContent;
    return out;
  }
  set textContent(v) {
    this.children = [];
    this.textRuns = [String(v)];
  }

  /* --- queries --- */
  querySelector(sel) {
    return this.querySelectorAll(sel)[0] ?? null;
  }
  querySelectorAll(sel) {
    const out = [];
    const walk = (el) => {
      for (const c of el.children) {
        if (matchesSelector(c, sel)) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  matches(sel) {
    return matchesSelector(this, sel);
  }
  closest(sel) {
    let node = this;
    while (node) {
      if (matchesSelector(node, sel)) return node;
      node = node.parentElement;
    }
    return null;
  }

  /* --- events --- */
  addEventListener(type, fn) {
    const list = this.__listeners.get(type) ?? [];
    list.push(fn);
    this.__listeners.set(type, list);
  }
  removeEventListener(type, fn) {
    const list = this.__listeners.get(type);
    if (!list) return;
    const i = list.indexOf(fn);
    if (i >= 0) list.splice(i, 1);
  }
  dispatchEvent(ev) {
    for (const fn of this.__listeners.get(ev.type) ?? []) fn(ev);
    return true;
  }
  focus() {}
  blur() {}
  requestPointerLock() {
    return Promise.resolve();
  }
  getBoundingClientRect() {
    return { left: 0, top: 0, width: this.clientWidth, height: this.clientHeight, right: this.clientWidth, bottom: this.clientHeight };
  }
  cloneNode(deep = false) {
    const copy = new El(this.tagName.toLowerCase());
    for (const [k, v] of this.attrs) copy.attrs.set(k, v);
    copy.value = this.value;
    copy.checked = this.checked;
    copy.__w = this.__w;
    copy.__h = this.__h;
    copy._buf = new Uint8ClampedArray(this._buf);
    copy.textRuns = [...this.textRuns];
    if (deep) for (const c of this.children) copy.appendChild(c.cloneNode(true));
    return copy;
  }
}

function parseHtml(html) {
  const root = new El('root');
  const stack = [root];
  const top = () => stack[stack.length - 1];
  const re = /<!--[\s\S]*?-->|<\/([A-Za-z0-9-]+)\s*>|<([A-Za-z0-9-]+)((?:"[^"]*"|'[^']*'|[^>"'])*)(\/?)>|([^<]+)/g;
  let m;
  while ((m = re.exec(html))) {
    if (m[1]) {
      const tag = m[1].toUpperCase();
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName === tag) {
          stack.length = i;
          break;
        }
      }
    } else if (m[2]) {
      const el = new El(m[2]);
      parseAttributes(el, m[3] ?? '');
      top().appendChild(el);
      if (!m[4] && !VOID_TAGS.has(m[2].toLowerCase())) stack.push(el);
    } else if (m[5] !== undefined) {
      const text = decodeEntities(m[5]);
      if (text) top().textRuns.push(text);
    }
  }
  return root;
}

/* --- selectors: tag / #id / .class / [attr] / [attr="v"], descendant chains --- */

function parseCompound(part) {
  const out = { tag: null, id: null, classes: [], attrs: [] };
  const re = /\[([A-Za-z0-9_:.-]+)(?:([~^$*|]?=)"?([^"\]]*)"?)?\]|([#.]?)([A-Za-z0-9_-]+)/g;
  let m;
  while ((m = re.exec(part))) {
    if (m[1]) out.attrs.push([m[1], m[2] ?? null, m[3] ?? null]);
    else if (m[4] === '#') out.id = m[5];
    else if (m[4] === '.') out.classes.push(m[5]);
    else out.tag = m[5].toUpperCase();
  }
  return out;
}

function matchCompound(el, c) {
  if (!el || el.nodeType !== 1) return false;
  if (c.tag && el.tagName !== c.tag) return false;
  if (c.id && el.getAttribute('id') !== c.id) return false;
  for (const cls of c.classes) if (!el.classList.contains(cls)) return false;
  for (const [name, op, value] of c.attrs) {
    const v = el.getAttribute(name);
    if (v === null) return false;
    if (op === '=' && v !== value) return false;
  }
  return true;
}

function matchesSelector(el, sel) {
  for (const chain of String(sel).split(',')) {
    const trimmed = chain.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/).map(parseCompound);
    if (!matchCompound(el, parts[parts.length - 1])) continue;
    let node = el.parentElement;
    let i = parts.length - 2;
    while (i >= 0 && node) {
      if (matchCompound(node, parts[i])) i--;
      node = node.parentElement;
    }
    if (i < 0) return true;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* Stub WebGL2 context (enough for three.js to initialise)             */
/* ------------------------------------------------------------------ */

function makeGl(canvas) {
  const target = { canvas, drawingBufferWidth: canvas.width, drawingBufferHeight: canvas.height };
  /** every GL enum is an ALL_CAPS constant: give it a stable number. */
  const hashName = (prop) => {
    let h = 0;
    for (let i = 0; i < prop.length; i++) h = (Math.imul(h, 31) + prop.charCodeAt(i)) | 0;
    return (Math.abs(h) % 60000) + 1;
  };
  const paramValues = new Map();
  const param = (name, value) => paramValues.set(hashName(name), value);
  param('VERSION', 'WebGL 2.0 (stub)');
  param('SHADING_LANGUAGE_VERSION', 'WebGL GLSL ES 3.00 (stub)');
  param('VENDOR', 'stub');
  param('RENDERER', 'stub');
  param('MAX_TEXTURE_SIZE', 16384);
  param('MAX_CUBE_MAP_TEXTURE_SIZE', 16384);
  param('MAX_TEXTURE_IMAGE_UNITS', 16);
  param('MAX_COMBINED_TEXTURE_IMAGE_UNITS', 32);
  param('MAX_VERTEX_UNIFORM_VECTORS', 4096);
  param('MAX_FRAGMENT_UNIFORM_VECTORS', 4096);
  param('MAX_VARYING_VECTORS', 32);
  param('MAX_VERTEX_ATTRIBS', 16);
  param('MAX_RENDERBUFFER_SIZE', 16384);
  param('MAX_SAMPLES', 4);
  param('MAX_3D_TEXTURE_SIZE', 2048);
  param('MAX_ARRAY_TEXTURE_LAYERS', 2048);
  param('SCISSOR_BOX', new Int32Array([0, 0, canvas.width, canvas.height]));
  param('VIEWPORT', new Int32Array([0, 0, canvas.width, canvas.height]));
  const handler = {
    get(_t, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return hashName(prop);
      if (prop === 'getParameter') return (p) => paramValues.get(p) ?? 0;
      if (prop === 'getExtension') return () => null;
      if (prop === 'getSupportedExtensions') return () => [];
      if (prop === 'getShaderPrecisionFormat') return () => ({ precision: 23, rangeMin: 127, rangeMax: 127 });
      if (prop === 'getError') return () => 0;
      if (prop === 'getContextAttributes') return () => ({ alpha: false, depth: true, stencil: false, antialias: false });
      if (prop === 'getShaderParameter' || prop === 'getProgramParameter') {
        return (_p, pname) => (pname === 0x8b81 || pname === 0x8b82 || pname === 0x8b83 ? true : 0);
      }
      if (prop === 'getShaderInfoLog' || prop === 'getProgramInfoLog') return () => '';
      if (prop === 'getUniformLocation') return () => ({ __loc: 1 });
      if (prop === 'getAttribLocation') return () => 0;
      if (prop === 'getActiveUniform') return () => ({ name: 'u', size: 1, type: 0 });
      if (prop === 'getActiveAttrib') return () => ({ name: 'a', size: 1, type: 0 });
      return (...args) => {
        if (prop.startsWith('create')) return { __created: prop, __args: args };
        if (prop.startsWith('is')) return false;
        if (prop.startsWith('get')) return null;
        return undefined;
      };
    },
    set(t, prop, value) {
      t[prop] = value;
      return true;
    },
  };
  return new Proxy(target, handler);
}

/* ------------------------------------------------------------------ */
/* Shims                                                              */
/* ------------------------------------------------------------------ */

/**
 * A controllable `performance.now()`.
 *
 * ContainerUI treats two clicks less than 260 ms apart as a double click and
 * gathers matching stacks onto the cursor. Synthetic clicks are instantaneous,
 * so every one of them would look like a double click; the harness advances a
 * fake clock between clicks instead of sleeping for real.
 */
const clock = { now: 0 };

function installShims() {
  Object.defineProperty(globalThis, 'performance', {
    configurable: true,
    writable: true,
    value: { now: () => clock.now, timeOrigin: 0 },
  });
  const documentElement = new El('html');
  const body = new El('body');
  documentElement.appendChild(body);
  const docListeners = new Map();
  const winListeners = new Map();

  globalThis.document = {
    createElement: (tag) => new El(tag),
    createElementNS: (_ns, tag) => new El(tag),
    createTextNode: (t) => {
      const el = new El('#text');
      el.textRuns = [String(t)];
      return el;
    },
    getElementById: (id) => documentElement.querySelector(`#${id}`),
    querySelector: (sel) => documentElement.querySelector(sel),
    querySelectorAll: (sel) => documentElement.querySelectorAll(sel),
    addEventListener: (type, fn) => {
      const list = docListeners.get(type) ?? [];
      list.push(fn);
      docListeners.set(type, list);
    },
    removeEventListener: () => undefined,
    body,
    documentElement,
    readyState: 'complete',
    hidden: false,
    pointerLockElement: null,
    exitPointerLock: () => undefined,
    execCommand: () => false,
  };

  const frameQueue = [];
  globalThis.window = {
    addEventListener: (type, fn) => {
      const list = winListeners.get(type) ?? [];
      list.push(fn);
      winListeners.set(type, list);
    },
    removeEventListener: () => undefined,
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    setInterval: () => 0,
    clearInterval: () => undefined,
    setTimeout: () => 0,
    clearTimeout: () => undefined,
    requestAnimationFrame: (cb) => {
      frameQueue.push(cb);
      return frameQueue.length;
    },
    cancelAnimationFrame: () => undefined,
    location: { href: 'http://127.0.0.1:5173/', search: '', hash: '' },
    getComputedStyle: () => ({ getPropertyValue: () => '' }),
    matchMedia: () => ({ matches: false, addEventListener: () => undefined }),
  };
  globalThis.requestAnimationFrame = globalThis.window.requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => undefined;

  globalThis.ImageData = class ImageData {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'node' }, configurable: true });
  }
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
}

/* ------------------------------------------------------------------ */
/* The test                                                            */
/* ------------------------------------------------------------------ */

export async function run(load) {
  installShims();

  const { Game } = await load('game.js');
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { oakTree } = await load('worldgen/trees.js');
  const { Rng } = await load('util/rng.js');
  const { B, getBlock, dropsFor } = await load('world/blocks.js');
  const { CHUNK_Y } = await load('world/chunk.js');
  const { itemDef, makeStack } = await load('items/items.js');
  const { makeIcon } = await load('ui/icons.js');
  const { buildBlockAtlas, buildItemAtlas } = await load('render/atlas.js');

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const eq = (name, a, b) => check(name, a === b, `(got ${JSON.stringify(a)}, want ${JSON.stringify(b)})`);
  const info = (m) => console.log(`  . ${m}`);

  /* ---------------- boot the real Game ---------------- */

  const canvas = new El('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const layers = {
    hud: new El('div'),
    containers: new El('div'),
    screens: new El('div'),
    debug: new El('div'),
  };

  let game;
  try {
    game = new Game(canvas, layers);
  } catch (e) {
    check('Game constructs headlessly', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
    console.log(`inventory: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  check('Game constructs headlessly', !!game);
  check('the drop manager has a collect handler', typeof game.drops.onCollect === 'function');
  info('Game constructed with the real Hud / ContainerUI / drop manager');
  // the title screen is up after construction; drop it like startWorld() does
  game.screens.hideAll();

  /* ---------------- a controlled flat world ---------------- */

  const gen = new TerrainGenerator(20240910);
  const world = new World(20240910, gen);
  const chunk = world.createChunk(0, 0);
  gen.generateChunk(chunk);
  for (let z = 0; z < 16; z++) {
    for (let x = 0; x < 16; x++) {
      for (let y = 58; y <= 64; y++) world.setBlock(x, y, z, B.stone);
      for (let y = 65; y < CHUNK_Y; y++) world.setBlock(x, y, z, 0);
    }
  }
  world.light.initialLight(chunk);
  game.world = world;
  game.running = true;
  game.player.gameMode = 'survival';
  game.inventory.clear();
  game.player.position.set(8.5, 65, 8.5);
  game.player.velocity.set(0, 0, 0);
  game.player.yaw = 0;
  game.player.pitch = 0;
  eq('flat test world surface', world.getBlockAt(8, 64, 8), B.stone);

  const tick = (n = 1, dt = 1 / 60) => {
    for (let i = 0; i < n; i++) game.tick(dt);
  };
  /** what the frame loop does for the HUD every frame (game.frame -> hud.update) */
  const pumpHud = () => {
    game.hud.update(
      1 / 60,
      game.inventory,
      { debugVisible: false, debugText: '', damageFlash: 0, underwater: false },
      {
        health: game.player.health,
        hunger: game.player.hunger,
        air: game.player.air,
        maxAir: game.player.maxAir,
        survival: true,
      },
    );
  };

  /* ---------------- 1. a tree, and breaking its logs ---------------- */

  const TREE = { x: 4, y: 65, z: 4 };
  const shape = oakTree(new Rng(7));
  for (const [dx, dy, dz, id] of shape.blocks) world.setBlock(TREE.x + dx, TREE.y + dy, TREE.z + dz, id);
  const trunk = shape.blocks
    .filter(([dx, dy, dz, id]) => id === B.oak_log && dx === 0 && dz === 0)
    .map(([, dy]) => dy)
    .sort((a, b) => a - b);
  check('the tree has a trunk to chop', trunk.length >= 3, `${trunk.length} logs`);
  eq('trunk base is an oak log block', world.getBlockAt(TREE.x, TREE.y, TREE.z), B.oak_log);
  eq('breaking a tree log yields oak_log', dropsFor(getBlock(B.oak_log))[0].item, 'oak_log');

  const breakAt = (x, y, z) => {
    const id = world.getBlockAt(x, y, z);
    game.breakBlock(
      { x, y, z, nx: 0, ny: 1, nz: 0, id, distance: 2, px: x, py: y + 1, pz: z },
      false,
    );
  };
  breakAt(TREE.x, TREE.y, TREE.z);
  eq('the log block is gone from the world', world.getBlockAt(TREE.x, TREE.y, TREE.z), 0);
  eq('breaking one log spawns one drop entity', game.drops.count, 1);
  eq('the drop carries the right item', game.drops.drops[0]?.stack.item, 'oak_log');
  eq('the drop carries the right count', game.drops.drops[0]?.stack.count, 1);
  for (const dy of trunk.slice(1, 3)) breakAt(TREE.x, TREE.y + dy, TREE.z);
  const dropped = game.drops.drops.reduce((n, d) => (d.stack.item === 'oak_log' ? n + d.stack.count : n), 0);
  eq('three chopped logs are in the world as drops', dropped, 3);
  eq('nothing reached the inventory yet', game.inventory.countOf('oak_log'), 0);

  /* ---------------- 2. walking over them collects them ---------------- */

  const walkOnto = (x, z, ticks = 120) => {
    game.player.position.set(x, 65, z);
    game.player.velocity.set(0, 0, 0);
    tick(ticks);
  };
  walkOnto(TREE.x + 0.5, TREE.z + 0.5);
  if (game.drops.count) walkOnto(TREE.x + 0.5, TREE.z + 0.5, 120);
  eq('walking over the drops empties the world of them', game.drops.count, 0);
  eq('the picked-up logs are in the inventory', game.inventory.countOf('oak_log'), 3);
  // the logs land in the selected hotbar slot, so the held view model must follow
  eq('the held-item view model followed the pickup', game.renderer3d.viewModel.currentKey, `b${B.oak_log}`);
  info(`picked up 3 oak_log; first hotbar slot now holds ${game.inventory.slots[0]?.item} x${game.inventory.slots[0]?.count}`);

  game.player.position.set(8.5, 65, 8.5);
  game.player.velocity.set(0, 0, 0);

  /* ---------------- 3. container clicks: the real ContainerUI ---------------- */

  const screenEl = () => layers.containers.querySelector('#container-screen');
  const fire = (el, type, props) => {
    const ev = { type, preventDefault: () => undefined, stopPropagation: () => undefined, ...props };
    el.dispatchEvent(ev);
  };
  const slotRefs = () => game.containers.refs;
  const refIndex = (pred) => slotRefs().findIndex(pred);
  const invSlotOf = (item) => refIndex((r) => r.kind === 'inv' && game.inventory.slots[r.index]?.item === item);
  const emptyInvSlot = () => refIndex((r) => r.kind === 'inv' && !game.inventory.slots[r.index]);
  const craftSlot = (i) => refIndex((r) => r.kind === 'craft' && r.index === i);
  const resultSlot = () => refIndex((r) => r.kind === 'result');
  const clickSlot = (index, button = 'left', shift = false) => {
    const el = game.containers.slotEls.get(String(index));
    if (!el) throw new Error(`no DOM element for slot ${index}`);
    clock.now += 500; // keep every click outside the 260 ms double-click window
    fire(screenEl(), 'mousedown', { target: el, button: button === 'right' ? 2 : 0, shiftKey: shift });
  };
  const cursor = () => game.containers.cursor;
  const stowCursor = () => {
    // put whatever the cursor holds into an empty inventory slot
    const empty = emptyInvSlot();
    if (empty >= 0) clickSlot(empty);
    return cursor() === null;
  };

  const inventoryMenu = () => game.openContainer('inventory');
  /** Park whatever the cursor holds in a free slot, then click the result slot. */
  const takeResult = () => {
    stowCursor();
    clickSlot(resultSlot());
    return cursor();
  };
  /** Exactly one log into the grid, take the planks, park everything else. */
  const craftOneLog = () => {
    clickSlot(invSlotOf('oak_log'));
    clickSlot(craftSlot(0), 'right');
    const produced = takeResult();
    stowCursor();
    return produced;
  };
  /**
   * Merge every stack of an item into the lowest-numbered slot that holds it
   * (the inventory is not one tidy stack, and `invSlotOf` only finds the first).
   * Returns that slot's ref index.
   */
  const consolidate = (item) => {
    const first = invSlotOf(item);
    if (first < 0) return -1;
    const firstIndex = slotRefs()[first].index;
    for (let guard = 0; guard < 40; guard++) {
      const other = refIndex((r) => r.kind === 'inv' && r.index !== firstIndex && game.inventory.slots[r.index]?.item === item);
      if (other < 0) break;
      clickSlot(other);
      clickSlot(first);
      if (cursor() !== null) break;
    }
    return first;
  };

  /* ---------------- 4. the crafting chain ---------------- */

  inventoryMenu();
  check('the survival inventory opens a 2x2 grid', game.containers.isOpen && game.crafting.size === 2);
  eq('the 2x2 grid has 4 craft slots', slotRefs().filter((r) => r.kind === 'craft').length, 4);

  // 1 log -> 4 planks
  clickSlot(invSlotOf('oak_log'));
  eq('clicking a stack picks it up onto the cursor', cursor()?.item, 'oak_log');
  clickSlot(craftSlot(0), 'right');
  eq('exactly one log sits in the crafting grid', game.crafting.slots[0]?.count, 1);
  const planksOut = takeResult();
  eq('the result slot crafts planks', planksOut?.item, 'oak_planks');
  eq('crafting one log gives exactly 4 planks', planksOut?.count, 4);
  check('the crafting grid was consumed', game.crafting.isEmpty());
  stowCursor();
  eq('4 planks are in the inventory', game.inventory.countOf('oak_planks'), 4);

  // 2 planks -> 4 sticks (shift-click crafts straight into the inventory)
  clickSlot(invSlotOf('oak_planks'));
  clickSlot(craftSlot(0), 'right');
  clickSlot(craftSlot(2), 'right');
  eq('two planks are laid out vertically', (game.crafting.slots[0]?.count ?? 0) + (game.crafting.slots[2]?.count ?? 0), 2);
  stowCursor();
  clickSlot(resultSlot(), 'left', true);
  eq('2 planks craft 4 sticks into the inventory', game.inventory.countOf('stick'), 4);
  eq('the two planks were consumed', game.inventory.countOf('oak_planks'), 2);
  check('shift-crafting emptied the grid', game.crafting.isEmpty());

  // 4 planks -> crafting table (a second log pays for it)
  eq('a second log gives 4 more planks', craftOneLog()?.count, 4);
  eq('6 planks are in the inventory', game.inventory.countOf('oak_planks'), 6);
  const planksBeforeTable = game.inventory.countOf('oak_planks');
  clickSlot(consolidate('oak_planks'));
  check('the whole planks stack is on the cursor', cursor()?.item === 'oak_planks' && cursor()?.count === 6, `${cursor()?.item} x${cursor()?.count}`);
  for (const i of [0, 1, 2, 3]) clickSlot(craftSlot(i), 'right');
  eq('four planks fill the 2x2 grid', game.crafting.slots.filter((s) => s?.item === 'oak_planks').length, 4);
  stowCursor();
  clickSlot(resultSlot());
  eq('4 planks craft a crafting table', cursor()?.item, 'crafting_table');
  eq('the table went onto the cursor', cursor()?.count, 1);
  stowCursor();
  eq('the crafting table is in the inventory', game.inventory.countOf('crafting_table'), 1);
  eq('exactly 4 planks were consumed', planksBeforeTable - game.inventory.countOf('oak_planks'), 4);

  /* ---------------- 5. placing the table and opening the 3x3 ---------------- */

  // move the table into the hotbar with clicks, the way a player would
  clickSlot(invSlotOf('crafting_table'));
  const hotbarTarget = refIndex((r) => r.kind === 'inv' && r.index < 9 && !game.inventory.slots[r.index]);
  check('there is a free hotbar slot for the table', hotbarTarget >= 0);
  const hotbarSlotIndex = slotRefs()[hotbarTarget].index;
  clickSlot(hotbarTarget);
  eq('the table is now in the hotbar', game.inventory.slots[hotbarSlotIndex]?.item, 'crafting_table');
  game.inventory.selected = hotbarSlotIndex;
  game.closeContainer();
  check('closing the container closes it', !game.containers.isOpen);
  eq('nothing was lost when the menu closed', game.inventory.countOf('crafting_table'), 1);

  // the third log pays for the pickaxe
  inventoryMenu();
  eq('the third log gives the last 4 planks', craftOneLog()?.count, 4);
  game.closeContainer();
  eq('all three logs became planks', game.inventory.countOf('oak_log'), 0);
  eq('6 planks are ready for the pickaxe', game.inventory.countOf('oak_planks'), 6);

  // aim at the ground in front of the player and right-click to place
  game.player.position.set(10.5, 65, 10.5);
  game.player.velocity.set(0, 0, 0);
  game.player.yaw = -Math.PI / 2; // facing +x
  game.player.pitch = -Math.PI / 4; // looking down at the ground
  game.running = true;
  game.useCooldown = 0;
  game.updateTarget();
  const aim = game.target;
  check('the player is looking at the ground in front of them', !!aim, String(aim));
  game.useCooldown = 0;
  game.tryUse();
  const [placedX, placedY, placedZ] = [aim.px, aim.py, aim.pz];
  eq('right-click placed a crafting table block', world.getBlockAt(placedX, placedY, placedZ), B.crafting_table);
  eq('placing the table consumed it', game.inventory.countOf('crafting_table'), 0);
  info(`table placed at ${placedX},${placedY},${placedZ}; upgradeable surface below: ${getBlock(world.getBlockAt(placedX, placedY - 1, placedZ)).name}`);

  game.useCooldown = 0;
  game.tryUse();
  check('using the placed table opens a container', game.containers.isOpen);
  eq('the open container is the crafting table', game.containers.ctx?.kind, 'crafting_table');
  eq('it offers a 3x3 grid', game.containers.ctx?.crafting?.size, 3);
  eq('the 3x3 grid has 9 craft slots', slotRefs().filter((r) => r.kind === 'craft').length, 9);

  /* ---------------- 6. the pickaxe ---------------- */

  const planksBefore = game.inventory.countOf('oak_planks');
  const sticksBefore = game.inventory.countOf('stick');
  clickSlot(consolidate('oak_planks'));
  for (const i of [0, 1, 2]) clickSlot(craftSlot(i), 'right');
  stowCursor();
  clickSlot(consolidate('stick'));
  for (const i of [4, 7]) clickSlot(craftSlot(i), 'right');
  stowCursor();
  eq('3 planks in the top row', game.containers.ctx.crafting.slots.filter((s) => s?.item === 'oak_planks').length, 3);
  eq('2 sticks in the middle column', game.containers.ctx.crafting.slots.filter((s) => s?.item === 'stick').length, 2);
  check('the cursor is empty before crafting the pickaxe', cursor() === null);
  clickSlot(resultSlot());
  eq('3 planks + 2 sticks craft a wooden pickaxe', cursor()?.item, 'wooden_pickaxe');
  stowCursor();

  eq('the pickaxe is in the inventory', game.inventory.countOf('wooden_pickaxe'), 1);
  eq('exactly 3 planks were consumed', planksBefore - game.inventory.countOf('oak_planks'), 3);
  eq('exactly 2 sticks were consumed', sticksBefore - game.inventory.countOf('stick'), 2);
  const pickaxe = game.inventory.slots.find((s) => s?.item === 'wooden_pickaxe');
  eq('the crafted pickaxe starts undamaged', pickaxe?.damage, 0);
  eq('the pickaxe has its real durability', itemDef('wooden_pickaxe').durability, 60);
  check('the pickaxe is a real tool', itemDef('wooden_pickaxe').toolClass === 'pickaxe' && itemDef('wooden_pickaxe').tier > 0);
  info(`chain complete: ${game.inventory.countOf('oak_planks')} planks, ${game.inventory.countOf('stick')} sticks, 1 wooden pickaxe in the inventory`);

  /* ---------------- 7. bug 2: icons must not be stolen by other slots ---------------- */

  const hotbarSlots = layers.hud.querySelectorAll('.hotbar-slot');
  eq('the HUD built 9 hotbar slots', hotbarSlots.length, 9);
  const iconsIn = (el) => el.children.filter((c) => c.className === 'icon');
  /** Every hotbar slot must own exactly one icon, and only when it holds a stack. */
  const hotbarProblems = () => {
    const bad = [];
    for (let i = 0; i < hotbarSlots.length; i++) {
      const stack = game.inventory.slots[i];
      const icons = iconsIn(hotbarSlots[i]);
      if (stack && icons.length !== 1) bad.push(`slot ${i} holds ${stack.item} but shows ${icons.length} icons`);
      if (!stack && icons.length > 0) bad.push(`slot ${i} is empty but still shows an icon`);
    }
    return bad;
  };
  const freeHotbar = () => refIndex((r) => r.kind === 'inv' && r.index < 9 && !game.inventory.slots[r.index]);
  const moveSlot = (from, to) => {
    clickSlot(from);
    clickSlot(to);
  };
  /** Move a whole stack of `item` into a free hotbar slot; returns its slot index. */
  const toHotbar = (item) => {
    const free = freeHotbar();
    if (free < 0) return -1;
    moveSlot(consolidate(item), free);
    return slotRefs()[free].index;
  };

  // arrange the hotbar the way a player would: one stack per slot
  const hotbarPlanks = toHotbar('oak_planks');
  const hotbarSticks = toHotbar('stick');
  const hotbarPick = toHotbar('wooden_pickaxe');
  check('the hotbar holds the crafted items', hotbarPlanks >= 0 && hotbarSticks >= 0 && hotbarPick >= 0, `${hotbarPlanks},${hotbarSticks},${hotbarPick}`);
  pumpHud();
  eq('the hotbar shows an icon for every held stack', hotbarProblems().length, 0, hotbarProblems().join(' | '));
  const paintedBefore = hotbarSlots.map((el) => iconsIn(el).reduce((n, c) => n + paintedPixels(c), 0));
  check('hotbar icons are actually painted', paintedBefore.filter((n) => n > 0).length >= 3, paintedBefore.join(','));
  // the copy a slot shows must be pixel-identical to a freshly drawn icon
  const copyMismatch = [];
  for (let i = 0; i < 9; i++) {
    const stack = game.inventory.slots[i];
    if (!stack) continue;
    const fresh = makeIcon(game.atlas, game.itemAtlas, stack.item, 34);
    const mounted = iconsIn(hotbarSlots[i])[0];
    if (!mounted || paintedPixels(mounted) !== paintedPixels(fresh)) {
      copyMismatch.push(`${stack.item}: ${mounted ? paintedPixels(mounted) : 'none'} vs ${paintedPixels(fresh)}`);
    }
  }
  eq('each hotbar icon is a faithful copy', copyMismatch.length, 0, copyMismatch.join(' | '));

  // opening the inventory screen draws the same items at the same icon size
  inventoryMenu();
  pumpHud();
  eq('opening the inventory does not steal the hotbar icons', hotbarProblems().length, 0, hotbarProblems().join(' | '));

  // ... and neither does moving stacks between squares
  moveSlot(invSlotOf('oak_planks'), emptyInvSlot());
  pumpHud();
  eq('moving a stack to another square keeps every hotbar icon', hotbarProblems().length, 0, hotbarProblems().join(' | '));

  // two squares holding the same item must own two *different* elements
  const planksBack = toHotbar('oak_planks');
  const hotbarB = freeHotbar();
  check('two hotbar slots are available for the duplicate test', planksBack >= 0 && hotbarB >= 0, `${planksBack},${hotbarB}`);
  if (planksBack >= 0 && hotbarB >= 0) {
    clickSlot(refIndex((r) => r.kind === 'inv' && r.index === planksBack), 'right'); // split in half
    clickSlot(hotbarB);
  }
  pumpHud();
  const sameItemIcons = [];
  for (let i = 0; i < 9; i++) {
    if (game.inventory.slots[i]?.item === 'oak_planks') sameItemIcons.push(...iconsIn(hotbarSlots[i]));
  }
  check('two hotbar slots holding the same item show two icons', sameItemIcons.length >= 2, `${sameItemIcons.length}`);
  check('those icons are distinct elements', new Set(sameItemIcons).size === sameItemIcons.length);
  eq('every hotbar icon is still in place', hotbarProblems().length, 0, hotbarProblems().join(' | '));

  // the container's own slots must each own a painted icon as well
  const containerBroken = [];
  let containerStacks = 0;
  for (let i = 0; i < slotRefs().length; i++) {
    const stack = game.containers.stackAt(slotRefs()[i]);
    const el = game.containers.slotEls.get(String(i));
    const icons = el ? iconsIn(el) : [];
    if (stack) {
      containerStacks++;
      if (icons.length !== 1) containerBroken.push(`slot ${i} (${stack.item}) shows ${icons.length} icons`);
      else if (icons.reduce((n, c) => n + paintedPixels(c), 0) === 0) containerBroken.push(`slot ${i} (${stack.item}) has a blank icon`);
    }
    if (!stack && icons.length > 0) containerBroken.push(`slot ${i} is empty but shows an icon`);
  }
  check('the container had stacks to draw', containerStacks >= 3, String(containerStacks));
  eq(
    'the container draws every inventory stack exactly once',
    containerStacks,
    game.inventory.slots.filter(Boolean).length + game.containers.ctx.crafting.slots.filter(Boolean).length,
  );
  eq('every container slot owns exactly one painted icon', containerBroken.length, 0, containerBroken.slice(0, 4).join(' | '));

  // the draggable cursor stack gets its own icon too
  clickSlot(invSlotOf('oak_planks'));
  const cursorEl = layers.containers.querySelector('#cursor-stack');
  eq('the cursor stack shows its icon', iconsIn(cursorEl).length, 1);
  check('the cursor icon is painted too', iconsIn(cursorEl).reduce((n, c) => n + paintedPixels(c), 0) > 0);
  stowCursor();
  pumpHud();
  eq('hotbar icons survive cursor drags', hotbarProblems().length, 0, hotbarProblems().join(' | '));

  /* ---------------- 8. closing a container returns its contents ---------------- */

  clickSlot(invSlotOf('stick'));
  clickSlot(craftSlot(0));
  eq('a stack can be parked in the crafting grid', game.containers.ctx.crafting.slots[0]?.item, 'stick');
  const sticksInGrid = game.containers.ctx.crafting.slots[0].count;
  const sticksHeldBefore = game.inventory.countOf('stick');
  game.closeContainer();
  eq('closing returns the grid to the inventory', game.inventory.countOf('stick'), sticksHeldBefore + sticksInGrid);

  /* ---------------- 9. a full inventory must not eat drops ---------------- */

  check('the cursor is empty before the pickup test', cursor() === null);
  for (let i = 0; i < 36; i++) game.inventory.slots[i] = makeStack('stone', 64);
  game.drops.clear();
  const p = game.player.position;
  game.drops.spawn('oak_log', 2, p.x, p.y + 0.4, p.z, 0);
  tick(120);
  eq('a drop stays in the world when the inventory is full', game.drops.count, 1);
  eq('the un-storable drop keeps its whole stack', game.drops.drops[0]?.stack.count, 2);
  eq('nothing was added to the full inventory', game.inventory.countOf('oak_log'), 0);
  game.inventory.slots[35] = null;
  tick(120);
  eq('freeing a slot lets the drop be collected', game.inventory.countOf('oak_log'), 2);
  eq('the collected drop left the world', game.drops.count, 0);

  /* ---- and neither may a closed screen destroy what the cursor held ---- */

  game.drops.clear();
  inventoryMenu();
  game.containers.cursor = makeStack('diamond', 5); // hold something with no room for it
  for (let i = 0; i < 36; i++) game.inventory.slots[i] = makeStack('stone', 64);
  game.closeContainer();
  eq('a full inventory spills the cursor instead of deleting it', game.drops.count, 1);
  eq('the spilled stack is intact', game.drops.drops[0]?.stack.item, 'diamond');
  eq('the spilled stack kept its count', game.drops.drops[0]?.stack.count, 5);
  check('the cursor was cleared', cursor() === null);
  eq('nothing was duplicated into the inventory', game.inventory.countOf('diamond'), 0);

  /* ---------------- 10. the icon factory itself ---------------- */

  const blockAtlas = buildBlockAtlas();
  const itemAtlas = buildItemAtlas();
  const hasMagenta = (c) => {
    const buf = c._buf;
    for (let i = 0; i < buf.length; i += 4) {
      if (buf[i] === 192 && buf[i + 1] === 32 && buf[i + 2] === 192) return true;
    }
    return false;
  };
  const a = makeIcon(blockAtlas, itemAtlas, 'oak_log', 34);
  const b = makeIcon(blockAtlas, itemAtlas, 'oak_log', 34);
  check('makeIcon hands out a fresh element every call', a !== b);
  // the exact shape of the bug: mounting the second icon must not unmount the first
  const boxA = new El('div');
  const boxB = new El('div');
  boxA.appendChild(a);
  boxB.appendChild(b);
  check(
    'two icons can be mounted at the same time',
    boxA.children.length === 1 && boxB.children.length === 1 && a.parentElement === boxA && b.parentElement === boxB,
    `${boxA.children.length}/${boxB.children.length}`,
  );
  check('a block icon is painted', paintedPixels(a) > 0, String(paintedPixels(a)));
  const stickIcon = makeIcon(blockAtlas, itemAtlas, 'stick', 34);
  check('an item sprite icon is painted', paintedPixels(stickIcon) > 0, String(paintedPixels(stickIcon)));
  const pickIcon = makeIcon(blockAtlas, itemAtlas, 'wooden_pickaxe', 40);
  check('the pickaxe icon has its own painter (no magenta marker)', !hasMagenta(pickIcon), '');

  console.log(`inventory: ${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}
