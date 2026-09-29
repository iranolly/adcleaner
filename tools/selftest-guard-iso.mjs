/* AdCleaner tools/selftest-guard-iso.mjs —— guard-iso.js 桩 DOM 自测（交付物）
 * =============================================================================
 * 运行：node tools/selftest-guard-iso.mjs   （或 npm test 的第一段）
 * 对象：extension/src/content/guard-iso.js（真实交付源码，vm 沙箱内执行）
 * 覆盖：
 *   S6/S11 P0 回归：同一 video 元素连续两个广告片段都能精确还原 rate/muted；
 *       安全阀第 2 次超时同样强制还原（touchedVideos 每次进入广告态都要重新登记）。
 *   S4/S5   P1-2/P3：被我们自己的 CSS 遮住的非空广告触发；隐藏层内空容器不触发。
 *   S12     P3：可见但为空的广告容器不再误判（可见分支同样要求非空）。
 *   S1/S2   P1-1 设置桥（无条件广播 / 字段封闭 / 白名单）。
 *   S3/S9/S10 正常启动/迟到回调/强弱广告态回归。
 *   S7/S8   P3 生命周期：stopAll 撤销全部注入与监听（含 stats 的 visibilitychange/pagehide），
 *       无需刷新即可恢复，重复开启幂等。
 * 说明：桩用「注入的 display:none 样式」真实模拟我们自己的 CSS 隐藏效果（_cssHidden 标记），
 *       因此隐藏层判定走的是与浏览器一致的 getComputedStyle/offsetParent 路径。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDom, createClock, getComputedStyle, makeEl, refreshCssHidden } from './stub-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GUARD = path.join(ROOT, 'extension/src/content/guard-iso.js');
const guardCode = await readFile(GUARD, 'utf8');

let checks = 0;
let failures = 0;
function check(name, cond, extra) {
  checks++;
  const mark = cond ? '✓' : '✗';
  if (!cond) failures++;
  console.log(`  ${mark} ${name}${cond ? '' : '   [' + (extra === undefined ? '' : extra) + ']'}`);
}
function el(tag, opts) { return makeEl(tag, opts.doc, opts); }

/* ------------------------------------------------------------------ 环境搭建 */
async function boot(opts) {
  const env = {
    hostname: opts.hostname || 'video.example',
    href: opts.href || 'https://video.example/watch',
    settings: opts.settings,
    messages: [],
    stats: [],
    logs: [],
    windowListeners: {}
  };
  const dom = createDom();
  env.dom = dom;
  const clock = createClock(1700000000000, (e) => console.log('  ! 定时器回调异常：', e && e.message));
  env.clock = clock;

  const observers = [];
  class MutationObserver {
    constructor(cb) { this.cb = cb; this.connected = false; }
    observe() { this.connected = true; observers.push(this); }
    disconnect() { this.connected = false; }
    takeRecords() { return []; }
  }
  env.connectedObservers = () => observers.filter((o) => o.connected).length;

  const chromeStub = {
    runtime: {
      getURL: (p) => 'chrome-extension://adcleaner-test/' + p,
      sendMessage: (msg, cb) => { env.stats.push(msg); try { if (cb) cb(); } catch (e) { /* 忽略 */ } },
      lastError: null
    },
    storage: {
      local: { get: (key) => Promise.resolve({ [key]: env.settings }) },
      onChanged: { addListener: (fn) => { env.onChanged = fn; } }
    }
  };

  const win = {
    postMessage: (msg, target) => { env.messages.push({ msg, target }); },
    addEventListener: (type, fn) => { (env.windowListeners[type] = env.windowListeners[type] || []).push(fn); },
    removeEventListener: (type, fn) => {
      const l = env.windowListeners[type] || [];
      const i = l.indexOf(fn);
      if (i >= 0) l.splice(i, 1);
    }
  };

  const sandbox = {
    console: {
      debug: function () { env.logs.push(Array.prototype.slice.call(arguments)); },
      log: () => { }, warn: () => { }, error: () => { }
    },
    window: win,
    document: dom,
    location: { hostname: env.hostname, href: env.href },
    getComputedStyle,
    MutationObserver,
    fetch: (url) => {
      const u = String(url);
      if (u.includes('cosmetics.json')) {
        env.cosmeticsFetchCount = (env.cosmeticsFetchCount || 0) + 1;
        if (opts.deferFirstCosmeticsFetch && env.cosmeticsFetchCount === 1) {
          return new Promise((resolve) => { env.resolveCosmetics = () => resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.cosmetics) }); });
        }
        return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.cosmetics) });
      }
      if (u.includes('video-sites.json')) return Promise.resolve({ ok: true, status: 200, json: () => Promise.resolve(opts.videoSites) });
      return Promise.resolve({ ok: false, status: 404 });
    },
    chrome: chromeStub,
    setTimeout: (fn, d) => clock.setTimeout(fn, d),
    clearTimeout: (id) => clock.clear(id),
    setInterval: (fn, d) => clock.setInterval(fn, d),
    clearInterval: (id) => clock.clear(id),
    Date: { now: () => clock.now() }
  };
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(guardCode, sandbox, { filename: 'guard-iso.js' });

  env.flush = async (rounds = 25) => {
    for (let i = 0; i < rounds; i++) await new Promise((r) => setImmediate(r));
    refreshCssHidden(dom);      // 回放我们注入的 CSS：隐藏层在 getComputedStyle 下真实变“不可见”
  };
  env.step = async (ms) => { await env.flush(3); clock.advance(ms); await env.flush(5); };
  env.setSettings = async (next) => {
    const prev = env.settings;
    env.settings = next;
    if (env.onChanged) env.onChanged({ 'adcleaner.settings': { oldValue: prev, newValue: next } }, 'local');
    await env.flush();
  };
  env.styles = () => dom.all().filter((e) => e.tagName === 'STYLE' && e.getAttribute('data-adcleaner') === '1');
  env.injectedCss = () => env.styles().map((s) => s.textContent).join('\n');
  return env;
}

/* ------------------------------------------------------------------ 场景数据 */
const COSMETICS = {
  version: 'selftest',
  groups: [{ hosts: ['video.example'], source: 'selftest', selectors: ['.video-ads'], note: '' }]
};
const VIDEO = {
  sites: {
    'video.example': {
      video: 'video',
      adState: ['.ad-showing'],
      skip: [],
      pauseAd: { containers: [], close: [] },
      maxAdSeconds: 600,
      actions: ['mute', 'speed', 'seek']
    }
  },
  generic: { video: 'video', adState: [], skip: [], pauseAd: { containers: [], close: [] }, maxAdSeconds: 180, actions: ['mute', 'speed'] }
};
const DEFAULT_SETTINGS = { enabled: true, whitelist: [], popupAggressive: false, videoAggressive: false };
const cfgWith = (maxAdSeconds, actions) => ({
  sites: { 'video.example': Object.assign({}, VIDEO.sites['video.example'], { maxAdSeconds, actions }) },
  generic: VIDEO.generic
});

function buildPage(env, { adText = 'AD 广告', adTag = 'div', hidden = true } = {}) {
  const dom = env.dom;
  const wrap = el('div', { doc: dom, className: 'video-ads' });
  const adEl = el(adTag, { doc: dom, className: 'ad-showing' });
  if (adText) adEl.textContent = adText;
  wrap.appendChild(adEl);
  const video = el('video', { doc: dom });
  video.duration = 4;
  video.currentTime = 0;
  video.paused = false;
  if (adText) {
    const adInner = el('span', { doc: dom });
    adInner.textContent = adText;
    adEl.appendChild(adInner);
  }
  dom.body.appendChild(video);
  dom.body.appendChild(wrap);
  if (hidden) wrap._cssHidden = true;      // 模拟我们注入的 CSS 已经隐藏该层
  return { video, wrap, adEl };
}

async function scenario(label, fn) {
  console.log('\n' + label);
  const saved = console.log;
  try { await fn(); } catch (e) { failures++; saved('  ✗ 场景异常：' + (e && e.stack ? e.stack : e)); }
}

/* --- S1 设置桥：关闭状态也广播，字段封闭 --- */
await scenario('S1 设置桥：enabled=false 时无条件广播，且只含 3 个布尔', async () => {
  const env = await boot({
    settings: { enabled: false, whitelist: ['other.com'], popupAggressive: true, videoAggressive: true, rulesets: { base: true } },
    cosmetics: COSMETICS, videoSites: VIDEO
  });
  await env.flush();
  check('启动时恰好广播 1 次', env.messages.length === 1, 'n=' + env.messages.length);
  const { msg, target } = env.messages[0];
  check('tag === adcleaner.settings', msg.tag === 'adcleaner.settings', JSON.stringify(msg));
  check('enabled=false 原样广播', msg.enabled === false, String(msg.enabled));
  check('popupAggressive=true 原样广播', msg.popupAggressive === true, String(msg.popupAggressive));
  check('whitelisted=false（本站点不在白名单）', msg.whitelisted === false, String(msg.whitelisted));
  check('target 为 *', target === '*', String(target));
  check('字段封闭：只有 tag + 3 个布尔', JSON.stringify(Object.keys(msg).sort()) === JSON.stringify(['enabled', 'popupAggressive', 'tag', 'whitelisted']), JSON.stringify(Object.keys(msg)));
  check('不泄露其他设置（无 whitelist/rulesets/videoAggressive/stats）', !('whitelist' in msg) && !('rulesets' in msg) && !('videoAggressive' in msg) && !('stats' in msg));
  check('关闭状态不注入任何样式', env.styles().length === 0, 'n=' + env.styles().length);
});

/* --- S2 设置桥：白名单站点 --- */
await scenario('S2 设置桥：命中白名单也广播（whitelisted=true）且不注入', async () => {
  const env = await boot({ settings: { enabled: true, whitelist: ['example'], popupAggressive: false }, cosmetics: COSMETICS, videoSites: VIDEO });
  await env.flush();
  const m = env.messages[0].msg;
  check('whitelisted=true（后缀匹配 example ⊃ video.example）', m.whitelisted === true, JSON.stringify(m));
  check('enabled=true', m.enabled === true);
  check('白名单站点不注入样式', env.styles().length === 0, 'n=' + env.styles().length);
  check('恰好广播 1 次', env.messages.length === 1, 'n=' + env.messages.length);
});

/* --- S3 正常启动 + cosmetics 注入 --- */
await scenario('S3 正常启动：广播 enabled=true/whitelisted=false 并注入 cosmetics', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: VIDEO });
  await env.flush();
  const m = env.messages[0].msg;
  check('enabled=true & whitelisted=false', m.enabled === true && m.whitelisted === false, JSON.stringify(m));
  check('注入了 .video-ads{display:none !important}', env.injectedCss().includes('.video-ads{display:none !important}'), env.injectedCss().slice(0, 120));
  check('后台统计消息存在 domBlocked 类型', env.stats.every((s) => s.type === 'domBlocked'));
});

/* --- S4 P1-2/P3：隐藏层内的非空广告触发 --- */
await scenario('S4 P1-2：被我们 CSS 遮住的非空广告层也能触发静音 + 16x + seek', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: VIDEO });
  const { video, wrap } = buildPage(env);
  await env.flush();
  check('前置条件：广告层被我们注入的 CSS 判为不可见', getComputedStyle(wrap).display === 'none');
  check('前置条件：隐藏层内元素 isVisible=false（旧逻辑会失灵）', wrap.offsetParent === null);
  await env.step(600);
  check('video.muted === true', video.muted === true, 'muted=' + video.muted);
  check('video.playbackRate === 16', video.playbackRate === 16, 'rate=' + video.playbackRate);
  check('actions 含 seek 时 seek 到广告末尾', Math.abs(video.currentTime - 3.9) < 0.01, 'currentTime=' + video.currentTime);
});

/* --- S5 P1-2/P3：隐藏层内的空容器不误伤 --- */
await scenario('S5 P1-2/P3：被隐藏的空广告容器（无子元素/无文本）不触发任何动作', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: VIDEO });
  const { video, adEl } = buildPage(env, { adText: '' });
  await env.flush();
  check('前置条件：广告容器为空', adEl.children.length === 0 && adEl.textContent.trim() === '');
  await env.step(1200);
  check('未静音', video.muted === false, 'muted=' + video.muted);
  check('未加速', video.playbackRate === 1, 'rate=' + video.playbackRate);
  check('未 seek', video.currentTime === 0, 'currentTime=' + video.currentTime);
});

/* --- S6 P1-2 安全阀：第 1/2 次超时都要能强制还原 --- */
await scenario('S6 P1-2 安全阀：强广告态超时→强制还原+忽略，选择器消失后重现才恢复；第 2 次超时同样还原', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: cfgWith(1, ['mute', 'speed']) });
  const { video, wrap, adEl } = buildPage(env);
  await env.flush();
  await env.step(600);
  check('超时前已进入广告处理（静音+16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  await env.step(1500);            // 强广告态连续存在 > maxAdSeconds(1s)
  check('第 1 次超时后强制还原静音', video.muted === false, 'muted=' + video.muted);
  check('第 1 次超时后强制还原倍速', video.playbackRate === 1, 'rate=' + video.playbackRate);
  await env.step(4000);
  check('忽略期间不再改 video（防正片永久 16x）', video.muted === false && video.playbackRate === 1, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  wrap.removeChild(adEl);           // 选择器消失
  await env.step(600);
  const adEl2 = el('div', { doc: env.dom, className: 'ad-showing' });
  adEl2.textContent = 'AD again';
  wrap.appendChild(adEl2);
  await env.step(600);
  check('选择器消失后再次出现 → 恢复广告处理（静音+16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  await env.step(1500);             // 第 2 次超时（P0 修复点：touchedVideos 必须在第 2 个片段重新登记）
  check('第 2 次超时后同样强制还原静音', video.muted === false, 'muted=' + video.muted);
  check('第 2 次超时后同样强制还原倍速', video.playbackRate === 1, 'rate=' + video.playbackRate);
  await env.step(2000);
  check('第 2 次忽略期间同样不再改 video', video.muted === false && video.playbackRate === 1, 'muted=' + video.muted + ' rate=' + video.playbackRate);
});

/* --- S7 P3：停止/恢复，无需刷新 --- */
await scenario('S7 P3 生命周期：关闭→stopAll 完整撤销（含 stats 监听）；重新开启→不刷新即恢复；重复开启不重复注册', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: VIDEO });
  const { video, adEl } = buildPage(env);
  await env.flush();
  await env.step(600);
  check('运行中：注入样式存在', env.styles().length >= 1, 'n=' + env.styles().length);
  check('运行中：广告态已处理', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted);
  const intervalsRunning = env.clock.count(true);
  check('运行中：有活动 interval', intervalsRunning === 3, 'n=' + intervalsRunning);
  const observInterval = intervalsRunning;
  check('运行中：stats 监听已注册（visibilitychange/pagehide 各 1）',
    (env.dom._listeners.visibilitychange || []).length === 1 && (env.windowListeners.pagehide || []).length === 1,
    'vis=' + (env.dom._listeners.visibilitychange || []).length + ' pagehide=' + (env.windowListeners.pagehide || []).length);

  await env.setSettings({ enabled: false, whitelist: [], popupAggressive: false });
  check('关闭后广播第 2 次且 enabled=false', env.messages.length === 2 && env.messages[1].msg.enabled === false, JSON.stringify(env.messages.map((m) => m.msg)));
  check('关闭后注入样式全部移除', env.styles().length === 0, 'n=' + env.styles().length);
  check('关闭后 interval 全部断开', env.clock.count(true) === 0, 'n=' + env.clock.count(true));
  check('关闭后 MutationObserver 全部断开', env.connectedObservers() === 0, 'n=' + env.connectedObservers());
  check('关闭后 stats 的 visibilitychange 监听被移除', (env.dom._listeners.visibilitychange || []).length === 0, 'n=' + (env.dom._listeners.visibilitychange || []).length);
  check('关闭后 stats 的 pagehide 监听被移除', (env.windowListeners.pagehide || []).length === 0, 'n=' + (env.windowListeners.pagehide || []).length);
  video.muted = false; video.playbackRate = 1;
  await env.step(1500);
  check('关闭后即使有强广告态也不动 video', video.muted === false && video.playbackRate === 1, 'muted=' + video.muted + ' rate=' + video.playbackRate);

  await env.setSettings({ enabled: true, whitelist: [], popupAggressive: false, videoAggressive: false });
  check('重新开启后广播第 3 次且 enabled=true', env.messages.length === 3 && env.messages[2].msg.enabled === true, JSON.stringify(env.messages.map((m) => m.msg)));
  check('重新开启后样式重新注入（无需刷新）', env.styles().length >= 1, 'n=' + env.styles().length);
  check('重新开启后 interval 恢复为 3', env.clock.count(true) === observInterval, 'n=' + env.clock.count(true));
  check('重新开启后 stats 监听重新注册（各 1，无重复泄漏）',
    (env.dom._listeners.visibilitychange || []).length === 1 && (env.windowListeners.pagehide || []).length === 1,
    'vis=' + (env.dom._listeners.visibilitychange || []).length + ' pagehide=' + (env.windowListeners.pagehide || []).length);
  await env.step(600);
  check('重新开启后广告态处理恢复（静音+16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);

  const stylesAfterRestart = env.styles().length;
  await env.setSettings({ enabled: true, whitelist: [], popupAggressive: false, videoAggressive: false });
  check('重复开启幂等：不重复注入样式', env.styles().length === stylesAfterRestart, stylesAfterRestart + ' -> ' + env.styles().length);
  check('重复开启幂等：不重复注册 interval', env.clock.count(true) === observInterval, 'n=' + env.clock.count(true));
  check('重复开启幂等：不重复注册 observer', env.connectedObservers() <= 2, 'n=' + env.connectedObservers());
  check('每次设置变化都重发设置桥消息', env.messages.length === 4, 'n=' + env.messages.length);
  check('切换成白名单也能撤销注入', await (async () => {
    await env.setSettings({ enabled: true, whitelist: ['video.example'], popupAggressive: false });
    return env.styles().length === 0 && env.messages[4].msg.whitelisted === true;
  })());
  void adEl;
});

/* --- S8 停止即还原：广告态中途关闭 → video 状态还原 --- */
await scenario('S8 生命周期：广告态中途关闭时精确还原用户状态', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: cfgWith(600, ['mute', 'speed']) });
  const { video } = buildPage(env);
  await env.flush();
  await env.step(600);
  check('进入广告态', video.muted === true && video.playbackRate === 16);
  await env.setSettings({ enabled: false, whitelist: [], popupAggressive: false });
  await env.step(1500);
  check('关闭后静音被还原', video.muted === false, 'muted=' + video.muted);
  check('关闭后倍速被还原', video.playbackRate === 1, 'rate=' + video.playbackRate);
});

/* --- S9 P3：stopAll 之后迟到的 cosmetics fetch 不得再注入 --- */
await scenario('S9 P3：stopAll 后迟到的 cosmetics 回调不再注入（无“复活”泄漏）', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: VIDEO, deferFirstCosmeticsFetch: true });
  await env.flush();
  check('前置条件：cosmetics fetch 尚未返回 → 无注入', env.styles().length === 0, 'n=' + env.styles().length);
  await env.setSettings({ enabled: false, whitelist: [], popupAggressive: false });
  env.resolveCosmetics();               // 迟到的数据到达
  await env.step(600);
  check('迟到回调未注入任何样式', env.styles().length === 0, 'n=' + env.styles().length);
  check('迟到回调未注册 interval', env.clock.count(true) === 0, 'n=' + env.clock.count(true));
  await env.setSettings({ enabled: true, whitelist: [], popupAggressive: false });
  await env.step(600);
  check('重新启用后正常注入（第二次 fetch 走同步路径）', env.styles().length >= 1, 'n=' + env.styles().length);
});

/* --- S10 回归：可见强/弱广告态行为不变 --- */
await scenario('S10 回归：可见的强广告态仍触发静音+16x；弱广告态仍然不动 video', async () => {
  const envStrong = await boot({
    settings: DEFAULT_SETTINGS, cosmetics: COSMETICS,
    videoSites: { sites: { 'video.example': Object.assign({}, VIDEO.sites['video.example'], { adState: ['.visible-ad'], maxAdSeconds: 600, actions: ['mute', 'speed'] }) }, generic: VIDEO.generic }
  });
  const v1 = el('video', { doc: envStrong.dom }); v1.duration = 4; v1.paused = false;
  const a1 = el('div', { doc: envStrong.dom, className: 'visible-ad' }); a1.textContent = 'AD';
  envStrong.dom.body.appendChild(v1); envStrong.dom.body.appendChild(a1);
  await envStrong.flush();
  check('前置条件：该广告层可见且不在我们的隐藏名单里', getComputedStyle(a1).display !== 'none' && envStrong.injectedCss().indexOf('.visible-ad') === -1);
  await envStrong.step(600);
  check('强广告态：静音+16x', v1.muted === true && v1.playbackRate === 16, 'muted=' + v1.muted + ' rate=' + v1.playbackRate);

  const envWeak = await boot({
    settings: DEFAULT_SETTINGS, cosmetics: COSMETICS,
    videoSites: { sites: { 'video.example': Object.assign({}, VIDEO.sites['video.example'], { adState: ['.ytp-ad-overlay-container'], maxAdSeconds: 600, actions: ['mute', 'speed'] }) }, generic: VIDEO.generic }
  });
  const v2 = el('video', { doc: envWeak.dom }); v2.duration = 4; v2.paused = false;
  const a2 = el('div', { doc: envWeak.dom, className: 'ytp-ad-overlay-container' }); a2.textContent = 'BANNER';
  envWeak.dom.body.appendChild(v2); envWeak.dom.body.appendChild(a2);
  await envWeak.flush();
  await envWeak.step(600);
  check('弱广告态：不动 video（仍交给 CSS 隐藏）', v2.muted === false && v2.playbackRate === 1, 'muted=' + v2.muted + ' rate=' + v2.playbackRate);
});

/* --- S11 P0 回归：同一 video 连续两个广告片段 --- */
await scenario('S11 P0 回归：同一 video 元素连续两个广告片段都能精确还原 rate/muted', async () => {
  const env = await boot({ settings: DEFAULT_SETTINGS, cosmetics: COSMETICS, videoSites: cfgWith(600, ['mute', 'speed']) });
  const { video, wrap, adEl } = buildPage(env);
  check('起点：用户状态为 rate=1 / muted=false', video.playbackRate === 1 && video.muted === false, 'rate=' + video.playbackRate);
  await env.flush();

  await env.step(600);
  check('片段 1：进入广告态（静音 + 16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  wrap.removeChild(adEl);
  await env.step(2200);            // 覆盖最坏情况：检测轮询 500ms + 随机还原延迟 1200ms（原 1500 会偶发抢跑）
  check('片段 1 结束：静音精确还原', video.muted === false, 'muted=' + video.muted);
  check('片段 1 结束：倍速精确还原', video.playbackRate === 1, 'rate=' + video.playbackRate);

  const adEl2 = el('div', { doc: env.dom, className: 'ad-showing' });
  adEl2.textContent = '第 2 个广告片段';
  wrap.appendChild(adEl2);
  await env.step(600);
  check('片段 2：同一 video 再次进入广告态（静音 + 16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  wrap.removeChild(adEl2);
  await env.step(2200);            // 同上：给“检测 + 随机延迟还原”留足窗口，消除测试抖动
  check('片段 2 结束：静音再次精确还原（P0 修复点）', video.muted === false, 'muted=' + video.muted);
  check('片段 2 结束：倍速再次精确还原（P0 修复点）', video.playbackRate === 1, 'rate=' + video.playbackRate);

  const adEl3 = el('div', { doc: env.dom, className: 'ad-showing' });
  adEl3.textContent = '第 3 个广告片段';
  wrap.appendChild(adEl3);
  await env.step(600);
  check('片段 3：仍能触发（登记逻辑不会退化为一次性）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  wrap.removeChild(adEl3);
  await env.step(2200);            // 同上
  check('片段 3 结束：仍能精确还原', video.muted === false && video.playbackRate === 1, 'muted=' + video.muted + ' rate=' + video.playbackRate);
});

/* --- S12 P3：可见但空的广告容器不误判 --- */
await scenario('S12 P3：可见但为空的广告容器不误判（可见分支同样要求非空）', async () => {
  const env = await boot({
    settings: DEFAULT_SETTINGS, cosmetics: COSMETICS,
    videoSites: { sites: { 'video.example': Object.assign({}, VIDEO.sites['video.example'], { adState: ['.visible-empty-ad'], maxAdSeconds: 600, actions: ['mute', 'speed'] }) }, generic: VIDEO.generic }
  });
  const v = el('video', { doc: env.dom }); v.duration = 4; v.paused = false;
  const a = el('div', { doc: env.dom, className: 'visible-empty-ad' });
  env.dom.body.appendChild(v); env.dom.body.appendChild(a);
  await env.flush();
  check('前置条件：容器可见且为空（isVisible=true，isNonEmpty=false）',
    getComputedStyle(a).display !== 'none' && a.offsetParent !== null && a.children.length === 0 && a.textContent.trim() === '',
    'display=' + getComputedStyle(a).display + ' children=' + a.children.length);
  await env.step(1200);
  check('可见空容器未导致静音（P3 修复点）', v.muted === false, 'muted=' + v.muted);
  check('可见空容器未导致加速（P3 修复点）', v.playbackRate === 1, 'rate=' + v.playbackRate);

  const inner = el('span', { doc: env.dom }); inner.textContent = 'AD';
  a.appendChild(inner);
  await env.step(600);
  check('同一容器补上内容后立即恢复触发（非空判定不是永久屏蔽）', v.muted === true && v.playbackRate === 16, 'muted=' + v.muted + ' rate=' + v.playbackRate);
});

console.log(`\n[selftest-guard-iso] ${checks - failures}/${checks} 通过` + (failures ? `，${failures} 失败` : '，全部通过'));
process.exit(failures ? 1 : 0);
