#!/usr/bin/env node
/**
 * AdCleaner tools/build-userscript.mjs —— 生成 Tampermonkey 油猴脚本
 * =============================================================================
 * 依据：SPEC.md 第 8.4 节。
 * 流程：
 *   1) 读取 extension/src/data/cosmetics.json 与 video-sites.json（JSON.parse 校验结构）
 *   2) 误伤禁区自检：cosmetics.json 的 selectors 与 extension/src/content/cosmetic.css 中
 *      不得出现 [class*="ad"] / [id*="ad"] / [class*="float"] / [class*="popup"] / [class*="banner"]
 *      这类宽泛选择器（SPEC 9.3）；也不得出现 :contains() / :-abp-contains() 非标准选择器
 *   3) 把两个数据文件内联进 userscript/template.js 的 /*@AD_DATA@*\/ 占位符（const AD_DATA = {...}）
 *      并把 extension/src/content/cosmetic.css 内联进 /*@AD_CSS@*\/ 占位符（const AD_CSS = "..."）：
 *      两个占位符在模板中都必须恰好出现 1 次，替换后不得残留；静态 CSS 里的
 *      #cs_left_couplet 等标志性选择器必须出现在产物中。
 *   4) 写出 userscript/adcleaner.user.js，并用 `node --check` 自校验语法与头部元字段
 *
 * 无第三方依赖；Node >= 18（本机 v24）。
 */
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');

const COSMETICS_JSON = path.join(ROOT, 'extension/src/data/cosmetics.json');
const VIDEO_JSON = path.join(ROOT, 'extension/src/data/video-sites.json');
const COSMETIC_CSS = path.join(ROOT, 'extension/src/content/cosmetic.css');
const TEMPLATE = path.join(ROOT, 'userscript/template.js');
const OUT = path.join(ROOT, 'userscript/adcleaner.user.js');

/** 数据占位符（template.js 中形如 `const AD_DATA = /*@AD_DATA@*\/null;`） */
const MARKER = '/*@AD_DATA@*/null';

/** 静态 CSS 占位符（template.js 中形如 `const AD_CSS = /*@AD_CSS@*\/'';`，
 *  占位符连同其后的空字符串字面量一起被替换为 CSS 字符串，模板本身保持合法 JS） */
const CSS_MARKER = `/*@AD_CSS@*/''`;

/** 产物中必须出现的静态 CSS 标志性选择器（验证 CSS 确实被内联） */
const CSS_REQUIRED_MARKERS = [
  '#cs_left_couplet',
  '#cs_right_couplet',
  'iframe[id^="google_ads_iframe"]',
  'ins.adsbygoogle',
  '[data-ad-status="unfilled"]',
];

/** SPEC 9.3 误伤禁区：宽泛 class/id 子串匹配选择器 */
const FORBIDDEN = [
  { label: '[class*="ad"]', re: /\[class\*="ad"\]/i },
  { label: '[id*="ad"]', re: /\[id\*="ad"\]/i },
  { label: '[class*="float"]', re: /\[class\*="float"\]/i },
  { label: '[class*="popup"]', re: /\[class\*="popup"\]/i },
  { label: '[class*="banner"]', re: /\[class\*="banner"\]/i },
];

/** 非标准选择器：必须丢弃，不得自造替代实现（SPEC 8.1） */
const NON_NATIVE = [
  { label: ':contains()', re: /:contains\(/i },
  { label: ':-abp-contains()', re: /:-abp-contains\(/i },
];

function fail(msg) {
  console.error(`[build-userscript] 失败：${msg}`);
  process.exit(1);
}

async function readJSON(file) {
  const text = await readFile(file, 'utf8');
  try {
    return JSON.parse(text);
  } catch (err) {
    fail(`${path.relative(ROOT, file)} JSON 解析失败：${err.message}`);
  }
}

/** 校验 cosmetics.json 结构 + 选择器集合 */
function validateCosmetics(data) {
  if (!data || typeof data !== 'object') fail('cosmetics.json 顶层不是对象');
  if (!Array.isArray(data.groups)) fail('cosmetics.json 缺少 groups 数组');
  let count = 0;
  const problems = [];
  for (let i = 0; i < data.groups.length; i++) {
    const g = data.groups[i];
    if (!Array.isArray(g.hosts)) problems.push(`groups[${i}] 缺少 hosts 数组`);
    if (!Array.isArray(g.selectors)) problems.push(`groups[${i}] 缺少 selectors 数组`);
    if (typeof g.source !== 'string' || !g.source) problems.push(`groups[${i}] 缺少 source 来源标注`);
    for (const sel of (g.selectors || [])) {
      count++;
      if (typeof sel !== 'string' || !sel) { problems.push(`groups[${i}] 存在非字符串选择器`); continue; }
      for (const f of FORBIDDEN) if (f.re.test(sel)) problems.push(`groups[${i}] 命中误伤禁区 ${f.label}：${sel}`);
      for (const n of NON_NATIVE) if (n.re.test(sel)) problems.push(`groups[${i}] 含非标准选择器 ${n.label}：${sel}`);
    }
  }
  if (problems.length) fail(`cosmetics.json 校验失败：\n  - ${problems.join('\n  - ')}`);
  return { groups: data.groups.length, selectors: count, version: data.version || '' };
}

/** 校验 video-sites.json 结构 */
function validateVideoSites(data) {
  if (!data || typeof data !== 'object') fail('video-sites.json 顶层不是对象');
  if (!data.sites || typeof data.sites !== 'object') fail('video-sites.json 缺少 sites 对象');
  if (!data.generic || typeof data.generic !== 'object') fail('video-sites.json 缺少 generic 对象');
  const required = ['video', 'adState', 'skip', 'pauseAd', 'maxAdSeconds', 'actions'];
  for (const [host, cfg] of Object.entries(data.sites)) {
    for (const key of required) {
      if (!(key in cfg)) fail(`video-sites.json sites["${host}"] 缺少字段 ${key}`);
    }
    if (!Array.isArray(cfg.adState) || !Array.isArray(cfg.skip) || !Array.isArray(cfg.actions)) {
      fail(`video-sites.json sites["${host}"] 的 adState/skip/actions 必须是数组`);
    }
    if (!cfg.pauseAd || !Array.isArray(cfg.pauseAd.containers) || !Array.isArray(cfg.pauseAd.close)) {
      fail(`video-sites.json sites["${host}"].pauseAd 需要 containers/close 数组`);
    }
  }
  for (const key of required) {
    if (!(key in data.generic)) fail(`video-sites.json generic 缺少字段 ${key}`);
  }
  return { sites: Object.keys(data.sites), genericActions: (data.generic.actions || []).join(',') };
}

/** 校验 cosmetic.css 不含误伤禁区选择器 */
async function validateCosmeticCss() {
  let css;
  try {
    css = await readFile(COSMETIC_CSS, 'utf8');
  } catch (err) {
    fail(`读取 cosmetic.css 失败：${err.message}`);
  }
  const problems = [];
  for (const f of FORBIDDEN) {
    const m = css.match(new RegExp(f.re.source, 'gi'));
    if (m) problems.push(`cosmetic.css 命中误伤禁区 ${f.label}（${m.length} 处）`);
  }
  for (const n of NON_NATIVE) {
    const m = css.match(new RegExp(n.re.source, 'gi'));
    if (m) problems.push(`cosmetic.css 含非标准选择器 ${n.label}（${m.length} 处）`);
  }
  if (problems.length) fail(problems.join('\n  - '));
  return { css, lines: css.split('\n').length };
}

/** 把字符串转成它在产物中的 JS 字符串字面量形式（用于在生成文件中搜标志性选择器） */
function asJsLiteralBody(text) {
  return JSON.stringify(text).slice(1, -1);
}

/** node --check 自校验 */
function nodeCheck(file) {
  try {
    execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
    return { ok: true, output: '' };
  } catch (err) {
    const out = `${err.stdout ? err.stdout.toString() : ''}${err.stderr ? err.stderr.toString() : ''}`.trim();
    return { ok: false, output: out };
  }
}

function validateUserscriptHead(text) {
  const need = [
    ['// ==UserScript==', '油猴头部起始'],
    ['// @name         AdCleaner 清道夫（油猴版）', '@name'],
    ['// @match        *://*/*', '@match 全站'],
    ['// @run-at       document-start', '@run-at document-start'],
    ['// @grant        none', '@grant none'],
  ];
  const missing = need.filter(([needle]) => !text.includes(needle)).map(([, label]) => label);
  if (missing.length) fail(`生成物缺少头部字段：${missing.join('、')}`);
  if (/\/\/\s*@noframes/.test(text)) fail('生成物不应包含 @noframes（SPEC 8.4 明确不开）');
  const constDecl = text.includes('const AD_DATA = {');
  if (!constDecl) fail('生成物缺少内联数据 const AD_DATA = {...}');
}

async function main() {
  const cosmetics = await readJSON(COSMETICS_JSON);
  const videoSites = await readJSON(VIDEO_JSON);
  const cStats = validateCosmetics(cosmetics);
  const vStats = validateVideoSites(videoSites);
  const cssInfo = await validateCosmeticCss();
  console.log(`[build-userscript] 数据校验通过：cosmetics ${cStats.groups} 组 / ${cStats.selectors} 条选择器（version ${cStats.version}）；`
    + ` video-sites ${vStats.sites.length} 站 + generic（${vStats.genericActions}）；cosmetic.css ${cssInfo.lines} 行、无禁区选择器`);

  const template = await readFile(TEMPLATE, 'utf8');
  const hits = template.split(MARKER).length - 1;
  if (hits !== 1) fail(`userscript/template.js 中占位符 ${MARKER} 出现 ${hits} 次（应为 1 次）`);
  const cssHits = template.split(CSS_MARKER).length - 1;
  if (cssHits !== 1) fail(`userscript/template.js 中占位符 ${CSS_MARKER} 出现 ${cssHits} 次（应为 1 次）`);
  if (!cssInfo.css.trim()) fail('extension/src/content/cosmetic.css 为空，无法内联');

  const payload = JSON.stringify({ cosmetics, videoSites }, null, 2);
  const output = template.replace(MARKER, payload).replace(CSS_MARKER, JSON.stringify(cssInfo.css));
  if (output.includes(MARKER)) fail('数据占位符替换失败');
  if (output.includes(CSS_MARKER)) fail('静态 CSS 占位符替换失败');
  if (!output.includes('const AD_CSS = "')) fail('生成物缺少内联静态 CSS 声明 const AD_CSS');
  const missingCss = CSS_REQUIRED_MARKERS.filter((m) => !output.includes(asJsLiteralBody(m)));
  if (missingCss.length) fail(`生成物内联的静态 CSS 缺少标志性选择器：${missingCss.join('、')}`);

  await mkdir(path.dirname(OUT), { recursive: true });
  await writeFile(OUT, output, 'utf8');
  const sizeKB = (Buffer.byteLength(output, 'utf8') / 1024).toFixed(1);
  console.log(`[build-userscript] 已生成 userscript/adcleaner.user.js（${sizeKB} KB，模板 ${template.split('\n').length} 行 + 内联数据 + 内联 CSS ${cssInfo.css.length} 字符）`);
  console.log(`[build-userscript] 占位符校验通过：${MARKER} ×1、${CSS_MARKER} ×1，替换后无残留；静态 CSS 标志选择器 ${CSS_REQUIRED_MARKERS.length} 个全部命中`);

  const check = nodeCheck(OUT);
  if (!check.ok) fail(`生成物 node --check 未通过：\n${check.output}`);
  console.log('[build-userscript] node --check userscript/adcleaner.user.js → 通过');

  const outText = await readFile(OUT, 'utf8');
  validateUserscriptHead(outText);
  console.log('[build-userscript] 头部元字段校验通过（@run-at document-start / @grant none / @match 全站 / 无 @noframes）');
  console.log('[build-userscript] 完成');
}

main().catch((err) => fail(err && err.stack ? err.stack : String(err)));
