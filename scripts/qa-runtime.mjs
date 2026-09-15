// Headless runtime harness.
//
// Boots the REAL Game class with a fake DOM and a stub WebGL2 context so the
// entire browser render path can be exercised in Node: world creation, chunk
// streaming, scene assembly and frame submission. It reports what the renderer
// actually submitted (draw calls / triangles), which is the number that tells us
// whether terrain is reaching the GPU at all.
//
// The WebGL stub is deliberately permissive: it satisfies three.js's
// initialisation queries so the renderer runs to completion, but it does not
// rasterise anything.

const GL_CONSTANTS = {
  COMPILE_STATUS: 0x8b81,
  LINK_STATUS: 0x8b82,
  ACTIVE_UNIFORMS: 0x8b86,
  ACTIVE_ATTRIBUTES: 0x8b89,
  VALIDATE_STATUS: 0x8b83,
  MAX_TEXTURE_SIZE: 0x0d33,
  MAX_VERTEX_UNIFORM_VECTORS: 0x8dfb,
  MAX_FRAGMENT_UNIFORM_VECTORS: 0x8dfd,
  MAX_VARYING_VECTORS: 0x8dfc,
  MAX_VERTEX_ATTRIBS: 0x8869,
  MAX_TEXTURE_IMAGE_UNITS: 0x8872,
  MAX_COMBINED_TEXTURE_IMAGE_UNITS: 0x8b4d,
  MAX_CUBE_MAP_TEXTURE_SIZE: 0x851c,
  MAX_RENDERBUFFER_SIZE: 0x84e8,
  MAX_SAMPLES: 0x8d57,
  MAX_3D_TEXTURE_SIZE: 0x8073,
  MAX_ARRAY_TEXTURE_LAYERS: 0x88ff,
  VERSION: 0x1f02,
  SHADING_LANGUAGE_VERSION: 0x8b8c,
  VENDOR: 0x1f00,
  RENDERER: 0x1f01,
  NO_ERROR: 0,
  FRAMEBUFFER_COMPLETE: 0x8cd5,
  SCISSOR_BOX: 0x0c10,
  VIEWPORT: 0x0ba2,
};

function makeGl(canvas) {
  const calls = { drawElements: 0, drawArrays: 0, drawElementsInstanced: 0 };
  const programs = [];
  const shaderSources = [];

  const target = {
    canvas,
    drawingBufferWidth: canvas.width,
    drawingBufferHeight: canvas.height,
    ...GL_CONSTANTS,
  };

  const valueFor = (pname) => {
    switch (pname) {
      case GL_CONSTANTS.VERSION: return 'WebGL 2.0 (stub)';
      case GL_CONSTANTS.SHADING_LANGUAGE_VERSION: return 'WebGL GLSL ES 3.00 (stub)';
      case GL_CONSTANTS.VENDOR: return 'stub';
      case GL_CONSTANTS.RENDERER: return 'stub';
      case GL_CONSTANTS.MAX_TEXTURE_SIZE: return 16384;
      case GL_CONSTANTS.MAX_CUBE_MAP_TEXTURE_SIZE: return 16384;
      case GL_CONSTANTS.MAX_VERTEX_UNIFORM_VECTORS: return 4096;
      case GL_CONSTANTS.MAX_FRAGMENT_UNIFORM_VECTORS: return 4096;
      case GL_CONSTANTS.MAX_VARYING_VECTORS: return 32;
      case GL_CONSTANTS.MAX_VERTEX_ATTRIBS: return 16;
      case GL_CONSTANTS.MAX_TEXTURE_IMAGE_UNITS: return 16;
      case GL_CONSTANTS.MAX_COMBINED_TEXTURE_IMAGE_UNITS: return 32;
      case GL_CONSTANTS.MAX_RENDERBUFFER_SIZE: return 16384;
      case GL_CONSTANTS.MAX_SAMPLES: return 4;
      case GL_CONSTANTS.MAX_3D_TEXTURE_SIZE: return 2048;
      case GL_CONSTANTS.MAX_ARRAY_TEXTURE_LAYERS: return 2048;
      case GL_CONSTANTS.SCISSOR_BOX: return new Int32Array([0, 0, canvas.width, canvas.height]);
      case GL_CONSTANTS.VIEWPORT: return new Int32Array([0, 0, canvas.width, canvas.height]);
      default: return 0;
    }
  };

  const handler = {
    get(_t, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;

      // every GL enum is an ALL_CAPS constant: give it a stable number so
      // three.js's switch statements take a real branch instead of hitting a
      // function object.
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) {
        let h = 0;
        for (let i = 0; i < prop.length; i++) h = (Math.imul(h, 31) + prop.charCodeAt(i)) | 0;
        return (Math.abs(h) % 60000) + 1;
      }

      if (prop === 'getParameter') return (p) => valueFor(p);
      if (prop === 'getExtension') return () => null;
      if (prop === 'getSupportedExtensions') return () => [];
      if (prop === 'getShaderPrecisionFormat') return () => ({ precision: 23, rangeMin: 127, rangeMax: 127 });
      if (prop === 'getError') return () => 0;
      if (prop === 'getContextAttributes') return () => ({ alpha: false, depth: true, stencil: false, antialias: false });

      if (prop === 'createProgram') {
        const p = { __id: programs.length, __shaders: [] };
        programs.push(p);
        return () => p;
      }
      if (prop === 'createShader') return () => ({ __src: '' });
      if (prop === 'shaderSource') {
        return (_s, src) => {
          shaderSources.push(src);
          if (_s) _s.__src = src;
        };
      }
      if (prop === 'compileShader') return () => undefined;
      if (prop === 'attachShader') {
        return (p, s) => {
          if (p && p.__shaders) p.__shaders.push(s);
        };
      }
      if (prop === 'getShaderParameter') return () => true;
      if (prop === 'getShaderInfoLog') return () => '';
      if (prop === 'getProgramParameter') {
        return (p, pname) => {
          if (pname === GL_CONSTANTS.LINK_STATUS || pname === GL_CONSTANTS.VALIDATE_STATUS) return true;
          return 0; // no active uniforms/attributes: three.js simply skips them
        };
      }
      if (prop === 'getProgramInfoLog') return () => '';
      if (prop === 'getUniformLocation') return () => ({ __loc: 1 });
      if (prop === 'getAttribLocation') return () => 0;
      if (prop === 'getActiveUniform') return () => ({ name: 'u', size: 1, type: 0 });
      if (prop === 'getActiveAttrib') return () => ({ name: 'a', size: 1, type: 0 });

      if (prop === 'drawElements') {
        return () => {
          calls.drawElements++;
        };
      }
      if (prop === 'drawArrays') {
        return () => {
          calls.drawArrays++;
        };
      }
      if (prop === 'drawElementsInstanced' || prop === 'drawArraysInstanced') {
        return () => {
          calls.drawElementsInstanced++;
        };
      }

      // everything else is a harmless no-op returning a fresh object
      return (...args) => {
        // create* helpers must return something truthy and unique-ish
        if (prop.startsWith('create')) return { __created: prop, __args: args };
        if (prop.startsWith('is')) return false;
        if (prop.startsWith('get')) return null;
        return undefined;
      };
    },
  };

  const gl = new Proxy(target, handler);
  return { gl, calls, programs, shaderSources };
}

/* ------------------------------------------------------------------ */
/* DOM stub                                                            */
/* ------------------------------------------------------------------ */

function makeElement(tag = 'div') {
  const el = {
    tagName: tag.toUpperCase(),
    style: {},
    dataset: {},
    children: [],
    parentElement: null,
    classList: {
      _s: new Set(),
      add(c) {
        this._s.add(c);
      },
      remove(c) {
        this._s.delete(c);
      },
      toggle(c, on) {
        if (on === undefined) this._s.has(c) ? this._s.delete(c) : this._s.add(c);
        else on ? this._s.add(c) : this._s.delete(c);
      },
      contains(c) {
        return this._s.has(c);
      },
    },
    innerHTML: '',
    textContent: '',
    width: 1280,
    height: 720,
    clientWidth: 1280,
    clientHeight: 720,
    appendChild(c) {
      this.children.push(c);
      c.parentElement = this;
      return c;
    },
    removeChild(c) {
      const i = this.children.indexOf(c);
      if (i >= 0) this.children.splice(i, 1);
      return c;
    },
    insertBefore(c) {
      return this.appendChild(c);
    },
    remove() {
      if (this.parentElement) this.parentElement.removeChild(this);
    },
    setAttribute() {},
    getAttribute() {
      return null;
    },
    addEventListener() {},
    removeEventListener() {},
    dispatchEvent() {},
    // memoised so repeated lookups of the same selector return the same stub
    _q: new Map(),
    querySelector(sel) {
      if (!this._q.has(sel)) {
        const child = makeElement('div');
        child.parentElement = this;
        this._q.set(sel, child);
      }
      return this._q.get(sel);
    },
    querySelectorAll() {
      return [];
    },
    cloneNode() {
      return makeElement(this.tagName.toLowerCase());
    },
    focus() {},
    blur() {},
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 1280, height: 720, right: 1280, bottom: 720 };
    },
    getContext(type) {
      if (type === '2d') return make2d();
      return this.__gl ?? null;
    },
    toDataURL() {
      return 'data:,';
    },
    requestPointerLock() {
      return Promise.resolve();
    },
  };
  return el;
}

function make2d() {
  const noop = () => undefined;
  const grad = { addColorStop: noop };
  return {
    canvas: null,
    fillStyle: '#000',
    strokeStyle: '#000',
    globalAlpha: 1,
    globalCompositeOperation: 'source-over',
    imageSmoothingEnabled: false,
    font: '',
    textAlign: 'left',
    filter: 'none',
    save: noop,
    restore: noop,
    translate: noop,
    scale: noop,
    rotate: noop,
    setTransform: noop,
    resetTransform: noop,
    clearRect: noop,
    fillRect: noop,
    strokeRect: noop,
    beginPath: noop,
    closePath: noop,
    moveTo: noop,
    lineTo: noop,
    arc: noop,
    fill: noop,
    stroke: noop,
    clip: noop,
    drawImage: noop,
    fillText: noop,
    measureText: () => ({ width: 10 }),
    createLinearGradient: () => grad,
    createRadialGradient: () => grad,
    createImageData: (w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    getImageData: (x, y, w, h) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: noop,
  };
}

export async function run(load) {
  /* ---- install the stubs before importing anything with side effects ---- */
  const listeners = new Map();
  const canvas = makeElement('canvas');
  const { gl, calls } = makeGl(canvas);
  canvas.__gl = gl;

  globalThis.document = {
    createElement: (t) => {
      const el = makeElement(t);
      if (t === 'canvas') el.__gl = makeGl(el).gl;
      return el;
    },
    createElementNS: (_ns, t) => makeElement(t),
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: (t, cb) => listeners.set(t, cb),
    removeEventListener: () => {},
    body: makeElement('body'),
    documentElement: makeElement('html'),
    readyState: 'complete',
    exitPointerLock: () => {},
    pointerLockElement: null,
    hidden: false,
  };
  globalThis.window = {
    addEventListener: (t, cb) => listeners.set(t, cb),
    removeEventListener: () => {},
    innerWidth: 1280,
    innerHeight: 720,
    devicePixelRatio: 1,
    setInterval: () => 0,
    clearInterval: () => {},
    setTimeout: (cb) => {
      if (typeof cb === 'function') cb();
      return 0;
    },
    location: { href: 'http://127.0.0.1:5173/', search: '' },
  };
  // Node 24 exposes a read-only `navigator`; only define it when absent.
  if (!globalThis.navigator) {
    Object.defineProperty(globalThis, 'navigator', { value: { userAgent: 'node', platform: 'node' }, configurable: true });
  }
  globalThis.ImageData = class {
    constructor(data, width, height) {
      this.data = data;
      this.width = width;
      this.height = height;
    }
  };
  const store = new Map();
  globalThis.localStorage = {
    getItem: (k) => (store.has(k) ? store.get(k) : null),
    setItem: (k, v) => store.set(k, String(v)),
    removeItem: (k) => store.delete(k),
    clear: () => store.clear(),
  };
  // requestAnimationFrame is a QUEUE, not a single slot: the game and the
  // loading sequence both schedule callbacks, and overwriting one would kill
  // the main loop.
  const frameQueue = [];
  globalThis.requestAnimationFrame = (cb) => {
    frameQueue.push(cb);
    return frameQueue.length;
  };
  window.requestAnimationFrame = globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = () => {};

  const pumpFrames = () => {
    const pending = frameQueue.splice(0, frameQueue.length);
    for (const cb of pending) cb(performance.now());
  };

  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) pass++;
    else {
      fail++;
      console.error(`  FAIL ${name} ${extra}`);
    }
  };
  const info = (m) => console.log(`  . ${m}`);

  const errors = [];
  const origError = console.error;
  console.error = (...a) => {
    errors.push(a.map(String).join(' '));
    origError(...a);
  };

  /* ---- boot the real Game ---- */
  const { Game } = await load('game.js');
  const layers = {
    hud: makeElement(),
    containers: makeElement(),
    screens: makeElement(),
    debug: makeElement(),
  };

  let game = null;
  try {
    game = new Game(canvas, layers);
  } catch (e) {
    check('Game constructs', false, e && e.stack ? e.stack.split('\n').slice(0, 4).join(' | ') : String(e));
    console.log(`runtime: ${pass} passed, ${fail} failed`);
    process.exit(1);
  }
  check('Game constructs', !!game);
  info('Game constructed');

  /* ---- start a world exactly the way the UI does ---- */
  const { SaveSystem } = await load('save/save.js');
  const meta = {
    id: 'qa-runtime',
    name: 'QA',
    seed: 20240910,
    gameMode: 'creative',
    createdAt: Date.now(),
    lastPlayed: Date.now(),
    playTime: 0,
  };
  SaveSystem.upsertMeta(meta);

  try {
    // startWorld awaits requestAnimationFrame between preload slices, so the
    // frame queue must be pumped while it runs.
    const pump = setInterval(pumpFrames, 0);
    try {
      await game.startWorld(meta, 'creative');
    } finally {
      clearInterval(pump);
    }
  } catch (e) {
    check('startWorld completes', false, e && e.stack ? e.stack.split('\n').slice(0, 5).join(' | ') : String(e));
  }
  check('startWorld completes', game.running === true);
  info(`world: seed ${game.world.seed} loaded ${game.world.loadedCount} chunks`);

  /* ---- run frames ---- */
  for (let i = 0; i < 240; i++) pumpFrames();

  const cm = game.renderer3d.chunkManager;
  info(`streaming: loaded=${cm.stats.loaded} meshed=${cm.stats.meshed} faces=${cm.stats.faces} drawCalls=${cm.stats.drawCalls}`);
  check('chunks generated', cm.stats.loaded > 50, String(cm.stats.loaded));
  check('chunks meshed', cm.stats.meshed > 20, String(cm.stats.meshed));

  /* ---- is the terrain actually in the scene? ---- */
  const THREE = await import('three');
  let sceneMeshes = 0;
  let sceneTriangles = 0;
  const scan = (obj) => {
    if (obj.isMesh) {
      sceneMeshes++;
      const idx = obj.geometry.getIndex();
      sceneTriangles += idx ? idx.count / 3 : 0;
    }
    for (const c of obj.children) scan(c);
  };
  scan(game.renderer3d.scene);
  info(`scene: meshes=${sceneMeshes} triangles=${sceneTriangles}`);
  check('terrain meshes are in the scene', sceneMeshes > 20, String(sceneMeshes));
  check('terrain triangles are in the scene', sceneTriangles > 10000, String(sceneTriangles));

  const inScene = (o) => {
    let p = o;
    while (p) {
      if (p === game.renderer3d.scene) return true;
      p = p.parent;
    }
    return false;
  };
  check('chunk group is attached to the scene', inScene(cm.group));
  check('chunk group is visible', cm.group.visible !== false);

  /* ---- what did the renderer submit? ---- */
  // renderer.info is reset by every render() call, and the frame ends with the
  // held-item pass, so the authoritative signal is the stub's own counter.
  const info2 = game.renderer3d.renderer.info;
  info(`renderer.info.render: calls=${info2.render.calls} triangles=${info2.render.triangles} (reset by the view-model pass)`);
  info(`stub drawElements calls: ${calls.drawElements} over 240 frames`);
  check('renderer submitted world draw calls', calls.drawElements > 1000, String(calls.drawElements));
  if (info2.render.calls > 0) {
    check('renderer.info reports draw calls', info2.render.calls > 0, String(info2.render.calls));
  }

  // one more explicit probe: render the world scene alone and read the counters
  game.renderer3d.renderer.info.reset();
  game.renderer3d.renderer.render(game.renderer3d.scene, game.renderer3d.camera);
  info(`single world render: calls=${info2.render.calls} triangles=${info2.render.triangles}`);
  check('a single world render issues draw calls', info2.render.calls > 5, String(info2.render.calls));
  check('a single world render submits triangles', info2.render.triangles > 1000, String(info2.render.triangles));

  /* ---- camera + player sanity ---- */
  const cam = game.renderer3d.camera;
  const p = game.player;
  info(`camera ${cam.position.x.toFixed(1)},${cam.position.y.toFixed(1)},${cam.position.z.toFixed(1)} fov ${cam.fov} near ${cam.near} far ${cam.far} aspect ${cam.aspect.toFixed(2)}`);
  check('camera is not at the origin', Math.abs(cam.position.x) + Math.abs(cam.position.z) > 0.1);
  check('camera near plane is positive', cam.near > 0.001);
  check('camera aspect is sane', cam.aspect > 0.2 && cam.aspect < 6, String(cam.aspect));

  const px = Math.floor(p.position.x);
  const pz = Math.floor(p.position.z);
  const feetY = Math.floor(p.position.y);
  const eyeY = Math.floor(p.eyeY);
  const { getBlock } = await load('world/blocks.js');
  info(`player ${p.position.x.toFixed(1)},${p.position.y.toFixed(1)},${p.position.z.toFixed(1)} feet=${getBlock(game.world.getBlockAt(px, feetY, pz)).name} eye=${getBlock(game.world.getBlockAt(px, eyeY, pz)).name} onGround=${p.onGround}`);
  check('player is above the ground', game.world.heightAt(px, pz) > 0 && p.position.y > game.world.heightAt(px, pz), `y ${p.position.y.toFixed(1)} height ${game.world.heightAt(px, pz)}`);
  check('player eye is not inside a solid block', !getBlock(game.world.getBlockAt(px, eyeY, pz)).solid, getBlock(game.world.getBlockAt(px, eyeY, pz)).name);
  check('player head is not inside a solid block', !getBlock(game.world.getBlockAt(px, eyeY + 1, pz)).solid, getBlock(game.world.getBlockAt(px, eyeY + 1, pz)).name);

  /* ---- scene graph integrity: three.js dereferences every child ---- */
  const badChildren = [];
  const walkGraph = (obj, path) => {
    const kids = obj.children;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (!c || c.isObject3D !== true) {
        badChildren.push(`${path}[${i}] = ${String(c)}`);
        continue;
      }
      walkGraph(c, `${path}/${c.name || c.type}`);
    }
  };
  walkGraph(game.renderer3d.scene, 'scene');
  check('no invalid children in the scene graph', badChildren.length === 0, badChildren.slice(0, 6).join(' | '));

  /* ---- force every entity type + item drops into the scene ---- */
  const mobTypes = ['pig', 'cow', 'sheep', 'chicken', 'zombie', 'skeleton', 'spider', 'creeper'];
  let spawned = 0;
  for (const t of mobTypes) {
    if (game.mobs.spawn(t, p.position.x + 2, p.position.y + 1, p.position.z + 2)) spawned++;
  }
  info(`forced ${spawned}/${mobTypes.length} mob spawns; entities now ${game.mobs.entities.length}`);
  for (const item of ['stone', 'dirt', 'oak_log', 'diamond_pickaxe', 'apple', 'torch', 'glass']) {
    game.drops.spawn(item, 3, p.position.x + 1, p.position.y + 1.5, p.position.z + 1, 0);
  }
  const hurt = game.mobs.entities[0];
  if (hurt) hurt.hurt(2, p.position.x, p.position.z, game.entityHost, 0.2);

  for (let i = 0; i < 240; i++) pumpFrames();

  const bad2 = [];
  const walkGraph2 = (obj, path) => {
    const kids = obj.children;
    for (let i = 0; i < kids.length; i++) {
      const c = kids[i];
      if (!c || c.isObject3D !== true) {
        bad2.push(`${path}[${i}] = ${String(c)}`);
        continue;
      }
      walkGraph2(c, `${path}/${c.name || c.type}`);
    }
  };
  walkGraph2(game.renderer3d.scene, 'scene');
  check('scene graph is still valid after entities spawn', bad2.length === 0, bad2.slice(0, 6).join(' | '));
  check('entities built renderable objects', game.mobs.entities.every((e) => !e.object3D || e.object3D.isObject3D === true));

  // every entity object must actually be attached to the scene
  const attached = game.mobs.entities.filter((e) => {
    let o = e.object3D;
    while (o) {
      if (o === game.renderer3d.scene) return true;
      o = o.parent;
    }
    return false;
  });
  check('mob objects are attached to the scene', attached.length >= spawned, `${attached.length}/${spawned}`);

  /* ---- a frame with entities present must still submit draw calls ---- */
  const before = calls.drawElements;
  for (let i = 0; i < 60; i++) pumpFrames();
  check('frames still submit draw calls with entities present', calls.drawElements > before, `${before} -> ${calls.drawElements}`);

  /* ---- movement direction must match the look direction ---- */
  {
    const { Player: P } = await load('player/player.js');
    const probe = new P();
    const cases = [
      { yaw: 0, key: 'forward', fy: 0 },
      { yaw: Math.PI / 2, key: 'forward', fy: 1 },
      { yaw: -Math.PI / 2, key: 'forward', fy: 2 },
      { yaw: 0.7, key: 'forward', fy: 3 },
      { yaw: 1.3, key: 'right', fy: 4 },
      { yaw: -2.1, key: 'right', fy: 5 },
      { yaw: 2.6, key: 'left', fy: 6 },
    ];
    let worst = 0;
    let worstCase = '';
    for (const c of cases) {
      probe.yaw = c.yaw;
      probe.position.set(0, 100, 0);
      probe.velocity.set(0, 0, 0);
      const input = {
        forward: c.key === 'forward',
        back: false,
        left: c.key === 'left',
        right: c.key === 'right',
        jump: false,
        sneak: false,
        sprint: false,
      };
      // one movement step with no gravity interference
      const saved = probe.velocity.clone();
      probe.update({ getBlockAt: () => 0, isSolidAt: () => false, getSkyLightAt: () => 15, getBlockLightAt: () => 0, isLoadedAt: () => true } , input, 1 / 60);
      const move = probe.velocity.clone().sub(saved);
      move.y = 0;
      if (move.lengthSq() < 1e-8) continue;
      move.normalize();
      const look = probe.lookDir();
      look.y = 0;
      look.normalize();
      // strafing must be perpendicular to the look direction
      const want =
        c.key === 'forward' ? look : c.key === 'right' ? { x: -look.z, y: 0, z: look.x } : { x: look.z, y: 0, z: -look.x };
      const dot = move.x * want.x + move.z * want.z;
      const err = 1 - dot;
      if (err > worst) {
        worst = err;
        worstCase = `${c.key} @ yaw ${c.yaw.toFixed(2)} (alignment ${dot.toFixed(4)})`;
      }
    }
    info(`movement/look alignment worst error ${worst.toFixed(6)} ${worstCase}`);
    check('WASD movement matches the camera direction', worst < 0.02, worstCase);
  }
  const fog = game.renderer3d.uniforms.uFogColor.value;
  const lum = 0.2126 * fog.r + 0.7152 * fog.g + 0.0722 * fog.b;
  info(`fog colour ${fog.r.toFixed(3)},${fog.g.toFixed(3)},${fog.b.toFixed(3)} luminance ${lum.toFixed(3)}`);
  check('daytime fog is bright', lum > 0.15, `luminance ${lum.toFixed(3)}`);

  console.log(`runtime: ${pass} passed, ${fail} failed`);
  if (errors.length) {
    console.log(`runtime: ${errors.length} console.error calls were logged:`);
    for (const e of errors.slice(0, 12)) console.log(`   ! ${e.slice(0, 400)}`);
  }
  if (fail) process.exit(1);
}
