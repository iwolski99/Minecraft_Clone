/**
 * On-screen material probe (`?probe=1`).
 *
 * The terrain renders through a custom ShaderMaterial, the mobs through a
 * built-in MeshBasicMaterial, and the clouds through a ShaderMaterial - and in
 * one user's browser the middle one came out black while the other two worked.
 * That is impossible to diagnose from JavaScript, because a GPU-side sampling
 * failure is silent.
 *
 * This draws a row of labelled swatches, each using a different material +
 * texture combination, straight into the corner of the frame. One screenshot
 * then says exactly which combination the driver refuses to render.
 */

import * as THREE from 'three';

export interface ProbeSwatch {
  label: string;
  ok: boolean;
}

export class MaterialProbe {
  readonly scene = new THREE.Scene();
  readonly camera: THREE.OrthographicCamera;
  readonly swatches: ProbeSwatch[] = [];

  private disposables: (THREE.Material | THREE.BufferGeometry | THREE.Texture)[] = [];

  constructor(blockTexture: THREE.Texture, itemTexture: THREE.Texture, cloudTexture: THREE.Texture | null) {
    // screen-space: x/y in -1..1 with the origin at the centre
    this.camera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);

    // A tiny opaque checker texture so "did the texture arrive at all" is
    // distinguishable from "the texture arrived and is black".
    const checker = this.makeChecker();
    const geo = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(geo);

    const add = (
      label: string,
      x: number,
      material: THREE.Material,
      expect: string,
    ): void => {
      const mesh = new THREE.Mesh(geo, material);
      mesh.scale.set(0.16, 0.16, 1);
      mesh.position.set(x, 0.62, 0);
      this.scene.add(mesh);
      this.disposables.push(material);
      this.swatches.push({ label: `${label} (${expect})`, ok: true });
    };

    // 1. control: colour only, no texture  -> must be solid green
    add('1', -0.72, new THREE.MeshBasicMaterial({ color: 0x4caf50, fog: false }), 'solid green');
    // 2. the atlas through a BUILT-IN material (this is what the mobs use)
    add('2', -0.48, new THREE.MeshBasicMaterial({ map: blockTexture, fog: false }), 'block textures');
    // 3. a generated checker through a built-in material
    add('3', -0.24, new THREE.MeshBasicMaterial({ map: checker, fog: false }), 'checker');
    // 4. the atlas through a custom ShaderMaterial (what the terrain uses)
    add('4', 0.0, this.texturedShader(blockTexture), 'block textures');
    // 5. the checker through the same custom shader
    add('5', 0.24, this.texturedShader(checker), 'checker');
    // 6. the cloud texture through the custom shader (known to work in the wild)
    if (cloudTexture) add('6', 0.48, this.texturedShader(cloudTexture), 'clouds');
    // 7. the item atlas through a built-in material
    add('7', 0.72, new THREE.MeshBasicMaterial({ map: itemTexture, fog: false }), 'item sprites');

    void itemTexture;
  }

  /** 32x32 magenta/cyan checker: unmistakable if it arrives. */
  private makeChecker(): THREE.DataTexture {
    const S = 32;
    const data = new Uint8Array(S * S * 4);
    for (let y = 0; y < S; y++) {
      for (let x = 0; x < S; x++) {
        const on = ((x >> 3) + (y >> 3)) % 2 === 0;
        const o = (y * S + x) * 4;
        data[o] = on ? 255 : 0;
        data[o + 1] = on ? 0 : 255;
        data[o + 2] = on ? 255 : 255;
        data[o + 3] = 255;
      }
    }
    const tex = new THREE.DataTexture(data, S, S, THREE.RGBAFormat);
    tex.magFilter = THREE.NearestFilter;
    tex.minFilter = THREE.NearestFilter;
    tex.generateMipmaps = false;
    tex.colorSpace = THREE.NoColorSpace;
    tex.needsUpdate = true;
    this.disposables.push(tex);
    return tex;
  }

  /** The absolute minimum textured shader: one sampler, one uv varying. */
  private texturedShader(map: THREE.Texture): THREE.ShaderMaterial {
    return new THREE.ShaderMaterial({
      uniforms: { uMap: { value: map } },
      vertexShader: `
        varying vec2 vUv;
        void main() {
          vUv = uv;
          gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
        }
      `,
      fragmentShader: `
        uniform sampler2D uMap;
        varying vec2 vUv;
        void main() {
          gl_FragColor = texture2D(uMap, vUv);
        }
      `,
      depthTest: false,
      depthWrite: false,
      fog: false,
    });
  }

  render(renderer: THREE.WebGLRenderer): void {
    renderer.clearDepth();
    renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    for (const d of this.disposables) d.dispose();
    this.disposables.length = 0;
  }
}
