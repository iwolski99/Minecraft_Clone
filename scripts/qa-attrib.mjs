// Vertex attribute, index buffer and depth state contract.
//
// The terrain's geometry carries four attributes (position, uv, aColor, aLight)
// while the minimal "textured only" shader declares two of them, so the obvious
// suspicion behind "terrain renders black / invisible" is that three.js binds
// `uv` to the wrong buffer once a program uses fewer attributes than the
// geometry provides. It does not - `WebGLBindingStates.setupVertexAttributes`
// walks the *program's* active attributes and looks each one up in
// `geometry.attributes` BY NAME - but "it does not" has to be demonstrated, not
// asserted, and a GPU-side binding failure is silent.
//
// This drives the real THREE.WebGLRenderer against a stub WebGL2 context that
// records every buffer binding, `vertexAttribPointer` and `drawElements`, so the
// mapping from attribute name -> buffer contents is observable:
//
//   * four-attribute program   -> uv points at the uv Float32Array
//   * two-attribute program    -> uv still points at the uv Float32Array and no
//                                 pointer is set for the inactive aColor/aLight
//   * Uint32Array index buffer -> drawElements(UNSIGNED_INT, index.count)
//   * matrixAutoUpdate = false -> the chunk mesh still lands at its chunk origin
//   * a depthTest:false sky drawn first does not leave the depth test disabled
//
//   node scripts/qa-attrib.mjs
//   node scripts/qa.mjs attrib

import fs from 'node:fs';
import path from 'node:path';
import * as THREE from 'three';
import { ROOT, compileOnce } from './compile.mjs';

const BUILD = path.join(ROOT, '.qa-build');

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
  /* ones this test interprets rather than just forwards */
  FLOAT: 0x1406,
  UNSIGNED_BYTE: 0x1401,
  UNSIGNED_SHORT: 0x1403,
  UNSIGNED_INT: 0x1405,
  FLOAT_VEC2: 0x8b50,
  FLOAT_VEC3: 0x8b51,
  FLOAT_VEC4: 0x8b52,
  FLOAT_MAT4: 0x8b5c,
  ARRAY_BUFFER: 0x8892,
  ELEMENT_ARRAY_BUFFER: 0x8893,
  DEPTH_TEST: 0x0b71,
};

const ATTR_TYPE = {
  position: GL_CONSTANTS.FLOAT_VEC3,
  normal: GL_CONSTANTS.FLOAT_VEC3,
  uv: GL_CONSTANTS.FLOAT_VEC2,
  uv1: GL_CONSTANTS.FLOAT_VEC2,
  aColor: GL_CONSTANTS.FLOAT_VEC4,
  aLight: GL_CONSTANTS.FLOAT_VEC2,
  color: GL_CONSTANTS.FLOAT_VEC4,
};

/** A permissive WebGL2 stub that answers three.js's questions and records the draw state. */
function makeGl(canvas) {
  const rec = {
    programs: [],
    /** every vertexAttribPointer, with the buffer bound at the time */
    pointers: [],
    enabled: new Set(),
    draws: [],
    /** state changes in call order, so the state at each draw can be replayed */
    stateLog: [],
  };

  const target = {
    canvas,
    drawingBufferWidth: canvas.width,
    drawingBufferHeight: canvas.height,
    ...GL_CONSTANTS,
  };
  const enumFor = (name) => {
    let h = 0;
    for (let i = 0; i < name.length; i++) h = (Math.imul(h, 31) + name.charCodeAt(i)) | 0;
    return (Math.abs(h) % 60000) + 1;
  };
  const valueFor = (pname) => {
    switch (pname) {
      case GL_CONSTANTS.VERSION:
        return 'WebGL 2.0 (stub)';
      case GL_CONSTANTS.SHADING_LANGUAGE_VERSION:
        return 'WebGL GLSL ES 3.00 (stub)';
      case GL_CONSTANTS.VENDOR:
      case GL_CONSTANTS.RENDERER:
        return 'stub';
      case GL_CONSTANTS.MAX_VERTEX_ATTRIBS:
        return 16;
      case GL_CONSTANTS.SCISSOR_BOX:
      case GL_CONSTANTS.VIEWPORT:
        return new Int32Array([0, 0, canvas.width, canvas.height]);
      default:
        return 16384;
    }
  };

  let boundArrayBuffer = null;
  let currentProgram = null;
  let depthTest = false;
  let depthMask = true;

  const handler = {
    get(_t, prop) {
      if (prop in target) return target[prop];
      if (typeof prop !== 'string') return undefined;
      if (/^[A-Z][A-Z0-9_]*$/.test(prop)) return enumFor(prop);

      switch (prop) {
        case 'getParameter':
          return (p) => valueFor(p);
        case 'getExtension':
          return () => null;
        case 'getSupportedExtensions':
          return () => [];
        case 'getShaderPrecisionFormat':
          return () => ({ precision: 23, rangeMin: 127, rangeMax: 127 });
        case 'getError':
          return () => 0;
        case 'getContextAttributes':
          return () => ({ alpha: false, depth: true, stencil: false, antialias: false });

        case 'createProgram': {
          const p = { __id: rec.programs.length, __attrs: [], __shaders: [] };
          rec.programs.push(p);
          return () => p;
        }
        case 'createShader':
          return () => ({ __src: '' });
        case 'shaderSource':
          return (s, src) => {
            if (s) s.__src = src;
          };
        case 'attachShader':
          return (p, s) => {
            if (p && p.__shaders && s) p.__shaders.push(s);
          };
        case 'compileShader':
        case 'linkProgram':
        case 'validateProgram':
          return (p) => {
            if (!p || prop === 'compileShader') return;
            // Which attributes survive compilation? three.js prepends
            // `attribute vec3 position; vec3 normal; vec2 uv;` and the shader
            // body adds its own; an unused attribute is optimised away, which is
            // exactly the situation under test.
            const vs = p.__shaders.find((s) => /gl_Position/.test(s.__src || ''));
            const src = vs ? vs.__src : '';
            const names = ['position', 'normal', 'uv', 'uv1', 'uv2', 'uv3', 'aColor', 'aLight', 'color'];
            const declared = new Set([...src.matchAll(/attribute\s+\w+\s+(\w+)/g)].map((m) => m[1]));
            p.__attrs = names
              .filter((n) => {
                if (n === 'position') return /gl_Position/.test(src);
                if (n === 'normal' || n === 'uv') return declared.has(n) || new RegExp(`\\b${n}\\b`).test(src);
                return declared.has(n);
              })
              .map((n) => ({ name: n, type: ATTR_TYPE[n] ?? GL_CONSTANTS.FLOAT_VEC4 }));
          };
        case 'getShaderParameter':
          return () => true;
        case 'getShaderInfoLog':
        case 'getProgramInfoLog':
          return () => '';
        case 'getProgramParameter':
          return (p, pname) => {
            if (pname === GL_CONSTANTS.LINK_STATUS || pname === GL_CONSTANTS.VALIDATE_STATUS) return true;
            if (pname === GL_CONSTANTS.ACTIVE_ATTRIBUTES) return p && p.__attrs ? p.__attrs.length : 0;
            return 0;
          };
        case 'getActiveAttrib':
          return (p, i) => {
            const a = p.__attrs[i];
            return { name: a.name, size: 1, type: a.type };
          };
        case 'getAttribLocation':
          return (p, name) => p.__attrs.findIndex((a) => a.name === name);
        case 'getUniformLocation':
          return () => ({ __loc: 1 });
        case 'getActiveUniform':
          return () => ({ name: 'u', size: 1, type: GL_CONSTANTS.FLOAT });

        case 'useProgram':
          return (p) => {
            currentProgram = p;
          };
        case 'bindBuffer':
          return (t, b) => {
            if (t === GL_CONSTANTS.ARRAY_BUFFER) boundArrayBuffer = b;
          };
        case 'bufferData':
          return (t, data) => {
            // keep the *identity* of the typed array so a pointer call can be
            // traced back to the attribute it came from
            if (t === GL_CONSTANTS.ARRAY_BUFFER && boundArrayBuffer) boundArrayBuffer.__data = data;
          };
        case 'enableVertexAttribArray':
          return (loc) => rec.enabled.add(loc);
        case 'disableVertexAttribArray':
          return (loc) => rec.enabled.delete(loc);
        case 'vertexAttribPointer':
          return (loc, size, type, normalized, stride, offset) =>
            rec.pointers.push({
              program: currentProgram,
              data: boundArrayBuffer ? boundArrayBuffer.__data : null,
              loc,
              size,
              type,
              normalized,
              stride,
              offset,
            });
        case 'enable':
          return (cap) => {
            if (cap === GL_CONSTANTS.DEPTH_TEST) depthTest = true;
            rec.stateLog.push({ cap, on: true });
          };
        case 'disable':
          return (cap) => {
            if (cap === GL_CONSTANTS.DEPTH_TEST) depthTest = false;
            rec.stateLog.push({ cap, on: false });
          };
        case 'depthMask':
          return (flag) => {
            depthMask = flag;
            rec.stateLog.push({ depthMask: flag });
          };
        case 'drawElements':
          return (mode, count, type, offset) =>
            rec.draws.push({ program: currentProgram, mode, count, type, offset, depthTest, depthMask });
        case 'drawArrays':
          return (mode, first, count) =>
            rec.draws.push({ program: currentProgram, mode, first, count, depthTest, depthMask });
        default:
          return (...args) => {
            if (prop.startsWith('create')) return { __created: prop, __args: args };
            if (prop.startsWith('is')) return false;
            if (prop.startsWith('get')) return null;
            return undefined;
          };
      }
    },
  };

  return { gl: new Proxy(target, handler), rec };
}

function makeCanvas(width = 320, height = 240) {
  const canvas = {
    width,
    height,
    style: {},
    addEventListener() {},
    removeEventListener() {},
    requestAnimationFrame: (cb) => setTimeout(() => cb(0), 16),
    cancelAnimationFrame: () => {},
    getContext(kind, attrs) {
      canvas.__kind = kind;
      canvas.__attrs = attrs;
      return gl;
    },
  };
  let gl = null;
  const made = makeGl(canvas);
  gl = made.gl;
  canvas.rec = made.rec;
  return canvas;
}

/* ------------------------------------------------------------------ */

export async function run(load) {
  let pass = 0;
  let fail = 0;
  const check = (name, cond, extra = '') => {
    if (cond) {
      pass++;
      console.log(`  ok    ${name}${extra ? `  (${extra})` : ''}`);
    } else {
      fail++;
      console.error(`  FAIL  ${name} ${extra}`);
    }
  };
  const info = (m) => console.log(`  . ${m}`);

  const canvas = makeCanvas();
  const rec = canvas.rec;
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
  info(`renderer created against ${canvas.__kind} (${renderer.capabilities.isWebGL2 ? 'WebGL2' : 'WebGL1'} path)`);

  /* ---- a chunk-like geometry: 4 attributes, Uint32Array index ---- */
  const makeChunkGeometry = () => {
    const geo = new THREE.BufferGeometry();
    const positions = new Float32Array([0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0]);
    const uvs = new Float32Array([0.25, 0.75, 0.5, 0.75, 0.5, 0.999, 0.25, 0.999]);
    const colors = new Uint8Array([255, 128, 64, 255, 255, 128, 64, 255, 255, 128, 64, 255, 255, 128, 64, 255]);
    const light = new Float32Array([1, 0, 1, 0, 1, 0, 1, 0]);
    const indices = new Uint32Array([0, 1, 2, 0, 2, 3]);
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geo.setAttribute('aColor', new THREE.BufferAttribute(colors, 4, true));
    geo.setAttribute('aLight', new THREE.BufferAttribute(light, 2));
    geo.setIndex(new THREE.BufferAttribute(indices, 1));
    geo.computeBoundingSphere();
    return { geo, positions, uvs, colors, light, indices };
  };

  const fullShader = new THREE.ShaderMaterial({
    name: 'terrain-full',
    uniforms: {},
    vertexShader: `
      attribute vec4 aColor;
      attribute vec2 aLight;
      varying vec2 vUv;
      varying vec4 vColor;
      varying vec2 vLight;
      void main() {
        vUv = uv;
        vColor = aColor;
        vLight = aLight;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      varying vec4 vColor;
      varying vec2 vLight;
      void main() { gl_FragColor = vec4(vUv, vColor.r, vLight.x); }
    `,
  });
  const minimalShader = new THREE.ShaderMaterial({
    name: 'terrain-minimal',
    uniforms: {},
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      varying vec2 vUv;
      void main() { gl_FragColor = vec4(vUv, 0.0, 1.0); }
    `,
  });

  const draw = (material, meshOpts = {}) => {
    const { geo, positions, uvs, colors, light, indices } = makeChunkGeometry();
    const mesh = new THREE.Mesh(geo, material);
    if (meshOpts.atChunkOrigin) {
      mesh.position.set(meshOpts.atChunkOrigin[0], 0, meshOpts.atChunkOrigin[1]);
      mesh.matrixAutoUpdate = false;
      mesh.updateMatrix();
    }
    const scene = new THREE.Scene();
    scene.add(mesh);
    const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    camera.position.set(0, 0, 3);
    camera.lookAt(0, 0, 0);
    // the sky-like quad: depthTest/depthWrite off, drawn before everything
    const sky = new THREE.Mesh(
      new THREE.PlaneGeometry(50, 50),
      new THREE.MeshBasicMaterial({ depthTest: false, depthWrite: false, color: 0x88bbff }),
    );
    sky.renderOrder = -1000;
    sky.position.set(0, 0, -1);
    scene.add(sky);

    rec.pointers.length = 0;
    rec.draws.length = 0;
    rec.enabled.clear();
    renderer.render(scene, camera);

    const byName = {};
    const lookup = {
      position: positions,
      uv: uvs,
      aColor: colors,
      aLight: light,
    };
    // The sky quad is drawn first with its own program; only the pointers issued
    // for the chunk's program say anything about the chunk geometry.
    const chunkDraw = rec.draws[rec.draws.length - 1];
    const chunkProgram = chunkDraw ? chunkDraw.program : null;
    const chunkPointers = rec.pointers.filter((p) => p.program === chunkProgram);
    for (const p of chunkPointers) {
      for (const [name, arr] of Object.entries(lookup)) {
        if (p.data === arr) byName[name] = p;
      }
    }
    return {
      geo,
      mesh,
      indices,
      byName,
      chunkPointers,
      pointers: rec.pointers.slice(),
      draws: rec.draws.slice(),
    };
  };

  /* ---- 1. the four-attribute program ---- */
  {
    const r = draw(fullShader);
    info(`four-attribute program: ${r.draws.length} draws, ${r.chunkPointers.length} attribute pointers`);
    check('geometry with a bounding sphere is drawn, not culled', r.draws.length >= 1, `${r.draws.length} draws`);
    const pos = r.byName.position;
    const uv = r.byName.uv;
    const col = r.byName.aColor;
    const lit = r.byName.aLight;
    check('position is bound to the position buffer', !!pos && pos.size === 3);
    check(
      'uv is bound to the uv buffer (not to aColor / aLight)',
      !!uv && uv.size === 2 && uv.type === GL_CONSTANTS.FLOAT && uv.normalized === false,
      uv ? `size=${uv.size} type=${uv.type} normalized=${uv.normalized}` : 'no pointer used the uv buffer',
    );
    check(
      'aColor is bound as a normalised 4-byte attribute',
      !!col && col.size === 4 && col.type === GL_CONSTANTS.UNSIGNED_BYTE && col.normalized === true,
      col ? `size=${col.size} type=${col.type} normalized=${col.normalized}` : 'missing',
    );
    check('aLight is bound as a 2-float attribute', !!lit && lit.size === 2 && lit.type === GL_CONSTANTS.FLOAT);
    check(
      'each attribute gets its own location',
      new Set([pos, uv, col, lit].map((p) => p && p.loc)).size === 4,
      [...new Set([pos, uv, col, lit].map((p) => p && p.loc))].join(','),
    );
  }

  /* ---- 2. the two-attribute program over the same geometry ---- */
  {
    const r = draw(minimalShader);
    info(`two-attribute program: ${r.draws.length} draws, ${r.chunkPointers.length} attribute pointers`);
    const uv = r.byName.uv;
    const pos = r.byName.position;
    check('the minimal shader still draws the chunk geometry', r.draws.length >= 1, `${r.draws.length} draws`);
    check(
      'uv still resolves to the uv buffer when the program ignores aColor / aLight',
      !!uv && uv.size === 2 && uv.type === GL_CONSTANTS.FLOAT,
      uv ? `size=${uv.size} type=${uv.type}` : 'no pointer used the uv buffer',
    );
    check(
      'no pointer is set up for the attributes the program dropped',
      r.chunkPointers.length === 2 && !!pos && !!uv,
      `${r.chunkPointers.length} pointers`,
    );
  }

  /* ---- 3. the index buffer ---- */
  {
    const r = draw(fullShader);
    const d = r.draws[r.draws.length - 1];
    info(`drawElements: mode=${d.mode} count=${d.count} type=${d.type} offset=${d.offset}`);
    check('the index buffer is submitted as UNSIGNED_INT', d.type === GL_CONSTANTS.UNSIGNED_INT, String(d.type));
    check('drawElements gets the whole index buffer', d.count === r.indices.length, `${d.count} vs ${r.indices.length}`);
    check('the index offset is zero', d.offset === 0, String(d.offset));
    check('6 indices = 2 triangles', d.count / 3 === 2, String(d.count / 3));

    // and the 16 bit path is still mapped correctly
    const geo16 = makeChunkGeometry();
    geo16.geo.setIndex(new THREE.BufferAttribute(new Uint16Array([0, 1, 2]), 1));
    const m = new THREE.Mesh(geo16.geo, fullShader);
    const scene = new THREE.Scene();
    scene.add(m);
    const cam = new THREE.PerspectiveCamera(75, 1, 0.1, 100);
    cam.position.z = 3;
    rec.draws.length = 0;
    renderer.render(scene, cam);
    const d16 = rec.draws[rec.draws.length - 1];
    check('a Uint16Array index buffer maps to UNSIGNED_SHORT', d16.type === GL_CONSTANTS.UNSIGNED_SHORT, String(d16.type));
  }

  /* ---- 4. matrixAutoUpdate = false, exactly as chunkmanager.ts sets it ---- */
  {
    const ox = 1600;
    const oz = -1200;
    const r = draw(fullShader, { atChunkOrigin: [ox, oz] });
    const e = r.mesh.matrixWorld.elements;
    info(`chunk mesh matrixWorld translation: ${e[12]}, ${e[13]}, ${e[14]}`);
    check(
      'a chunk mesh with matrixAutoUpdate = false still reports its chunk origin',
      e[12] === ox && e[13] === 0 && e[14] === oz,
      `${e[12]},${e[13]},${e[14]}`,
    );
    check('and is not culled by the frustum test', r.draws.length >= 1, `${r.draws.length} draws`);
    info(`renderer.info.render: calls=${renderer.info.render.calls} triangles=${renderer.info.render.triangles}`);
    check('renderer.info counts the submitted terrain triangles', renderer.info.render.triangles >= 2);
  }

  /* ---- 5. the depth state a depthTest:false sky leaves behind ---- */
  {
    const r = draw(fullShader);
    const skyDraw = r.draws[0];
    const terrainDraw = r.draws[r.draws.length - 1];
    info(`first draw depthTest=${skyDraw.depthTest} depthMask=${skyDraw.depthMask}`);
    info(`terrain draw depthTest=${terrainDraw.depthTest} depthMask=${terrainDraw.depthMask}`);
    check('the sky really is submitted with the depth test off', skyDraw.depthTest === false);
    check('the depth test is re-enabled for the terrain draw', terrainDraw.depthTest === true);
    check('the depth mask is re-enabled for the terrain draw', terrainDraw.depthMask === true);
  }

  // three's dispose() stops the (never started) animation loop through a
  // global `cancelAnimationFrame` that does not exist in Node; that is not part
  // of what this test measures.
  try {
    renderer.dispose();
  } catch {
    /* the stub has no animation frame source */
  }
  console.log(`attrib: ${pass} passed, ${fail} failed`);
  return fail;
}

/* ------------------------------------------------------------------ */

async function main() {
  let load;
  if (process.argv[2] === '--built') {
    load = (rel) => import(new URL(`../.qa-build/src/${rel}`, import.meta.url).href);
  } else {
    if (!fs.existsSync(BUILD)) {
      const { ok } = compileOnce(BUILD);
      if (!ok) throw new Error('compile failed');
    }
    load = (rel) => import(new URL(`../.qa-build/src/${rel}`, import.meta.url).href);
  }
  void load;
  const failed = await run(null);
  if (failed) process.exit(1);
}

if (process.argv[1] && process.argv[1].endsWith('qa-attrib.mjs')) await main();
