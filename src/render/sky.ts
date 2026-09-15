/**
 * Sky, sun, moon, stars and clouds, plus the day/night lighting model that the
 * terrain shader consumes.
 */

import * as THREE from 'three';
import { PixBuf, rgb, tileNoise } from './pixel.js';
import { SKY_VERT, SKY_FRAG, CLOUD_VERT, CLOUD_FRAG } from './materials.js';

export interface SkyState {
  /** 0 = dawn, 0.25 = noon, 0.5 = dusk, 0.75 = midnight */
  time: number;
  dayFactor: number;
  sunDir: THREE.Vector3;
  sunIntensity: number;
  starAmount: number;
  moonAmount: number;
  topColor: THREE.Color;
  horizonColor: THREE.Color;
  fogColor: THREE.Color;
  skyLight: THREE.Color;
  ambient: THREE.Color;
  underwater: boolean;
}

const DAY_TOP = new THREE.Color(0x3f7fdc);
const DAY_HORIZON = new THREE.Color(0xa9cbf0);
const NIGHT_TOP = new THREE.Color(0x03050e);
const NIGHT_HORIZON = new THREE.Color(0x0a1024);
const DUSK_HORIZON = new THREE.Color(0xe07a3c);
const DUSK_TOP = new THREE.Color(0x2c3f78);
const BELOW = new THREE.Color(0x0a1020);

const DAY_SKYLIGHT = new THREE.Color(1.0, 0.99, 0.95);
const NIGHT_SKYLIGHT = new THREE.Color(0.13, 0.16, 0.29);
const DAY_AMBIENT = new THREE.Color(0.055, 0.058, 0.07);
const NIGHT_AMBIENT = new THREE.Color(0.02, 0.023, 0.038);

/* ------------------------------------------------------------------ */
/* Clouds                                                              */
/* ------------------------------------------------------------------ */

/**
 * Cells across the cloud field. Each cell becomes a block in the 3D mesh.
 *
 * 96 cells at 12 units is a field 1152 blocks across, so the layer stretches
 * well past the view distance in every direction. At the original 48 the field
 * was 576 across and, being sparse, it was common to look up into a clear patch
 * and see clouds only far away - reported as the clouds not generating overhead.
 */
const CLOUD_CELLS = 96;
/** World units per cloud cell. */
const CLOUD_SCALE = 12;
/** Height of a cloud block. The original's fancy clouds are four blocks. */
const CLOUD_THICKNESS = 4;

/**
 * The cloud field: which cells are solid.
 *
 * The previous version used noise with a base period of 6 across the texture,
 * so each blob spanned about twenty texels, and at the coverage its threshold
 * produced they all merged - the sky had exactly one enormous cloud, in every
 * world, which is what was reported.
 *
 * Real clouds are many small puffs with clear sky between them. A shorter period
 * gives more, smaller blobs, and a higher threshold trims the coverage until the
 * gaps survive instead of being filled in by their neighbours.
 */
function buildCloudField(): Uint8Array {
  const N = CLOUD_CELLS;
  const n1 = tileNoise(N, N, 0x5151, 13, 2);
  const n2 = tileNoise(N, N, 0x9191, 27, 1);
  const out = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i++) {
    const v = n1[i] * 0.62 + n2[i] * 0.38;
    /*
     * Threshold chosen for roughly a third of the field.
     *
     * Set back to the value that was reported as looking right. Dropping it to
     * 0.565 for a quarter cover was meant to reduce an overcast impression, but
     * the sky is the one thing no headless render here can check - the reference
     * rasteriser builds its triangles from chunk meshes and never draws the dome
     * or the clouds - so a change made blind was a change made badly.
     */
    out[i] = v > 0.53 ? 1 : 0;
  }
  /*
   * Break up any remaining slabs. Even at a higher frequency a smooth noise
   * field produces a few large connected masses; clearing scattered cells thins
   * them into the ragged, separated puffs the original's sky has.
   */
  const holes = tileNoise(N, N, 0x77aa, 19, 1);
  let solid = 0;
  for (let i = 0; i < N * N; i++) {
    if (out[i] && holes[i] < 0.34) out[i] = 0;
    if (out[i]) solid++;
  }
  // Guarantee a sky with gaps even if the seed is unkind.
  if (solid > N * N * 0.42) {
    for (let i = 0; i < N * N; i++) if (holes[i] < 0.5) out[i] = 0;
  }
  return out;
}

/**
 * A 3D mesh of cloud blocks.
 *
 * Faces between two solid cells are not emitted, exactly as the terrain mesher
 * skips faces between two opaque blocks. For a field that is mostly surface this
 * removes well over half the geometry, and it is what makes a genuinely
 * three-dimensional cloud layer affordable.
 */
function buildCloudGeometry(field: Uint8Array): THREE.BufferGeometry {
  const N = CLOUD_CELLS;
  const s = CLOUD_SCALE;
  const t = CLOUD_THICKNESS;
  const half = (N * s) / 2;
  const at = (x: number, z: number) => (x < 0 || z < 0 || x >= N || z >= N ? 0 : field[z * N + x]);

  const pos: number[] = [];
  const col: number[] = [];

  // Top is brightest, sides dimmer, underside darkest - the same convention the
  // terrain shader uses, so clouds read as lit from above.
  const quad = (
    ax: number, ay: number, az: number,
    bx: number, by: number, bz: number,
    cx: number, cy: number, cz: number,
    dx: number, dy: number, dz: number,
    r: number, g: number, b: number,
  ) => {
    pos.push(ax, ay, az, bx, by, bz, cx, cy, cz, ax, ay, az, cx, cy, cz, dx, dy, dz);
    for (let i = 0; i < 6; i++) col.push(r, g, b);
  };

  for (let z = 0; z < N; z++) {
    for (let x = 0; x < N; x++) {
      if (!at(x, z)) continue;
      const x0 = x * s - half;
      const x1 = x0 + s;
      const z0 = z * s - half;
      const z1 = z0 + s;
      const y0 = 0;
      const y1 = t;
      if (!at(x, z - 1)) quad(x0, y0, z0, x0, y1, z0, x1, y1, z0, x1, y0, z0, 0.80, 0.83, 0.88);
      if (!at(x, z + 1)) quad(x1, y0, z1, x1, y1, z1, x0, y1, z1, x0, y0, z1, 0.80, 0.83, 0.88);
      if (!at(x - 1, z)) quad(x0, y0, z1, x0, y1, z1, x0, y1, z0, x0, y0, z0, 0.76, 0.79, 0.85);
      if (!at(x + 1, z)) quad(x1, y0, z0, x1, y1, z0, x1, y1, z1, x1, y0, z1, 0.76, 0.79, 0.85);
      if (!at(x, z)) continue;
      // top and bottom are always emitted for a solid cell
      quad(x0, y1, z1, x1, y1, z1, x1, y1, z0, x0, y1, z0, 1.0, 1.0, 1.0);
      quad(x0, y0, z0, x1, y0, z0, x1, y0, z1, x0, y0, z1, 0.62, 0.66, 0.74);
    }
  }

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  geo.computeVertexNormals();
  return geo;
}

function buildCloudTexture(): THREE.DataTexture {
  const S = 128;
  const buf = new PixBuf(S, S, 0xc10d);
  const n1 = tileNoise(S, S, 0x5151, 6, 4);
  const n2 = tileNoise(S, S, 0x9191, 16, 3);
  for (let y = 0; y < S; y++) {
    for (let x = 0; x < S; x++) {
      const v = n1[y * S + x] * 0.72 + n2[y * S + x] * 0.28;
      // quantised alpha keeps the clouds blocky rather than soft
      const on = v > 0.545;
      const edge = v > 0.5 && v <= 0.545;
      const shade = 200 + Math.floor(((x * 7 + y * 13) % 5) * 8);
      buf.set(x, y, on ? [shade, shade, shade, 255] : edge ? [180, 180, 180, 255] : [0, 0, 0, 0]);
    }
  }
  const tex = new THREE.DataTexture(new Uint8Array(buf.data), S, S, THREE.RGBAFormat);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.wrapS = THREE.RepeatWrapping;
  tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.NoColorSpace;
  tex.needsUpdate = true;
  return tex;
}

/* ------------------------------------------------------------------ */

export class Sky {
  readonly state: SkyState = {
    time: 0.28,
    dayFactor: 1,
    sunDir: new THREE.Vector3(0, 1, 0),
    sunIntensity: 1,
    starAmount: 0,
    moonAmount: 0,
    topColor: new THREE.Color(),
    horizonColor: new THREE.Color(),
    fogColor: new THREE.Color(),
    skyLight: new THREE.Color(),
    ambient: new THREE.Color(),
    underwater: false,
  };

  private dome: THREE.Mesh;
  private skyUniforms: Record<string, THREE.IUniform>;
  private clouds: THREE.Mesh;
  /** seconds per full day/night cycle */
  dayLength = 1200;
  private elapsed = 0.28 * 1200;

  constructor(scene: THREE.Scene) {
    this.skyUniforms = {
      uTopColor: { value: new THREE.Color(0x3f7fdc) },
      uHorizonColor: { value: new THREE.Color(0xa9cbf0) },
      uBottomColor: { value: new THREE.Color(0x0a1020) },
      uSunColor: { value: new THREE.Color(0xfff2c4) },
      uSunDir: { value: new THREE.Vector3(0, 1, 0) },
      uSunRight: { value: new THREE.Vector3(1, 0, 0) },
      uSunUp: { value: new THREE.Vector3(0, 0, 1) },
      uSunIntensity: { value: 1 },
      uStarAmount: { value: 0 },
      uMoonAmount: { value: 1 },
      // drives the star twinkle; the sky shader has no other use for time
      uTime: { value: 0 },
    };
    /*
     * High tessellation on purpose.
     *
     * `vDir` is a linearly interpolated varying, and the dome is viewed from
     * inside. Quads near the silhouette - the horizon - are seen almost edge-on,
     * so they cover a large screen area while spanning only a few degrees of
     * direction. Across such a quad the interpolated direction sweeps wrongly,
     * which smeared round stars into long streaks near the horizon while they
     * stayed round overhead. At 96x48 the error is roughly 28x smaller in each
     * direction and the effect disappears; 9216 triangles for the whole sky is
     * nothing beside the terrain's million.
     */
    const domeGeo = new THREE.SphereGeometry(1, 96, 48);
    const domeMat = new THREE.ShaderMaterial({
      uniforms: this.skyUniforms,
      vertexShader: SKY_VERT,
      fragmentShader: SKY_FRAG,
      side: THREE.BackSide,
      depthWrite: false,
      /*
       * Drawn LAST, with depth testing on, as a true skybox.
       *
       * The dome's vertex shader already forces its depth to the far plane, so
       * every pixel it covers is a pixel no geometry reached. Drawing it first
       * with depthTest off - which is what this used to do - filled the entire
       * screen and then had all the terrain painted over the top of it: a full
       * screen of pure overdraw, every frame, for nothing. Sorted last with
       * LessEqual it shades only the sky that is actually visible.
       */
      depthTest: true,
      depthFunc: THREE.LessEqualDepth,
      fog: false,
    });
    this.dome = new THREE.Mesh(domeGeo, domeMat);
    this.dome.frustumCulled = false;
    // after all opaque geometry, so the depth test can reject covered pixels
    this.dome.renderOrder = 900;
    this.dome.scale.setScalar(1);
    scene.add(this.dome);

    /*
     * A 3D cloud layer.
     *
     * This used to be a single 4000x4000 plane with a repeating texture, which
     * is flat by construction. It is now a mesh of blocks built from the cloud
     * field, so the layer has real thickness and its sides catch the light.
     *
     * Vertex colours carry the face shading, and three.js's own fog blends it
     * into the horizon, which is what the old uFogColor uniform was imitating.
     */
    const cloudField = buildCloudField();
    const cloudGeo = buildCloudGeometry(cloudField);
    const cloudMat = new THREE.MeshBasicMaterial({
      vertexColors: true,
      transparent: true,
      opacity: 0.88,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: true,
    });
    this.clouds = new THREE.Mesh(cloudGeo, cloudMat);
    this.clouds.name = 'clouds';
    this.clouds.position.y = 148;
    this.clouds.renderOrder = 2;
    this.clouds.frustumCulled = false;
    scene.add(this.clouds);
  }

  setTime(t: number): void {
    this.elapsed = ((t % 1) + 1) % 1 * this.dayLength;
  }

  get time(): number {
    return this.elapsed / this.dayLength;
  }

  update(dt: number, camera: THREE.Camera, playerY: number): SkyState {
    this.elapsed = (this.elapsed + dt) % this.dayLength;
    const t = this.elapsed / this.dayLength;
    const s = this.state;
    s.time = t;

    const a = t * Math.PI * 2;
    s.sunDir.set(Math.cos(a), Math.sin(a), 0.28).normalize();

    const sunHeight = s.sunDir.y;
    const dayFactor = smoothstep(-0.14, 0.26, sunHeight);
    s.dayFactor = dayFactor;
    s.sunIntensity = Math.max(0, smoothstep(-0.2, 0.1, sunHeight));
    s.starAmount = 1 - smoothstep(-0.18, 0.08, sunHeight);
    s.moonAmount = 1 - smoothstep(-0.1, 0.2, sunHeight);

    // warm band when the sun is near the horizon
    const dusk = Math.max(0, 1 - Math.abs(sunHeight) / 0.32) * smoothstep(-0.28, -0.02, sunHeight);
    s.topColor.copy(NIGHT_TOP).lerp(DAY_TOP, dayFactor).lerp(DUSK_TOP, dusk * 0.7);
    s.horizonColor.copy(NIGHT_HORIZON).lerp(DAY_HORIZON, dayFactor).lerp(DUSK_HORIZON, dusk * 0.85);
    s.fogColor.copy(s.horizonColor);

    s.skyLight.copy(NIGHT_SKYLIGHT).lerp(DAY_SKYLIGHT, dayFactor);
    s.ambient.copy(NIGHT_AMBIENT).lerp(DAY_AMBIENT, dayFactor);

    const u = this.skyUniforms;
    (u.uTopColor.value as THREE.Color).copy(s.topColor);
    (u.uHorizonColor.value as THREE.Color).copy(s.horizonColor);
    (u.uBottomColor.value as THREE.Color).copy(BELOW).lerp(s.horizonColor, dayFactor * 0.3);
    (u.uSunDir.value as THREE.Vector3).copy(s.sunDir);
    const right = new THREE.Vector3().crossVectors(s.sunDir, new THREE.Vector3(0, 1, 0)).normalize();
    if (right.lengthSq() < 1e-6) right.set(1, 0, 0);
    const up = new THREE.Vector3().crossVectors(right, s.sunDir).normalize();
    (u.uSunRight.value as THREE.Vector3).copy(right);
    (u.uSunUp.value as THREE.Vector3).copy(up);
    u.uSunIntensity.value = 0.35 + s.sunIntensity * 0.65;
    u.uStarAmount.value = s.starAmount;
    u.uMoonAmount.value = s.moonAmount;
    u.uTime.value = this.elapsed;
    (u.uSunColor.value as THREE.Color).setRGB(1.0, 0.95 - dusk * 0.16, 0.76 - dusk * 0.3);

    // the dome follows the camera so it never clips
    this.dome.position.copy(camera.position);
    this.dome.scale.setScalar(1);

    /*
     * The cloud layer follows the player and drifts.
     *
     * It is a finite mesh that wraps: snapping the position to whole cloud
     * fields means the layer appears to tile seamlessly in every direction while
     * only ~48x48 cells of geometry exist. Drift is the same offset accumulating
     * across those field-sized steps.
     */
    const field = CLOUD_CELLS * CLOUD_SCALE;
    const driftX = (this.elapsed * 1.6) % field;
    const driftZ = (this.elapsed * 0.55) % field;
    this.clouds.position.x = Math.round((camera.position.x + driftX) / field) * field;
    this.clouds.position.z = Math.round((camera.position.z + driftZ) / field) * field;
    this.clouds.position.y = playerY + 120;
    /*
     * Clouds are unlit white geometry, so they have to be tinted by hand to
     * follow the sky - full white at noon, dim and blue at night, and never
     * below a floor or they vanish against the dark.
     */
    /*
     * Clouds are unlit white geometry, so the tint is applied by hand. Left at
     * the values that were reported as looking right.
     */
    const mat = this.clouds.material as THREE.MeshBasicMaterial;
    mat.opacity = 0.55 + dayFactor * 0.33;
    mat.color.setRGB(
      0.34 + dayFactor * 0.66,
      0.35 + dayFactor * 0.65,
      0.42 + dayFactor * 0.58,
    );
    return s;
  }

  /**
   * One line describing the cloud layer, for the debug overlay.
   *
   * The sky cannot be checked by any headless render here, so when clouds go
   * missing the only way to find out why is to report what the layer actually
   * is in the running game: how many cells are solid, where the mesh sits, and
   * whether it is visible.
   */
  cloudDebug(): string {
    const mat = this.clouds.material as THREE.MeshBasicMaterial;
    const pos = this.clouds.geometry.attributes.position;
    const n = pos ? pos.count : 0;
    return `Clouds ${n} verts  pos ${this.clouds.position.x.toFixed(0)},${this.clouds.position.y.toFixed(0)},${this.clouds.position.z.toFixed(0)}  vis ${this.clouds.visible}  op ${mat.opacity.toFixed(2)}`;
  }

  /** Temporarily hide the sky so a diagnostics pass can measure terrain alone. */
  setTestHidden(hidden: boolean): void {
    this.dome.visible = !hidden;
    this.clouds.visible = !hidden;
  }

  /** The cloud material, exposed for diagnostics. */
  get cloudTexture(): THREE.Texture | null {
    const m = this.clouds.material as THREE.MeshBasicMaterial;
    return m.map ?? null;
  }

  dispose(scene: THREE.Scene): void {
    scene.remove(this.dome);
    scene.remove(this.clouds);
    this.dome.geometry.dispose();
    (this.dome.material as THREE.Material).dispose();
    this.clouds.geometry.dispose();
    (this.clouds.material as THREE.Material).dispose();
  }
}

function smoothstep(e0: number, e1: number, x: number): number {
  const t = Math.min(1, Math.max(0, (x - e0) / (e1 - e0)));
  return t * t * (3 - 2 * t);
}

export { rgb };
