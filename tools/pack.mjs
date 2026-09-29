#!/usr/bin/env node
/**
 * AdCleaner 免安装包打包脚本（零依赖）
 *
 * 产物：dist/AdCleaner-v<版本>.zip
 * 内容：
 *   AdCleaner-v<版本>/
 *     extension/              —— 完整可加载的 Chrome/Edge 扩展（含规则集与图标）
 *     userscript/             —— Tampermonkey 油猴脚本
 *     使用说明.txt            —— 中文快速上手
 *     README.md / LICENSE     —— 详细说明与 GPL-3.0 许可证
 *
 * 说明：
 * - ZIP 由本脚本内置的写入器生成（deflate-raw + CRC32），不需要系统安装 zip 工具；
 * - 自动排除 Chrome 加载扩展后生成的 extension/_metadata 缓存等垃圾文件；
 * - 打包后会在 dist/ 保留解压后的暂存目录，便于人工检查。
 */
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT_DIR = path.join(ROOT, 'extension');
const USERSCRIPT = path.join(ROOT, 'userscript', 'adcleaner.user.js');
const README = path.join(ROOT, 'README.md');
const LICENSE = path.join(ROOT, 'LICENSE');

// ---------- 基本检查 ----------
for (const p of [EXT_DIR, USERSCRIPT, README, LICENSE]) {
  if (!fs.existsSync(p)) {
    console.error(`[pack] 缺少必需文件/目录：${p}`);
    process.exit(1);
  }
}
const manifest = JSON.parse(fs.readFileSync(path.join(EXT_DIR, 'manifest.json'), 'utf8'));
const VERSION = manifest.version;
const NAME = `AdCleaner-v${VERSION}`;
const DIST = path.join(ROOT, 'dist');
const STAGE = path.join(DIST, NAME);
const ZIP = path.join(DIST, `${NAME}.zip`);

// ---------- 准备暂存目录 ----------
fs.rmSync(DIST, { recursive: true, force: true });
fs.mkdirSync(path.join(STAGE, 'userscript'), { recursive: true });

const SKIP_SEGMENTS = new Set(['_metadata', '.DS_Store', 'Thumbs.db']);
fs.cpSync(EXT_DIR, path.join(STAGE, 'extension'), {
  recursive: true,
  filter: (src) => {
    const rel = path.relative(EXT_DIR, src);
    if (!rel) return true;
    return !rel.split(path.sep).some((seg) => SKIP_SEGMENTS.has(seg));
  },
});
fs.copyFileSync(USERSCRIPT, path.join(STAGE, 'userscript', path.basename(USERSCRIPT)));
fs.copyFileSync(README, path.join(STAGE, 'README.md'));
fs.copyFileSync(LICENSE, path.join(STAGE, 'LICENSE'));

const USAGE = `AdCleaner 清道夫 v${VERSION} —— 免安装使用说明
================================================

一、扩展版（推荐：功能最全，能用浏览器自带的网络拦截）
1. 把本压缩包解压到任意位置（例如 D:\\AdCleaner）。
2. 打开 Chrome 或 Edge，地址栏输入 chrome://extensions（Chrome）或 edge://extensions（Edge），回车。
3. 打开页面右上角的「开发者模式」。
4. 点「加载已解压的扩展程序」，选择解压目录里的 extension 文件夹。
5. 地址栏右侧出现 AdCleaner 的图标就装好了。
   要求：Chrome / Edge 128 或更高版本。

二、油猴版（备选：适合无法装扩展的浏览器；没有网络层拦截）
1. 浏览器先安装 Tampermonkey（油猴）扩展。
2. 用记事本打开 userscript\\adcleaner.user.js，全选、复制。
3. 在油猴里点「添加新脚本」，粘贴内容并保存。

三、日常使用
- 更新过扩展文件后：到扩展管理页点一次「重新加载」，然后刷新网页。
- 某网站被误伤（正常内容被隐藏、视频异常等）：点扩展图标里的「暂停在此网站」，
  或在选项页把它加入白名单；也可以到 GitHub 提问题。

四、已知限制（详见 README.md）
- YouTube 服务端合流的广告无法 100% 拦截，扩展用「静音 + 加速 + 跳片段」尽力而为。
- 国内视频网站可能有反广告拦截提示（黑屏等）；发现异常请暂停该网站。
- 网络层拦截依赖 Chrome/Edge 128+；油猴版没有网络层拦截。

项目主页与更新：https://github.com/iranolly/adcleaner
`;
fs.writeFileSync(path.join(STAGE, '使用说明.txt'), USAGE, 'utf8');

// ---------- 收集文件 ----------
function walk(dir, base = '') {
  const out = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name));
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = base ? `${base}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(full, rel));
    else if (e.isFile()) out.push({ full, rel });
  }
  return out;
}
const files = walk(STAGE, NAME);
if (!files.some((f) => f.rel.endsWith('extension/rulesets/cn.json'))) {
  console.error('[pack] 异常：暂存目录里没有规则集，打包中止');
  process.exit(1);
}

// ---------- 内置 ZIP 写入器 ----------
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
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
function dosDateTime(d) {
  const time = ((d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1)) & 0xffff;
  const date = (((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;
  return { time, date };
}

const now = new Date();
const { time, date } = dosDateTime(now);
const localChunks = [];
const centralChunks = [];
let offset = 0;
let stored = 0;
let totalRaw = 0;

for (const f of files) {
  const name = Buffer.from(f.rel, 'utf8');
  const data = fs.readFileSync(f.full);
  const compressed = zlib.deflateRawSync(data, { level: 9 });
  const useCompressed = compressed.length < data.length;
  const payload = useCompressed ? compressed : data;
  const method = useCompressed ? 8 : 0;
  const crc = crc32(data);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);   // 本地文件头签名
  local.writeUInt16LE(20, 4);           // 解压所需版本
  local.writeUInt16LE(0x0800, 6);       // 文件名按 UTF-8 编码
  local.writeUInt16LE(method, 8);
  local.writeUInt16LE(time, 10);
  local.writeUInt16LE(date, 12);
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(payload.length, 18);
  local.writeUInt32LE(data.length, 22);
  local.writeUInt16LE(name.length, 26);
  local.writeUInt16LE(0, 28);
  localChunks.push(local, name, payload);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); // 中央目录签名
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(method, 10);
  central.writeUInt16LE(time, 12);
  central.writeUInt16LE(date, 14);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(payload.length, 20);
  central.writeUInt32LE(data.length, 24);
  central.writeUInt16LE(name.length, 28);
  central.writeUInt16LE(0, 30);         // extra
  central.writeUInt16LE(0, 32);         // comment
  central.writeUInt16LE(0, 34);         // disk
  central.writeUInt16LE(0, 36);         // 内部属性
  central.writeUInt32LE(0x81a40000, 38); // 外部属性：普通文件 644
  central.writeUInt32LE(offset, 42);
  centralChunks.push(central, name);

  offset += local.length + name.length + payload.length;
  stored += payload.length;
  totalRaw += data.length;
}

const centralBuf = Buffer.concat(centralChunks);
const end = Buffer.alloc(22);
end.writeUInt32LE(0x06054b50, 0);       // 目录结束记录
end.writeUInt16LE(0, 4);
end.writeUInt16LE(0, 6);
end.writeUInt16LE(files.length, 8);
end.writeUInt16LE(files.length, 10);
end.writeUInt32LE(centralBuf.length, 12);
end.writeUInt32LE(offset, 16);
end.writeUInt16LE(0, 20);
fs.writeFileSync(ZIP, Buffer.concat([...localChunks, centralBuf, end]));

// ---------- 自检：重新解析目录结束记录 + 汇报 ----------
const zipBuf = fs.readFileSync(ZIP);
const eocdPos = zipBuf.length - 22;
if (eocdPos < 0 || zipBuf.readUInt32LE(eocdPos) !== 0x06054b50) {
  console.error('[pack] 自检失败：找不到 ZIP 结束记录');
  process.exit(1);
}
const count = zipBuf.readUInt16LE(eocdPos + 10);
if (count !== files.length) {
  console.error(`[pack] 自检失败：目录条数 ${count} != 文件数 ${files.length}`);
  process.exit(1);
}

console.log(`[pack] 已生成 ${path.relative(ROOT, ZIP)}`);
console.log(`[pack] 版本 v${VERSION}，文件 ${files.length} 个，压缩前 ${(totalRaw / 1024 / 1024).toFixed(2)}MB，压缩后 ${(stored / 1024 / 1024).toFixed(2)}MB，ZIP ${(zipBuf.length / 1024 / 1024).toFixed(2)}MB`);
console.log('[pack] 内容清单：');
for (const f of files) {
  const size = fs.statSync(f.full).size;
  console.log(`  ${String(size).padStart(9)}  ${f.rel}`);
}
