/**
 * AdCleaner 清道夫 —— 选项页逻辑
 * -----------------------------------------------------------------------------
 * 功能：规则集开关 + 说明、来源/许可表（读 rulesets/_sources.json）、白名单编辑、
 *       视频/弹窗激进模式、清空统计、设置导出/导入。
 * 与后台交互：读走 {type:"getState"}，写走 {type:"setSettings"}（消息失败时回退 storage）。
 * 无内联脚本、无远程资源、无第三方库；所有插入 DOM 的文本均用 textContent。
 */

'use strict';

const STORAGE_KEY = 'adcleaner.settings';

const RULESETS = [
  { id: 'base', label: '基础规则（base）', desc: 'Peter Lowe 广告/追踪服务器列表 + uBlock Origin badware + SPEC 4.4 种子域名' },
  { id: 'cn', label: '中文规则（cn）', desc: 'AdGuard Chinese MV3 变体（已含 EasyList China）' },
  { id: 'annoyances', label: '干扰元素（annoyances）', desc: 'CJX List：浮层、引导下载、Cookie 提示、反广告拦截对抗' },
  { id: 'popups', label: '弹窗域名（popups）', desc: '手写：popunder 落地域 block main_frame + 弹窗脚本路径' },
  { id: 'video', label: '视频广告（video）', desc: '手写：爱奇艺/优酷/芒果/搜狐/乐视/腾讯/B站广告域 + 播放器 SDK 放行' },
  { id: 'tracking', label: 'URL 跟踪参数（tracking）', desc: 'AdGuard URL Tracking：重定向剥离 utm_*、gclid 等参数' },
];

const el = {
  toast: document.getElementById('toast'),
  enabled: document.getElementById('enabled'),
  videoAggressive: document.getElementById('videoAggressive'),
  popupAggressive: document.getElementById('popupAggressive'),
  statLine: document.getElementById('stat-line'),
  clearStats: document.getElementById('clear-stats'),
  rulesets: document.getElementById('rulesets'),
  whitelist: document.getElementById('whitelist'),
  whitelistHint: document.getElementById('whitelist-hint'),
  saveWhitelist: document.getElementById('save-whitelist'),
  sources: document.getElementById('sources'),
  settingsJson: document.getElementById('settings-json'),
  exportSettings: document.getElementById('export-settings'),
  importSettings: document.getElementById('import-settings'),
  importHint: document.getElementById('import-hint'),
};

let state = null;

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

function mergeSettings(raw) {
  const src = raw && typeof raw === 'object' ? raw : {};
  const rulesets = { base: true, cn: true, annoyances: true, popups: true, video: true, tracking: true };
  const srcRulesets = src.rulesets && typeof src.rulesets === 'object' ? src.rulesets : {};
  for (const id of Object.keys(rulesets)) {
    if (typeof srcRulesets[id] === 'boolean') rulesets[id] = srcRulesets[id];
  }
  const srcStats = src.stats && typeof src.stats === 'object' ? src.stats : {};
  const sameDay = srcStats.date === today();
  return {
    enabled: typeof src.enabled === 'boolean' ? src.enabled : true,
    whitelist: Array.isArray(src.whitelist) ? src.whitelist.filter((d) => typeof d === 'string') : [],
    rulesets,
    videoAggressive: typeof src.videoAggressive === 'boolean' ? src.videoAggressive : false,
    popupAggressive: typeof src.popupAggressive === 'boolean' ? src.popupAggressive : false,
    stats: { date: sameDay ? srcStats.date : today(), dom: sameDay && Number.isFinite(Number(srcStats.dom)) ? Math.max(0, Math.floor(Number(srcStats.dom))) : 0 },
  };
}

let toastTimer = null;
function toast(text, isError) {
  el.toast.textContent = text;
  el.toast.classList.add('show');
  el.toast.style.color = isError ? 'var(--warn)' : 'var(--ok)';
  if (toastTimer) clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 2200);
}

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
  try {
    const got = await chrome.storage.local.get(STORAGE_KEY);
    return mergeSettings(got && got[STORAGE_KEY]);
  } catch {
    return mergeSettings(null);
  }
}

async function savePatch(patch) {
  const res = await send({ type: 'setSettings', settings: patch });
  if (res && res.ok && res.settings) {
    state = mergeSettings(res.settings);
    return state;
  }
  const next = mergeSettings({
    ...state,
    ...patch,
    rulesets: { ...(state ? state.rulesets : {}), ...(patch.rulesets || {}) },
    stats: { ...(state ? state.stats : {}), ...(patch.stats || {}) },
  });
  try {
    await chrome.storage.local.set({ [STORAGE_KEY]: next });
  } catch (err) {
    console.warn('[AdCleaner] 直接写 storage 失败：', err);
  }
  state = next;
  return next;
}

// ---------------------------------------------------------------------------
// 渲染
// ---------------------------------------------------------------------------

function buildRulesetList() {
  const frag = document.createDocumentFragment();
  for (const item of RULESETS) {
    const li = document.createElement('li');

    const text = document.createElement('div');
    const b = document.createElement('b');
    b.textContent = item.label;
    const span = document.createElement('span');
    span.className = 'muted';
    span.textContent = item.desc;
    text.append(b, span);

    const sw = document.createElement('label');
    sw.className = 'switch';
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

    li.append(text, sw);
    frag.append(li);
  }
  el.rulesets.textContent = '';
  el.rulesets.append(frag);
}

function render() {
  if (!state) return;
  el.enabled.checked = state.enabled;
  el.videoAggressive.checked = state.videoAggressive;
  el.popupAggressive.checked = state.popupAggressive;

  const todayCount = state.stats.date === today() ? state.stats.dom : 0;
  el.statLine.textContent = `今日已拦截 ${todayCount > 999 ? '999+' : todayCount} 次（含隐藏元素与视频广告动作）。`;

  for (const input of el.rulesets.querySelectorAll('input[data-ruleset]')) {
    const id = input.getAttribute('data-ruleset');
    input.checked = Boolean(state.rulesets[id]);
    input.disabled = !state.enabled;
  }

  // 白名单文本框：仅在未聚焦时覆盖，避免正在输入时被打断
  if (document.activeElement !== el.whitelist) {
    el.whitelist.value = state.whitelist.join('\n');
  }
  el.whitelistHint.textContent = `当前白名单 ${state.whitelist.length} 个域名`;
}

// ---------------------------------------------------------------------------
// 来源 / 许可表
// ---------------------------------------------------------------------------

function textCell(text, className) {
  const td = document.createElement('td');
  td.textContent = text;
  if (className) td.className = className;
  return td;
}

function statusBadge(status) {
  const span = document.createElement('span');
  const ok = status === 'OK' || status === 'OK_CACHED' || status === 'HANDWRITTEN' || status === 'SEED_APPENDED';
  span.className = 'badge ' + (ok ? 'ok' : 'warn');
  span.textContent = status || '未知';
  return span;
}

function renderSources(data) {
  el.sources.textContent = '';
  const files = Array.isArray(data.files) ? data.files : [];
  const sources = Array.isArray(data.sources) ? data.sources : Array.isArray(data) ? data : [];

  // 1) 文件汇总
  if (files.length) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const [label, cls] of [['文件', ''], ['规则数', 'num'], ['正则', 'num'], ['体积', 'num'], ['状态', '']]) {
      const th = document.createElement('th');
      th.textContent = label;
      if (cls) th.className = cls;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const f of files) {
      const tr = document.createElement('tr');
      tr.append(textCell(String(f.file || f.rulesetId || '')));
      tr.append(textCell(String(f.rules || 0), 'num'));
      tr.append(textCell(String(f.regexRules || 0), 'num'));
      tr.append(textCell(`${f.humanSizeKB || 0} KB`, 'num'));
      const td = document.createElement('td');
      td.append(statusBadge(f.fallback ? 'FALLBACK' : f.handwritten ? 'HANDWRITTEN' : 'OK'));
      tr.append(td);
      tbody.append(tr);
    }
    table.append(tbody);
    el.sources.append(table);
  }

  // 2) 来源明细
  if (sources.length) {
    const table = document.createElement('table');
    const thead = document.createElement('thead');
    const hr = document.createElement('tr');
    for (const label of ['规则集', '来源 / 许可', '规则数', '抓取时间', '状态']) {
      const th = document.createElement('th');
      th.textContent = label;
      hr.append(th);
    }
    thead.append(hr);
    table.append(thead);

    const tbody = document.createElement('tbody');
    for (const s of sources) {
      const tr = document.createElement('tr');
      tr.append(textCell(String(s.file || '-')));
      const td = document.createElement('td');
      const b = document.createElement('b');
      b.textContent = s.name || s.sourceUrl || '-';
      const lic = document.createElement('div');
      lic.className = 'muted';
      lic.textContent = `许可：${s.license || '未标注'}`;
      const url = document.createElement('code');
      url.textContent = String(s.sourceUrl || '');
      td.append(b, lic, url);
      tr.append(td);
      tr.append(textCell(String(s.ruleCount === undefined ? '-' : s.ruleCount), 'num'));
      tr.append(textCell(String(s.fetchedAt || '-').replace('T', ' ').replace('Z', '')));
      const std = document.createElement('td');
      std.append(statusBadge(s.status));
      tr.append(std);
      tbody.append(tr);
    }
    table.append(tbody);
    el.sources.append(table);
  }

  // 3) 生成信息 / 失败说明
  const meta = document.createElement('p');
  meta.className = 'muted';
  const generated = data && data.generatedAt ? String(data.generatedAt) : '未知';
  const converter = data && data.converter ? String(data.converter) : '未知';
  const failures = data && Array.isArray(data.failures) ? data.failures : [];
  meta.textContent =
    `生成时间：${generated}　转换器：${converter}　` +
    (failures.length ? `⚠ ${failures.length} 个来源失败（已用种子兜底，详见 _sources.json）` : '所有来源抓取/转换正常');
  el.sources.append(meta);

  if (!files.length && !sources.length) {
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = '未读到规则集信息，请先运行 npm run build:rules 生成 extension/rulesets/_sources.json。';
    el.sources.append(p);
  }
}

async function loadSources() {
  try {
    const url = chrome.runtime.getURL('rulesets/_sources.json');
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    renderSources(await res.json());
  } catch (err) {
    el.sources.textContent = '';
    const p = document.createElement('p');
    p.className = 'muted';
    p.textContent = `读取 rulesets/_sources.json 失败：${err && err.message ? err.message : err}`;
    el.sources.append(p);
  }
}

// ---------------------------------------------------------------------------
// 事件
// ---------------------------------------------------------------------------

el.enabled.addEventListener('change', async () => {
  state = await savePatch({ enabled: el.enabled.checked });
  render();
  toast('已保存');
});

el.videoAggressive.addEventListener('change', async () => {
  state = await savePatch({ videoAggressive: el.videoAggressive.checked });
  render();
  toast(el.videoAggressive.checked ? '已开启视频激进模式（可能误伤，请观察）' : '已关闭视频激进模式');
});

el.popupAggressive.addEventListener('change', async () => {
  state = await savePatch({ popupAggressive: el.popupAggressive.checked });
  render();
  toast(el.popupAggressive.checked ? '已开启弹窗激进模式' : '已关闭弹窗激进模式');
});

el.saveWhitelist.addEventListener('click', async () => {
  const lines = el.whitelist.value.split(/[\n,;，；\s]+/);
  const valid = [];
  const seen = new Set();
  let dropped = 0;
  for (const line of lines) {
    if (!line.trim()) continue;
    const d = normalizeDomain(line);
    if (!d) {
      dropped += 1;
      continue;
    }
    if (seen.has(d)) continue;
    seen.add(d);
    valid.push(d);
  }
  state = await savePatch({ whitelist: valid });
  render();
  toast(`已保存 ${valid.length} 个域名${dropped ? `（忽略 ${dropped} 条非法输入）` : ''}`, dropped > 0);
});

el.clearStats.addEventListener('click', async () => {
  state = await savePatch({ stats: { date: today(), dom: 0 } });
  render();
  toast('今日统计已清空');
});

el.exportSettings.addEventListener('click', () => {
  const payload = {
    enabled: state.enabled,
    whitelist: state.whitelist,
    rulesets: state.rulesets,
    videoAggressive: state.videoAggressive,
    popupAggressive: state.popupAggressive,
  };
  el.settingsJson.value = JSON.stringify(payload, null, 2);
  el.importHint.textContent = '已导出到文本框，可复制保存。';
  toast('已导出');
});

el.importSettings.addEventListener('click', async () => {
  const text = el.settingsJson.value.trim();
  if (!text) {
    el.importHint.textContent = '文本框为空，请先粘贴要导入的 JSON。';
    toast('导入失败：内容为空', true);
    return;
  }
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    el.importHint.textContent = `JSON 解析失败：${err && err.message ? err.message : err}`;
    toast('导入失败：JSON 非法', true);
    return;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    el.importHint.textContent = '导入内容必须是 JSON 对象。';
    toast('导入失败：格式不对', true);
    return;
  }
  const allowed = {};
  for (const key of ['enabled', 'whitelist', 'rulesets', 'videoAggressive', 'popupAggressive']) {
    if (key in parsed) allowed[key] = parsed[key];
  }
  if (!Object.keys(allowed).length) {
    el.importHint.textContent = '没有可导入的字段（支持 enabled / whitelist / rulesets / videoAggressive / popupAggressive）。';
    toast('导入失败：无有效字段', true);
    return;
  }
  if (Array.isArray(allowed.whitelist)) {
    allowed.whitelist = allowed.whitelist.map(normalizeDomain).filter(Boolean);
  }
  state = await savePatch(allowed);
  render();
  el.importHint.textContent = '导入完成，设置已生效。';
  toast('已导入并生效');
});

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

(async function init() {
  buildRulesetList();
  state = await loadSettings();
  render();
  await loadSources();
})();
