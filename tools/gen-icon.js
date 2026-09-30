// 生成 src-tauri 图标源图（512×512 PNG，纯 node 手写编码，无依赖）
// 用法：node tools/gen-icon.js && npx tauri icon src-tauri/icon-src.png
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

const S = 512;
const px = new Uint8Array(S * S * 4);

function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= S || y >= S) return;
  const i = (y * S + x) * 4;
  px[i] = r; px[i + 1] = g; px[i + 2] = b; px[i + 3] = a;
}
// 圆角矩形填充（抗锯齿：覆盖率混色）
function roundRect(x0, y0, x1, y1, r, cr, cg, cb, a = 255) {
  for (let y = Math.floor(y0); y < Math.ceil(y1); y++) {
    for (let x = Math.floor(x0); x < Math.ceil(x1); x++) {
      const cx = Math.max(x0 + r - x, x - (x1 - 1 - r), 0);
      const cy = Math.max(y0 + r - y, y - (y1 - 1 - r), 0);
      const d = Math.hypot(cx, cy);
      const cov = d >= r + 1 ? 0 : d <= r - 1 ? 1 : (r + 1 - d) / 2;
      if (cov > 0) {
        const i = (y * S + x) * 4;
        const na = cov * a / 255;
        px[i] = Math.round(px[i] * (1 - na) + cr * na);
        px[i + 1] = Math.round(px[i + 1] * (1 - na) + cg * na);
        px[i + 2] = Math.round(px[i + 2] * (1 - na) + cb * na);
        px[i + 3] = Math.max(px[i + 3], Math.round(255 * Math.min(1, na + (px[i + 3] / 255) * (1 - na))));
      }
    }
  }
}
function rect(x0, y0, x1, y1, cr, cg, cb) {
  for (let y = Math.round(y0); y < Math.round(y1); y++)
    for (let x = Math.round(x0); x < Math.round(x1); x++) set(x, y, cr, cg, cb);
}

// 设计与应用内 logo 同款：蓝底圆角方块 + 白文档 + 折角 + 文字行
roundRect(8, 8, 504, 504, 96, 79, 142, 247);            // #4f8ef7
rect(140, 96, 372, 416, 255, 255, 255);                  // 文档
for (let y = 96; y < 180; y++) for (let x = 300; x < 372; x++) { // 折角三角
  const t = (x - 300) / 72;
  if (y - 96 <= 84 * (1 - t)) set(x, y, 214, 224, 240);
}
[176, 232, 288, 344].forEach(y => rect(180, y, 332, y + 18, 79, 142, 247)); // 文字行
rect(180, 344, 260, 362, 79, 142, 247);

// --- PNG 编码（IHDR/IDAT/IEND + CRC32）---
const CRC_T = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
const crc32 = buf => { let c = 0xFFFFFFFF; for (const b of buf) c = CRC_T[(c ^ b) & 0xFF] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
const raw = Buffer.alloc(S * (S * 4 + 1));
for (let y = 0; y < S; y++) {
  raw[y * (S * 4 + 1)] = 0; // filter: none
  Buffer.from(px.buffer, y * S * 4, S * 4).copy(raw, y * (S * 4 + 1) + 1);
}
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(S, 0); ihdr.writeUInt32BE(S, 4);
ihdr[8] = 8; ihdr[9] = 6; // 8bit RGBA
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]),
  chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
]);
const out = path.join(__dirname, '..', 'src-tauri', 'icon-src.png');
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, png);
console.log('written', out, png.length, 'bytes');
