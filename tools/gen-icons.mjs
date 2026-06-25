// Generates PullDown QR's toolbar icons as PNGs (no external deps — uses
// node:zlib for DEFLATE). Run: `node tools/gen-icons.mjs`
import { deflateSync } from 'node:zlib';
import { writeFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'icons');
mkdirSync(OUT, { recursive: true });

const BLUE = [37, 99, 235, 255];
const CLEAR = [0, 0, 0, 0];

// ---- PNG encoder ----------------------------------------------------------
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = crcTable[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}
function encodePNG(S, rgba) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
  ihdr[8] = 8; ihdr[9] = 6; // 8-bit, RGBA
  const stride = S * 4;
  const raw = Buffer.alloc((stride + 1) * S);
  for (let y = 0; y < S; y++) {
    raw[y * (stride + 1)] = 0; // filter: none
    Buffer.from(rgba.buffer, rgba.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))]);
}

// ---- drawing --------------------------------------------------------------
function canvas(S) { return { S, data: new Uint8Array(S * S * 4) }; }
function rect(cv, x, y, w, h, color) {
  const x0 = Math.round(x), y0 = Math.round(y), x1 = Math.round(x + w), y1 = Math.round(y + h);
  for (let yy = y0; yy < y1; yy++) {
    if (yy < 0 || yy >= cv.S) continue;
    for (let xx = x0; xx < x1; xx++) {
      if (xx < 0 || xx >= cv.S) continue;
      const i = (yy * cv.S + xx) * 4;
      cv.data[i] = color[0]; cv.data[i + 1] = color[1]; cv.data[i + 2] = color[2]; cv.data[i + 3] = color[3];
    }
  }
}
function finder(cv, x, y, f) {
  const t = Math.max(1, Math.round(f * 0.18));
  rect(cv, x, y, f, f, BLUE);                       // outer square
  rect(cv, x + t, y + t, f - 2 * t, f - 2 * t, CLEAR); // hollow ring
  rect(cv, x + 2 * t, y + 2 * t, f - 4 * t, f - 4 * t, BLUE); // center eye
}

function drawIcon(S) {
  const cv = canvas(S);
  const pad = Math.max(1, Math.round(S * 0.09));
  const inner = S - 2 * pad;
  const f = Math.round(inner * 0.42);
  finder(cv, pad, pad, f);                 // top-left
  finder(cv, S - pad - f, pad, f);         // top-right
  finder(cv, pad, S - pad - f, f);         // bottom-left
  // data-module checker in the empty bottom-right quadrant for a QR feel
  const m = Math.max(1, Math.round(f / 5));
  const qx = S - pad - f, qy = S - pad - f;
  for (let i = 0; i < 3; i++)
    for (let j = 0; j < 3; j++)
      if ((i + j) % 2 === 0) rect(cv, qx + i * 2 * m, qy + j * 2 * m, m, m, BLUE);
  return encodePNG(S, cv.data);
}

for (const S of [16, 32, 48, 128]) {
  writeFileSync(join(OUT, `icon${S}.png`), drawIcon(S));
  console.log(`icons/icon${S}.png`);
}
