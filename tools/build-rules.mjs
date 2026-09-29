#!/usr/bin/env node
/**
 * tools/build-rules.mjs —— AdCleaner 规则集构建脚本（构建期工具，不随扩展发布）
 * =============================================================================
 * 作用
 *   1. 下载公开过滤列表（AdGuard Chinese MV3 / CJX / Peter Lowe / uBO badware / AdGuard URL Tracking）
 *   2. 用 @adguard/dnr-converter 把它们转换成 Chrome declarativeNetRequest (DNR) 规则
 *   3. 后处理：priority 归一 → 纯域名规则合并为 requestDomains → 剔除单标签(TLD)/IP 条目
 *      → 去重 → 重新编号（requestDomains 被剔空则整条规则丢弃，见 sanitizeRequestDomains）
 *   4. 校验（顶层数组 / 条数 ≤ 30000 / regex ≤ 1000 且单条 ≤ 512 字符）
 *   5. 写出 extension/rulesets/{base,cn,annoyances,popups,video,tracking}.json 与 _sources.json
 *
 * 用法
 *   npm install --include=dev      # 见 README「常见问题」：本机 npm 可能默认 omit=dev
 *   npm run build:rules            # 等价于 node tools/build-rules.mjs
 *   可选参数：--no-cache（忽略 .cache/rules 本地缓存，强制重新下载）
 *
 * 下载策略（每个 URL 依次尝试）：Node fetch（重试 1 次）→ curl（走系统代理，兼容
 * 直连被墙的 raw.githubusercontent.com）→ 备用 URL（GitHub raw ↔ jsDelivr 镜像）→ 本地缓存。
 * 全部失败才认定该列表失败，转入种子兜底。
 *
 * 关于 @adguard/dnr-converter 的真实 API（依据 node_modules/@adguard/dnr-converter/README.md
 * 与 dist/types/src/*.d.ts，版本 2.0.0 实测）：
 *   import { Filter, FilterConverter } from '@adguard/dnr-converter';
 *   const [ { ruleset, errors, limitations } ] = await new FilterConverter()
 *       .convert([new Filter(filterId, filterText)], { combine: true, ... });
 *   JSON.parse(ruleset.serialize())  // => DeclarativeRule[]，元素形如
 *                                    //    { id, priority, action:{type}, condition:{urlFilter|regexFilter, ...} }
 *   注意：`Filter` 第一个参数是数字 id，第二个是列表全文（字符串）或惰性函数；
 *   `serialize()` 在简单模式（未开 withSourceMap）下直接返回规则数组的 JSON 文本。
 *   转换器只做网络层规则；`$popup`/`$replace`/`$csp` 等无法表达为 DNR 的规则会进入 errors，属预期。
 *
 * 注意：本脚本是 GPL-3.0 组件（@adguard/dnr-converter）的构建期使用者，产物为纯 JSON 规则数据。
 */

import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

// ---------------------------------------------------------------------------
// 常量与路径
// ---------------------------------------------------------------------------

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const RULESET_DIR = path.join(ROOT, 'extension', 'rulesets');
const CACHE_DIR = path.join(ROOT, '.cache', 'rules');

const MAX_RULES_PER_FILE = 30000; // SPEC 4.1：单文件条数上限
const MAX_REGEX_RULES = 1000; // Chrome 限制：正则规则 ≤ 1000
const MAX_REGEX_LENGTH = 512; // 本项目收紧（Chrome 要求 regexFilter < 2KB）
const MAX_DOMAINS_PER_RULE = 2000; // 合并 requestDomains 时单条规则承载的域名上限（保证规则体量可控）
const TOTAL_BUDGET = 30000; // Chrome 仅保证同时启用 30000 条静态规则，全量启用时的总预算

const USER_AGENT = 'curl/8.4.0';
const FETCH_TIMEOUT_MS = 120000;
const NO_CACHE = process.argv.includes('--no-cache');

// 输出文件顺序与 manifest.json 中 rule_resources 的顺序一致
const OUTPUT_FILES = ['base', 'cn', 'annoyances', 'popups', 'video', 'tracking'];

// ---------------------------------------------------------------------------
// 需要的 DNR 规则结构（用于校验，见 SPEC 0/4.1）
// ---------------------------------------------------------------------------

const ACTION_TYPES = new Set([
  'block',
  'redirect',
  'allow',
  'upgradeScheme',
  'modifyHeaders',
  'allowAllRequests',
]);

const CONDITION_KEYS = new Set([
  'urlFilter',
  'regexFilter',
  'isUrlFilterCaseSensitive',
  'initiatorDomains',
  'excludedInitiatorDomains',
  'requestDomains',
  'excludedRequestDomains',
  'resourceTypes',
  'excludedResourceTypes',
  'requestMethods',
  'excludedRequestMethods',
  'domainType',
  'responseHeaders',
  'excludedResponseHeaders',
  'tabIds',
  'excludedTabIds',
]);

const RULE_TOP_LEVEL_KEYS = new Set(['id', 'priority', 'action', 'condition']);

// ---------------------------------------------------------------------------
// 列表来源定义
//   attempts: 依次尝试；每个 attempt 的 slots 依次解析（第一个可用 URL），并把各 slot 文本拼接。
// ---------------------------------------------------------------------------

const LISTS = {
  base: [
    {
      name: "Peter Lowe's Ad and tracking server list",
      license: 'No SPDX（免费使用，需注明来源 pgl.yoyo.org）',
      attempts: [
        { label: 'main', slots: [['https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext']] },
      ],
    },
    {
      name: 'uBlock Origin uAssets – badware',
      license: 'GPL-3.0',
      attempts: [
        {
          label: 'main',
          slots: [
            [
              'https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt',
              'https://cdn.jsdelivr.net/gh/uBlockOrigin/uAssets@master/filters/badware.txt',
            ],
          ],
        },
      ],
    },
  ],
  cn: [
    {
      name: 'AdGuard Chinese (MV3 变体，含 EasyList China)',
      license: 'GPL-3.0（AdGuard）/ GPLv3+ & CC BY-SA（EasyList China）',
      attempts: [
        { label: 'chromium-mv3 filter 224', slots: [['https://filters.adtidy.org/extension/chromium-mv3/filters/224.txt']] },
        {
          label: 'AdguardFilters master：adservers.txt + specific.txt 拼接',
          slots: [
            [
              'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/ChineseFilter/sections/adservers.txt',
              'https://cdn.jsdelivr.net/gh/AdguardTeam/AdguardFilters@master/ChineseFilter/sections/adservers.txt',
            ],
            [
              'https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/ChineseFilter/sections/specific.txt',
              'https://cdn.jsdelivr.net/gh/AdguardTeam/AdguardFilters@master/ChineseFilter/sections/specific.txt',
            ],
          ],
        },
      ],
    },
  ],
  annoyances: [
    {
      name: 'CJX List – cjx-annoyance',
      license: 'LGPL-3.0',
      attempts: [
        {
          label: 'main',
          slots: [
            [
              'https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjx-annoyance.txt',
              'https://cdn.jsdelivr.net/gh/cjx82630/cjxlist@master/cjx-annoyance.txt',
            ],
          ],
        },
      ],
    },
  ],
  tracking: [
    {
      name: 'AdGuard URL Tracking Filter',
      license: 'GPL-3.0',
      attempts: [
        { label: 'ublock filter 17', slots: [['https://filters.adtidy.org/extension/ublock/filters/17.txt']] },
      ],
    },
  ],
};

// ---------------------------------------------------------------------------
// SPEC 4.4 种子域名（兜底 + 追加进 base.json；全部 block、priority 10）
//   - 前一段逐字来自 SPEC 4.4；
//   - 后一段为同类已知广告/追踪域补充（SPEC 允许「自行补充同类已知广告域」），
//     已刻意避开 cupid.iqiyi.com / tb.mgtv.com / union.video.qq.com / vd.l.qq.com /
//     valipl.cp31.ott.cibntv.net 等需要放行整域的视频播放器 SDK 域。
// ---------------------------------------------------------------------------

const SEED_DOMAINS = [
  // —— SPEC 4.4 原文 ——
  'pos.baidu.com', 'cpro.baidu.com', 'cbjs.baidu.com', 'cpro.baidustatic.com', 'mobads.baidu.com',
  'afd.baidu.com', 'nsclick.baidu.com', 'qzs.gdtimg.com', 'adsmind.gdtimg.com', 'gdtimg.com',
  'impdsp.meituan.com', 'rtb.julang.taobao.com', 'tanx.com', 'atanx.alicdn.com', 'alimama.cn',
  'mmstat.com', 'miaozhen.com', 'admaster.com.cn', 'adbot.tw', 'adbottw.net', 'fam-8.net',
  'cdn.holmesmind.com', 'ad.ettoday.net', 'tagtoo.co', 'adserve.work', 'hm.baidu.com', 'cnzz.com',
  'cnzz.net', 'umeng.com', 'talkingdata.com', 'growingio.com', 'sensorsdata.cn',
  'beacon.sina.com.cn', 'log.byteoversea.com', 'mon.byteoversea.com',
  'dsp-track-global.zmaticoo.com', 'pagead2.googlesyndication.com', 'tpc.googlesyndication.com',
  'partner.googleadservices.com', 'adservice.google.com', 'adserver.bing.com', 'ads.msn.com',
  'pb.sogou.com', 'google-analytics.com', 'www.googletagmanager.com', 'googletagmanager.com',
  'analytics.google.com', 'doubleclick.net', 'demdex.net', 'agkn.com', 'bluekai.com', 'criteo.com',
  'taboola.com', 'outbrain.com', 'hotjar.com', 'mixpanel.com', 'segment.io', 'amplitude.com',
  'adjust.com', 'appsflyer.com', 'adsrvr.org', 'casalemedia.com', 'pubmatic.com', 'rubiconproject.com',
  'openx.net', 'adnxs.com', 'smartadserver.com', 'rlcdn.com', 'krxd.net', 'quantserve.com',
  'scorecardresearch.com', 'matomo.cloud', 'zhongziso.com',
  // —— 同类补充（与上列同级的公开已知广告/追踪域）——
  'adcolony.com', 'adform.net', 'adition.com', 'adroll.com', 'adsafeprotected.com',
  'advertising.com', 'adzerk.net', 'amazon-adsystem.com', 'applovin.com', 'bidswitch.net',
  'chartbeat.com', 'chartboost.com', 'contextweb.com', 'crwdcntrl.net', 'dable.io', 'dotomi.com',
  'doubleverify.com', 'exelator.com', 'flashtalking.com', 'fyber.com', 'googleadservices.com',
  'googlesyndication.com', 'gumgum.com', 'inmobi.com', 'indexexchange.com', 'ipredictive.com',
  'lijit.com', 'loopme.me', 'media.net', 'moatads.com', 'mookie1.com', 'mopub.com', 'netmng.com',
  'openx.com', 'owneriq.net', 'quantcount.com', 'revsci.net', 'rfihub.com', 'serving-sys.com',
  'sharethrough.com', 'simpli.fi', 'sizmek.com', 'sovrn.com', 'spotxchange.com', 'supersonicads.com',
  'teads.tv', 'tribalfusion.com', 'turn.com', 'undertone.com', 'unityads.unity3d.com',
  'vidazoo.com', 'vungle.com', 'yieldmo.com', 'zedo.com',
  'adash.m.taobao.com', 'adashbc.ut.taobao.com', 'adashx.ut.taobao.com', 'tmead.qq.com',
  'tmeadcomm.qq.com', 'e.qq.com', 'pingjs.qq.com', 'mta.qq.com', 'ta.qq.com', 'aegis.qq.com',
  'oa.pengpeng.com', 'ad.oceanengine.com', 'ad.bytedance.com', 'pangolin-sdk-toutiao.com',
  'ads.kuaishou.com', 'api.ad.xiaomi.com', 'ad.mi.com', '51.la', 'mobad.ijinshan.com',
];

const SEED_SOURCE_URL = 'seed://SPEC-4.4（脚本内硬编码种子域名，见 tools/build-rules.mjs）';
const SEED_LICENSE = '本项目自编（公开已知广告/追踪域名清单）';

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function log(...args) {
  console.log('[build-rules]', ...args);
}

function warn(...args) {
  console.warn('[build-rules]', ...args);
}

function todayISO() {
  return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function todayDate() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function cacheKeyFor(url) {
  return url.replace(/[^a-zA-Z0-9]+/g, '_').slice(0, 120) + '.txt';
}

// ---------------------------------------------------------------------------
// 下载（fetch → curl → 备用 URL → 本地缓存）
// ---------------------------------------------------------------------------

const execFileAsync = promisify(execFile);

async function fetchOnce(url) {
  const res = await fetch(url, {
    redirect: 'follow',
    headers: {
      'user-agent': USER_AGENT,
      accept: 'text/plain,text/*,*/*',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} ${res.statusText}`);
  }
  const text = await res.text();
  if (text.length < 64) {
    throw new Error(`响应过短（${text.length} bytes），疑似失败`);
  }
  return text;
}

/** curl 兜底：curl 会读取 HTTP(S)_PROXY 环境变量，穿透只允许代理出口的网络 */
async function curlFetch(url) {
  const { stdout } = await execFileAsync(
    'curl',
    ['-sS', '-L', '--compressed', '--max-time', '120', '-A', USER_AGENT, url],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true },
  );
  if (!stdout || stdout.length < 64) {
    throw new Error(`curl 响应过短（${stdout ? stdout.length : 0} bytes）`);
  }
  return stdout;
}

/** 下载单个 URL：fetch（重试 1 次）→ curl → 本地缓存。返回 { text, fetchedAt, fromCache, method } */
async function fetchWithFallback(url) {
  const tried = [];
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    try {
      const text = await fetchOnce(url);
      const fetchedAt = todayISO();
      await mkdir(CACHE_DIR, { recursive: true });
      await writeFile(path.join(CACHE_DIR, cacheKeyFor(url)), text, 'utf8').catch(() => {});
      return { text, fetchedAt, fromCache: false, method: 'fetch', url };
    } catch (err) {
      tried.push(`fetch 第 ${attempt} 次：${err && err.message ? err.message : String(err)}`);
      if (attempt === 1) await sleep(1500);
    }
  }
  // curl 兜底（走系统代理）
  try {
    const text = await curlFetch(url);
    await mkdir(CACHE_DIR, { recursive: true });
    await writeFile(path.join(CACHE_DIR, cacheKeyFor(url)), text, 'utf8').catch(() => {});
    warn(`fetch 失败，改用 curl 成功：${url}`);
    return { text, fetchedAt: todayISO(), fromCache: false, method: 'curl', url };
  } catch (err) {
    tried.push(`curl：${err && err.message ? err.message : String(err)}`);
  }
  // 缓存兜底
  if (!NO_CACHE) {
    try {
      const cached = await readFile(path.join(CACHE_DIR, cacheKeyFor(url)), 'utf8');
      if (cached.length >= 64) {
        warn(`下载失败，改用本地缓存：${url}`);
        return { text: cached, fetchedAt: todayISO(), fromCache: true, method: 'cache', url, error: tried.join(' | ') };
      }
    } catch {
      /* 无缓存，继续抛错 */
    }
  }
  throw new Error(`下载失败：${url}（${tried.join(' | ')}）`);
}

/** 解析一个 slot：按顺序尝试候选 URL，返回第一个成功的。 */
async function resolveSlot(urls) {
  const problems = [];
  for (const url of urls) {
    try {
      return await fetchWithFallback(url);
    } catch (err) {
      problems.push(err.message);
    }
  }
  throw new Error(`所有候选 URL 均失败：${problems.join(' | ')}`);
}

/** 解析一个列表来源：按 attempt 顺序尝试，返回 { parts: [{url,text,fetchedAt,fromCache}], label } */
async function resolveList(list) {
  const problems = [];
  for (const attempt of list.attempts) {
    try {
      const parts = [];
      for (const slot of attempt.slots) {
        // eslint-disable-next-line no-await-in-loop
        parts.push(await resolveSlot(slot));
      }
      return { label: attempt.label, parts };
    } catch (err) {
      problems.push(`[${attempt.label}] ${err.message}`);
    }
  }
  throw new Error(problems.join(' || '));
}

// ---------------------------------------------------------------------------
// 转换（@adguard/dnr-converter）
// ---------------------------------------------------------------------------

async function convertFilterText(Filter, FilterConverter, filterId, text, name) {
  const converter = new FilterConverter();
  const results = await converter.convert([new Filter(filterId, text)], {
    combine: true,
    maxNumberOfRules: 200000, // 放宽转换期上限，交给本脚本统一裁剪
    maxNumberOfUnsafeRules: 20000,
    maxNumberOfRegexpRules: MAX_REGEX_RULES,
  });
  const result = results && results[0];
  if (!result || !result.ruleset) {
    throw new Error(`转换器未返回规则集（${name}）`);
  }
  const raw = result.ruleset.serialize();
  const rules = JSON.parse(raw);
  if (!Array.isArray(rules)) {
    throw new Error(`转换产物不是数组（${name}）`);
  }
  const errors = (result.errors || []).map((e) => (e && e.name ? e.name : 'Error'));
  const limitations = (result.limitations || []).map((e) => (e && e.name ? e.name : 'LimitationError'));
  const errorKinds = {};
  for (const e of errors) errorKinds[e] = (errorKinds[e] || 0) + 1;
  return { rules, errors: errors.length, errorKinds, limitations };
}

// ---------------------------------------------------------------------------
// 后处理
// ---------------------------------------------------------------------------

const PURE_DOMAIN_URL_FILTER = /^\|\|([a-z0-9_.-]+)\^$/i;

function normalizePriority(actionType) {
  if (actionType === 'allow' || actionType === 'allowAllRequests') return 30;
  if (actionType === 'redirect') return 11;
  return 10;
}

function isValidAction(action) {
  if (!action || typeof action !== 'object') return false;
  if (typeof action.type !== 'string' || !ACTION_TYPES.has(action.type)) return false;
  if (action.type === 'redirect') {
    const r = action.redirect;
    if (!r || typeof r !== 'object') return false;
    if (!r.url && !r.extensionPath && !r.transform) return false;
  }
  if (action.type === 'modifyHeaders') {
    const hasOps = Array.isArray(action.requestHeaders) || Array.isArray(action.responseHeaders);
    if (!hasOps) return false;
  }
  return true;
}

function isValidCondition(condition) {
  if (condition === undefined) return true;
  if (condition === null || typeof condition !== 'object' || Array.isArray(condition)) return false;
  for (const key of Object.keys(condition)) {
    if (!CONDITION_KEYS.has(key)) return false;
  }
  if (condition.urlFilter !== undefined) {
    if (typeof condition.urlFilter !== 'string' || condition.urlFilter === '') return false;
    // DNR 要求 urlFilter 只能是 ASCII 可打印字符
    if (!/^[\x20-\x7e]+$/.test(condition.urlFilter)) return false;
    if (condition.urlFilter.startsWith('||*')) return false;
  }
  if (condition.regexFilter !== undefined) {
    if (typeof condition.regexFilter !== 'string' || condition.regexFilter === '') return false;
    if (!/^[\x20-\x7e]+$/.test(condition.regexFilter)) return false;
  }
  if (condition.urlFilter !== undefined && condition.regexFilter !== undefined) return false;
  for (const key of ['initiatorDomains', 'requestDomains', 'excludedInitiatorDomains', 'excludedRequestDomains']) {
    const v = condition[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0) return false;
    if (v.some((d) => typeof d !== 'string' || d === '' || !/^[a-z0-9.*_-]+$/i.test(d))) return false;
  }
  for (const key of ['resourceTypes', 'excludedResourceTypes', 'requestMethods', 'excludedRequestMethods']) {
    const v = condition[key];
    if (v === undefined) continue;
    if (!Array.isArray(v) || v.length === 0) return false;
  }
  if (condition.resourceTypes && condition.excludedResourceTypes) return false;
  if (condition.requestMethods && condition.excludedRequestMethods) return false;
  // allowAllRequests 必须带 main_frame / sub_frame
  return true;
}

function extractPureDomain(condition) {
  if (!condition) return null;
  const keys = Object.keys(condition);
  if (keys.length !== 1 || keys[0] !== 'urlFilter') return null;
  const m = PURE_DOMAIN_URL_FILTER.exec(condition.urlFilter);
  return m ? m[1].toLowerCase() : null;
}

/** 记录进报告/日志的剔除示例条数上限（每类） */
const MAX_SANITIZE_EXAMPLES = 12;

/**
 * 判断一个 requestDomains 条目是否必须剔除：
 *   - 单标签（无点，如 com / top / click）—— 上游列表里的 `$domain=com` 会产生这种 TLD 级约束，
 *     留着会误封整个 TLD；
 *   - IP 字面量（IPv4 及其纯数字变体；含 ':' 的 IPv6/端口）—— DNR 的 requestDomains 只接受主机名；
 *   - 空串 / 非法字符 / 前导或尾随点 / 连续点。
 */
function isRejectedRequestDomain(domain) {
  if (typeof domain !== 'string') return true;
  const d = domain.trim().toLowerCase();
  if (!d) return true;
  if (d.includes(':')) return true; // IPv6 字面量或带端口
  if (d.includes('.')) {
    if (!/^[a-z0-9_.*-]+$/.test(d)) return true;
    if (/^[0-9.]+$/.test(d)) return true; // IPv4 字面量及其变体（全数字标签）
    if (d.startsWith('.') || d.endsWith('.') || d.includes('..')) return true;
    return false;
  }
  return true; // 单标签：TLD / 主机名片段 / IPv6 片段
}

/**
 * requestDomains 安全过滤：逐条剔除单标签与 IP 字面量。
 *   - 被剔除后数组为空 => 丢弃该条规则（无论 action 类型：block / allow / redirect 一律丢弃）；
 *   - 剔除数量与示例记入 postProcess 报告，最终写进构建日志与 _sources.json。
 */
function sanitizeRequestDomains(rules, stats, file) {
  const out = [];
  for (const rule of rules) {
    const condition = rule && rule.condition;
    if (!condition || !Array.isArray(condition.requestDomains)) {
      out.push(rule);
      continue;
    }
    const keptDomains = [];
    let removed = 0;
    for (const domain of condition.requestDomains) {
      if (isRejectedRequestDomain(domain)) {
        removed += 1;
        stats.sanitizedDomains += 1;
        if (stats.sanitizeExamples.length < MAX_SANITIZE_EXAMPLES) {
          stats.sanitizeExamples.push(`${file}:${String(domain)}(${(rule.action && rule.action.type) || '?'})`);
        }
        continue;
      }
      if (!keptDomains.includes(domain)) keptDomains.push(domain);
    }
    if (removed === 0) {
      out.push(rule);
      continue;
    }
    if (keptDomains.length === 0) {
      stats.sanitizedDroppedRules += 1;
      if (stats.sanitizeDroppedExamples.length < MAX_SANITIZE_EXAMPLES) {
        stats.sanitizeDroppedExamples.push(
          `${file}:丢弃 ${(rule.action && rule.action.type) || '?'} [${condition.requestDomains.slice(0, 5).join(',')}]`,
        );
      }
      continue;
    }
    out.push({ ...rule, condition: { ...condition, requestDomains: keptDomains } });
  }
  return out;
}

/** 内置断言：写出前任何规则集的 requestDomains 都不允许再出现单标签/IP，否则直接构建失败 */
function assertNoBadRequestDomains(files) {
  const bad = [];
  for (const f of files) {
    for (const rule of f.rules || []) {
      const domains = rule && rule.condition && rule.condition.requestDomains;
      if (!Array.isArray(domains)) continue;
      for (const d of domains) {
        if (isRejectedRequestDomain(d)) bad.push(`${f.id}.json#${rule.id}:${String(d)}`);
      }
    }
  }
  if (bad.length) {
    throw new Error(
      `requestDomains 安全过滤断言失败（${bad.length} 处）：${bad.slice(0, 10).join(', ')}`,
    );
  }
}

/**
 * 后处理流水线：结构校验 → priority 归一 → 去重 → 纯域名合并 → 重新编号 → 校验裁剪
 */
function postProcess(rawRules, file) {
  const stats = {
    input: rawRules.length,
    invalid: 0,
    duplicated: 0,
    mergedFrom: 0,
    mergedTo: 0,
    regexDropped: 0,
    lengthDropped: 0,
    trimmed: 0,
    sanitizedDomains: 0, // 被剔除的单标签/IP requestDomains 条目数
    sanitizedDroppedRules: 0, // 因 requestDomains 被剔空而整条丢弃的规则数
    sanitizeExamples: [],
    sanitizeDroppedExamples: [],
  };

  const seen = new Set();
  const kept = [];
  const groups = new Map(); // key -> { action, domains:Set }

  for (const raw of rawRules) {
    if (!raw || typeof raw !== 'object') {
      stats.invalid += 1;
      continue;
    }
    // 丢弃 DNR 不认识的顶层字段（例如转换器内部用的 metadata）
    for (const key of Object.keys(raw)) {
      if (!RULE_TOP_LEVEL_KEYS.has(key)) delete raw[key];
    }
    if (!isValidAction(raw.action) || !isValidCondition(raw.condition)) {
      stats.invalid += 1;
      continue;
    }
    if (raw.condition && raw.condition.regexFilter !== undefined) {
      if (raw.condition.regexFilter.length > MAX_REGEX_LENGTH) {
        stats.lengthDropped += 1;
        continue;
      }
    }
    const rule = {
      action: { ...raw.action },
      condition: raw.condition ? { ...raw.condition } : undefined,
      priority: normalizePriority(raw.action.type),
    };
    if (!rule.condition) delete rule.condition;

    const dedupeKey = JSON.stringify([rule.action, rule.condition, rule.priority]);
    if (seen.has(dedupeKey)) {
      stats.duplicated += 1;
      continue;
    }
    seen.add(dedupeKey);

    const domain = extractPureDomain(rule.condition);
    const mergeable = domain !== null && (rule.action.type === 'block' || rule.action.type === 'allow');
    if (mergeable) {
      const key = rule.action.type;
      let group = groups.get(key);
      if (!group) {
        group = { action: rule.action, domains: new Set() };
        groups.set(key, group);
      }
      group.domains.add(domain);
      stats.mergedFrom += 1;
      continue;
    }
    kept.push(rule);
  }

  // 合并组展开（每个组可能拆成多条，避免单条规则体量过大）
  for (const group of groups.values()) {
    const domains = [...group.domains].sort();
    for (let i = 0; i < domains.length; i += MAX_DOMAINS_PER_RULE) {
      const chunk = domains.slice(i, i + MAX_DOMAINS_PER_RULE);
      kept.push({
        action: group.action,
        condition: { requestDomains: chunk },
        priority: normalizePriority(group.action.type),
      });
      stats.mergedTo += 1;
    }
  }

  // 编号 + 最终校验（requestDomains 安全过滤可能让原本不同的规则变成同构，这里二次去重）
  const sanitized = sanitizeRequestDomains(kept, stats, file);
  const out = [];
  const seenOut = new Set();
  let regexCount = 0;
  for (const rule of sanitized) {
    const outKey = JSON.stringify([rule.action, rule.condition, rule.priority]);
    if (seenOut.has(outKey)) {
      stats.duplicated += 1;
      continue;
    }
    seenOut.add(outKey);
    if (rule.condition && rule.condition.regexFilter !== undefined) {
      if (regexCount >= MAX_REGEX_RULES) {
        stats.regexDropped += 1;
        continue;
      }
      regexCount += 1;
    }
    if (out.length >= MAX_RULES_PER_FILE) {
      stats.trimmed += 1;
      continue;
    }
    out.push({ id: out.length + 1, priority: rule.priority, action: rule.action, ...(rule.condition ? { condition: rule.condition } : {}) });
  }

  const report = {
    file,
    rulesOut: out.length,
    regexOut: regexCount,
    ...stats,
  };
  return { rules: out, report };
}

// 全局裁剪：超过 Chrome 保证的 30000 条同时启用上限时，从指定文件尾部丢弃并记录
function enforceTotalBudget(files, budget) {
  const total = files.reduce((sum, f) => sum + f.rules.length, 0);
  if (total <= budget) return { total, dropped: 0, trimmedFile: null };
  // 只裁「转换得来」的文件，且优先裁最大的
  const candidates = files
    .filter((f) => ['cn', 'base', 'annoyances', 'tracking'].includes(f.id))
    .sort((a, b) => b.rules.length - a.rules.length);
  let dropped = 0;
  let trimmedFile = null;
  for (const f of candidates) {
    if (total - dropped <= budget) break;
    const need = total - dropped - budget;
    const take = Math.min(need, f.rules.length);
    f.rules = f.rules.slice(0, f.rules.length - take);
    dropped += take;
    trimmedFile = f.id;
  }
  return { total, dropped, trimmedFile };
}

// ---------------------------------------------------------------------------
// 手写规则集（SPEC 4.1：不走转换器）
// ---------------------------------------------------------------------------

function buildPopupsRuleset() {
  const domains = [
    'getpopunder.com',
    'popunder.bid',
    'popunderoctober.store',
    'popunderstar.com',
    'popunderz.com',
    'popunderjs.com',
    'uptopopunder.com',
  ].sort();
  const rules = [
    {
      id: 1,
      priority: 10,
      action: { type: 'block' },
      condition: { requestDomains: domains, resourceTypes: ['main_frame'] },
    },
  ];
  for (const urlFilter of ['/jspopunder.js', '/popunder.min.js', '/popunderpro/']) {
    rules.push({
      id: rules.length + 1,
      priority: 10,
      action: { type: 'block' },
      condition: { urlFilter, resourceTypes: ['script'] },
    });
  }
  return rules;
}

function buildVideoRuleset() {
  const blockFilters = [
    '||cupid.iqiyi.com/show2?',
    '||iqiyi.com/player/common/adflash',
    '||iqiyi.com/player/common/rebull',
    '||ad.youku.com/vp?',
    '||atm.youku.com^',
    '||cad.youku.com^',
    '||da.mgtv.com^',
    '||video.da.mgtv.com^',
    '||pcvideoyf.titan.mgtv.com/pb/*.mp4',
    '||ads.sohu.com^',
    '||aty.sohu.com/v?',
    '||m.aty.sohu.com^',
    '||tv.sohu.com/upload/csad/',
    '||ark.le.com/s?vid=',
    '||api.bilibili.com/x/ad/',
    '||cm.bilibili.com^',
    '||adx.qq.com^',
    '||gdt.qq.com^',
    '||cm.l.qq.com^',
    '||iwan-s.video.qq.com^',
    '||ssp.qq.com/ad^',
    '||ad.youku.com^',
  ];
  const allowRules = [
    { urlFilter: '||cupid.iqiyi.com/mixer', resourceTypes: ['script'], initiatorDomains: ['iqiyi.com'] },
    { urlFilter: '||tb.mgtv.com/sdk/*/ad-sdk.js', resourceTypes: ['script'], initiatorDomains: ['mgtv.com'] },
    { urlFilter: '||union.video.qq.com/fcgi-bin/', resourceTypes: ['script'], initiatorDomains: ['qq.com'] },
    { urlFilter: '||vd.l.qq.com^', initiatorDomains: ['qq.com'] },
    { urlFilter: '||valipl.cp31.ott.cibntv.net^', initiatorDomains: ['youku.com'] },
  ];

  const rules = [];
  for (const urlFilter of blockFilters) {
    rules.push({
      id: rules.length + 1,
      priority: 10,
      action: { type: 'block' },
      condition: { urlFilter },
    });
  }
  for (const r of allowRules) {
    const condition = { urlFilter: r.urlFilter };
    if (r.resourceTypes) condition.resourceTypes = r.resourceTypes;
    if (r.initiatorDomains) condition.initiatorDomains = r.initiatorDomains;
    rules.push({ id: rules.length + 1, priority: 30, action: { type: 'allow' }, condition });
  }
  return rules;
}

/** 种子兜底规则集：全部 block、priority 10、合并为 requestDomains */
function buildSeedRules(domains = SEED_DOMAINS) {
  const sorted = [...new Set(domains.map((d) => d.toLowerCase()))].sort();
  const rules = [];
  for (let i = 0; i < sorted.length; i += MAX_DOMAINS_PER_RULE) {
    rules.push({
      id: rules.length + 1,
      priority: 10,
      action: { type: 'block' },
      condition: { requestDomains: sorted.slice(i, i + MAX_DOMAINS_PER_RULE) },
    });
  }
  return rules;
}

// ---------------------------------------------------------------------------
// 输出
// ---------------------------------------------------------------------------

async function writeRuleset(id, rules) {
  const file = path.join(RULESET_DIR, `${id}.json`);
  const body = `[\n${rules.map((r) => JSON.stringify(r)).join(',\n')}\n]\n`;
  await writeFile(file, body, 'utf8');
  return { file, bytes: Buffer.byteLength(body, 'utf8') };
}

function summarizeErrorKinds(kinds) {
  const entries = Object.entries(kinds).sort((a, b) => b[1] - a[1]);
  if (!entries.length) return '';
  return entries.map(([k, v]) => `${k}×${v}`).join(', ');
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main() {
  log(`Node ${process.version} / 输出目录 ${path.relative(ROOT, RULESET_DIR) || '.'}`);

  let Filter;
  let FilterConverter;
  let converterVersion = 'unknown';
  try {
    const mod = await import('@adguard/dnr-converter');
    ({ Filter, FilterConverter } = mod);
    converterVersion = mod.DNR_CONVERTER_VERSION || '2.x';
  } catch (err) {
    throw new Error(
      `无法加载 @adguard/dnr-converter（${err.message}）。请先执行：npm install --include=dev`,
    );
  }
  log(`转换器：@adguard/dnr-converter@${converterVersion}`);

  await mkdir(RULESET_DIR, { recursive: true });

  /** @type {{id:string, rules:object[], fallback:boolean, sources:object[], report:object}[]} */
  const outputs = [];
  const sourceRecords = [];
  const failures = [];
  let filterId = 100;

  // 1) 转换类规则集
  for (const id of ['base', 'cn', 'annoyances', 'tracking']) {
    const lists = LISTS[id] || [];
    const converted = [];
    const fileSources = [];
    let fallback = false;

    for (const list of lists) {
      let resolved;
      try {
        resolved = await resolveList(list);
      } catch (err) {
        failures.push({ file: id, source: list.name, reason: err.message });
        warn(`FALLBACK USED: ${list.name}（${id}.json）→ 原因：${err.message}`);
        fileSources.push({
          file: `${id}.json`,
          sourceUrl: list.attempts.flatMap((a) => a.slots.flat()).join(' | '),
          fetchedAt: todayISO(),
          license: list.license,
          ruleCount: 0,
          name: list.name,
          status: 'FAILED',
          error: err.message,
        });
        fallback = true;
        continue;
      }

      const text = resolved.parts.map((p) => p.text).join('\n');
      const sourceUrl = resolved.parts.map((p) => p.url).join(' + ');
      const fetchedAt = resolved.parts.map((p) => p.fetchedAt).sort().pop();
      const fromCache = resolved.parts.some((p) => p.fromCache);
      const methods = [...new Set(resolved.parts.map((p) => p.method))].join('+');
      let result;
      try {
        filterId += 1;
        result = await convertFilterText(Filter, FilterConverter, filterId, text, list.name);
      } catch (err) {
        failures.push({ file: id, source: list.name, reason: `转换失败：${err.message}` });
        warn(`FALLBACK USED: ${list.name}（${id}.json）→ 转换失败：${err.message}`);
        fileSources.push({
          file: `${id}.json`,
          sourceUrl,
          fetchedAt,
          license: list.license,
          ruleCount: 0,
          name: list.name,
          status: 'CONVERT_FAILED',
          error: err.message,
        });
        fallback = true;
        continue;
      }

      log(
        `${id} ← ${list.name}：下载 ${(Buffer.byteLength(text, 'utf8') / 1024).toFixed(0)}KB` +
          `${fromCache ? '（本地缓存）' : `（${methods}）`}，转换出 ${result.rules.length} 条规则` +
          `，无法转换 ${result.errors} 条（${summarizeErrorKinds(result.errorKinds) || '无'}）` +
          `${result.limitations.length ? `，限制警告：${result.limitations.join(',')}` : ''}`,
      );
      converted.push(...result.rules);
      fileSources.push({
        file: `${id}.json`,
        sourceUrl,
        fetchedAt,
        license: list.license,
        ruleCount: result.rules.length,
        name: list.name,
        status: fromCache ? 'OK_CACHED' : 'OK',
        fetchMethod: methods,
        conversionErrors: result.errors,
        errorKinds: result.errorKinds,
      });
    }

    if (converted.length === 0) {
      // 全部来源失败 → 种子兜底（SPEC 4.1 第 6 步）
      warn(`FALLBACK USED: ${id}.json 全部来源失败，改用 SPEC 4.4 种子域名（${SEED_DOMAINS.length} 个）`);
      fallback = true;
      const seedRules = buildSeedRules();
      outputs.push({
        id,
        rules: seedRules,
        fallback: true,
        sources: fileSources,
        seedFallback: true,
      });
      sourceRecords.push(...fileSources, {
        file: `${id}.json`,
        sourceUrl: SEED_SOURCE_URL,
        fetchedAt: todayISO(),
        license: SEED_LICENSE,
        ruleCount: seedRules.length,
        name: 'SPEC 4.4 种子域名（兜底）',
        status: 'FALLBACK',
      });
      continue;
    }

    outputs.push({ id, rules: converted, fallback, sources: fileSources });
    sourceRecords.push(...fileSources);
  }

  // 2) 种子域名追加进 base.json（SPEC 4.4）
  const baseOut = outputs.find((o) => o.id === 'base');
  if (baseOut && !baseOut.seedFallback) {
    const seedRules = buildSeedRules();
    baseOut.rules.push(...seedRules);
    sourceRecords.push({
      file: 'base.json',
      sourceUrl: SEED_SOURCE_URL,
      fetchedAt: todayISO(),
      license: SEED_LICENSE,
      ruleCount: seedRules.length,
      name: `SPEC 4.4 种子域名（附加，${SEED_DOMAINS.length} 个域名）`,
      status: 'SEED_APPENDED',
    });
    log(`base ← 追加 SPEC 4.4 种子域名 ${SEED_DOMAINS.length} 个（合并为 ${seedRules.length} 条规则）`);
  }

  // 3) 手写规则集
  const popupRules = postProcess(buildPopupsRuleset(), 'popups');
  outputs.push({ id: 'popups', rules: popupRules.rules, fallback: false, sources: [], report: popupRules.report, handwritten: true });
  sourceRecords.push({
    file: 'popups.json',
    sourceUrl: 'handwritten://SPEC-4.1（手写 popunder 落地域 + 脚本路径）',
    fetchedAt: todayISO(),
    license: '本项目自编（MIT，见 README）',
    ruleCount: popupRules.rules.length,
    name: '手写 popups 规则集',
    status: 'HANDWRITTEN',
  });

  const videoRules = postProcess(buildVideoRuleset(), 'video');
  outputs.push({ id: 'video', rules: videoRules.rules, fallback: false, sources: [], report: videoRules.report, handwritten: true });
  sourceRecords.push({
    file: 'video.json',
    sourceUrl: 'handwritten://SPEC-4.1（手写视频贴片/暂停广告域名规则 + 播放器 SDK allow 白名单）',
    fetchedAt: todayISO(),
    license: '本项目自编（MIT，见 README）',
    ruleCount: videoRules.rules.length,
    name: '手写 video 规则集',
    status: 'HANDWRITTEN',
  });

  // 4) 后处理转换类规则集
  for (const out of outputs) {
    if (out.handwritten) continue;
    const processed = postProcess(out.rules, out.id);
    out.rules = processed.rules;
    out.report = processed.report;
  }

  // 5) 全局预算（Chrome 只保证同时启用 30000 条静态规则）
  const budgetFiles = outputs.filter((o) => o.id !== 'popups' && o.id !== 'video');
  const beforeTotal = budgetFiles.reduce((s, f) => s + f.rules.length, 0);
  const budget = enforceTotalBudget(budgetFiles, TOTAL_BUDGET - 100);
  let budgetInfo = `转换类规则集合计 ${beforeTotal} 条（预算 ${TOTAL_BUDGET}）`;
  if (budget.dropped > 0) {
    budgetInfo += `，超出预算，已从 ${budget.trimmedFile}.json 尾部丢弃 ${budget.dropped} 条`;
    warn(`超出总预算：已从 ${budget.trimmedFile}.json 尾部丢弃 ${budget.dropped} 条规则（规则集仍可用，但覆盖略降）`);
    // 重新编号被裁剪的文件
    const trimmed = budgetFiles.find((f) => f.id === budget.trimmedFile);
    if (trimmed) trimmed.rules = trimmed.rules.map((r, i) => ({ ...r, id: i + 1 }));
  }

  // 6) 写出规则集（写前断言：不得残留单标签/IP 的 requestDomains）
  assertNoBadRequestDomains(outputs);
  const order = new Map(OUTPUT_FILES.map((id, i) => [id, i]));
  outputs.sort((a, b) => (order.get(a.id) ?? 99) - (order.get(b.id) ?? 99));

  const summary = [];
  const fileSummaries = [];
  for (const out of outputs) {
    const { bytes } = await writeRuleset(out.id, out.rules);
    const regex = out.rules.filter((r) => r.condition && r.condition.regexFilter).length;
    const unsafe = out.rules.filter(
      (r) => r.action.type === 'redirect' || r.action.type === 'modifyHeaders',
    ).length;
    summary.push({
      id: out.id,
      rules: out.rules.length,
      regex,
      unsafe,
      bytes,
      fallback: Boolean(out.fallback),
      report: out.report || null,
    });
    fileSummaries.push({
      file: `extension/rulesets/${out.id}.json`,
      rulesetId: out.id,
      rules: out.rules.length,
      regexRules: regex,
      unsafeRules: unsafe,
      bytes,
      humanSizeKB: Number((bytes / 1024).toFixed(1)),
      fallback: Boolean(out.fallback),
      handwritten: Boolean(out.handwritten),
      trimmed: out.report ? out.report.trimmed : 0,
      sanitizedDroppedRules: out.report ? out.report.sanitizedDroppedRules : 0,
      sanitizedDomains: out.report ? out.report.sanitizedDomains : 0,
      sanitizeExamples: out.report ? out.report.sanitizeExamples : [],
      sanitizeDroppedExamples: out.report ? out.report.sanitizeDroppedExamples : [],
    });
  }

  // requestDomains 安全过滤汇总（写进 _sources.json 与控制台）
  const sanitizeTotals = summary.reduce(
    (acc, s) => {
      const r = s.report || {};
      acc.sanitizedDroppedRules += r.sanitizedDroppedRules || 0;
      acc.removedDomains += r.sanitizedDomains || 0;
      for (const ex of r.sanitizeExamples || []) {
        if (acc.examples.length < MAX_SANITIZE_EXAMPLES) acc.examples.push(ex);
      }
      for (const ex of r.sanitizeDroppedExamples || []) {
        if (acc.droppedExamples.length < MAX_SANITIZE_EXAMPLES) acc.droppedExamples.push(ex);
      }
      return acc;
    },
    { sanitizedDroppedRules: 0, removedDomains: 0, examples: [], droppedExamples: [] },
  );

  // 7) _sources.json
  const meta = {
    generatedAt: todayISO(),
    generatedDate: todayDate(),
    converter: `@adguard/dnr-converter@${converterVersion}`,
    node: process.version,
    notes:
      '每项记录形如 {file, sourceUrl, fetchedAt, license, ruleCount}；status 为 OK/OK_CACHED/HANDWRITTEN/SEED_APPENDED/FALLBACK/FAILED/CONVERT_FAILED，' +
      'fetchMethod 记录实际下载通道（fetch / curl / cache，用 + 连接多段拼接来源）。' +
      'FALLBACK 表示该列表下载或转换失败，已用 SPEC 4.4 种子域名兜底。' +
      'sanitize 记录 requestDomains 安全过滤：剔除单标签(TLD)/IP 条目与因剔空而丢弃的规则数及示例。',
    budget: budgetInfo,
    sanitize: {
      sanitizedDroppedRules: sanitizeTotals.sanitizedDroppedRules,
      removedDomains: sanitizeTotals.removedDomains,
      examples: sanitizeTotals.examples,
      droppedExamples: sanitizeTotals.droppedExamples,
    },
    failures,
    files: fileSummaries,
    sources: sourceRecords,
  };
  const sourcesPath = path.join(RULESET_DIR, '_sources.json');
  await writeFile(sourcesPath, JSON.stringify(meta, null, 2) + '\n', 'utf8');

  // 8) 控制台汇总
  log('');
  log('规则集统计：');
  for (const s of summary) {
    log(
      `  ${s.id.padEnd(11)} rules=${String(s.rules).padStart(6)}  regex=${String(s.regex).padStart(4)}` +
        `  unsafe=${String(s.unsafe).padStart(3)}  ${(s.bytes / 1024).toFixed(1).padStart(8)}KB` +
        `${s.fallback ? '  [FALLBACK]' : ''}`,
    );
    if (s.report) {
      const r = s.report;
      log(
        `  ${' '.repeat(11)} 输入=${r.input} 非法丢弃=${r.invalid} 重复=${r.duplicated} ` +
          `纯域名合并=${r.mergedFrom}→${r.mergedTo} 超长正则丢弃=${r.lengthDropped} 超限丢弃=${r.regexDropped + r.trimmed}`,
      );
      if (r.sanitizedDomains || r.sanitizedDroppedRules) {
        log(
          `  ${' '.repeat(11)} requestDomains 安全过滤：剔除单标签/IP ${r.sanitizedDomains} 个条目，` +
            `整条丢弃 ${r.sanitizedDroppedRules} 条规则`,
        );
      }
    }
  }
  log(
    `  requestDomains 安全过滤合计：剔除单标签/IP ${sanitizeTotals.removedDomains} 个条目，` +
      `整条丢弃 ${sanitizeTotals.sanitizedDroppedRules} 条规则`,
  );
  if (sanitizeTotals.examples.length) {
    log(`    剔除示例：${sanitizeTotals.examples.join(' | ')}`);
  }
  if (sanitizeTotals.droppedExamples.length) {
    log(`    丢弃示例：${sanitizeTotals.droppedExamples.join(' | ')}`);
  }
  const totalRules = summary.reduce((s, x) => s + x.rules, 0);
  const totalBytes = summary.reduce((s, x) => s + x.bytes, 0);
  const totalRegex = summary.reduce((s, x) => s + x.regex, 0);
  log(`  合计 ${totalRules} 条规则 / ${totalRegex} 条正则 / ${(totalBytes / 1024).toFixed(1)}KB`);
  log(`  ${budgetInfo}`);
  log(`  _sources.json → ${path.relative(ROOT, sourcesPath)}`);
  if (failures.length) {
    warn(`本机存在 ${failures.length} 个来源失败（已记录在 _sources.json）：`);
    for (const f of failures) warn(`  - ${f.file} / ${f.source}：${f.reason}`);
  }
  log('完成 ✅');
}

main().catch((err) => {
  console.error('[build-rules] 失败：', err && err.stack ? err.stack : err);
  process.exit(1);
});
