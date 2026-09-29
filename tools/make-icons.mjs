#!/usr/bin/env node
/**
 * tools/make-icons.mjs —— 生成扩展图标（零外部依赖，只用 Node 内置 zlib 手写 PNG）
 * =============================================================================
 * 产物：extension/icons/icon16.png、icon32.png、icon48.png、icon128.png
 * 图形：圆角方形渐变底 + 白色盾牌 + 红色斜杠（「拦截广告」语义），24/48 位真彩 RGBA，
 *       逐像素 3×3 / 4×4 超采样做抗锯齿。
 * 校验：写出后重新读回，检查 PNG 签名、IHDR 尺寸/位深/色型与 IEND 结束块。
 *
 * 用法：npm run build:icons   （= node tools/make-icons.mjs）
 */

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync } from 'node:zlib';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const ICON_DIR = path.join(ROOT, 'extension', 'icons');

const SIZES = [16, 32, 48, 128];

// 配色（与 popup/options 的主题色一致）
const BG_TOP = [0x4c, 0x7d, 0xf7];
const BG_BOTTOM = [0x16, 0x32, 0x8f];
const SHIELD = [0xff, 0xff, 0xff];
const SLASH = [0xe5, 0x48, 0x4d];

// 盾牌多边形（归一化坐标 0..1，顺序为顺时针：顶中 → 右上 → 右下 → 底尖 → 左下 → 左上）
const SHIELD_POLY = [
  [0.5, 0.09],
  [0.85, 0.225],
  [0.85, 0.555],
  [0.5, 0.92],
  [0.15, 0.555],
  [0.15, 0.225],
];

const SLASH_FROM = [0.255, 0.245];
const SLASH_TO = [0.745, 0.755];
const SLASH_HALF_THICKNESS = 0.058;

// ---------------------------------------------------------------------------
// 几何
// ---------------------------------------------------------------------------

function inRoundedRect(x, y, radius) {
  const dx = Math.max(Math.abs(x - 0.5) - (0.5 - radius), 0);
  const dy = Math.max(Math.abs(y - 0.5) - (0.5 - radius), 0);
  return Math.hypot(dx, dy) <= radius;
}

function inPolygon(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i, i += 1) {
    const [xi, yi] = poly[i];
    const [xj, yj] = poly[j];
    const intersects = yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

function distanceToSegment(x, y, [x1, y1], [x2, y2]) {
  const vx = x2 - x1;
  const vy = y2 - y1;
  const wx = x - x1;
  const wy = y - y1;
  const len2 = vx * vx + vy * vy;
  const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / len2));
  return Math.hypot(x - (x1 + t * vx), y - (y1 + t * vy));
}

/** 单点采样：返回 [r,g,b,a]，a 为 0/1 */
function sampleColor(x, y) {
  if (!inRoundedRect(x, y, 0.22)) return [0, 0, 0, 0];
  // 背景渐变
  const k = Math.min(1, Math.max(0, y));
  const bg = [
    Math.round(BG_TOP[0] + (BG_BOTTOM[0] - BG_TOP[0]) * k),
    Math.round(BG_TOP[1] + (BG_BOTTOM[1] - BG_TOP[1]) * k),
    Math.round(BG_TOP[2] + (BG_BOTTOM[2] - BG_TOP[2]) * k),
  ];
  const inShield = inPolygon(x, y, SHIELD_POLY);
  if (!inShield) return [bg[0], bg[1], bg[2], 1];
  const d = distanceToSegment(x, y, SLASH_FROM, SLASH_TO);
  if (d <= SLASH_HALF_THICKNESS) return [SLASH[0], SLASH[1], SLASH[2], 1];
  return [SHIELD[0], SHIELD[1], SHIELD[2], 1];
}

/** 渲染为 RGBA 像素缓冲（超采样抗锯齿） */
function renderRGBA(size) {
  const ss = size <= 32 ? 4 : 3;
  const out = Buffer.alloc(size * size * 4);
  const samples = ss * ss;
  for (let py = 0; py < size; py += 1) {
    for (let px = 0; px < size; px += 1) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < ss; sy += 1) {
        for (let sx = 0; sx < ss; sx += 1) {
          const x = (px + (sx + 0.5) / ss) / size;
          const y = (py + (sy + 0.5) / ss) / size;
          const [cr, cg, cb, ca] = sampleColor(x, y);
          r += cr * ca;
          g += cg * ca;
          b += cb * ca;
          a += ca;
        }
      }
      const alpha = a / samples;
      const i = (py * size + px) * 4;
      if (alpha > 0) {
        out[i] = Math.round(r / a);
        out[i + 1] = Math.round(g / a);
        out[i + 2] = Math.round(b / a);
        out[i + 3] = Math.round(Math.min(1, alpha) * 255);
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 最小 PNG 编码器（zlib + CRC32，无第三方依赖）
// ---------------------------------------------------------------------------

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const CRC_TABLE = (() => {
  const table = new Int32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c;
  }
  return table;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([length, typeBuf, data, crc]);
}

function encodePNG(width, height, rgba) {
  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    raw[y * (stride + 1)] = 0; // filter type 0 (None)
    rgba.copy(raw, y * (stride + 1) + 1, y * stride, (y + 1) * stride);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type: truecolor + alpha
  ihdr[10] = 0; // compression
  ihdr[11] = 0; // filter
  ihdr[12] = 0; // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// ---------------------------------------------------------------------------
// 校验
// ---------------------------------------------------------------------------

async function verifyPNG(file, expectedSize) {
  const buf = await readFile(file);
  const problems = [];
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIGNATURE)) {
    problems.push('PNG 签名非法');
  }
  if (buf.toString('ascii', 12, 16) !== 'IHDR') {
    problems.push('缺少 IHDR');
  }
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  const bitDepth = buf[24];
  const colorType = buf[25];
  if (width !== expectedSize || height !== expectedSize) {
    problems.push(`IHDR 尺寸异常 ${width}x${height}（应为 ${expectedSize}）`);
  }
  if (bitDepth !== 8 || colorType !== 6) {
    problems.push(`IHDR 位深/色型异常 depth=${bitDepth} color=${colorType}`);
  }
  if (buf.toString('ascii', buf.length - 8, buf.length - 4) !== 'IEND') {
    problems.push('缺少 IEND 结束块');
  }
  return { buf, width, height, bitDepth, colorType, problems };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  await mkdir(ICON_DIR, { recursive: true });
  const results = [];
  for (const size of SIZES) {
    const rgba = renderRGBA(size);
    const png = encodePNG(size, size, rgba);
    const file = path.join(ICON_DIR, `icon${size}.png`);
    await writeFile(file, png);
    const check = await verifyPNG(file, size);
    results.push({ file: path.relative(ROOT, file), size, bytes: png.length, problems: check.problems });
  }

  let failed = 0;
  for (const r of results) {
    const ok = r.problems.length === 0;
    if (!ok) failed += 1;
    console.log(
      `[make-icons] ${ok ? 'OK  ' : 'FAIL'} ${r.file}  ${r.size}x${r.size}  ${r.bytes} bytes` +
        (ok ? '  (PNG 头合法)' : `  → ${r.problems.join('; ')}`),
    );
  }
  if (failed) {
    throw new Error(`${failed} 个图标未通过校验`);
  }
  console.log(`[make-icons] 完成 ✅ 共 ${results.length} 个文件，输出目录 ${path.relative(ROOT, ICON_DIR)}`);
}

main().catch((err) => {
  console.error('[make-icons] 失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
