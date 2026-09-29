/**
 * AdCleaner 清道夫 —— 后台 Service Worker（MV3）
 * =============================================================================
 * 职责（见 SPEC 第 3、5 节）：
 *   1. 首次安装写入默认设置到 chrome.storage.local["adcleaner.settings"]
 *   2. 按设置启用/停用 declarativeNetRequest 静态规则集
 *      （enabled=false → 停用全部 + 加一条全局 allowAllRequests 会话规则）
 *   3. 站点白名单 → 会话规则（allowAllRequests, priority 100, main_frame）
 *   4. 今日拦截计数 + 图标 badge（>999 显示 "999+"）
 *   5. 消息：{type:"getState"} / {type:"setSettings", settings} / {type:"domBlocked", n}
 *   6. Service Worker 冷启动时校正一次规则集状态，保证与设置一致
 *
 * 所有 Chrome API 调用均包在 try/catch 内：后台绝不能因为一次 API 异常而失效。
 */

'use strict';

/** chrome.storage.local 中唯一的设置键（SPEC 第 3 节固定键名） */
const STORAGE_KEY = 'adcleaner.settings';

/** 静态规则集 id，必须与 manifest.json 的 rule_resources 一致 */
const RULESET_IDS = ['base', 'cn', 'annoyances', 'popups', 'video', 'tracking'];

/** 会话规则 id 规划：1 = 全局放行；1000+ = 白名单 */
const GLOBAL_ALLOW_RULE_ID = 1;
const WHITELIST_RULE_ID_BASE = 1000;
const MAX_WHITELIST = 500; // Chrome 会话规则上限 5000，白名单留出足够余量

function defaultSettings() {
  return {
    enabled: true,
    whitelist: [],
    rulesets: { base: true, cn: true, annoyances: true, popups: true, video: true, tracking: true },
    videoAggressive: false,
    popupAggressive: false,
    stats: { date: today(), dom: 0 },
  };
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function asBool(v, fallback) {
  return typeof v === 'boolean' ? v : fallback;
}

/** 把用户输入（可含协议/路径/端口/通配符）规范化为纯小写域名；非法返回 '' */
function normalizeDomain(input) {
  let v = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split('/')[0].split('?')[0].split('#')[0].split('@').pop();
  v = v.replace(/:\d+$/, '');
  v = v.replace(/^\*\./, '');
  v = v.replace(/^\.+/, '').replace(/\.+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) return '';
  return v;
}

function normalizeWhitelist(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  const seen = new Set();
  for (const item of list) {
    const d = normalizeDomain(item);
    if (!d || seen.has(d)) continue;
    seen.add(d);
    out.push(d);
    if (out.length >= MAX_WHITELIST) break;
  }
  return out;
}

/** 把任意（可能来自旧版本/损坏的）对象合并成合法设置 */
function normalizeSettings(raw) {
  const d = defaultSettings();
  const src = raw && typeof raw === 'object' ? raw : {};
  const rulesets = {};
  const srcRulesets = src.rulesets && typeof src.rulesets === 'object' ? src.rulesets : {};
  for (const id of RULESET_IDS) {
    rulesets[id] = asBool(srcRulesets[id], d.rulesets[id]);
  }
  const srcStats = src.stats && typeof src.stats === 'object' ? src.stats : {};
  const date = typeof srcStats.date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(srcStats.date) ? srcStats.date : d.stats.date;
  const dom = Number.isFinite(Number(srcStats.dom)) && Number(srcStats.dom) >= 0 ? Math.floor(Number(srcStats.dom)) : 0;
  return {
    enabled: asBool(src.enabled, d.enabled),
    whitelist: normalizeWhitelist(src.whitelist),
    rulesets,
    videoAggressive: asBool(src.videoAggressive, d.videoAggressive),
    popupAggressive: asBool(src.popupAggressive, d.popupAggressive),
    // 跨日自动重置
    stats: { date, dom: date === today() ? Math.min(dom, 999999) : 0 },
  };
}

// ---------------------------------------------------------------------------
// 存储
// ---------------------------------------------------------------------------

async function readSettings() {
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return normalizeSettings(got ? got[STORAGE_KEY] : undefined);
  } catch (err) {
    console.warn('[AdCleaner] 读取设置失败：', err);
    return defaultSettings();
  }
}

async function writeSettings(settings) {
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: settings });
    return true;
  } catch (err) {
    console.warn('[AdCleaner] 写入设置失败：', err);
    return false;
  }
}

/** 合并式写入（与 SPEC 第 5 节 setSettings 语义一致） */
async function mergeSettings(patch) {
  const current = await readSettings();
  const merged = normalizeSettings({
    ...current,
    ...(patch && typeof patch === 'object' ? patch : {}),
    rulesets: { ...current.rulesets, ...((patch && patch.rulesets) || {}) },
    stats: { ...current.stats, ...((patch && patch.stats) || {}) },
    whitelist: patch && 'whitelist' in patch ? patch.whitelist : current.whitelist,
  });
  await writeSettings(merged);
  return merged;
}

// ---------------------------------------------------------------------------
// 规则集 / 会话规则 / badge
// ---------------------------------------------------------------------------

async function applyRulesets(settings) {
  const enableRulesetIds = [];
  const disableRulesetIds = [];
  for (const id of RULESET_IDS) {
    if (settings.enabled && settings.rulesets[id]) enableRulesetIds.push(id);
    else disableRulesetIds.push(id);
  }
  try {
    await chrome.declarativeNetRequest.updateEnabledRulesets({ enableRulesetIds, disableRulesetIds });
    console.debug('[AdCleaner] 规则集同步：启用', enableRulesetIds.join(',') || '无', '| 停用', disableRulesetIds.join(',') || '无');
  } catch (err) {
    console.warn('[AdCleaner] 更新规则集失败：', err);
  }
}

async function applySessionRules(settings) {
  try {
    const existing = await chrome.declarativeNetRequest.getSessionRules();
    const removeRuleIds = existing.map((r) => r.id);
    const addRules = [];

    if (!settings.enabled) {
      // 总开关关闭：全局放行（静态规则集也会被停用，这里是双保险）
      addRules.push({
        id: GLOBAL_ALLOW_RULE_ID,
        priority: 1000,
        action: { type: 'allowAllRequests' },
        condition: { urlFilter: '*', resourceTypes: ['main_frame', 'sub_frame'] },
      });
    }
    settings.whitelist.forEach((domain, i) => {
      addRules.push({
        id: WHITELIST_RULE_ID_BASE + i,
        priority: 100,
        action: { type: 'allowAllRequests' },
        condition: { requestDomains: [domain], resourceTypes: ['main_frame'] },
      });
    });

    await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds, addRules });
    console.debug('[AdCleaner] 会话规则同步：', addRules.length, '条');
  } catch (err) {
    console.warn('[AdCleaner] 更新会话规则失败：', err);
  }
}

async function updateBadge(settings) {
  try {
    const n = settings.stats.date === today() ? settings.stats.dom : 0;
    const text = !settings.enabled ? 'off' : n > 0 ? (n > 999 ? '999+' : String(n)) : '';
    await chrome.action.setBadgeText({ text });
    await chrome.action.setBadgeBackgroundColor({ color: settings.enabled ? '#2b5ce6' : '#8a8f98' });
    if (typeof chrome.action.setBadgeTextColor === 'function') {
      try {
        await chrome.action.setBadgeTextColor({ color: '#ffffff' });
      } catch {
        /* 旧版 Chrome 不支持文字颜色，忽略 */
      }
    }
  } catch (err) {
    console.warn('[AdCleaner] 更新 badge 失败：', err);
  }
}

/** 冷启动 / 设置变化后的统一校正入口 */
async function syncAll(settings) {
  const s = settings || (await readSettings());
  await applyRulesets(s);
  await applySessionRules(s);
  await updateBadge(s);
  return s;
}

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------

chrome.runtime.onInstalled.addListener((details) => {
  (async () => {
    try {
      const existing = await chrome.storage.local.get(STORAGE_KEY);
      if (!existing || !existing[STORAGE_KEY]) {
        const d = defaultSettings();
        await writeSettings(d);
        console.info('[AdCleaner] 已写入默认设置（' + details.reason + '）');
      } else {
        // 升级：把旧设置规范化补齐（新增字段/跨日统计重置）
        await writeSettings(await readSettings());
      }
      await syncAll();
    } catch (err) {
      console.warn('[AdCleaner] onInstalled 处理失败：', err);
    }
  })();
});

chrome.runtime.onStartup.addListener(() => {
  syncAll().catch((err) => console.warn('[AdCleaner] onStartup 同步失败：', err));
});

// Service Worker 冷启动校正（每次唤醒都会执行一次，幂等）
syncAll().catch((err) => console.warn('[AdCleaner] 冷启动同步失败：', err));

/** 只关心设置键的变化，并按变化字段决定重做什么，避免无谓开销 */
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'local' || !changes || !changes[STORAGE_KEY]) return;
  (async () => {
    try {
      const oldRaw = normalizeSettings(changes[STORAGE_KEY].oldValue);
      const next = normalizeSettings(changes[STORAGE_KEY].newValue);
      const rulesetChanged =
        oldRaw.enabled !== next.enabled || JSON.stringify(oldRaw.rulesets) !== JSON.stringify(next.rulesets);
      const sessionChanged =
        oldRaw.enabled !== next.enabled || JSON.stringify(oldRaw.whitelist) !== JSON.stringify(next.whitelist);
      if (rulesetChanged) await applyRulesets(next);
      if (sessionChanged) await applySessionRules(next);
      await updateBadge(next);
    } catch (err) {
      console.warn('[AdCleaner] 设置变更处理失败：', err);
    }
  })();
});

// ---------------------------------------------------------------------------
// 消息接口
// ---------------------------------------------------------------------------

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message || typeof message !== 'object') return undefined;
  const type = message.type;

  if (type === 'getState') {
    (async () => {
      try {
        const s = await readSettings();
        sendResponse({ ok: true, settings: s });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (type === 'setSettings') {
    (async () => {
      try {
        const merged = await mergeSettings(message.settings);
        await syncAll(merged);
        sendResponse({ ok: true, settings: merged });
      } catch (err) {
        console.warn('[AdCleaner] setSettings 失败：', err);
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  if (type === 'domBlocked') {
    (async () => {
      try {
        const n = Math.max(0, Math.min(10000, Math.floor(Number(message.n) || 0)));
        if (n === 0) {
          sendResponse({ ok: true, settings: await readSettings() });
          return;
        }
        const s = await readSettings();
        const stats =
          s.stats.date === today()
            ? { date: s.stats.date, dom: s.stats.dom + n }
            : { date: today(), dom: n };
        s.stats = stats;
        await writeSettings(s);
        await updateBadge(s);
        sendResponse({ ok: true, today: stats.dom });
      } catch (err) {
        sendResponse({ ok: false, error: String(err) });
      }
    })();
    return true;
  }

  return undefined;
});
