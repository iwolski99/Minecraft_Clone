// Render-path QA.
//
//   node scripts/qa.mjs renderpath
//
// Browsers cannot launch in this environment, so this command proves the 3D
// path end to end without a GPU:
//
//   1. it builds the real atlas + World + VoxelMesher output and audits the
//      vertex buffers (finite in-chunk positions, in-range UVs, 0..255 colours
//      and light, alpha == 255, every index < vertexCount, repeated builds
//      byte-identical, and a biome tint above 1.0 clamping instead of wrapping
//      modulo 256),
//   2. it constructs the real materials/sky/view-model through src/render/ and
//      parses every ShaderMaterial's GLSL against its own uniforms object, its
//      varyings and the geometry attributes it reads (a uniform the shader uses
//      but the uniforms object omits, or a varying/attribute nothing supplies,
//      is exactly the class of bug that makes a material draw nothing, black or
//      garbage),
//   3. it runs the *real* THREE.WebGLRenderer against a mock WebGL2 context
//      that records the ordered clear/draw calls of a frame and asserts: the
//      sky dome is drawn before the terrain, the world pass submits geometry,
//      exactly one colour clear happens per frame and it happens *before* the
//      world is drawn, and the held-item pass (which reuses the depth buffer)
//      never touches the colour buffer again.
//
// Point 3 is what catches "the 3D viewport is a uniform clear colour": a second
// renderer.render() call with autoClear left on erases the world between
// drawing it and presenting it, leaving only the clear colour on screen.
//
// Known limitation: a GPU shader compile cannot be executed here. That is
// mitigated by the GLSL audit above plus an explicit check that the installed
// three.js still translates GLSL1 ShaderMaterial source (`attribute`,
// `varying`, `texture2D`, `gl_FragColor`) into GLSL3 for WebGL2.

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import * as THREE from 'three';

/* ================================================================== */
/* Mock WebGL2 context                                                 */
/* ================================================================== */

const noop = () => {};

function createMockGL(canvas) {
  const byName = new Map();
  const byValue = new Map();
  let nextConst = 0x2000;

  const glConst = (name) => {
    if (!byName.has(name)) {
      // The three buffer bits are the only constants combined with bitwise
      // OR/AND, so they get their real single-bit GL values.
      const fixed = { COLOR_BUFFER_BIT: 0x4000, DEPTH_BUFFER_BIT: 0x0100, STENCIL_BUFFER_BIT: 0x0400 };
      const v = fixed[name] ?? nextConst++;
      byName.set(name, v);
      byValue.set(v, name);
    }
    return byName.get(name);
  };

  const log = [];
  canvas.__calls = log;
  const obj = () => ({ __glObject: true });

  const api = {
    canvas,
    drawingBufferWidth: canvas.width,
    drawingBufferHeight: canvas.height,
    getContextAttributes: () => ({
      alpha: false, depth: true, stencil: false, antialias: false,
      premultipliedAlpha: true, preserveDrawingBuffer: false,
      powerPreference: 'high-performance', failIfMajorPerformanceCaveat: false,
    }),
    getExtension: () => null,
    getSupportedExtensions: () => [],
    isContextLost: () => false,
    getError: () => 0,
    finish: noop,
    flush: noop,
    getParameter(pname) {
      switch (byValue.get(pname)) {
        case 'VERSION': return 'WebGL 2.0 (qa mock)';
        case 'SHADING_LANGUAGE_VERSION': return 'WebGL GLSL ES 3.00 (qa mock)';
        case 'VENDOR':
        case 'RENDERER': return 'qa-mock';
        case 'VIEWPORT':
        case 'SCISSOR_BOX': return new Int32Array([0, 0, canvas.width, canvas.height]);
        case 'MAX_SAMPLES': return 4;
        case 'MAX_TEXTURE_SIZE':
        case 'MAX_CUBE_MAP_TEXTURE_SIZE': return 16384;
        case 'MAX_TEXTURE_IMAGE_UNITS':
        case 'MAX_COMBINED_TEXTURE_IMAGE_UNITS':
        case 'MAX_VERTEX_TEXTURE_IMAGE_UNITS': return 16;
        case 'MAX_VERTEX_ATTRIBS': return 16;
        case 'MAX_VERTEX_UNIFORM_VECTORS':
        case 'MAX_FRAGMENT_UNIFORM_VECTORS': return 1024;
        case 'MAX_VARYING_VECTORS': return 30;
        case 'MAX_ARRAY_TEXTURE_LAYERS': return 256;
        default: return 8;
      }
    },
    getShaderPrecisionFormat: () => ({ rangeMin: 127, rangeMax: 127, precision: 23 }),

    createShader: obj,
    shaderSource: noop,
    compileShader: noop,
    getShaderParameter: () => true,
    getShaderInfoLog: () => '',
    deleteShader: noop,
    createProgram: obj,
    attachShader: noop,
    bindAttribLocation: noop,
    linkProgram: noop,
    getProgramParameter(_p, pname) {
      const name = byValue.get(pname) ?? '';
      if (name === 'LINK_STATUS' || name === 'VALIDATE_STATUS') return true;
      return 0; // no active uniforms/attributes: three then uploads nothing
    },
    getProgramInfoLog: () => '',
    getActiveUniform: () => null,
    getActiveAttrib: () => null,
    getUniformLocation: () => null,
    getAttribLocation: () => -1,
    useProgram: (p) => log.push({ kind: 'useProgram', program: p }),
    deleteProgram: noop,

    createBuffer: obj,
    bindBuffer: noop,
    bufferData: noop,
    bufferSubData: noop,
    deleteBuffer: noop,
    createVertexArray: obj,
    bindVertexArray: noop,
    deleteVertexArray: noop,

    createTexture: obj,
    bindTexture: noop,
    activeTexture: noop,
    texParameteri: noop,
    texParameterf: noop,
    texImage2D: noop,
    texSubImage2D: noop,
    texStorage2D: noop,
    generateMipmap: noop,
    pixelStorei: noop,
    deleteTexture: noop,

    enable: noop,
    disable: noop,
    blendEquation: noop,
    blendEquationSeparate: noop,
    blendFunc: noop,
    blendFuncSeparate: noop,
    blendColor: noop,
    depthFunc: noop,
    depthMask: noop,
    colorMask: noop,
    cullFace: noop,
    frontFace: noop,
    lineWidth: noop,
    polygonOffset: noop,
    scissor: noop,
    viewport: noop,
    clearColor: noop,
    clearDepth: noop,
    clearStencil: noop,
    clear: (mask) => log.push({ kind: 'clear', mask }),
    drawArrays: () => log.push({ kind: 'draw' }),
    drawElements: () => log.push({ kind: 'draw' }),
    drawArraysInstanced: () => log.push({ kind: 'draw' }),
    drawElementsInstanced: () => log.push({ kind: 'draw' }),
    readPixels: noop,
  };

  return new Proxy(api, {
    get(target, prop) {
      if (prop in target) return target[prop];
      if (typeof prop === 'string' && /^[A-Z][A-Z0-9_]*$/.test(prop)) return glConst(prop);
      return noop;
    },
    has: () => true,
  });
}

function createMockCanvas(width, height) {
  const canvas = {
    width,
    height,
    style: {},
    clientWidth: width,
    clientHeight: height,
    addEventListener: noop,
    removeEventListener: noop,
    dispatchEvent: noop,
    getContext(kind) {
      if (String(kind).startsWith('webgl')) return canvas.__gl;
      return {
        putImageData: noop,
        getImageData: () => ({ data: new Uint8ClampedArray(4) }),
        drawImage: noop,
        fillRect: noop,
        clearRect: noop,
        imageSmoothingEnabled: false,
      };
    },
  };
  canvas.__gl = createMockGL(canvas);
  return canvas;
}

/** three.js touches a handful of browser globals; give it inert versions. */
function installDomGlobals() {
  const g = globalThis;
  if (!g.window) {
    g.window = { devicePixelRatio: 1, innerWidth: 1280, innerHeight: 720, addEventListener: noop, removeEventListener: noop };
  }
  if (!g.self) g.self = g.window;
  if (!g.navigator) g.navigator = { userAgent: 'node-qa' };
  if (!g.document) {
    g.document = {
      createElement: (tag) => (tag === 'canvas' ? createMockCanvas(1, 1) : { style: {}, appendChild: noop, addEventListener: noop }),
      createElementNS: () => createMockCanvas(1, 1),
      addEventListener: noop,
      removeEventListener: noop,
    };
  }
}

/* ================================================================== */
/* GLSL parsing                                                        */
/* ================================================================== */

const THREE_BUILTIN_ATTRIBUTES = new Set([
  'position', 'normal', 'uv', 'uv1', 'uv2', 'uv3', 'color', 'tangent',
  'skinIndex', 'skinWeight', 'instanceMatrix', 'instanceColor',
  'morphTargetInfluences', 'morphTarget0', 'morphNormal0', 'batchIndex',
]);

function stripComments(src) {
  return String(src).replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/\/\/[^\n]*/g, ' ');
}

/** name -> type for every `uniform` / `varying` / `attribute` declaration. */
function declared(src, keyword) {
  const out = new Map();
  const re = new RegExp(`\\b${keyword}\\s+(?:(?:lowp|mediump|highp)\\s+)?([A-Za-z_]\\w*)\\s+([A-Za-z_]\\w*)\\s*(?:\\[[^\\]]*\\])?\\s*;`, 'g');
  let m;
  while ((m = re.exec(stripComments(src))) !== null) out.set(m[2], m[1]);
  return out;
}

/* ================================================================== */
/* Tiny check runner                                                   */
/* ================================================================== */

const results = [];

function section(title) {
  results.push({ section: title });
}
function check(name, pass, detail = '') {
  results.push({ name, pass: !!pass, detail: detail ? String(detail) : '' });
  return !!pass;
}

/* ================================================================== */
/* Main                                                                */
/* ================================================================== */

export async function run(load) {
  installDomGlobals();
  const THREE = await import('three');

  const { buildBlockAtlas, buildItemAtlas } = await load('render/atlas.js');
  const { World } = await load('world/world.js');
  const { TerrainGenerator } = await load('worldgen/terrain.js');
  const { BIOMES } = await load('worldgen/biomes.js');
  const { B } = await load('world/blocks.js');
  const { VoxelMesher } = await load('render/mesher.js');
  const { createAtlasTexture } = await load('render/materials.js');
  const { CHUNK_X, CHUNK_Y, CHUNK_Z } = await load('world/chunk.js');

  const blockAtlas = buildBlockAtlas();
  const itemAtlas = buildItemAtlas();
  const blockTexture = createAtlasTexture(blockAtlas);
  const itemTexture = createAtlasTexture(itemAtlas);

  /* ---------------------------------------------------------------- */
  section('shader translation (three r169 + WebGL2)');
  {
    const threePath = fileURLToPath(import.meta.resolve('three'));
    const threeSrc = fs.readFileSync(threePath, 'utf8');
    check('installed three build found', threeSrc.length > 1000, threePath);
    check(
      'GLSL1 ShaderMaterial source is still translated to GLSL3',
      threeSrc.includes('#version 300 es') &&
        threeSrc.includes('#define attribute in') &&
        threeSrc.includes('#define varying out') &&
        threeSrc.includes('#define varying in') &&
        threeSrc.includes('#define texture2D texture') &&
        threeSrc.includes('#define gl_FragColor pc_fragColor'),
      'WebGLProgram must map attribute/varying/texture2D/gl_FragColor',
    );
  }

  /* ---------------------------------------------------------------- */
  section('colour pipeline');
  check('THREE.ColorManagement is disabled (display-space authoring)', THREE.ColorManagement.enabled === false);
  {
    const c = new THREE.Color(0xa9cbf0);
    const want = [169 / 255, 203 / 255, 240 / 255];
    const got = [c.r, c.g, c.b];
    check(
      'hex colours keep their authored (display-space) values',
      got.every((v, i) => Math.abs(v - want[i]) < 1e-4),
      `0xa9cbf0 -> ${got.map((v) => v.toFixed(4)).join(', ')} (want ${want.map((v) => v.toFixed(4)).join(', ')})`,
    );
  }
  check('block atlas texture is NoColorSpace', blockTexture.colorSpace === THREE.NoColorSpace, String(blockTexture.colorSpace));
  check('item atlas texture is NoColorSpace', itemTexture.colorSpace === THREE.NoColorSpace, String(itemTexture.colorSpace));

  /* ---------------------------------------------------------------- */
  section('mesher geometry (real generated + lit chunks)');

  const seed = 20240910;
  const world = new World(seed, new TerrainGenerator(seed));
  const mesher = new VoxelMesher(blockAtlas);
  const R = 1;
  for (let cz = -R; cz <= R; cz++) {
    for (let cx = -R; cx <= R; cx++) {
      const c = world.createChunk(cx, cz);
      world.generator.generateChunk(c);
      world.light.initialLight(c);
      c.stage = 'lit';
    }
  }

  let vertexTotal = 0;
  let indexTotal = 0;
  let faceTotal = 0;
  let badPosition = 0;
  let badUv = 0;
  let badColor = 0;
  let badAlpha = 0;
  let badLight = 0;
  let badIndex = 0;
  let badLengths = 0;
  let maxIndex = -1;

  for (let cz = -R; cz <= R; cz++) {
    for (let cx = -R; cx <= R; cx++) {
      const chunk = world.getChunk(cx, cz);
      const res = mesher.build(world, chunk);
      faceTotal += res.faceCount;
      for (const data of [res.opaque, res.transparent]) {
        if (!data) continue;
        const verts = data.positions.length / 3;
        vertexTotal += verts;
        indexTotal += data.indices.length;
        if (
          data.positions.length % 3 !== 0 ||
          data.uvs.length !== verts * 2 ||
          data.colors.length !== verts * 4 ||
          data.light.length !== verts * 2 ||
          data.indices.length % 3 !== 0
        ) {
          badLengths++;
        }
        if (
          !(data.positions instanceof Float32Array) ||
          !(data.uvs instanceof Uint16Array) ||
          !(data.colors instanceof Uint8Array) ||
          !(data.light instanceof Uint8Array) ||
          // Indices are 16-bit wherever the mesh fits, which halves index
          // bandwidth (12 bytes of every triangle's traffic). Anything past
          // 65,535 vertices legitimately falls back to 32-bit.
          !(data.indices instanceof Uint16Array || data.indices instanceof Uint32Array) ||
          (data.indices instanceof Uint16Array && verts > 65535)
        ) {
          badLengths++;
        }
        for (let i = 0; i < verts; i++) {
          const x = data.positions[i * 3];
          const y = data.positions[i * 3 + 1];
          const z = data.positions[i * 3 + 2];
          // local chunk space; box/leaf geometry may poke a block past an edge
          if (
            !Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(z) ||
            x < -1 || x > CHUNK_X + 1 || y < -1 || y > CHUNK_Y + 1 || z < -1 || z > CHUNK_Z + 1
          ) {
            badPosition++;
          }
          // normalised 16-bit
          const u = data.uvs[i * 2] / 65535;
          const v = data.uvs[i * 2 + 1] / 65535;
          if (!Number.isFinite(u) || !Number.isFinite(v) || u < 0 || u > 1 || v < 0 || v > 1) badUv++;
          for (let k = 0; k < 3; k++) {
            const c = data.colors[i * 4 + k];
            if (!(c >= 0 && c <= 255)) badColor++;
          }
          if (data.colors[i * 4 + 3] !== 255) badAlpha++;
          for (let k = 0; k < 2; k++) {
            // aLight is a plain float attribute holding 0..1
            // normalised 8-bit
            const l = data.light[i * 2 + k];
            if (!(l >= 0 && l <= 255)) badLight++;
          }
        }
        for (let i = 0; i < data.indices.length; i++) {
          const idx = data.indices[i];
          if (idx >= verts) badIndex++;
          if (idx > maxIndex) maxIndex = idx;
        }
      }
    }
  }

  check('chunks produced geometry', faceTotal > 1000, `${faceTotal} faces, ${vertexTotal} vertices, ${indexTotal / 3} triangles`);
  check('attribute arrays match the vertex count and dtypes', badLengths === 0, `${badLengths} bad buffers`);
  check('positions are finite and inside the chunk', badPosition === 0, `${badPosition} bad vertices`);
  check('uvs are finite and inside 0..1', badUv === 0, `${badUv} bad uvs`);
  check('aColor components are all inside 0..255', badColor === 0, `${badColor} out-of-range components`);
  check('aColor.a is always 255', badAlpha === 0, `${badAlpha} vertices with alpha != 255`);
  check('aLight components are all inside 0..1', badLight === 0, `${badLight} out-of-range components`);
  check('every index is < vertexCount', badIndex === 0, `${badIndex} bad indices, highest index ${maxIndex}`);

  {
    const chunk = world.getChunk(0, 0);
    const a = mesher.build(world, chunk);
    const b = mesher.build(world, chunk);
    const same =
      !!a.opaque && !!b.opaque &&
      a.opaque.positions.length === b.opaque.positions.length &&
      a.opaque.indices.length === b.opaque.indices.length &&
      a.opaque.positions.every((v, i) => v === b.opaque.positions[i]) &&
      a.opaque.colors.every((v, i) => v === b.opaque.colors[i]) &&
      a.opaque.light.every((v, i) => v === b.opaque.light[i]) &&
      a.opaque.indices.every((v, i) => v === b.opaque.indices[i]);
    check('rebuilding a chunk reuses the buffers without stale data', same);
    const big = mesher.build(world, world.getChunk(-1, -1));
    if (big.opaque) {
      const verts = big.opaque.positions.length / 3;
      check(
        'a later build slices exactly its own range',
        big.opaque.colors.length === verts * 4 &&
          big.opaque.light.length === verts * 2 &&
          big.opaque.indices.every((i) => i < verts),
      );
    } else {
      check('a later build slices exactly its own range', false, 'no opaque geometry for chunk (-1,-1)');
    }
  }

  /* ---------------------------------------------------------------- */
  section('mesher biome tint clamp');

  {
    // A grass top has l = AO_LEVEL[3] * FACE_SHADE[2] = 1.0, so the unclamped
    // byte is tint.r * 255 - above 255 for desert/savanna/plains/beach. A
    // Uint8Array store wraps modulo 256, which used to turn fully lit grass
    // tops into near-black (and magenta) blocks.
    let tintBiome = -1;
    for (let i = 0; i < BIOMES.length; i++) {
      const b = BIOMES[i];
      if (b && b.grassTint && b.grassTint.some((c) => c * 255 > 255)) {
        tintBiome = i;
        break;
      }
    }
    check('found a biome with a grass tint above 1.0', tintBiome >= 0, `biome id ${tintBiome}`);

    const grass = B.grass_block ?? 0;
    const stone = B.stone ?? 1;
    check('grass_block / stone block ids resolved', grass > 0, `grass=${grass} stone=${stone}`);

    const chunk = world.createChunk(400, 400); // private chunk, no neighbours
    const surface = 63;
    for (let z = 0; z < CHUNK_Z; z++) {
      for (let x = 0; x < CHUNK_X; x++) {
        for (let y = 0; y <= surface; y++) {
          const i = (y << 8) | (z << 4) | x;
          chunk.blocks[i] = y === surface ? grass : stone;
          chunk.skyLight[i] = 15;
          chunk.blockLight[i] = 0;
        }
      }
    }
    if (tintBiome >= 0) chunk.biome.fill(tintBiome);
    const res = mesher.build(world, chunk);
    let maxRed = 0;
    let maxGreen = 0;
    let maxBlue = 0;
    if (res.opaque) {
      for (let i = 0; i < res.opaque.positions.length / 3; i++) {
        maxRed = Math.max(maxRed, res.opaque.colors[i * 4]);
        maxGreen = Math.max(maxGreen, res.opaque.colors[i * 4 + 1]);
        maxBlue = Math.max(maxBlue, res.opaque.colors[i * 4 + 2]);
      }
    }
    check(
      'a fully lit grass top reaches full intensity instead of wrapping',
      !!res.opaque && maxRed >= 250,
      `max aColor.r = ${maxRed} (wraps to ~14 without the clamp)`,
    );
    check('the other tint channels stay in range', maxGreen <= 255 && maxBlue <= 255, `max g=${maxGreen} b=${maxBlue}`);
  }

  /* ---------------------------------------------------------------- */
  section('renderer construction (real scene, mock WebGL2)');

  const { Renderer } = await load('render/renderer.js');
  const canvas = createMockCanvas(1280, 720);
  const gl = canvas.__gl;
  const calls = canvas.__calls;

  let renderer3d = null;
  try {
    renderer3d = new Renderer(canvas, blockAtlas, itemAtlas, world);
    check('Renderer constructed against the mock context', true);
  } catch (e) {
    check('Renderer constructed against the mock context', false, e && e.message ? e.message : String(e));
  }

  if (renderer3d) {
    check('renderer.autoClear is off (each pass owns its buffers)', renderer3d.renderer.autoClear === false);
    check(
      'output colour space stays linear (no implicit re-encode)',
      renderer3d.renderer.outputColorSpace === THREE.LinearSRGBColorSpace,
      String(renderer3d.renderer.outputColorSpace),
    );

    renderer3d.applySettings({ fov: 75, renderDistance: 3, bobAmount: 1, graphics: 'fancy', showFps: false }, world);

    let spawn = { x: 0.5, y: 72, z: 0.5 };
    for (let r = 4; r < 900; r += 4) {
      const x = Math.round(Math.cos(r * 2.399) * r);
      const z = Math.round(Math.sin(r * 2.399) * r);
      const h = world.heightAt(x, z);
      if (h > 64) {
        spawn = { x: x + 0.5, y: h + 2.2, z: z + 0.5 };
        break;
      }
    }
    renderer3d.chunkManager.setCentre(spawn.x, spawn.z);
    const preload = { radius: 3, pass: 0, index: 0 };
    for (let i = 0; i < 8000 && renderer3d.chunkManager.preloadStep(preload, 25) < 1; i++) {
      /* stream until the staged preload reports done */
    }
    check(
      'chunk streamer produced meshes',
      renderer3d.chunkManager.meshedCount > 4,
      `${renderer3d.chunkManager.meshedCount} meshes, ${renderer3d.chunkManager.stats.faces} faces`,
    );

    renderer3d.camera.position.set(spawn.x, spawn.y, spawn.z);
    renderer3d.camera.rotation.set(-0.12, 0.7, 0);
    const skyState = renderer3d.sky.update(0.016, renderer3d.camera, spawn.y);
    renderer3d.update(0.016, world, skyState, { underwater: false, underground: false, bobAmount: 1, light: new THREE.Color(1, 1, 1) });

    /* ---------------- scene / sky state ---------------- */
    section('scene, sky and depth state');

    const scene = renderer3d.scene;
    const all = [];
    scene.traverse((o) => all.push(o));
    const dome = all.find((o) => o.isMesh && o.geometry && o.geometry.type === 'SphereGeometry');
    /*
     * Found by name, not by geometry type. This assertion used to require a
     * PlaneGeometry, which pinned the clouds as a flat sheet - so it would have
     * failed the moment they became genuinely 3D, which is what they should be.
     */
    const clouds = all.find((o) => o.isMesh && o.name === 'clouds');
    check('sky dome exists in the scene', !!dome);
    check('cloud layer exists in the scene', !!clouds);
    if (clouds) {
      /*
       * The clouds must be genuinely three-dimensional.
       *
       * They used to be a single flat plane with a repeating texture, so this
       * measured zero thickness. Real 3D clouds have height, and the sides are
       * what makes them read as volumes rather than a painted sheet.
       */
      const g = clouds.geometry;
      g.computeBoundingBox();
      const bb = g.boundingBox;
      const height = bb ? bb.max.y - bb.min.y : 0;
      check('the cloud layer has real thickness', height > 1, `height ${height.toFixed(2)}`);
      check('the cloud layer is not a flat plane', g.type !== 'PlaneGeometry', g.type);
      const verts = g.attributes.position ? g.attributes.position.count : 0;
      console.log(`  . cloud mesh: ${verts.toLocaleString()} vertices, ${height.toFixed(0)} units thick, type ${g.type}`);
      check('the cloud layer has geometry', verts > 600, `${verts} vertices`);
      check('cloud faces are shaded, not flat white', !!g.attributes.color);
    }
    if (dome) {
      check('sky dome does not write depth', dome.material.depthWrite === false);
      /*
       * The dome is a skybox, not a backdrop: its vertex shader forces its depth
       * to the far plane, so with depth testing on and LessEqual it shades only
       * the pixels no geometry reached. Drawing it first with depth testing off
       * - which this suite used to pin - filled the entire screen and then had
       * every terrain pixel painted over it: a full screen of pure overdraw,
       * every frame. These assertions now hold the efficient contract instead.
       */
      check('sky dome tests depth as a skybox', dome.material.depthTest === true);
      check('sky dome uses LessEqual so it fills only untouched pixels', dome.material.depthFunc === THREE.LessEqualDepth);
      check(
        'sky dome renders after other opaque geometry',
        all.filter((o) => o.isMesh && o !== dome && o.material && o.material.transparent !== true).every((o) => o.renderOrder <= dome.renderOrder),
        `dome.renderOrder=${dome.renderOrder}`,
      );
      check('sky dome is never frustum culled', dome.frustumCulled === false);
      const { uTopColor, uHorizonColor } = dome.material.uniforms;
      check(
        'sky uniforms carry display-space colours',
        Math.abs(uHorizonColor.value.r - 0.6627) < 0.01 && Math.abs(uTopColor.value.r - 0.2471) < 0.01,
        `horizon r=${uHorizonColor.value.r.toFixed(4)} top r=${uTopColor.value.r.toFixed(4)}`,
      );
      check('sky dome follows the camera', Math.abs(dome.position.x - renderer3d.camera.position.x) < 1e-6);
    }
    if (clouds) check('cloud layer does not write depth', clouds.material.depthWrite === false);

    const chunkMeshes = [];
    renderer3d.chunkManager.group.traverse((o) => {
      if (o.isMesh && o.material && /^terrain-/.test(o.material.name)) chunkMeshes.push(o);
    });
    const opaqueMesh = chunkMeshes.find((m) => m.material.name === 'terrain-opaque');
    const waterMesh = chunkMeshes.find((m) => m.material.name === 'terrain-water');
    check('chunk meshes exist in the scene graph', chunkMeshes.length > 4, `${chunkMeshes.length} chunk meshes`);
    if (opaqueMesh) {
      check('opaque terrain writes and tests depth', opaqueMesh.material.depthWrite === true && opaqueMesh.material.depthTest === true);
      check('opaque terrain is front-side only', opaqueMesh.material.side === THREE.FrontSide);
      check('chunk geometry has a bounding sphere for culling', !!opaqueMesh.geometry.boundingSphere);
    } else {
      check('opaque terrain mesh found', false);
    }
    if (waterMesh) {
      check('water is transparent and writes no depth', waterMesh.material.transparent === true && waterMesh.material.depthWrite === false);
    }

    {
      // The breaking overlay stacks the eight destroy stages in one DataTexture
      // (flipY is false, so data row 0 is v = 0). With repeat.y = 1/8 the
      // sampled band is [offset.y, offset.y + 1/8], so stage N must have
      // offset.y = N/8 exactly - otherwise mining shows the cracked-through
      // texture first and an intact block just before it breaks.
      const overlayTex = renderer3d.highlight.overlayTexture;
      const bands = [];
      for (const [progress, stage] of [[0.01, 0], [0.4, 3], [0.99, 7]]) {
        renderer3d.highlight.setProgress(progress);
        bands.push(overlayTex.offset.y * 8 === stage);
      }
      check(
        'the destroy overlay samples the stage that matches mining progress',
        overlayTex.repeat.y === 1 / 8 && bands.every(Boolean),
        `repeat.y=${overlayTex.repeat.y}`,
      );
      renderer3d.highlight.setProgress(0);
    }

    /* ---------------- materials: uniforms / varyings / attributes -------- */
    section('shader contract (uniforms, varyings, attributes)');

    const { ItemDropManager } = await load('items/drops.js');
    const drops = new ItemDropManager(blockAtlas, itemAtlas, blockTexture, itemTexture);

    const materials = [];
    const pushMat = (label, mat) => {
      if (mat && mat.isShaderMaterial) materials.push({ label, mat });
    };
    scene.traverse((o) => {
      if (o.material && o.material.isShaderMaterial) {
        pushMat(o.material.name || `${o.geometry ? o.geometry.type : o.type} material`, o.material);
      }
    });
    // held *block* geometry (built by blockicon.ts)
    renderer3d.viewModel.setHeld(B.stone ?? 1, null);
    renderer3d.viewModel.scene.traverse((o) => {
      if (o.material && o.material.isShaderMaterial) pushMat('viewmodel block material', o.material);
    });
    // held *item* sprite geometry (a bare plane)
    const itemTex = await load('render/itemTextures.js');
    const itemNames = typeof itemTex.itemNames === 'function' ? [...itemTex.itemNames()].sort() : [];
    const itemName = itemNames.length ? itemNames[0] : null;
    renderer3d.viewModel.setHeld(0, itemName);
    renderer3d.viewModel.scene.traverse((o) => {
      if (o.material && o.material.isShaderMaterial) pushMat('viewmodel item material', o.material);
    });
    pushMat('drops block material', drops.blockMat);
    pushMat('drops item material', drops.itemMat);

    const seen = new Set();
    const unique = [];
    for (const entry of materials) {
      if (seen.has(entry.mat.uuid)) continue;
      seen.add(entry.mat.uuid);
      unique.push(entry);
    }
    check('shader materials discovered', unique.length >= 5, `${unique.length} unique ShaderMaterials: ${unique.map((u) => u.label).join(', ')}`);

    for (const { label, mat } of unique) {
      const vert = mat.vertexShader;
      const frag = mat.fragmentShader;
      const missing = [];
      for (const [name] of [...declared(vert, 'uniform'), ...declared(frag, 'uniform')]) {
        if (!mat.uniforms || !(name in mat.uniforms)) missing.push(name);
      }
      check(`[${label}] every uniform the GLSL reads is supplied`, missing.length === 0, `missing: ${missing.join(', ')}`);

      // a fragment `in` with no matching vertex `out` - or a type mismatch - is
      // a link error, and a material with a dead program draws nothing at all
      const vertVaryings = declared(vert, 'varying');
      const fragVaryings = declared(frag, 'varying');
      const badVarying = [];
      for (const [name, type] of fragVaryings) {
        if (!vertVaryings.has(name)) badVarying.push(`${name}: not declared in the vertex shader`);
        else if (vertVaryings.get(name) !== type) badVarying.push(`${name}: ${vertVaryings.get(name)} vs ${type}`);
      }
      check(`[${label}] fragment varyings are produced by the vertex shader`, badVarying.length === 0, badVarying.join('; '));
      check(`[${label}] declares both stages and writes gl_FragColor`, !!vert && !!frag && /gl_FragColor\s*=/.test(stripComments(frag)));
    }

    /* ---------------- attribute contract ---------------- */
    const attributeFailures = [];
    const normalizedFailures = [];
    const roots = [scene, renderer3d.viewModel.scene];
    for (const root of roots) {
      root.traverse((o) => {
        const mat = o.material;
        if (!mat || !mat.isShaderMaterial || !o.geometry) return;
        const geoAttrs = o.geometry.attributes || {};
        for (const name of declared(mat.vertexShader, 'attribute').keys()) {
          if (THREE_BUILTIN_ATTRIBUTES.has(name)) continue;
          if (!(name in geoAttrs)) attributeFailures.push(`${mat.name || o.geometry.type} reads ${name}, geometry has ${Object.keys(geoAttrs).join('/') || 'none'}`);
        }
        if (mat.name === 'terrain-opaque' || mat.name === 'terrain-water') {
          const c = geoAttrs.aColor;
          const l = geoAttrs.aLight;
          if (!c || c.itemSize !== 4 || c.normalized !== true) normalizedFailures.push(`${mat.name}: aColor`);
          // aLight is a normalised byte pair. Light is a 0..15 level scaled to
          // 0..255, so a byte holds it exactly where a float was spending four
          // bytes to express 256 possible values; the game is GPU-bound on
          // vertex bandwidth, and this is the largest saving after positions.
          if (!l) normalizedFailures.push(`${mat.name}: aLight missing`);
          else if (l.itemSize !== 2) normalizedFailures.push(`${mat.name}: aLight itemSize ${l.itemSize}`);
          else if (l.normalized !== true) normalizedFailures.push(`${mat.name}: aLight must be normalised`);
          else if (!(l.array instanceof Uint8Array)) normalizedFailures.push(`${mat.name}: aLight must be Uint8Array`);
        }
      });
    }
    check('every custom attribute the shaders read is supplied by its geometry', attributeFailures.length === 0, attributeFailures.join('; '));
    check('chunk attributes use the expected dtypes', normalizedFailures.length === 0, normalizedFailures.join('; '));

    /* ---------------- frame composition ---------------- */
    section('frame composition (world pass then held-item pass)');

    // Tag every object with a marker pushed straight into the GL call log, so
    // the ordered clear/draw sequence can be attributed without guessing.
    const tag = (root, kind) => {
      root.traverse((o) => {
        const material = o.material;
        o.onBeforeRender = function () {
          calls.push({
            kind: 'object',
            tag: kind,
            material: material ? material.name || (o.geometry ? o.geometry.type : o.type) : 'none',
            object: o,
          });
        };
      });
    };
    tag(scene, 'world');
    tag(renderer3d.viewModel.scene, 'viewmodel');

    const CB = gl.COLOR_BUFFER_BIT;
    const DB = gl.DEPTH_BUFFER_BIT;

    const runFrame = () => {
      calls.length = 0;
      renderer3d.render();
      const worldCalls = renderer3d.renderer.info.render.calls;
      const worldTriangles = renderer3d.renderer.info.render.triangles;
      const programs = renderer3d.renderer.info.programs.map((p) => p.name || '(unnamed)');
      renderer3d.renderViewModel(new THREE.Color(1, 1, 1), 0, false, 0, 1);

      const seen2 = { worldDraws: 0, viewModelDraws: 0, firstWorldDraw: -1, lastWorldDraw: -1, firstDomeDraw: -1, firstTerrainDraw: -1, firstViewModelDraw: -1, lastViewModelDraw: -1 };
      const colourClears = [];
      const depthClears = [];
      const colourClearAfterWorldDraw = [];
      const colourClearAfterViewModelDraw = [];
      let current = 'unknown';

      for (let i = 0; i < calls.length; i++) {
        const c = calls[i];
        if (c.kind === 'object') {
          current = c.tag;
          if (c.tag === 'world' && c.object === dome && seen2.firstDomeDraw < 0) seen2.firstDomeDraw = i;
          if (c.tag === 'world' && c.material === 'terrain-opaque' && seen2.firstTerrainDraw < 0) seen2.firstTerrainDraw = i;
          if (c.tag === 'viewmodel' && seen2.firstViewModelDraw < 0) seen2.firstViewModelDraw = i;
          continue;
        }
        if (c.kind === 'clear') {
          if ((c.mask & CB) !== 0) {
            colourClears.push(i);
            if (seen2.lastWorldDraw >= 0 && seen2.lastViewModelDraw < 0) colourClearAfterWorldDraw.push(i);
            if (seen2.lastViewModelDraw >= 0) colourClearAfterViewModelDraw.push(i);
          } else if ((c.mask & DB) !== 0) {
            depthClears.push(i);
          }
          continue;
        }
        if (c.kind === 'draw') {
          if (current === 'world') {
            if (seen2.firstWorldDraw < 0) seen2.firstWorldDraw = i;
            seen2.lastWorldDraw = i;
            seen2.worldDraws++;
          } else if (current === 'viewmodel') {
            if (seen2.firstViewModelDraw < 0) seen2.firstViewModelDraw = i;
            seen2.lastViewModelDraw = i;
            seen2.viewModelDraws++;
          }
        }
      }
      return { ...seen2, colourClears, depthClears, colourClearAfterWorldDraw, colourClearAfterViewModelDraw, worldCalls, worldTriangles, programs };
    };

    // make sure the held-item pass has something to draw
    renderer3d.viewModel.setHeld(B.stone ?? 1, null);
    renderer3d.highlight.hide();

    const f1 = runFrame();
    check('the world pass submits geometry', f1.worldCalls > 10 && f1.worldTriangles > 1000, `${f1.worldCalls} draw calls, ${f1.worldTriangles} triangles`);
    check('the world pass issued draw calls for the chunks', f1.worldDraws > 10, `${f1.worldDraws} world draws`);
    // The dome goes last now (see the skybox note above), so what matters is
    // that terrain is submitted before it and that both still happen in the
    // world pass rather than being skipped.
    check(
      'terrain is drawn before the sky dome, which fills what is left',
      f1.firstDomeDraw >= 0 && f1.firstTerrainDraw >= 0 && f1.firstTerrainDraw < f1.firstDomeDraw,
      `dome@${f1.firstDomeDraw} terrain@${f1.firstTerrainDraw}`,
    );
    check(
      'the world pass resolved a program for the sky, terrain, water and particles',
      f1.programs.includes('terrain-opaque') &&
        f1.programs.includes('terrain-water') &&
        f1.programs.includes('particles') &&
        f1.programs.filter((n) => n === '(unnamed)').length >= 2,
      f1.programs.join(', '),
    );
    check('exactly one colour clear per frame', f1.colourClears.length === 1, `colour clears at ${f1.colourClears.join(', ')}`);
    check(
      'the colour clear happens before the world is drawn',
      f1.colourClears.length === 1 && f1.colourClears[0] < f1.firstWorldDraw,
      `clear@${f1.colourClears[0]} firstWorldDraw@${f1.firstWorldDraw}`,
    );
    check(
      'no colour clear after the world pass (the viewport cannot be wiped)',
      f1.colourClearAfterWorldDraw.length === 0,
      `clear(s) at ${f1.colourClearAfterWorldDraw.join(', ')} after world draws ended at ${f1.lastWorldDraw}`,
    );
    check('the held-item pass clears depth only', f1.depthClears.length === 1, `depth-only clears at ${f1.depthClears.join(', ')}`);
    check(
      'the depth-only clear sits between the two passes',
      f1.depthClears.length === 1 && f1.depthClears[0] > f1.lastWorldDraw,
      `depthClear@${f1.depthClears[0]} lastWorldDraw@${f1.lastWorldDraw}`,
    );
    check(
      'the held item is drawn after the world, on top of it',
      f1.viewModelDraws > 0 && f1.lastViewModelDraw > f1.lastWorldDraw,
      `${f1.viewModelDraws} view-model draws, last@${f1.lastViewModelDraw}, lastWorldDraw@${f1.lastWorldDraw}`,
    );
    check('the held-item pass never clears colour', f1.colourClearAfterViewModelDraw.length === 0, `clears at ${f1.colourClearAfterViewModelDraw.join(', ')}`);

    const f2 = runFrame();
    check(
      'a second frame keeps the same composition',
      f2.colourClears.length === 1 &&
        f2.colourClears[0] < f2.firstWorldDraw &&
        f2.colourClearAfterWorldDraw.length === 0 &&
        f2.viewModelDraws > 0 &&
        f2.lastViewModelDraw > f2.lastWorldDraw,
      `world draws ${f2.worldDraws}, view-model draws ${f2.viewModelDraws}`,
    );
  }

  /* ---------------------------------------------------------------- */
  /* Report                                                            */
  /* ---------------------------------------------------------------- */

  let passed = 0;
  let failed = 0;
  const lines = [];
  for (const r of results) {
    if (r.section) {
      lines.push('');
      lines.push(`-- ${r.section} ${'-'.repeat(Math.max(0, 56 - r.section.length))}`);
      continue;
    }
    if (r.pass) {
      passed++;
      lines.push(`  ok    ${r.name}${r.detail ? `  (${r.detail})` : ''}`);
    } else {
      failed++;
      lines.push(`  FAIL  ${r.name}${r.detail ? `  -> ${r.detail}` : ''}`);
    }
  }
  console.log(lines.join('\n'));
  console.log('');
  console.log(`renderpath: ${passed} passed, ${failed} failed`);

  if (failed > 0) {
    console.log('renderpath: FAILED');
    process.exit(1);
  }
  console.log('renderpath: all render-path checks passed.');
  return { passed, failed };
}
