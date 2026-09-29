/* AdCleaner tools/selftest-userscript.mjs —— 油猴版自测（交付物）
 * =============================================================================
 * 运行：node tools/selftest-userscript.mjs   （或 npm test 的第二段；需先 `node tools/build-userscript.mjs`）
 * 对象：构建产物 userscript/adcleaner.user.js（真实交付物）
 * 覆盖：
 *   U1 弹窗 guard：无 __adcleanerProxy expando 泄漏 + 拦截/放行 + Function.prototype.toString 反指纹；
 *   U2 内联 CSS（cosmetic.css）与 COSMETICS 规则被完整注入；
 *   U3 白名单时整体不执行；
 *   U4 P1-2/P3：被我们 CSS 遮住的非空广告层触发静音/16x；隐藏层内空容器不触发；
 *   U5 P0 回归：同一 video 连续两个（三个）广告片段都能精确还原 rate/muted；
 *   U6 P1-2 安全阀：iqiyi(maxAdSeconds=300) 超时强制还原 + 忽略；第 2 次超时同样还原；
 *   另：静态断言油猴版仍无 chrome.* / settings 依赖。
 */
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createDom, createClock, getComputedStyle, makeEl, refreshCssHidden } from './stub-dom.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const USERSCRIPT = path.join(ROOT, 'userscript/adcleaner.user.js');
const COSMETIC_CSS = path.join(ROOT, 'extension/src/content/cosmetic.css');

const code = await readFile(USERSCRIPT, 'utf8');
const cssText = await readFile(COSMETIC_CSS, 'utf8');

let checks = 0, failures = 0;
function check(name, cond, extra) {
  checks++;
  if (!cond) failures++;
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '   [' + (extra === undefined ? '' : extra) + ']'}`);
}
function el(tag, doc, opts = {}) { return makeEl(tag, doc, opts); }

function boot({ hostname = 'www.youtube.com', whitelist = null } = {}) {
  const dom = createDom();
  const clock = createClock(1700000000000, (e) => console.log('  ! 定时器回调异常：', e && e.message));
  const opened = [];
  const store = new Map();
  if (whitelist !== null) store.set('adcleaner.whitelist', JSON.stringify(whitelist));
  const sandbox = {
    console: { debug: () => { }, log: () => { }, warn: () => { }, error: () => { } },
    document: dom,
    location: { hostname, href: 'https://' + hostname + '/watch?v=abc' },
    getComputedStyle,
    MutationObserver: class { constructor() { } observe() { } disconnect() { } takeRecords() { return []; } },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, String(v)),
      removeItem: (k) => store.delete(k)
    },
    // 浏览器里 window.open 是 window 的属性；这里同样放在全局
    open: function open(url) { opened.push(String(url)); return { url }; },
    setTimeout: (fn, d) => clock.setTimeout(fn, d),
    clearTimeout: (id) => clock.clear(id),
    setInterval: (fn, d) => clock.setInterval(fn, d),
    clearInterval: (id) => clock.clear(id),
    Date: { now: () => clock.now() },
    __opened: opened
  };
  sandbox.window = sandbox;                 // @grant none：window === globalThis
  sandbox.__origOpen = sandbox.open;        // 记录原生函数引用，供白名单场景比对
  sandbox.globalThis = sandbox;
  sandbox.window.addEventListener = () => { };
  sandbox.window.removeEventListener = () => { };
  vm.createContext(sandbox);
  vm.runInContext(code, sandbox, { filename: 'adcleaner.user.js' });
  const flush = async (n = 12) => {
    for (let i = 0; i < n; i++) await new Promise((r) => setImmediate(r));
    refreshCssHidden(dom);                  // 回放注入的 CSS：隐藏层在 getComputedStyle 下真实变“不可见”
  };
  const step = async (ms) => { await flush(3); clock.advance(ms); await flush(5); };
  return {
    sandbox, dom, clock, opened, flush, step,
    styles: () => dom.all().filter((e) => e.tagName === 'STYLE' && e.getAttribute('data-adcleaner') === '1')
  };
}

console.log('\nU1 弹窗 guard：无 expando 泄漏 + 拦截/放行行为 + 反指纹');
{
  const env = boot();
  await env.flush();
  const win = env.sandbox.window;
  check('window.open 已被代理（不再是原函数）', typeof win.open === 'function' && win.open !== env.sandbox.__origOpen);
  check('window.open 上没有 __adcleanerProxy own-property', Object.getOwnPropertyNames(win.open).indexOf('__adcleanerProxy') === -1,
    Object.getOwnPropertyNames(win.open).join(','));
  check('window.open.__adcleanerProxy === undefined', win.open.__adcleanerProxy === undefined, String(win.open.__adcleanerProxy));
  const blocked = win.open('https://ads.example.com/popunder.js?id=1');
  check('广告 popunder 被拦截并返回 null', blocked === null, String(blocked));
  check('被拦截时未调用原生 window.open', env.opened.length === 0, JSON.stringify(env.opened));
  const allowed = win.open('https://accounts.example.com/oauth?login=1', '_blank', 'width=600');
  check('登录弹窗被放行并转发参数', env.opened.length === 1 && env.opened[0].includes('oauth'), JSON.stringify(env.opened));
  check('放行时保留返回值', !!allowed);
  check('Function.prototype.toString.call(window.open) 反指纹', vm.runInContext('Function.prototype.toString.call(window.open)', env.sandbox) === 'function open() { [native code] }',
    vm.runInContext('Function.prototype.toString.call(window.open)', env.sandbox));
  check('String(Function.prototype.toString) 反指纹', vm.runInContext('String(Function.prototype.toString)', env.sandbox) === 'function toString() { [native code] }',
    vm.runInContext('String(Function.prototype.toString)', env.sandbox));
}

console.log('\nU2 内联 CSS：cosmetic.css 完整注入，含 #cs_left_couplet 等标记');
{
  const env = boot();
  await env.flush();
  const styles = env.styles();
  const cosmetic = styles.find((s) => s.id === 'adcleaner-cosmetic');
  check('存在 id=adcleaner-cosmetic 的注入样式', !!cosmetic);
  check('内联 CSS 与 extension/src/content/cosmetic.css 内容完全一致', !!cosmetic && cosmetic.textContent === cssText,
    cosmetic ? `len ${cosmetic.textContent.length} vs ${cssText.length}` : 'missing');
  check('含 #cs_left_couplet 标记', !!cosmetic && cosmetic.textContent.includes('#cs_left_couplet'));
  check('含 #cs_right_couplet 标记', !!cosmetic && cosmetic.textContent.includes('#cs_right_couplet'));
  check('含 iframe[id^="google_ads_iframe"] 标记', !!cosmetic && cosmetic.textContent.includes('iframe[id^="google_ads_iframe"]'));
  check('含 ins.adsbygoogle 标记', !!cosmetic && cosmetic.textContent.includes('ins.adsbygoogle'));
  check('COSMETICS.json 规则也已注入（>=1 条 .video-ads）',
    env.styles().some((s) => s.textContent === '.video-ads{display:none !important}'),
    env.styles().map((s) => s.textContent.slice(0, 40)).join(' | '));
  check('源码中不再有 expando 赋值 proxy.__adcleanerProxy', !/proxy\.__adcleanerProxy\s*=/.test(code));
  check('源码中保留了闭包布尔 popupGuardInstalled', code.includes('var popupGuardInstalled = false;'));
  const codeNoComments = code.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  check('P1-2 未引入 settings/chrome 依赖（运行时无 chrome.* 引用）', !/\bchrome\.[A-Za-z]/.test(codeNoComments));
  check('安全阀参数缺失时回落 generic 180s', /maxAdSeconds\s*=\s*\(typeof cfg\.maxAdSeconds === 'number' && cfg\.maxAdSeconds > 0\)\s*\?\s*cfg\.maxAdSeconds\s*:\s*180/.test(code));
}

console.log('\nU3 白名单：整体不执行（不装弹窗 guard、不注入任何样式）');
{
  const env = boot({ whitelist: ['youtube.com'] });
  await env.flush();
  check('白名单命中后不注入任何样式', env.styles().length === 0, 'n=' + env.styles().length);
  check('白名单命中后 window.open 保持原函数（未被代理）', env.sandbox.window.open === env.sandbox.__origOpen);
  const opened = env.sandbox.window.open('https://ads.example.com/popunder.js');
  check('白名单命中后不拦截弹窗', env.opened.length === 1 && !!opened, JSON.stringify(env.opened));
}

/* 构造一个 youtube 站页面：video 用真实配置选择器 video.html5-main-video */
function youtubePage(env, { adClass = 'html5-video-player ad-showing', adText = 'AD', hiddenLayer = null } = {}) {
  const dom = env.dom;
  const video = el('video', dom, { className: 'html5-main-video' });
  video.duration = 4; video.currentTime = 0; video.paused = false; video.readyState = 4;
  let host = dom.body;
  if (hiddenLayer) {                          // .video-ads 被 cosmetic 规则 display:none
    const wrap = el('div', dom, { className: hiddenLayer });
    dom.body.appendChild(wrap);
    host = wrap;
  }
  const ad = el('div', dom, { className: adClass });
  if (adText) {
    const inner = el('span', dom); inner.textContent = adText;
    ad.appendChild(inner);
  }
  dom.body.appendChild(video);
  host.appendChild(ad);
  return { video, ad };
}

console.log('\nU4 P1-2/P3：隐藏层内的广告态存在性');
{
  const env = boot();                          // www.youtube.com
  const { video, ad } = youtubePage(env, { hiddenLayer: 'video-ads', adText: 'AD' });
  await env.flush();
  check('前置条件：广告层被我们注入的 CSS 判为不可见（isVisible=false）', getComputedStyle(ad).display === 'none' && ad.offsetParent === null);
  await env.step(600);
  check('隐藏层内的非空广告：静音', video.muted === true, 'muted=' + video.muted);
  check('隐藏层内的非空广告：16x', video.playbackRate === 16, 'rate=' + video.playbackRate);

  const env2 = boot();
  const page2 = youtubePage(env2, { hiddenLayer: 'video-ads', adText: '' });
  await env2.flush();
  check('前置条件：隐藏层内的广告容器为空', page2.ad.children.length === 0 && page2.ad.textContent.trim() === '');
  await env2.step(1200);
  check('隐藏层内的空容器：未静音', page2.video.muted === false, 'muted=' + page2.video.muted);
  check('隐藏层内的空容器：未加速', page2.video.playbackRate === 1, 'rate=' + page2.video.playbackRate);
}

console.log('\nU5 P0 回归：同一 video 连续两个（三个）广告片段都能精确还原 rate/muted');
{
  const env = boot();
  const { video, ad } = youtubePage(env, { adText: 'AD 1' });
  check('起点：用户状态为 rate=1 / muted=false', video.playbackRate === 1 && video.muted === false, 'rate=' + video.playbackRate);
  await env.flush();

  await env.step(600);
  check('片段 1：进入广告态（静音 + 16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  ad.parentNode.removeChild(ad);
  await env.step(2200);            // 覆盖最坏情况：检测轮询 500ms + 随机还原延迟 1200ms（消除偶发抖动）
  check('片段 1 结束：静音精确还原', video.muted === false, 'muted=' + video.muted);
  check('片段 1 结束：倍速精确还原', video.playbackRate === 1, 'rate=' + video.playbackRate);

  const ad2 = el('div', env.dom, { className: 'html5-video-player ad-showing' });
  ad2.textContent = 'AD 2';
  env.dom.body.appendChild(ad2);
  await env.step(600);
  check('片段 2：同一 video 再次进入广告态（静音 + 16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  env.dom.body.removeChild(ad2);
  await env.step(2200);            // 同上
  check('片段 2 结束：静音再次精确还原（P0 修复点）', video.muted === false, 'muted=' + video.muted);
  check('片段 2 结束：倍速再次精确还原（P0 修复点）', video.playbackRate === 1, 'rate=' + video.playbackRate);

  const ad3 = el('div', env.dom, { className: 'html5-video-player ad-showing' });
  ad3.textContent = 'AD 3';
  env.dom.body.appendChild(ad3);
  await env.step(600);
  check('片段 3：仍能触发（登记逻辑不会退化为一次性）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  env.dom.body.removeChild(ad3);
  await env.step(2200);            // 同上
  check('片段 3 结束：仍能精确还原', video.muted === false && video.playbackRate === 1, 'muted=' + video.muted + ' rate=' + video.playbackRate);
}

console.log('\nU6 P1-2 安全阀：iqiyi(maxAdSeconds=300) 超时强制还原 + 忽略 + 第 2 次超时同样还原');
{
  const env = boot({ hostname: 'www.iqiyi.com' });
  const dom = env.dom;
  const video = el('video', dom);
  video.duration = 600; video.currentTime = 0; video.paused = false; video.readyState = 4;
  const ad = el('div', dom, { className: 'maxPauseAd-container' });   // 也在 cosmetics 隐藏名单里
  const inner = el('span', dom); inner.textContent = 'PAUSE AD'; ad.appendChild(inner);
  dom.body.appendChild(video);
  dom.body.appendChild(ad);
  await env.flush();
  check('前置条件：暂停广告层被我们注入的 CSS 遮住', getComputedStyle(ad).display === 'none');
  await env.step(600);
  check('超时前已进入广告处理（静音 + 16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);

  await env.step(301000);                     // 强广告态连续存在 > maxAdSeconds(300s)
  check('第 1 次超时后强制还原静音', video.muted === false, 'muted=' + video.muted);
  check('第 1 次超时后强制还原倍速', video.playbackRate === 1, 'rate=' + video.playbackRate);
  await env.step(5000);
  check('忽略期间不再改 video（防正片永久 16x）', video.muted === false && video.playbackRate === 1, 'muted=' + video.muted + ' rate=' + video.playbackRate);

  dom.body.removeChild(ad);                   // 选择器消失 → 解除忽略
  await env.step(600);
  const ad2 = el('div', dom, { className: 'maxPauseAd-container' });
  const inner2 = el('span', dom); inner2.textContent = 'PAUSE AD 2'; ad2.appendChild(inner2);
  dom.body.appendChild(ad2);
  await env.step(600);
  check('选择器消失后再次出现 → 恢复广告处理（静音 + 16x）', video.muted === true && video.playbackRate === 16, 'muted=' + video.muted + ' rate=' + video.playbackRate);
  await env.step(301000);                     // 第 2 次超时（P0 修复点）
  check('第 2 次超时后同样强制还原静音', video.muted === false, 'muted=' + video.muted);
  check('第 2 次超时后同样强制还原倍速', video.playbackRate === 1, 'rate=' + video.playbackRate);
  await env.step(5000);
  check('第 2 次忽略期间同样不再改 video', video.muted === false && video.playbackRate === 1, 'muted=' + video.muted + ' rate=' + video.playbackRate);
}

console.log(`\n[selftest-userscript] ${checks - failures}/${checks} 通过` + (failures ? `，${failures} 失败` : '，全部通过'));
process.exit(failures ? 1 : 0);
