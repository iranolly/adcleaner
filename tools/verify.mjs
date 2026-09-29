#!/usr/bin/env node
/**
 * tools/verify.mjs —— AdCleaner 零依赖自检脚本（SPEC.md §9「验证与验收」的可执行版）
 * =============================================================================
 * 用法：npm run verify   （等价于 node tools/verify.mjs；退出码 0=全部通过，1=有失败项）
 *
 * 覆盖项（全部只读，不改任何产物）：
 *   1. 语法：`node --check` 全部 .js / .mjs（跳过 node_modules/.cache/.tmp）；
 *   2. JSON：`JSON.parse` 全部 .json；
 *   3. 清单：manifest v3 / minimum_chrome_version ≥ 128 / 引用的 js·css·png·规则集文件都存在 /
 *      规则集 id 唯一且与文件一致；
 *   4. 规则集约束：顶层数组、单文件 ≤ 30000 条、正则 ≤ 1000 条且单条 ≤ 512 字符、id 文件内唯一、
 *      requestDomains 不得含「单标签」(TLD) 或 IP 字面量；
 *   5. 误伤禁区（SPEC 8.1 / 9.3）：cosmetic.css 与 cosmetics.json 中不得出现
 *      [class*="ad"] / [id*="ad"] / [class*="float"] / [class*="popup"] / [class*="banner"]；
 *   6. 图标：4 个 PNG 魔数合法；
 *   7. 油猴脚本构建可调用：构建脚本/模板/数据源/产物齐全，产物带 ==UserScript== 头且内联了 AD_DATA。
 *
 * 有意不做的事：不联网、不执行构建（避免改动他人负责的产物）、不 import 项目内其它模块。
 */

import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SKIP_DIRS = new Set(['node_modules', '.git', '.cache', '.tmp']);
const MAX_RULES_PER_FILE = 30000;
const MAX_REGEX_RULES = 1000;
const MAX_REGEX_LENGTH = 512;

const failures = [];
const fail = (check, message) => failures.push(`[${check}] ${message}`);
const rel = (p) => path.relative(ROOT, p).split(path.sep).join('/');

function walk(dir, out = []) {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (SKIP_DIRS.has(entry.name)) continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.isFile()) out.push(full);
  }
  return out;
}

const ALL_FILES = walk(ROOT).sort();

// ---------------------------------------------------------------------------
// 1. 语法
// ---------------------------------------------------------------------------
function checkSyntax() {
  const targets = ALL_FILES.filter((f) => /\.(?:js|mjs)$/.test(f));
  let passed = 0;
  for (const file of targets) {
    try {
      execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' });
      passed += 1;
    } catch (err) {
      const msg = String(err.stderr || err.message || '').trim().split('\n')[0];
      fail('syntax', `${rel(file)}: node --check 失败 → ${msg}`);
    }
  }
  console.log(`[1/7] syntax      ${passed}/${targets.length} 个 .js/.mjs 通过 node --check`);
}

// ---------------------------------------------------------------------------
// 2. JSON
// ---------------------------------------------------------------------------
const jsonByPath = new Map();
function checkJson() {
  const targets = ALL_FILES.filter((f) => f.endsWith('.json'));
  for (const file of targets) {
    try {
      jsonByPath.set(rel(file), JSON.parse(readFileSync(file, 'utf8')));
    } catch (err) {
      fail('json', `${rel(file)}: JSON.parse 失败 → ${err.message}`);
    }
  }
  console.log(`[2/7] json        ${jsonByPath.size}/${targets.length} 个 .json 解析通过`);
}

// ---------------------------------------------------------------------------
// 3. manifest
// ---------------------------------------------------------------------------
const MANIFEST_PATH = 'extension/manifest.json';

function checkManifest() {
  const manifest = jsonByPath.get(MANIFEST_PATH);
  if (!manifest) {
    fail('manifest', `${MANIFEST_PATH} 缺失或无法解析`);
    console.log('[3/7] manifest    跳过（清单缺失）');
    return null;
  }

  if (manifest.manifest_version !== 3) {
    fail('manifest', `manifest_version=${manifest.manifest_version}，必须为 3`);
  }
  const minChrome = Number(manifest.minimum_chrome_version);
  if (!Number.isFinite(minChrome) || minChrome < 128) {
    fail(
      'manifest',
      `minimum_chrome_version=${manifest.minimum_chrome_version}，应 ≥ 128（tracking 规则集使用 redirect.transform.queryTransform）`,
    );
  }

  // 引用文件必须存在
  const refs = [];
  refs.push(['background.service_worker', manifest.background?.service_worker]);
  refs.push(['options_page', manifest.options_page]);
  refs.push(['action.default_popup', manifest.action?.default_popup]);
  for (const [size, icon] of Object.entries(manifest.action?.default_icon || {})) {
    refs.push([`action.default_icon.${size}`, icon]);
  }
  for (const [size, icon] of Object.entries(manifest.icons || {})) {
    refs.push([`icons.${size}`, icon]);
  }
  (manifest.content_scripts || []).forEach((cs, i) => {
    for (const js of cs.js || []) refs.push([`content_scripts[${i}].js`, js]);
    for (const css of cs.css || []) refs.push([`content_scripts[${i}].css`, css]);
  });
  for (const [label, p] of refs) {
    // 清单内路径均相对于 manifest.json 所在目录（extension/）
    if (!p || !existsSync(path.join(ROOT, 'extension', p))) {
      fail('manifest', `${label} 引用的文件不存在：extension/${p}`);
    }
  }

  // 规则集 id 唯一 + 文件存在
  const resources = manifest.declarative_net_request?.rule_resources || [];
  if (!Array.isArray(resources) || resources.length === 0) {
    fail('manifest', 'declarative_net_request.rule_resources 缺失或为空');
  }
  const seenIds = new Set();
  for (const res of resources) {
    if (!res || typeof res.id !== 'string' || !res.id) {
      fail('manifest', `rule_resources 中存在非法 id：${JSON.stringify(res)}`);
      continue;
    }
    if (seenIds.has(res.id)) fail('manifest', `rule_resources id 重复：${res.id}`);
    seenIds.add(res.id);
    const p = path.join(ROOT, 'extension', res.path || '');
    if (!res.path || !existsSync(p)) fail('manifest', `规则集 ${res.id} 的文件不存在：${res.path}`);
  }

  console.log(
    `[3/7] manifest    v${manifest.manifest_version} / minChrome=${manifest.minimum_chrome_version} / ` +
      `${refs.length} 个引用文件 / ${resources.length} 个规则集`,
  );
  return manifest;
}

// ---------------------------------------------------------------------------
// 4. 规则集约束（含 requestDomains 无单标签/IP）
// ---------------------------------------------------------------------------
const IPV4ISH_RE = /^[0-9.]+$/;

function isRejectedRequestDomain(domain) {
  if (typeof domain !== 'string') return true;
  const d = domain.trim().toLowerCase();
  if (!d) return true;
  if (d.includes(':')) return true; // IPv6 字面量 / 带端口
  if (!d.includes('.')) return true; // 单标签（TLD，如 com / top / click）
  if (/^[0-9.]+$/.test(d)) return true; // IPv4 字面量及其变体
  if (d.startsWith('.') || d.endsWith('.') || d.includes('..')) return true;
  return false;
}

function checkRulesets(manifest) {
  const resources = manifest?.declarative_net_request?.rule_resources || [];
  let totalRules = 0;
  let totalRegex = 0;

  for (const res of resources) {
    const p = `extension/${res.path}`;
    const rules = jsonByPath.get(p);
    if (!Array.isArray(rules)) {
      fail('rulesets', `${p} 不是顶层数组（或未成功解析）`);
      continue;
    }
    totalRules += rules.length;
    if (rules.length > MAX_RULES_PER_FILE) {
      fail('rulesets', `${res.id}: ${rules.length} 条 > 上限 ${MAX_RULES_PER_FILE}`);
    }

    const ids = new Set();
    let regex = 0;
    let badDomains = 0;
    let idErrors = 0;
    for (const rule of rules) {
      if (!rule || typeof rule !== 'object') {
        fail('rulesets', `${res.id}: 存在非对象规则`);
        idErrors += 1;
        continue;
      }
      if (!Number.isInteger(rule.id) || rule.id <= 0) {
        fail('rulesets', `${res.id}: 非法 rule.id=${JSON.stringify(rule.id)}`);
        idErrors += 1;
      } else if (ids.has(rule.id)) {
        fail('rulesets', `${res.id}: rule.id 重复 ${rule.id}`);
        idErrors += 1;
      } else {
        ids.add(rule.id);
      }
      if (!rule.action || typeof rule.action.type !== 'string') {
        fail('rulesets', `${res.id}#${rule.id}: action.type 缺失`);
      }
      const condition = rule.condition;
      if (condition && typeof condition.regexFilter === 'string') {
        regex += 1;
        if (condition.regexFilter.length > MAX_REGEX_LENGTH) {
          fail('rulesets', `${res.id}#${rule.id}: regexFilter 长度 ${condition.regexFilter.length} > ${MAX_REGEX_LENGTH}`);
        }
      }
      if (condition && Array.isArray(condition.requestDomains)) {
        for (const d of condition.requestDomains) {
          if (isRejectedRequestDomain(d)) {
            badDomains += 1;
            if (badDomains <= 3) {
              fail('rulesets', `${res.id}#${rule.id}: requestDomains 含单标签/IP 条目 ${JSON.stringify(d)}`);
            }
          }
        }
      }
    }
    if (badDomains > 3) fail('rulesets', `${res.id}: 共 ${badDomains} 个单标签/IP requestDomains 条目`);
    if (regex > MAX_REGEX_RULES) {
      fail('rulesets', `${res.id}: regexFilter ${regex} 条 > 上限 ${MAX_REGEX_RULES}`);
    }
    totalRegex += regex;
    console.log(
      `[4/7] ruleset ${res.id.padEnd(11)} rules=${String(rules.length).padStart(6)} regex=${String(regex).padStart(4)}` +
        ` id唯一=${idErrors === 0} 单标签/IP=${badDomains}`,
    );
  }

  if (totalRules > MAX_RULES_PER_FILE) {
    fail('rulesets', `6 个规则集合计 ${totalRules} 条 > Chrome 同时启用保证上限 ${MAX_RULES_PER_FILE}`);
  }
  if (!jsonByPath.has('extension/rulesets/_sources.json')) {
    fail('rulesets', 'extension/rulesets/_sources.json 缺失或无法解析');
  }
  console.log(`      合计 rules=${totalRules} regex=${totalRegex}（_sources.json 存在：${jsonByPath.has('extension/rulesets/_sources.json')}）`);
}

// ---------------------------------------------------------------------------
// 5. 误伤禁区（SPEC 8.1 / 9.3）
// ---------------------------------------------------------------------------
const FORBIDDEN_PATTERNS = [
  '[class*="ad"]',
  '[id*="ad"]',
  '[class*="float"]',
  '[class*="popup"]',
  '[class*="banner"]',
];
const SELECTOR_FILES = ['extension/src/content/cosmetic.css', 'extension/src/data/cosmetics.json'];

function checkForbiddenSelectors() {
  let hits = 0;
  for (const p of SELECTOR_FILES) {
    const abs = path.join(ROOT, p);
    if (!existsSync(abs)) {
      fail('selectors', `${p} 不存在`);
      continue;
    }
    // 去掉反斜杠转义后再匹配，兼容 JSON 字符串里的 \" 写法
    const text = readFileSync(abs, 'utf8').replace(/\\/g, '');
    for (const pattern of FORBIDDEN_PATTERNS) {
      if (text.includes(pattern)) {
        hits += 1;
        fail('selectors', `${p} 命中禁区选择器 ${pattern}`);
      }
    }
  }
  console.log(`[5/7] selectors   ${SELECTOR_FILES.length} 个文件 × ${FORBIDDEN_PATTERNS.length} 条禁区模式，命中 ${hits}`);
}

// ---------------------------------------------------------------------------
// 6. PNG 图标
// ---------------------------------------------------------------------------
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function checkIcons() {
  const icons = ALL_FILES.filter((f) => f.toLowerCase().endsWith('.png'));
  let ok = 0;
  for (const file of icons) {
    const head = readFileSync(file).subarray(0, 8);
    if (head.equals(PNG_MAGIC)) ok += 1;
    else fail('icons', `${rel(file)} PNG 魔数非法`);
  }
  console.log(`[6/7] icons       ${ok}/${icons.length} 个 PNG 魔数合法`);
}

// ---------------------------------------------------------------------------
// 7. 油猴脚本构建可调用
// ---------------------------------------------------------------------------
function checkUserscriptBuild() {
  const required = [
    'tools/build-userscript.mjs',
    'userscript/template.js',
    'userscript/adcleaner.user.js',
    'extension/src/data/cosmetics.json',
    'extension/src/data/video-sites.json',
  ];
  for (const p of required) {
    if (!existsSync(path.join(ROOT, p))) fail('userscript', `构建链文件缺失：${p}`);
  }

  try {
    const builder = readFileSync(path.join(ROOT, 'tools/build-userscript.mjs'), 'utf8');
    for (const token of ['template.js', 'cosmetics.json', 'video-sites.json']) {
      if (!builder.includes(token)) fail('userscript', `tools/build-userscript.mjs 未引用 ${token}`);
    }
  } catch (err) {
    fail('userscript', `读取构建脚本失败：${err.message}`);
  }

  try {
    const out = readFileSync(path.join(ROOT, 'userscript/adcleaner.user.js'), 'utf8');
    for (const token of ['// ==UserScript==', '@match', 'const AD_DATA']) {
      if (!out.includes(token)) fail('userscript', `userscript/adcleaner.user.js 缺少 ${token}`);
    }
  } catch (err) {
    fail('userscript', `读取产物失败：${err.message}`);
  }

  console.log('[7/7] userscript  构建脚本 / 模板 / 数据源 / 产物齐全（产物 ==UserScript== 头 + AD_DATA 内联）');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------
console.log(`AdCleaner verify —— 根目录 ${ROOT}\n`);
checkSyntax();
checkJson();
const manifest = checkManifest();
checkRulesets(manifest);
checkForbiddenSelectors();
checkIcons();
checkUserscriptBuild();

console.log('');
if (failures.length) {
  console.error(`✗ verify 失败：${failures.length} 项`);
  for (const f of failures) console.error(`  - ${f}`);
  process.exit(1);
}
console.log('✓ verify 全部通过');
