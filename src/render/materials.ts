/**
 * Terrain shaders.
 *
 * Lighting is entirely baked into vertex attributes by the mesher:
 *   aColor.rgb = ambient occlusion * face shading * biome tint
 *   aLight.rg  = skylight / blocklight (0..1)
 *
 * The fragment shader combines those with the current time-of-day sky colour and
 * the warm torch colour, then applies distance fog. No realtime lights, no
 * shadow maps - which is exactly why a large render distance stays cheap.
 */

import * as THREE from 'three';
import type { Atlas } from './atlas.js';
import { flipRowsInPlace } from './pixel.js';

/**
 * The whole render pipeline is authored in *display* space:
 *
 *  - atlas texels are tagged `NoColorSpace` and sampled verbatim,
 *  - the shaders mix them with hex-authored sky/fog colours and write
 *    `gl_FragColor` straight out (`outputColorSpace` stays linear, and three
 *    never injects a colour-space conversion into a ShaderMaterial),
 *  - the headless reference renderer in scripts/qa-render.mjs uses the same
 *    raw display values.
 *
 * three r169 enables `ColorManagement` by default, which converts every
 * `new THREE.Color(0xRRGGBB)` from sRGB to linear when it is *constructed*.
 * Nothing ever converts it back, so the sky, clouds, fog and clear colour all
 * rendered at ~1/4 of their authored brightness.
 *
 * This has to live at module scope - and in this module specifically - because
 * src/render/sky.ts builds its palette from hex literals while its own module
 * body runs, which happens before any Renderer exists (sky.ts imports this
 * file, so this statement executes first).
 */
THREE.ColorManagement.enabled = false;

export interface TerrainUniforms {
  uMap: { value: THREE.Texture };
  uSkyLight: { value: THREE.Color };
  uBlockLight: { value: THREE.Color };
  uAmbient: { value: THREE.Color };
  uFogColor: { value: THREE.Color };
  uFogNear: { value: number };
  uFogFar: { value: number };
  uTime: { value: number };
  uOpacity: { value: number };
  uAlphaTest: { value: number };
  uUnderwater: { value: number };
  uUnderwaterColor: { value: THREE.Color };
}

/**
 * Upload an atlas as a GPU texture.
 *
 * The rows are flipped on the way to the GPU. `atlas.data` is in canvas order
 * (row 0 = top) and every UV in the project is built to match it -
 * `Atlas.uvSlot()` returns `v = 1 - row / height` - but a `DataTexture` is
 * sampled bottom-up (`flipY` is false, and `UNPACK_FLIP_Y_WEBGL` does nothing for
 * an ArrayBufferView source, so this cannot be fixed with a texture flag).
 * Without the flip every terrain, item and block-icon UV lands on the mirrored
 * band of the atlas, which is unpainted: the opaque terrain shader then
 * multiplies black texels by the vertex lighting and renders solid black, and an
 * alpha-tested shader discards every fragment.
 *
 * Flipping here rather than in `uvSlot()` keeps `atlas.data` canvas-ordered, so
 * `texel()`, `averageColor()`, `toCanvas()`, the PNG dumps and the software
 * reference renderer all keep working unchanged.
 */
export function createAtlasTexture(atlas: Atlas): THREE.DataTexture {
  const data = new Uint8Array(atlas.data);
  flipRowsInPlace(data, atlas.width, atlas.height);
  const tex = new THREE.DataTexture(data, atlas.width, atlas.height, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.ClampToEdgeWrapping;
  tex.wrapT = THREE.ClampToEdgeWrapping;
  // Values are authored directly in display space; no conversion is applied.
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

export function createTerrainUniforms(map: THREE.Texture): TerrainUniforms {
  return {
    uMap: { value: map },
    uSkyLight: { value: new THREE.Color(1, 1, 1) },
    uBlockLight: { value: new THREE.Color(1.0, 0.72, 0.42) },
    uAmbient: { value: new THREE.Color(0.06, 0.07, 0.1) },
    uFogColor: { value: new THREE.Color(0.62, 0.76, 0.94) },
    uFogNear: { value: 60 },
    uFogFar: { value: 130 },
    uTime: { value: 0 },
    uOpacity: { value: 1 },
    uAlphaTest: { value: 0 },
    uUnderwater: { value: 0 },
    uUnderwaterColor: { value: new THREE.Color(0.12, 0.28, 0.55) },
  };
}

const TERRAIN_VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec2 aLight;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vLight;
varying float vDepth;
varying vec3 vWorld;

void main() {
  vUv = uv;
  vColor = aColor;
  vLight = aLight;
  vWorld = position + vec3(0.0);
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const TERRAIN_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSkyLight;
uniform vec3 uBlockLight;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uAlphaTest;
uniform float uOpacity;
uniform float uUnderwater;
uniform vec3 uUnderwaterColor;

varying vec2 vUv;
varying vec4 vColor;
varying vec2 vLight;
varying float vDepth;

void main() {
  vec4 tex = texture2D(uMap, vUv);
  if (tex.a < uAlphaTest) discard;

  vec3 light = max(max(uSkyLight * vLight.x, uBlockLight * vLight.y), uAmbient);
  vec3 c = tex.rgb * vColor.rgb * light;

  float fog = clamp((vDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  fog = fog * fog * (3.0 - 2.0 * fog);
  vec3 fogCol = uFogColor;
  if (uUnderwater > 0.5) {
    float wf = clamp((vDepth - 1.0) / 22.0, 0.0, 1.0);
    fogCol = mix(uUnderwaterColor, uUnderwaterColor * 0.35, wf);
    fog = max(fog, wf);
  }
  c = mix(c, fogCol, fog);
  gl_FragColor = vec4(c, tex.a * uOpacity);
}
`;

const WATER_VERT = /* glsl */ `
attribute vec4 aColor;
attribute vec2 aLight;
uniform float uTime;
varying vec2 vUv;
varying vec4 vColor;
varying vec2 vLight;
varying float vDepth;
varying vec3 vWorld;

void main() {
  vWorld = position;
  // subtle bob so the surface reads as liquid without a full fluid sim
  float bob = sin(position.x * 0.7 + uTime * 1.6) * 0.012 + sin(position.z * 0.9 - uTime * 1.1) * 0.012;
  vec3 p = vec3(position.x, position.y + max(0.0, step(0.5, fract(position.y))) * bob, position.z);
  vUv = uv;
  vColor = aColor;
  vLight = aLight;
  vec4 mv = modelViewMatrix * vec4(p, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;

const WATER_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uSkyLight;
uniform vec3 uBlockLight;
uniform vec3 uAmbient;
uniform vec3 uFogColor;
uniform float uFogNear;
uniform float uFogFar;
uniform float uOpacity;
uniform float uTime;
uniform float uUnderwater;
uniform vec3 uUnderwaterColor;
// Must be declared here as well as in TERRAIN_FRAG. Referencing an undeclared
// uniform is a compile error, which makes the whole program fail to link and the
// material draw nothing at all - the water and glass vanished completely.
uniform float uAlphaTest;

varying vec2 vUv;
varying vec4 vColor;
varying vec2 vLight;
varying float vDepth;
varying vec3 vWorld;

void main() {
  /*
   * This shader serves the whole transparent layer - water, ice, glass and
   * portal - so the sampled texel's OWN alpha has to be respected:
   *
   *   * glass is a frame at alpha ~205 around a fully transparent middle. Writing
   *     a constant uOpacity instead of tex.a painted that middle as
   *     vec4(0, 0, 0, 0.8) - 80% opaque black - which is why glass was neither
   *     see-through nor correct, and ice and portal were wrong in the same way.
   *   * uAlphaTest was declared but never used here, so a fully clear texel was
   *     never discarded.
   *
   * The UV scroll that used to live here has been removed: it applied to every
   * block in the layer, so it dragged glass's frame out of the sampled range
   * (the clamp below skips the outermost texels the frame is drawn on) and
   * animated ice. Water is a static tile for now; animating it properly needs a
   * separate material for the liquid layer so glass and ice keep a fixed UV.
   */
  vec4 tex = texture2D(uMap, vUv);
  if (tex.a < uAlphaTest) discard;
  vec3 light = max(max(uSkyLight * vLight.x, uBlockLight * vLight.y), uAmbient);
  vec3 c = tex.rgb * vColor.rgb * light * 1.06;

  float fog = clamp((vDepth - uFogNear) / max(1.0, uFogFar - uFogNear), 0.0, 1.0);
  fog = fog * fog * (3.0 - 2.0 * fog);
  vec3 fogCol = uFogColor;
  if (uUnderwater > 0.5) {
    float wf = clamp((vDepth - 1.0) / 20.0, 0.0, 1.0);
    fogCol = uUnderwaterColor;
    fog = max(fog, wf);
  }
  c = mix(c, fogCol, fog);
  /*
   * Opacity is the texel's own alpha, with a floor.
   *
   * A liquid tile is painted at alpha 220-255, so its surface is solid, while a
   * glass pane's fully transparent interior never reaches this line - it is
   * discarded by the alpha test above - and its frame blends at its own alpha.
   *
   * The floor exists because a completely invisible water surface is
   * catastrophic and silent: the player sees straight through to the sea floor,
   * which is unlit at depth, and the whole ocean reads as a black void in
   * daylight. Any future change that drives a liquid texel's alpha toward zero
   * now degrades the water instead of deleting it.
   */
  gl_FragColor = vec4(c, clamp(tex.a, 0.55, 1.0) * uOpacity);
}
`;

export function createTerrainMaterial(u: TerrainUniforms, opts: { transparent?: boolean; water?: boolean } = {}): THREE.ShaderMaterial {
  const water = !!opts.water;
  const mat = new THREE.ShaderMaterial({
    uniforms: u as unknown as Record<string, THREE.IUniform>,
    vertexShader: water ? WATER_VERT : TERRAIN_VERT,
    fragmentShader: water ? WATER_FRAG : TERRAIN_FRAG,
    transparent: !!opts.transparent,
    depthWrite: !opts.transparent,
    depthTest: true,
    side: water ? THREE.DoubleSide : THREE.FrontSide,
    alphaTest: 0,
  });
  mat.name = water ? 'terrain-water' : 'terrain-opaque';
  return mat;
}

/* ------------------------------------------------------------------ */
/* Sky                                                                 */
/* ------------------------------------------------------------------ */

export const SKY_VERT = /* glsl */ `
varying vec3 vDir;
void main() {
  vDir = position;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  gl_Position.z = gl_Position.w; // force to far plane
}
`;

export const SKY_FRAG = /* glsl */ `
uniform vec3 uTopColor;
uniform vec3 uHorizonColor;
uniform vec3 uBottomColor;
uniform vec3 uSunColor;
uniform vec3 uSunDir;
uniform vec3 uSunRight;
uniform vec3 uSunUp;
uniform float uSunIntensity;
uniform float uStarAmount;
uniform float uMoonAmount;
uniform float uTime;
varying vec3 vDir;

float hash(vec2 p) {
  p = fract(p * vec2(123.34, 456.21));
  p += dot(p, p + 45.32);
  return fract(p.x * p.y);
}

void main() {
  vec3 d = normalize(vDir);
  float h = clamp(d.y, -1.0, 1.0);
  vec3 col;
  if (h >= 0.0) {
    float t = pow(clamp(h, 0.0, 1.0), 0.62);
    col = mix(uHorizonColor, uTopColor, t);
  } else {
    col = mix(uHorizonColor, uBottomColor, clamp(-h * 2.4, 0.0, 1.0));
  }

  vec3 sdir = normalize(uSunDir);
  float sd = max(0.0, dot(d, sdir));
  col += uSunColor * pow(sd, 220.0) * 1.4 * uSunIntensity;
  col += uSunColor * pow(sd, 6.0) * 0.22 * uSunIntensity;

  /*
   * Stars.
   *
   * The previous version lit an entire cell of a slanted 2D projection of the
   * view direction - floor(d.xz * 90 + d.y * 33) - so a "star" was a filled
   * block whose screen size depended entirely on where you were looking: near
   * the horizon the projection stretches and the blocks became long streaks,
   * overhead they compressed into small squares, and nothing about it was
   * round or consistent.
   *
   * Stars are points. This carves a 3D grid in direction space - cells are
   * near-cubical on the celestial sphere rather than stretched - gives each
   * occupied cell one jittered position inside it, and lights a small disc
   * around that. The result is round, roughly uniform points that twinkle
   * independently, which is what the original's sky looks like.
   */
  if (uStarAmount > 0.001 && h > 0.02) {
    vec3 dn = normalize(d);
    vec3 starCell = floor(dn * 130.0);
    // hash() takes a vec2, and GLSL has no implicit vec3 -> vec2 conversion:
    // passing a vec3 here is a compile error, which fails the whole sky shader
    // and leaves nothing but the clear colour. Swizzle at every call.
    float r = hash(starCell.xy + starCell.z * 0.37);
    if (r > 0.988) {
      vec3 jitter = vec3(hash(starCell.xy + 1.7), hash(starCell.xy + 3.1), hash(starCell.xy + 5.3));
      // the cell centre in direction space, jittered within the cell and then
      // normalised, so the star sits somewhere inside its own cell
      vec3 pos = normalize(starCell + 0.5 + (jitter - 0.5) * 0.8);
      // Chord, not acos(dot(...)). Both give the angle for nearby directions,
      // but the dot product of two nearly-parallel unit vectors is 1 - a^2/2,
      // which loses most of its significant digits before acos ever sees it;
      // the subtraction below is exact for close values.
      float chord = length(dn - pos);
      float size = 0.0025 + 0.0030 * hash(starCell.xy + 7.9);
      float disc = 1.0 - smoothstep(size * 0.3, size, chord);
      float tw = 0.75 + 0.25 * sin(uTime * 1.6 + hash(starCell.xy + 11.3) * 40.0);
      float bright = (0.4 + 0.6 * smoothstep(0.988, 0.9995, r)) * tw * disc;
      col += vec3(bright) * uStarAmount * smoothstep(0.02, 0.3, h);
    }
  }

  /*
   * Aurora.
   *
   * A curtain of light standing above the northern horizon, present whenever the
   * stars are - uStarAmount is already the night factor, so the aurora fades in
   * and out with them and needs no uniform of its own.
   *
   * It is built from three layers, which is what gives a real aurora its look:
   * a broad band confined to a range of elevation, a slow wave along the horizon
   * that makes the band wander, and a fast, fine ripple that stands in for the
   * vertical folds. Colour runs green at the base through teal to violet at the
   * top, the way the real thing is layered by altitude.
   *
   * Cost is confined to a few sin and atan calls on pixels the depth test has
   * already let through, since the dome is drawn last behind the terrain.
   */
  if (uStarAmount > 0.001) {
    float az = atan(dn.z, dn.x);
    float el = h;
    // Brightest toward -Z, so it reads as a northern display rather than a ring.
    float north = 0.30 + 0.70 * smoothstep(-0.2, 1.0, -dn.z);
    // the band only occupies a range of elevation: nothing at the horizon
    // itself, fading out well before overhead
    float band = smoothstep(0.02, 0.20, el) * (1.0 - smoothstep(0.34, 0.72, el));
    if (band > 0.001) {
      float wave =
        sin(az * 2.3 + uTime * 0.11) * 0.55 +
        sin(az * 5.1 - uTime * 0.17) * 0.28 +
        sin(az * 11.0 + uTime * 0.29) * 0.12;
      // fine vertical striations, sheared by the wave so they lean and drift
      float fold = sin(az * 46.0 + wave * 7.0 + uTime * 0.55) * 0.5 + 0.5;
      fold = 0.35 + 0.65 * fold * fold;
      float strength = band * north * fold;
      vec3 green = vec3(0.22, 1.00, 0.42);
      vec3 teal = vec3(0.20, 0.88, 0.78);
      vec3 violet = vec3(0.58, 0.30, 0.95);
      vec3 acol = mix(green, teal, smoothstep(0.06, 0.34, el));
      acol = mix(acol, violet, smoothstep(0.34, 0.80, el));
      // a faint floor of glow so the curtain sits in the sky rather than on it
      col += acol * strength * uStarAmount * 0.85;
      col += acol * band * north * uStarAmount * 0.06;
    }
  }

  // square sun and moon, classic block-game style
  if (dot(d, sdir) > 0.0) {
    float ex = abs(dot(d, uSunRight));
    float ey = abs(dot(d, uSunUp));
    if (max(ex, ey) < 0.030) col = mix(col, uSunColor * 1.6 + 0.35, 1.0);
  }
  vec3 mdir = -sdir;
  if (dot(d, mdir) > 0.0) {
    float ex = abs(dot(d, uSunRight));
    float ey = abs(dot(d, uSunUp));
    if (max(ex, ey) < 0.024) col = mix(col, vec3(0.92, 0.93, 0.86), uMoonAmount);
    else if (max(ex, ey) < 0.032) col = mix(col, vec3(0.55, 0.58, 0.66), uMoonAmount * 0.5);
  }

  gl_FragColor = vec4(col, 1.0);
}
`;

/* ------------------------------------------------------------------ */
/* Clouds                                                              */
/* ------------------------------------------------------------------ */

export const CLOUD_FRAG = /* glsl */ `
uniform sampler2D uMap;
uniform vec3 uColor;
uniform float uOpacity;
uniform float uFogAmount;
uniform vec3 uFogColor;
varying vec2 vUv;
varying float vDepth;

void main() {
  vec4 t = texture2D(uMap, vUv);
  if (t.a < 0.35) discard;
  vec3 c = uColor * (0.82 + t.r * 0.3);
  float fog = clamp((vDepth - 240.0) / 420.0, 0.0, 1.0);
  c = mix(c, uFogColor, fog * uFogAmount);
  gl_FragColor = vec4(c, uOpacity * t.a);
}
`;

export const CLOUD_VERT = /* glsl */ `
varying vec2 vUv;
varying float vDepth;
void main() {
  vUv = uv;
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  vDepth = -mv.z;
  gl_Position = projectionMatrix * mv;
}
`;
