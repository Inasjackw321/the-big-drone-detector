'use strict';

/**
 * Generates build/icon.png (512x512) — a radar-themed app icon — with no
 * external dependencies (raw PNG via zlib). electron-builder converts this to
 * the platform icon formats (.ico / .icns) at build time.
 *
 *   node scripts/make-icon.js
 */

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const SIZE = 512;
const cx = SIZE / 2;
const cy = SIZE / 2;

function lerp(a, b, t) {
  return a + (b - a) * t;
}

// RGBA framebuffer.
const px = Buffer.alloc(SIZE * SIZE * 4);
function set(x, y, r, g, b, a = 255) {
  if (x < 0 || y < 0 || x >= SIZE || y >= SIZE) return;
  const i = (y * SIZE + x) * 4;
  // simple alpha blend over existing
  const ea = px[i + 3] / 255;
  const na = a / 255;
  const out = na + ea * (1 - na);
  if (out <= 0) return;
  px[i] = Math.round((r * na + px[i] * ea * (1 - na)) / out);
  px[i + 1] = Math.round((g * na + px[i + 1] * ea * (1 - na)) / out);
  px[i + 2] = Math.round((b * na + px[i + 2] * ea * (1 - na)) / out);
  px[i + 3] = Math.round(out * 255);
}

// Background: radial dark-navy gradient.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - cx, y - cy) / (SIZE / 2);
    const t = Math.min(1, d);
    set(
      x,
      y,
      Math.round(lerp(21, 11, t)),
      Math.round(lerp(39, 22, t)),
      Math.round(lerp(58, 34, t)),
      255
    );
  }
}

function strokeCircle(radius, r, g, b, a, thickness = 3) {
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - radius) <= thickness / 2) set(x, y, r, g, b, a);
    }
  }
}

function fillDisc(ox, oy, radius, r, g, b, a) {
  for (let y = Math.floor(oy - radius); y <= oy + radius; y++) {
    for (let x = Math.floor(ox - radius); x <= ox + radius; x++) {
      const d = Math.hypot(x - ox, y - oy);
      if (d <= radius) {
        // anti-alias the edge
        const edge = radius - d;
        const aa = edge >= 1 ? a : a * Math.max(0, edge);
        set(x, y, r, g, b, aa);
      }
    }
  }
}

const GREEN = [54, 224, 130];
const maxR = 210;

// Concentric radar rings.
strokeCircle(maxR, GREEN[0], GREEN[1], GREEN[2], 230, 4);
strokeCircle(maxR * 0.66, GREEN[0], GREEN[1], GREEN[2], 150, 3);
strokeCircle(maxR * 0.33, GREEN[0], GREEN[1], GREEN[2], 110, 3);

// Crosshair.
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const d = Math.hypot(x - cx, y - cy);
    if (d <= maxR && (Math.abs(x - cx) <= 1.2 || Math.abs(y - cy) <= 1.2)) {
      set(x, y, GREEN[0], GREEN[1], GREEN[2], 90);
    }
  }
}

// Radar sweep wedge (pointing up-right).
const sweepAngle = -Math.PI / 4;
const sweepWidth = 0.7; // radians
for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const dx = x - cx;
    const dy = y - cy;
    const d = Math.hypot(dx, dy);
    if (d > maxR) continue;
    let ang = Math.atan2(dy, dx);
    let diff = ang - sweepAngle;
    while (diff > Math.PI) diff -= 2 * Math.PI;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    // trailing fade: only behind the leading edge
    if (diff <= 0 && diff >= -sweepWidth) {
      const fade = (1 + diff / sweepWidth) * (1 - d / maxR) * 0.85;
      set(x, y, GREEN[0], GREEN[1], GREEN[2], Math.round(120 * fade));
    }
  }
}

// Center hub.
fillDisc(cx, cy, 10, GREEN[0], GREEN[1], GREEN[2], 255);

// Blips — green contacts + one red "drone".
fillDisc(cx + 70, cy - 95, 9, GREEN[0], GREEN[1], GREEN[2], 255);
fillDisc(cx - 110, cy + 40, 7, GREEN[0], GREEN[1], GREEN[2], 220);
fillDisc(cx + 30, cy + 120, 6, GREEN[0], GREEN[1], GREEN[2], 200);
// Red threat blip with glow.
fillDisc(cx + 120, cy - 30, 22, 255, 92, 92, 60);
fillDisc(cx + 120, cy - 30, 12, 255, 92, 92, 255);

// ---- PNG encode ----
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(SIZE, 0);
ihdr.writeUInt32BE(SIZE, 4);
ihdr[8] = 8; // bit depth
ihdr[9] = 6; // color type RGBA
ihdr[10] = 0;
ihdr[11] = 0;
ihdr[12] = 0;

// Add filter byte (0) per scanline.
const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1));
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0;
  px.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4);
}
const idat = zlib.deflateSync(raw, { level: 9 });

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', idat),
  chunk('IEND', Buffer.alloc(0)),
]);

const outDir = path.join(__dirname, '..', 'build');
fs.mkdirSync(outDir, { recursive: true });
const outPath = path.join(outDir, 'icon.png');
fs.writeFileSync(outPath, png);
console.log('wrote', outPath, `(${png.length} bytes)`);

// Also ship a copy inside the app bundle so the runtime window/taskbar icon
// is set even on platforms where the executable icon isn't embedded.
const srcCopy = path.join(__dirname, '..', 'src', 'icon.png');
fs.writeFileSync(srcCopy, png);
console.log('wrote', srcCopy);
