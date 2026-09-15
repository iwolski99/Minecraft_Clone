// Minimal PNG encoder (RGBA8, no filtering) - used by the QA renderer so visual
// checks never depend on an external image library.
import zlib from 'node:zlib';
import fs from 'node:fs';

const CRC_TABLE = (() => {
  const t = new Int32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c;
  }
  return t;
})();

function crc32(buf) {
  let c = -1;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/**
 * @param {string} file
 * @param {number} width
 * @param {number} height
 * @param {Uint8ClampedArray|Uint8Array} rgba
 */
export function writePng(file, width, height, rgba) {
  const raw = Buffer.alloc(height * (width * 4 + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width * 4 + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer ? rgba.buffer : rgba, rgba.byteOffset || 0, rgba.length).copy(
      raw,
      y * (width * 4 + 1) + 1,
      y * width * 4,
      (y + 1) * width * 4,
    );
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const png = Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
  fs.writeFileSync(file, png);
}

/** Draw an RGBA source buffer scaled by an integer factor onto an RGBA canvas buffer. */
export function makeCanvas(width, height, bg = [24, 24, 30, 255]) {
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    data[i * 4] = bg[0];
    data[i * 4 + 1] = bg[1];
    data[i * 4 + 2] = bg[2];
    data[i * 4 + 3] = bg[3];
  }
  return data;
}

export function blitScaled(dst, dstW, src, srcW, srcH, dx, dy, scale, alphaBlend = true) {
  for (let y = 0; y < srcH * scale; y++) {
    for (let x = 0; x < srcW * scale; x++) {
      const sx = (x / scale) | 0;
      const sy = (y / scale) | 0;
      const so = (sy * srcW + sx) * 4;
      const px = dx + x;
      const py = dy + y;
      if (px < 0 || py < 0) continue;
      const doff = (py * dstW + px) * 4;
      if (doff + 3 >= dst.length) continue;
      const a = src[so + 3] / 255;
      if (!alphaBlend || a >= 0.999) {
        dst[doff] = src[so];
        dst[doff + 1] = src[so + 1];
        dst[doff + 2] = src[so + 2];
        dst[doff + 3] = 255;
      } else {
        dst[doff] = src[so] * a + dst[doff] * (1 - a);
        dst[doff + 1] = src[so + 1] * a + dst[doff + 1] * (1 - a);
        dst[doff + 2] = src[so + 2] * a + dst[doff + 2] * (1 - a);
        dst[doff + 3] = 255;
      }
    }
  }
}
