/**
 * AdCleaner 清道夫 —— popup 逻辑
 * -----------------------------------------------------------------------------
 * 只用 chrome.storage.local + runtime 消息与后台交互（不假设 popup 页面长期打开）。
 * 写入统一走 {type:"setSettings"}，读取走 {type:"getState"}，消息失败时回退到直接读写 storage。
 * 界面全部中文，无内联脚本、无远程资源、无第三方库。
 */

'use strict';

const STORAGE_KEY = 'adcleaner.settings';

/** 与 background.js / manifest.json 保持一致 */
const RULESETS = [
  { id: 'base', label: '基础规则', desc: '通用广告/恶意域名（Peter Lowe + uBO badware + 种子域）' },
  { id: 'cn', label: '中文规则', desc: 'AdGuard Chinese（含 EasyList China）' },
  { id: 'annoyances', label: '干扰规则', desc: 'CJX 列表：浮层、引导下载、Cookie 提示等' },
  { id: 'popups', label: '弹窗规则', desc: 'popunder 落地域与弹窗脚本路径' },
  { id: 'video', label: '视频规则', desc: '视频站贴片/暂停广告域名（含播放器 SDK 放行）' },
  { id: 'tracking', label: '跟踪参数', desc: 'AdGuard URL Tracking：剥离 utm/gclid 等跟踪参数' },
];

const DEFAULTS = {
  enabled: true,
  whitelist: [],
  rulesets: { base: true, cn: true, annoyances: true, popups: true, video: true, tracking: true },
  videoAggressive: false,
  popupAggressive: false,
  stats: { date: '', dom: 0 },
};

const el = {
  enabled: document.getElementById('enabled'),
  status: document.getElementById('status'),
  statToday: document.getElementById('stat-today'),
  pauseSite: document.getElementById('pause-site'),
  rulesets: document.getElementById('rulesets'),
  openOptions: document.getElementById('open-options'),
  siteTip: document.getElementById('site-tip'),
};

let state = null; // 当前设置
let currentHost = ''; // 当前标签页域名（可能为空）

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------

function today() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

function normalizeDomain(input) {
  let v = String(input || '').trim().toLowerCase();
  if (!v) return '';
  v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
  v = v.split('/')[0].split('?')[0].split('#')[0].split('@').pop();
  v = v.replace(/:\d+$/, '').replace(/^\*\./, '').replace(/^\.+/, '').replace(/\.+$/, '');
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(v)) return '';
  return v;
}

function isWhitelisted(host, list) {
  if (!host) return false;
  return (list || []).some((d) => host === d || host.endsWith('.' + d));
}

function mergeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rulesets = { ...DEFAULTS.rulesets };
  const srcRulesets = src.rulesets && typeof src.rulesets === 'object' ? src.rulesets : {};
  for (const id of Object.keys(rulesets)) {
    if (typeof srcRulesets[id] === 'boolean') rulesets[id] = srcRulesets[id];
  }
  const srcStats = src.stats && typeof src.stats === 'object' ? src.stats : {};
  const date = srcStats.date === today() ? srcStats.date : today();
  const dom = srcStats.date === today() && Number.isFinite(Number(srcStats.dom)) ? Math.max(0, Math.floor(Number(srcStats.dom))) : 0;
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : DEFAULTS.enabled,
    whitelist: Array.isArray(src.whitelist) ? src.whitelist.filter((d) => typeof d === 'string') : [],
    rulesets,
    videoAggressive: typeof src.videoAggressive === 'boolean' ? src.videoAggressive : false,
    popupAggressive: typeof src.popupAggressive === 'boolean' ? src.popupAggressive : false,
    stats: { date, dom },
  };
}

// ---------------------------------------------------------------------------
// 与后台通信（带 storage 回退）
// ---------------------------------------------------------------------------

function send(message) {
  return new Promise((resolve) => {
    try {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          resolve({ ok: false, error: chrome.runtime.lastError.message });
          return;
        }
        resolve(response || { ok: false, error: '空响应' });
      });
    } catch (err) {
      resolve({ ok: false, error: String(err) });
    }
  });
}

async function loadSettings() {
  const res = await send({ type: 'getState' });
  if (res && res.ok && res.settings) return mergeSettings(res.settings);
  // 回退：直接读 storage
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return mergeSettings(got && got[STORAGE_KEY]);
  } catch {
    return mergeSettings(DEFAULTS);
  }
}

async function savePatch(patch) {
  const res = await send({ type: 'setSettings', settings: patch });
  if (res && res.ok && res.settings) return mergeSettings(res.settings);
  // 回退：本地合并后直接写 storage（background 的 onChanged 会同步规则集）
  const next = mergeSettings({
    ...state,
    ...patch,
    rulesets: { ...(state ? state.rulesets : DEFAULTS.rulesets), ...(patch.rulesets || {}) },
    stats: { ...(state ? state.stats : DEFAULTS.stats), ...(patch.stats || {}) },
  });
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (err) {
    console.warn('[AdCleaner] 保存设置失败：', err);
  }
  return next;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function render() {
  if (!state) return;
  el.enabled.checked = state.enabled;

  const todayCount = state.stats.date === today() ? state.stats.dom : 0;
  el.statToday.textContent = todayCount > 999 ? '999+' : String(todayCount);

  const paused = isWhitelisted(currentHost, state.whitelist);
  if (!state.enabled) {
    el.status.textContent = '已全局关闭';
    el.status.className = 'status off';
  } else if (paused) {
    el.status.textContent = currentHost ? `已暂停：${currentHost}` : '已暂停此站点';
    el.status.className = 'status off';
  } else {
    el.status.textContent = currentHost ? `保护中：${currentHost}` : '保护中';
    el.status.className = 'status on';
  }

  el.pauseSite.textContent = paused ? '恢复在此网站' : '暂停在此网站';
  el.pauseSite.classList.toggle('paused', paused);
  el.pauseSite.disabled = !currentHost;
  el.siteTip.textContent = currentHost
    ? '「暂停」会把当前域名加入白名单，该站点不再隐藏任何元素、不再拦截视频广告。'
    : '当前标签页不是普通网页（浏览器内部页面或本地文件），无法加入白名单。';

  for (const input of el.rulesets.querySelectorAll('input[data-ruleset]')) {
    const id = input.getAttribute('data-ruleset');
    input.checked = Boolean(state.rulesets[id]);
    input.disabled = !state.enabled;
  }
}

function buildRulesetList() {
  const frag = document.createDocumentFragment();
  for (const item of RULESETS) {
    const li = document.createElement('li');

    const label = document.createElement('div');
    label.className = 'label';
    const b = document.createElement('b');
    b.textContent = item.label;
    const span = document.createElement('span');
    span.textContent = item.desc;
    span.title = item.desc;
    label.append(b, span);

    const sw = document.createElement('label');
    sw.className = 'switch small';
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.setAttribute('data-ruleset', item.id);
    input.setAttribute('aria-label', item.label);
    const slider = document.createElement('span');
    slider.className = 'slider';
    sw.append(input, slider);

    input.addEventListener('change', async () => {
      const rulesets = { ...state.rulesets, [item.id]: input.checked };
      state = await savePatch({ rulesets });
      render();
    });

    li.append(label, sw);
    frag.append(li);
  }
  el.rulesets.textContent = '';
  el.rulesets.append(frag);
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

el.enabled.addEventListener('change', async () => {
  state = await savePatch({ enabled: el.enabled.checked });
  render();
});

el.pauseSite.addEventListener('click', async () => {
  if (!state || !currentHost) return;
  const paused = isWhitelisted(currentHost, state.whitelist);
  const whitelist = paused
    ? state.whitelist.filter((d) => currentHost !== d && !currentHost.endsWith('.' + d))
    : [...state.whitelist, currentHost];
  state = await savePatch({ whitelist });
  render();
});

el.openOptions.addEventListener('click', () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (err) {
    console.warn('[AdCleaner] 打开选项页失败：', err);
  }
});

// storage 变化时（例如选项页改动）同步刷新
try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes || !changes[STORAGE_KEY]) return;
    state = mergeSettings(changes[STORAGE_KEY].newValue);
    render();
  });
} catch (err) {
  console.warn('[AdCleaner] 监听 storage 失败：', err);
}

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

async function init() {
  buildRulesetList();
  try {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const url = tabs && tabs[0] && tabs[0].url ? tabs[0].url : '';
    if (/^https?:/i.test(url)) {
      try {
        currentHost = normalizeDomain(new URL(url).hostname);
      } catch {
        currentHost = '';
      }
    }
  } catch (err) {
    console.warn('[AdCleaner] 读取当前标签页失败：', err);
  }
  state = await loadSettings();
  render();
}

init();
