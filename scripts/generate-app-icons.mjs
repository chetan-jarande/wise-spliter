#!/usr/bin/env node
/**
 * Deterministic Wise-Spliter App Icon Generator (`scripts/generate-app-icons.mjs`)
 * Generates valid RGBA PNGs (192x192, 512x512, maskable 512x512) and favicon.svg
 * using Node's built-in `node:zlib` (zero external native image dependencies).
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = resolve(__dirname, '..', 'public');
const ICONS_DIR = resolve(PUBLIC_DIR, 'icons');

const CRC_TABLE = new Uint32Array(256);
for (let n = 0; n < 256; n++) {
  let c = n;
  for (let k = 0; k < 8; k++) {
    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[n] = c >>> 0;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function pngChunk(type, data) {
  const typeBuf = Buffer.from(type, 'ascii');
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length, 0);
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function encodeRgbaPng(width, height, pixelFn) {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);

  for (let y = 0; y < height; y++) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0; // filter type 0
    for (let x = 0; x < width; x++) {
      const [r, g, b, a] = pixelFn(x, y, width, height);
      const idx = rowOffset + 1 + x * 4;
      raw[idx] = r;
      raw[idx + 1] = g;
      raw[idx + 2] = b;
      raw[idx + 3] = a;
    }
  }

  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', idat),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

function sdRoundedBox(px, py, bx, by, radius) {
  const qx = Math.abs(px) - bx + radius;
  const qy = Math.abs(py) - by + radius;
  const outDist = Math.hypot(Math.max(qx, 0), Math.max(qy, 0));
  const inDist = Math.min(Math.max(qx, qy), 0);
  return outDist + inDist - radius;
}

function distToSegment(px, py, ax, ay, bx, by) {
  const vx = bx - ax;
  const vy = by - ay;
  const wx = px - ax;
  const wy = py - ay;
  const lenSq = vx * vx + vy * vy;
  const t = lenSq > 0 ? Math.max(0, Math.min(1, (wx * vx + wy * vy) / lenSq)) : 0;
  return Math.hypot(px - (ax + t * vx), py - (ay + t * vy));
}

function renderWiseSpliterIcon(x, y, w, h, maskable = false) {
  const nx = (x + 0.5) / w * 2 - 1;
  const ny = (y + 0.5) / h * 2 - 1;

  // Outer card / maskable full-bleed background (#090D16 -> #0F172A)
  const outerDist = maskable ? -1 : sdRoundedBox(nx, ny, 0.92, 0.92, 0.24);
  if (outerDist > 0.01) {
    return [0, 0, 0, 0];
  }
  const outerAlpha = outerDist > -0.01 ? Math.round((0.01 - outerDist) / 0.02 * 255) : 255;

  const scale = maskable ? 0.76 : 1.0;
  const sx = nx / scale;
  const sy = ny / scale;

  // Base gradient (#090D16 to #111827)
  const grad = Math.max(0, Math.min(1, (ny + 1) * 0.5));
  let r = Math.round(9 + grad * 10);
  let g = Math.round(13 + grad * 14);
  let b = Math.round(22 + grad * 22);

  // Emerald inner bezel ring (#059669 / #10B981)
  const ringDist = Math.abs(sdRoundedBox(sx, sy, 0.74, 0.74, 0.2)) - 0.028;
  if (ringDist < 0.008) {
    const t = Math.max(0, Math.min(1, (0.008 - ringDist) / 0.016));
    r = Math.round(r * (1 - t) + 16 * t);
    g = Math.round(g * (1 - t) + 185 * t);
    b = Math.round(b * (1 - t) + 129 * t);
  }

  // Stylized geometric "W" split-node emblem in crisp emerald -> white
  const segments = [
    [-0.42, -0.26, -0.22, 0.28],
    [-0.22, 0.28, 0.0, -0.08],
    [0.0, -0.08, 0.22, 0.28],
    [0.22, 0.28, 0.42, -0.26],
  ];
  let minGlyphDist = 999;
  for (const [ax, ay, bx, by] of segments) {
    minGlyphDist = Math.min(minGlyphDist, distToSegment(sx, sy, ax, ay, bx, by));
  }
  const strokeRadius = 0.078;
  if (minGlyphDist < strokeRadius + 0.01) {
    const t = Math.max(0, Math.min(1, (strokeRadius + 0.01 - minGlyphDist) / 0.02));
    const isRightHalf = sx > 0.02;
    const tr = isRightHalf ? 16 : 248;
    const tg = isRightHalf ? 185 : 250;
    const tb = isRightHalf ? 129 : 252;
    r = Math.round(r * (1 - t) + tr * t);
    g = Math.round(g * (1 - t) + tg * t);
    b = Math.round(b * (1 - t) + tb * t);
  }

  // Top emerald balance dot
  const dotDist = Math.hypot(sx, sy + 0.34) - 0.075;
  if (dotDist < 0.01) {
    const t = Math.max(0, Math.min(1, (0.01 - dotDist) / 0.02));
    r = Math.round(r * (1 - t) + 52 * t);
    g = Math.round(g * (1 - t) + 211 * t);
    b = Math.round(b * (1 - t) + 153 * t);
  }

  return [r, g, b, outerAlpha];
}

mkdirSync(ICONS_DIR, { recursive: true });

writeFileSync(
  resolve(ICONS_DIR, 'icon-192.png'),
  encodeRgbaPng(192, 192, (x, y, w, h) => renderWiseSpliterIcon(x, y, w, h, false))
);
writeFileSync(
  resolve(ICONS_DIR, 'icon-512.png'),
  encodeRgbaPng(512, 512, (x, y, w, h) => renderWiseSpliterIcon(x, y, w, h, false))
);
writeFileSync(
  resolve(ICONS_DIR, 'icon-maskable-512.png'),
  encodeRgbaPng(512, 512, (x, y, w, h) => renderWiseSpliterIcon(x, y, w, h, true))
);

const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 128 128">
  <rect x="4" y="4" width="120" height="120" rx="28" fill="#090D16"/>
  <rect x="14" y="14" width="100" height="100" rx="22" fill="#111827" stroke="#10B981" stroke-width="3.5"/>
  <circle cx="64" cy="36" r="6" fill="#34D399"/>
  <path d="M34 48 L48 86 L64 60 L80 86 L94 48" fill="none" stroke="#F8FAFC" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
  <path d="M64 60 L80 86 L94 48" fill="none" stroke="#10B981" stroke-width="10" stroke-linecap="round" stroke-linejoin="round"/>
</svg>
`;
writeFileSync(resolve(PUBLIC_DIR, 'favicon.svg'), faviconSvg, 'utf8');

const ANDROID_RES_DIR = resolve(__dirname, '..', 'android', 'app', 'src', 'main', 'res');

if (existsSync(ANDROID_RES_DIR)) {
  const mipmaps = [
    { dir: 'mipmap-mdpi', launcher: 48, fg: 108 },
    { dir: 'mipmap-hdpi', launcher: 72, fg: 162 },
    { dir: 'mipmap-xhdpi', launcher: 96, fg: 216 },
    { dir: 'mipmap-xxhdpi', launcher: 144, fg: 324 },
    { dir: 'mipmap-xxxhdpi', launcher: 192, fg: 432 },
  ];
  for (const m of mipmaps) {
    const targetDir = resolve(ANDROID_RES_DIR, m.dir);
    mkdirSync(targetDir, { recursive: true });
    const launcherPng = encodeRgbaPng(m.launcher, m.launcher, (x, y, w, h) =>
      renderWiseSpliterIcon(x, y, w, h, false)
    );
    const roundPng = encodeRgbaPng(m.launcher, m.launcher, (x, y, w, h) => {
      const nx = ((x + 0.5) / w) * 2 - 1;
      const ny = ((y + 0.5) / h) * 2 - 1;
      if (Math.hypot(nx, ny) > 0.96) return [0, 0, 0, 0];
      return renderWiseSpliterIcon(x, y, w, h, true);
    });
    const fgPng = encodeRgbaPng(m.fg, m.fg, (x, y, w, h) =>
      renderWiseSpliterIcon(x, y, w, h, true)
    );
    writeFileSync(resolve(targetDir, 'ic_launcher.png'), launcherPng);
    writeFileSync(resolve(targetDir, 'ic_launcher_round.png'), roundPng);
    writeFileSync(resolve(targetDir, 'ic_launcher_foreground.png'), fgPng);
  }
  console.log('[generate-app-icons] Updated Android adaptive launcher mipmaps.');
}

console.log('[generate-app-icons] Generated favicon.svg, icon-192.png, icon-512.png, and icon-maskable-512.png');
