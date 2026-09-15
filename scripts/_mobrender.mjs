// Scratch: software-render every mob rig to a PNG so the box models and
// procedural atlases can actually be eyeballed. Deleted before finishing.
import * as THREE from 'three';
import fs from 'node:fs';
import zlib from 'node:zlib';

let crcTableInited = null;

const { buildMobRig } = await import('../.mobbuild/entities/models.js');
const { SPECS } = await import('../.mobbuild/entities/mobs.js');

const W = 1180;
const H = 420;
const buf = new Uint8Array(W * H * 4);
// background: soft sky gradient
for (let y = 0; y < H; y++) {
  const t = y / H;
  const r = Math.round(150 + 60 * (1 - t));
  const g = Math.round(180 + 50 * (1 - t));
  const b = Math.round(220 + 30 * (1 - t));
  for (let x = 0; x < W; x++) {
    const i = (y * W + x) * 4;
    buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
  }
}

function setPx(x, y, r, g, b) {
  if (x < 0 || y < 0 || x >= W || y >= H) return;
  const i = (y * W + x) * 4;
  buf[i] = r; buf[i + 1] = g; buf[i + 2] = b; buf[i + 3] = 255;
}

/** Paints one rig, centred at (cx, groundY) with a fixed 3/4 camera. */
function drawRig(type, cx, groundY, scale) {
  const rig = buildMobRig(type);
  rig.root.updateMatrixWorld(true);

  const meshes = [];
  rig.root.traverse((o) => { if (o.isMesh) meshes.push(o); });
  if (!meshes.length) return 0;

  // Camera: an orthographic-ish three-quarter view built from an explicit
  // look-at basis. Everything is in world space, so `project` must NOT add the
  // screen-space centre again (rasterize already works in screen pixels).
  const eye = new THREE.Vector3(2.4 * scale, 1.35 * scale, 2.6 * scale);
  const target = new THREE.Vector3(0, 0.4 * scale, 0);
  const fwd = target.clone().sub(eye).normalize();
  const right = new THREE.Vector3().crossVectors(fwd, new THREE.Vector3(0, 1, 0)).normalize();
  const up = new THREE.Vector3().crossVectors(right, fwd).normalize();
  const f = 300; // focal length in screen px

  const project = (p) => {
    const d = p.clone().sub(eye);
    const z = d.dot(fwd);
    if (z <= 0.05) return null;
    const persp = f / z;
    return {
      x: cx + d.dot(right) * persp,
      y: groundY - d.dot(up) * persp,
      z,
    };
  };

  const atlas = meshes[0].material.map;
  const aw = atlas.image.width;
  const ah = atlas.image.height;
  const tex = atlas.image.data;

  let tris = 0;
  let drawn = 0;
  let minPx = Infinity, maxPx = -Infinity, minPy = Infinity, maxPy = -Infinity;
  let debugged = false;
  // painter order: far meshes first (cheap and good enough for a box rig)
  const drawList = [];
  for (const mesh of meshes) {
    const g = mesh.geometry;
    const pos = g.attributes.position;
    const uv = g.attributes.uv;
    const idx = g.index;
    const m = mesh.matrixWorld;
    const triCount = idx ? idx.count / 3 : pos.count / 3;
    for (let t = 0; t < triCount; t++) {
      const a = idx ? idx.getX(t * 3) : t * 3;
      const b = idx ? idx.getX(t * 3 + 1) : t * 3 + 1;
      const c = idx ? idx.getX(t * 3 + 2) : t * 3 + 2;
      const v = [a, b, c].map((i) => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(m));
      const depth = v.reduce((s, p) => s + p.distanceTo(eye), 0) / 3;
      drawList.push({ v, uvs: [a, b, c].map((i) => [uv.getX(i), uv.getY(i)]), depth });
    }
  }
  drawList.sort((p, q) => q.depth - p.depth);

  for (const tri of drawList) {
    const pts = tri.v.map(project);
    if (pts.some((p) => !p)) continue;
    if (!debugged) {
      debugged = true;
      console.log('   tri0 v=', tri.v.map((v) => `(${v.x.toFixed(2)},${v.y.toFixed(2)},${v.z.toFixed(2)})`).join(' '));
      console.log('   tri0 p=', pts.map((p) => `(${p.x.toFixed(1)},${p.y.toFixed(1)},${p.z.toFixed(2)})`).join(' '));
    }
    for (const p of pts) {
      if (p.x < minPx) minPx = p.x;
      if (p.x > maxPx) maxPx = p.x;
      if (p.y < minPy) minPy = p.y;
      if (p.y > maxPy) maxPy = p.y;
    }
    // face normal for flat shading
    const n = new THREE.Vector3().subVectors(tri.v[1], tri.v[0]).cross(new THREE.Vector3().subVectors(tri.v[2], tri.v[0])).normalize();
    const facing = Math.abs(n.dot(fwd));
    const shade = 0.62 + 0.38 * facing;
    drawn += rasterize(pts, tri.uvs, shade, tex, aw, ah);
    tris++;
  }
  console.log(`  ${type}: tris=${tris} pixels=${drawn} screen=[${minPx.toFixed(0)},${minPy.toFixed(0)} .. ${maxPx.toFixed(0)},${maxPy.toFixed(0)}] ` +
    `fwd=(${fwd.x.toFixed(2)},${fwd.y.toFixed(2)},${fwd.z.toFixed(2)}) up=(${up.x.toFixed(2)},${up.y.toFixed(2)},${up.z.toFixed(2)})`);
  return tris;
}

function rasterize(pts, uvs, shade, tex, aw, ah) {
  const minX = Math.max(0, Math.floor(Math.min(pts[0].x, pts[1].x, pts[2].x)));
  const maxX = Math.min(W - 1, Math.ceil(Math.max(pts[0].x, pts[1].x, pts[2].x)));
  const minY = Math.max(0, Math.floor(Math.min(pts[0].y, pts[1].y, pts[2].y)));
  const maxY = Math.min(H - 1, Math.ceil(Math.max(pts[0].y, pts[1].y, pts[2].y)));
  const [p0, p1, p2] = pts;
  const area = (p1.x - p0.x) * (p2.y - p0.y) - (p2.x - p0.x) * (p1.y - p0.y);
  if (Math.abs(area) < 1e-6) return 0;
  let painted = 0;
  for (let y = minY; y <= maxY; y++) {
    for (let x = minX; x <= maxX; x++) {
      const w0 = ((p1.x - x) * (p2.y - y) - (p2.x - x) * (p1.y - y)) / area;
      const w1 = ((p2.x - x) * (p0.y - y) - (p0.x - x) * (p2.y - y)) / area;
      const w2 = 1 - w0 - w1;
      if (w0 < 0 || w1 < 0 || w2 < 0) continue;
      let u = w0 * uvs[0][0] + w1 * uvs[1][0] + w2 * uvs[2][0];
      let v = w0 * uvs[0][1] + w1 * uvs[1][1] + w2 * uvs[2][1];
      // This samples `atlas.image.data` with the *canvas* convention
      // (v = 1 - row / height), which is how .mobbuild/entities/models.js built
      // its UVs - but the shader samples the uploaded buffer bottom-up, so this
      // tool paints mobs the GPU cannot see. Swapping this line for
      // `Math.floor(v * ah)` reproduces what the real renderer does.
      const tx = Math.min(aw - 1, Math.max(0, Math.floor(u * aw)));
      const ty = Math.min(ah - 1, Math.max(0, Math.floor((1 - v) * ah)));
      const ti = (ty * aw + tx) * 4;
      if (tex[ti + 3] < 40) continue;
      setPx(x, y, tex[ti] * shade, tex[ti + 1] * shade, tex[ti + 2] * shade);
      painted++;
    }
  }
  return painted;
}

// 1. all mob types in a row
const order = ['chicken', 'spider', 'arrow'];
let total = 0;
for (let i = 0; i < order.length; i++) {
  total += drawRig(order[i], 200 + i * 380, 330, order[i] === 'chicken' ? 6.0 : 2.4);
}
console.log('triangles drawn:', total);
fs.writeFileSync('scripts/_mobs.png', png(buf, W, H));
console.log('wrote scripts/_mobs.png');

/* ---------------- minimal PNG writer ---------------- */
function png(data, w, h) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) {
    raw[y * (w * 4 + 1)] = 0;
    Buffer.from(data.buffer, data.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(body.length);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(Buffer.concat([t, body])) >>> 0);
    return Buffer.concat([len, t, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
function crc32(buf) {
  if (!crcTableInited) {
    crcTableInited = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTableInited[n] = c;
    }
  }
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = crcTableInited[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}
