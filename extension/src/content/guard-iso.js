/* AdCleaner guard-iso.js —— ISOLATED world 内容脚本（document_start，all_frames）
 * =============================================================================
 * 职责（SPEC.md 第 8 节）：
 *   0) 设置桥（P1-1，发送方）：无条件向 MAIN world 广播
 *      window.postMessage({tag:'adcleaner.settings', enabled, popupAggressive, whitelisted}, '*')
 *      —— 脚本启动时一次（早于 enabled/白名单短路）+ chrome.storage.onChanged 每次变化后一次；
 *      即使 enabled=false 或当前站点命中白名单也必须广播。载荷只有 tag + 这 3 个布尔，不泄露其他设置。
 *   1) 门禁：读 chrome.storage.local['adcleaner.settings']；enabled=false 或 host 命中白名单 → 不注入任何东西
 *   2) cosmetics.json：host 后缀匹配规则组 → 等价 CSS 逐条 <style> 注入（每条独立，坏选择器只丢弃自己）
 *   3) 遮罩解冻：body 内联 overflow:hidden 且存在 .ad-mask/.popup-mask/#popups → 注入 html,body{overflow:auto !important}（限 30s）
 *   4) 视频状态机：video-sites.json 站点配置；settings.videoAggressive=true 时对未列站点启用 generic 保守模式
 *   5) 搜索广告清理：Google/Bing/百度/搜狗/360/DuckDuckGo（内嵌选择器，不依赖异步 cosmetics）
 *   6) 统计上报：去抖（≤1 次/分钟）chrome.runtime.sendMessage({type:'domBlocked', n})
 *   7) 生命周期（P3）：start()/stopAll() 对称幂等；设置变化可在不刷新页面的情况下恢复/撤销全部注入
 *
 * P1-2（广告态存在性）：我们自己的 CSS 把广告层 display:none 后 getComputedStyle 会判「不可见」，
 *   导致状态机失灵。故广告态元素的存在性判定改为「非空 且（isVisible(el) || 被我们自己的隐藏层遮住）」，
 *   与跳过按钮的 isClickable 保持一致；非空 = 有子元素 / 有文本 / 本身是 iframe 或 video。
 *   P3：可见分支同样要求非空 —— 常驻的空广告容器即便可见也不算广告态。
 *   安全阀：强广告态连续存在超过该站点 maxAdSeconds 时强制还原，并忽略该状态直到其选择器消失后再次出现，
 *   防止站点常驻的空广告容器让正片被永久静音 + 16x。
 *
 * P0（双片段还原）：restore() 结束后会清空 touchedVideos，所以 stateOf() 每次调用都必须确保
 *   video 已登记（而不是只在首次创建 state 时 push），否则同一 video 的第 2 个广告片段结束后
 *   restore() 将遍历空数组，静音/倍速永不还原。
 *
 * 依据：SPEC.md 第 0/3/8/9 节（2026-09-29）；数据：src/data/cosmetics.json、src/data/video-sites.json。
 * 约束：经典脚本（非 ES module，不用 import）；数据用 chrome.runtime.getURL + fetch 读取；
 *       不加载任何远程代码；所有 DOM 动作 try/catch，异常时放弃该动作。
 *
 * 视频状态机的安全原则：只在「明确广告态」动 video，先记录用户倍速/静音，广告结束后精确还原；
 * 弱广告态（广告 UI 覆盖在正片上）只交给 CSS 隐藏，绝不改 video —— 宁可不跳，也不要把正片快进坏。
 */
(function () {
  'use strict';

  var TAG = '[AdCleaner]';
  var SETTINGS_KEY = 'adcleaner.settings';
  /** P1-1 设置桥的消息 tag（与 guard-main 的接收实现约定，不可改） */
  var SETTINGS_MSG_TAG = 'adcleaner.settings';
  var COSMETICS_FILE = 'src/data/cosmetics.json';
  var VIDEO_FILE = 'src/data/video-sites.json';

  var TICK_MS = 500;                 // 状态机 tick 间隔（SPEC 8.2）
  var REPORT_INTERVAL_MS = 60000;    // 统计上报去抖上限
  var SEEK_HARD_CAP_SECONDS = 240;   // seek 硬上限：时长超过它按正片/SSAI 处理，绝不 seek
  var GENERIC_SHORT_SEEK_SECONDS = 10; // aggressive generic 模式的单次短 seek
  var MASK_WATCH_TICKS = 30;         // 遮罩解冻观察窗口（秒）
  var RESTORE_DELAY_MIN = 300;       // 广告态结束后的还原延迟区间（SPEC：300–1200ms）
  var RESTORE_DELAY_SPAN = 900;

  /** 与 background 的默认设置保持同构（SPEC 第 3 节）；只用到 enabled / whitelist / videoAggressive */
  var DEFAULT_SETTINGS = {
    enabled: true,
    whitelist: [],
    rulesets: { base: true, cn: true, annoyances: true, popups: true, video: true, tracking: true },
    videoAggressive: false,
    popupAggressive: false,
    stats: { date: '', dom: 0 }
  };

  /** 弱广告态：广告 UI 覆盖在正在播放的正片之上（或语义不确定），只允许 CSS 隐藏，绝不动 video。
   *  youtube: .ytp-ad-overlay-container 是横幅浮层广告；.ytp-ad-player-overlay 语义不稳定，保守处理。
   *  iqiyi: .overlayAd-container / .definitionAd-container / .cupid-panel 为叠加在正片上的广告层。 */
  var WEAK_AD_STATES = [
    '.ytp-ad-overlay-container',
    '.ytp-ad-player-overlay',
    '.definitionAd-container',
    '.overlayAd-container',
    '.cupid-panel',
    '.as_stages-wrapper'
  ];

  /** 搜索引擎结果页广告（SPEC 8.3，内嵌以避免依赖异步 cosmetics 数据） */
  var SEARCH_GROUPS = [
    {
      re: /^(?:(?:www|m)\.)?google\.[a-z.]{2,}$/,
      selectors: [
        '#tads[aria-label]', '#tadsb[aria-label]', '.uEierd', '.cu-container', 'div[data-text-ad]',
        'a[href^="/aclk?sa="]', 'div[data-is-ad="1"]', '.commercial-unit-desktop-rhs', '.OcdnDb'
      ]
    },
    {
      hosts: ['bing.com'],
      selectors: [
        'ol#b_results > li.b_algo:has(.b_title a[href^="https://www.bing.com/aclk?"])',
        'ol#b_results > li:has(a[href^="https://www.bing.com/aclk?"])',
        '.b_ad', '.pa_sb', '.mmaAdCard', '.top-ads-separator-enabled', '.b_bza_pole'
      ]
    },
    {
      hosts: ['baidu.com'],
      selectors: [
        '#content_left > div:has(.ec-tuiguang)', '#content_left > div:has(span[data-tuiguang])',
        '#content_right > div:has(span[data-tuiguang])', '.c-container:has(.t > a[data-landurl])',
        'div[data-key^="ad__"]', 'a[class*="fengchaoContainer"]', '.ec_ad', '.ec-fc-ad-results', '#ecl-temai-general'
      ]
    },
    {
      hosts: ['sogou.com'],
      selectors: [
        '.ad_result', '.ad-results', '#PZL', '#PZR', 'div[id^="ad_result_page1_"]',
        '.tgad-box', '.js-ad-item', '.pop-tuiguang'
      ]
    },
    {
      hosts: ['so.com', 'haosou.com', '360.cn'],
      selectors: [
        '.g-a-noline[data-md*="sad"]', '#e_idea_pp', '#e_idea_left', '#e_idea_frame_0', '#m-spread-left',
        '#so_kw-ad', '.res-mediav', '.atom-adv', '#so_bd-ad'
      ]
    },
    {
      hosts: ['duckduckgo.com'],
      selectors: ['.result--ad', 'a[href*="duckduckgo.com/y.js?"]', '.result__badge-wrap:has(button.badge--ad)', 'tr.result-sponsored']
    }
  ];

  // ---------------------------------------------------------------------------
  // 小型工具
  // ---------------------------------------------------------------------------

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(TAG);
      console.debug.apply(console, args);
    } catch (e) { /* 忽略：日志失败绝不能影响拦截 */ }
  }

  /** 规范化为小写纯域名（容忍用户填了协议/路径/端口） */
  function normHost(input) {
    var v = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
    if (!v) return '';
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    v = v.split('/')[0].split('?')[0].split('#')[0].split('@').pop();
    v = v.replace(/:\d+$/, '');
    return v;
  }

  /** host 后缀匹配：www.baidu.com 命中 baidu.com；'*' 命中所有站点（SPEC 8.1） */
  function hostMatches(host, list) {
    if (!host || !Array.isArray(list)) return false;
    for (var i = 0; i < list.length; i++) {
      var d = normHost(list[i]);
      if (!d) continue;
      if (d === '*') return true;
      if (host === d) return true;
      if (host.length > d.length && host.slice(-(d.length + 1)) === '.' + d) return true;
    }
    return false;
  }

  function getJSON(url) {
    return fetch(url, { cache: 'force-cache' }).then(function (res) {
      if (!res || !res.ok) throw new Error('HTTP ' + (res && res.status));
      return res.json();
    });
  }

  function queryAll(sel) {
    try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; }
  }

  /** SPEC 8.2 的可见性判定：display/visibility 非 none/hidden 且 offsetParent!==null。
   *  例外：position:fixed 元素在 Chrome 中 offsetParent 为 null，但确实可见，故一并放行。 */
  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var cs = getComputedStyle(el);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (el.offsetParent === null && cs.position !== 'fixed') return false;
      return true;
    } catch (e) { return false; }
  }

  /** P1-2 的「非空」判定：有子元素、有文本，或本身就是 iframe/video（空容器不算广告态，避免误伤正片） */
  function isNonEmpty(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var tag = el.tagName;
      if (tag === 'IFRAME' || tag === 'VIDEO') return true;
      if (el.firstElementChild || (el.children && el.children.length > 0)) return true;
      var txt = (el.textContent === undefined || el.textContent === null) ? '' : String(el.textContent);
      return txt.replace(/\s+/g, '').length > 0;
    } catch (e) { return false; }
  }

  function injectStyle(cssText, elId) {
    try {
      var root = document.head || document.documentElement;
      if (!root) return null;
      var st = document.createElement('style');
      if (elId) st.id = elId;
      st.setAttribute('data-adcleaner', '1');
      st.textContent = cssText;
      root.appendChild(st);
      injectedStyles.push(st);
      return st;
    } catch (e) { log('注入样式失败', e); return null; }
  }

  // ---------------------------------------------------------------------------
  // 全局状态 / 生命周期
  // ---------------------------------------------------------------------------

  var ctx = { host: '', pending: 0, hidden: 0, adEvents: 0, lastReportAt: Date.now(), cosmeticSelectors: [] };
  var controllers = [];        // 所有可停控制器（设置变化时统一撤销）
  var injectedStyles = [];     // 我们注入的 <style>（撤销时移除）
  var inlineHiddenEls = [];    // 我们内联隐藏的元素（撤销时恢复）
  var active = false;          // P3 生命周期标志：防止重复注册（start 幂等）

  function registerStop(fn) {
    if (typeof fn === 'function') controllers.push(fn);
  }

  /** 撤销全部注入并断开所有监听/定时器；可重复调用（幂等）。设置被关闭或命中白名单时调用 */
  function stopAll() {
    active = false;
    for (var i = 0; i < controllers.length; i++) {
      try { controllers[i](); } catch (e) { log('停止控制器失败', e); }
    }
    controllers = [];
    for (var j = 0; j < injectedStyles.length; j++) {
      try { var s = injectedStyles[j]; if (s && s.parentNode) s.parentNode.removeChild(s); } catch (e) { /* 忽略 */ }
    }
    injectedStyles = [];
    for (var k = 0; k < inlineHiddenEls.length; k++) {
      try { inlineHiddenEls[k].style.removeProperty('display'); } catch (e) { /* 忽略 */ }
    }
    inlineHiddenEls = [];
    ctx.cosmeticSelectors = [];
    log('已撤销所有注入');
  }

  /** 启动全部子系统；可重复调用（active 时直接返回，不重复注册 observer/interval/style） */
  function start(settings) {
    if (active) { log('已在运行，忽略重复启动'); return; }
    active = true;
    ctx.host = normHost(location.hostname || '');
    registerStop(applyCosmetics(ctx));
    registerStop(startMaskUnfreeze(ctx));
    registerStop(startVideoMachine(settings, ctx));
    registerStop(startSearchCleanup(ctx));
    registerStop(startStatsReporting(ctx));
    log('已启动', ctx.host, 'aggressive=', !!settings.videoAggressive);
  }

  /** 归一化设置：非法/缺失一律回落默认值（enabled=true） */
  function normalizeSettings(raw) {
    var s;
    try { s = Object.assign({}, DEFAULT_SETTINGS, (raw && typeof raw === 'object') ? raw : {}); }
    catch (e) { s = Object.assign({}, DEFAULT_SETTINGS); }
    if (!Array.isArray(s.whitelist)) s.whitelist = [];
    return s;
  }

  function isWhitelisted(settings, host) {
    return hostMatches(host, Array.isArray(settings.whitelist) ? settings.whitelist : []);
  }

  /** P1-1 设置桥：无条件广播 3 个布尔（MAIN world 的 guard-main 是接收方）。
   *  只在 tag/enabled/popupAggressive/whitelisted 四个字段，不携带任何其他设置。 */
  function broadcastSettings(settings) {
    try {
      var host = normHost(location.hostname || '');
      window.postMessage({
        tag: SETTINGS_MSG_TAG,
        enabled: settings.enabled !== false,
        popupAggressive: settings.popupAggressive === true,
        whitelisted: isWhitelisted(settings, host)
      }, '*');
    } catch (e) { log('设置桥广播失败', e); }
  }

  /** 读设置：chrome.storage.local 单键；失败/缺失一律回落默认值（enabled=true） */
  function readSettings() {
    return new Promise(function (resolve) {
      var done = function (raw) { resolve(normalizeSettings(raw)); };
      try {
        if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.local) { done(null); return; }
        var maybe = chrome.storage.local.get(SETTINGS_KEY);
        if (maybe && typeof maybe.then === 'function') {
          maybe.then(function (r) { done(r && r[SETTINGS_KEY]); }, function () { done(null); });
        } else {
          chrome.storage.local.get(SETTINGS_KEY, function (r) { done(r && r[SETTINGS_KEY]); });
        }
      } catch (e) { log('读取设置失败，使用默认值', e); done(null); }
    });
  }

  /** 监听设置变化（SPEC 第 3 节）：
   *  - 无条件重发设置桥消息（含关闭/白名单状态）；
   *  - 禁止（enabled=false 或命中白名单）→ stopAll()；允许 → 未启动则 start()。无需刷新页面。 */
  function watchSettings() {
    try {
      if (typeof chrome === 'undefined' || !chrome.storage || !chrome.storage.onChanged) return;
      chrome.storage.onChanged.addListener(function (changes, area) {
        if (area !== 'local' || !changes || !changes[SETTINGS_KEY]) return;
        var next = normalizeSettings(changes[SETTINGS_KEY].newValue);
        ctx.host = normHost(location.hostname || '');
        broadcastSettings(next);
        if (next.enabled === false || isWhitelisted(next, ctx.host)) { stopAll(); return; }
        if (!active) start(next);
      });
    } catch (e) { log('监听设置变化失败', e); }
  }

  // ---------------------------------------------------------------------------
  // 1) cosmetics.json 应用（逐条 <style> 注入 + 统计计数）
  // ---------------------------------------------------------------------------

  function isSupportedSelector(sel) {
    if (typeof sel !== 'string' || !sel || sel.length > 1024) return false;
    if (/:(?:-abp-)?contains\(/i.test(sel)) return false;  // 非标准选择器一律丢弃，不自造替代
    return true;
  }

  function applyCosmetics(ctx) {
    var timers = [];
    var stopped = false;                 // P3：stopAll 之后迟到的 fetch 回调不得再注入任何东西
    var url;
    try { url = chrome.runtime.getURL(COSMETICS_FILE); } catch (e) { log('getURL 失败，跳过 cosmetics', e); return null; }

    getJSON(url).then(function (data) {
      if (stopped) { log('cosmetics 加载完成时已停止，放弃注入'); return; }
      var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
      var selectors = [];
      var dropped = 0;
      for (var i = 0; i < groups.length; i++) {
        var g = groups[i];
        if (!g || !hostMatches(ctx.host, g.hosts)) continue;
        var list = Array.isArray(g.selectors) ? g.selectors : [];
        for (var j = 0; j < list.length; j++) {
          var sel = list[j];
          if (!isSupportedSelector(sel)) { dropped++; log('丢弃不支持的选择器', sel); continue; }
          try { document.querySelector(sel); } catch (e) { dropped++; log('无效选择器，丢弃', sel); continue; }
          selectors.push(sel);
          injectStyle(sel + '{display:none !important}');   // 每条独立，坏选择器不影响其它条
        }
      }
      ctx.cosmeticSelectors = selectors;
      log('cosmetics 注入完成：选择器', selectors.length, '丢弃', dropped, 'host', ctx.host);
      var passTimes = [500, 2000, 5000, 10000, 20000];
      var seen = new WeakSet();
      for (var k = 0; k < passTimes.length; k++) {
        timers.push(setTimeout(function () {
          var n = 0;
          for (var m = 0; m < selectors.length; m++) {
            var els = queryAll(selectors[m]);
            for (var q = 0; q < els.length; q++) {
              var el = els[q];
              if (seen.has(el)) continue;
              if (el.hasAttribute && el.hasAttribute('data-adcleaner-hidden')) continue; // 搜索清理已计过，避免重复
              seen.add(el);
              n++;
            }
          }
          if (n) { ctx.pending += n; ctx.hidden += n; }
        }, passTimes[k]));
      }
    }).catch(function (e) { log('cosmetics 加载失败', e); });

    return function stop() {
      stopped = true;
      for (var i = 0; i < timers.length; i++) { try { clearTimeout(timers[i]); } catch (e) { /* 忽略 */ } }
    };
  }

  // ---------------------------------------------------------------------------
  // 2) 遮罩解冻（SPEC 8.1）：body 内联 overflow:hidden + 广告遮罩层 → 恢复滚动
  // ---------------------------------------------------------------------------

  function startMaskUnfreeze(ctx) {
    var style = null;
    var counted = false;
    var ticks = 0;
    var iv = setInterval(function () {
      ticks++;
      try {
        var body = document.body;
        var styleAttr = body ? (body.getAttribute('style') || '') : '';
        var overflowHidden = /overflow\s*:\s*hidden/i.test(styleAttr);
        var mask = document.querySelector('.ad-mask, .popup-mask, #popups');
        if (body && overflowHidden && mask) {
          if (!style || !style.parentNode) {
            style = injectStyle('html,body{overflow:auto !important}', 'adcleaner-unfreeze');
            log('检测到广告遮罩锁定滚动，已注入解冻样式');
          }
          if (!counted) { counted = true; ctx.pending += 1; }
        } else if (counted) {
          ticks = MASK_WATCH_TICKS;   // 遮罩已消失：停止观察
        }
      } catch (e) { log('遮罩检查失败', e); }
      if (ticks >= MASK_WATCH_TICKS) { try { clearInterval(iv); } catch (e) { /* 忽略 */ } }
    }, 1000);
    return function stop() { try { clearInterval(iv); } catch (e) { /* 忽略 */ } };
  }

  // ---------------------------------------------------------------------------
  // 3) 视频状态机（SPEC 8.2）
  // ---------------------------------------------------------------------------

  function searchConfigFor(host) {
    for (var i = 0; i < SEARCH_GROUPS.length; i++) {
      var g = SEARCH_GROUPS[i];
      if (g.re && g.re.test(host)) return g;
      if (g.hosts && hostMatches(host, g.hosts)) return g;
    }
    return null;
  }

  function startSearchCleanup(ctx) {
    var cfg = searchConfigFor(ctx.host);
    if (!cfg) return null;
    var seen = new WeakSet();

    function pass() {
      var n = 0;
      for (var i = 0; i < cfg.selectors.length; i++) {
        var els = queryAll(cfg.selectors[i]);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          if (seen.has(el)) continue;                       // 按元素去重（SPEC 8.3）
          seen.add(el);
          try {
            el.style.setProperty('display', 'none', 'important');   // 不 remove DOM
            el.setAttribute('data-adcleaner-hidden', '1');          // 幂等标记
            inlineHiddenEls.push(el);
            n++;
          } catch (e) { /* 忽略单个元素 */ }
        }
      }
      if (n) { ctx.pending += n; ctx.hidden += n; log('搜索页广告已隐藏', n); }
    }

    pass();
    var t0 = Date.now();
    var iv = setInterval(function () {
      try { pass(); } catch (e) { log('搜索清理扫描失败', e); }
      if (Date.now() - t0 > 20000) { try { clearInterval(iv); } catch (e) { /* 忽略 */ } }
    }, 1000);

    var mo = null;
    var moTimer = 0;
    try {
      mo = new MutationObserver(function () {
        if (moTimer) return;
        moTimer = setTimeout(function () { moTimer = 0; pass(); }, 250);  // debounce 250ms
      });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) { log('搜索 MutationObserver 失败', e); }

    log('搜索清理已启动', ctx.host);
    return function stop() {
      try { clearInterval(iv); } catch (e) { /* 忽略 */ }
      if (moTimer) { try { clearTimeout(moTimer); } catch (e) { /* 忽略 */ } }
      if (mo) { try { mo.disconnect(); } catch (e) { /* 忽略 */ } }
    };
  }

  // ---------------------------------------------------------------------------
  // 4) 统计上报（去抖，≤ 每分钟 1 次）
  // ---------------------------------------------------------------------------

  function reportStats(ctx, urgent) {
    if (!ctx.pending) return;
    var now = Date.now();
    if (!urgent && now - ctx.lastReportAt < REPORT_INTERVAL_MS - 1000) return;
    var n = ctx.pending;
    ctx.pending = 0;
    ctx.lastReportAt = now;
    try {
      if (typeof chrome === 'undefined' || !chrome.runtime || !chrome.runtime.sendMessage) {
        ctx.pending += n;
        return;
      }
      chrome.runtime.sendMessage({ type: 'domBlocked', n: n }, function () {
        try { if (chrome.runtime.lastError && chrome.runtime.lastError.message) ctx.pending += n; } catch (e) { /* 忽略 */ }
      });
    } catch (e) {
      ctx.pending += n;
      log('统计上报失败', e);
    }
  }

  function startStatsReporting(ctx) {
    var iv = setInterval(function () { reportStats(ctx, false); }, 30000);
    var onVisibility = function () {
      if (document.visibilityState === 'hidden') reportStats(ctx, true);
    };
    var onPageHide = function () { reportStats(ctx, true); };
    try { document.addEventListener('visibilitychange', onVisibility); } catch (e) { /* 忽略 */ }
    try { window.addEventListener('pagehide', onPageHide); } catch (e) { /* 忽略 */ }
    // P3：stopAll 必须同时移除这两个监听，否则关闭/白名单后仍会残留（重复启用还会叠加）
    return function stop() {
      try { clearInterval(iv); } catch (e) { /* 忽略 */ }
      try { document.removeEventListener('visibilitychange', onVisibility); } catch (e) { /* 忽略 */ }
      try { window.removeEventListener('pagehide', onPageHide); } catch (e) { /* 忽略 */ }
    };
  }

  // ---------------------------------------------------------------------------
  // 5) 视频状态机实现
  // ---------------------------------------------------------------------------

  function startVideoMachine(settings, ctx) {
    var stopped = false;
    var machineStop = null;
    var url;
    try { url = chrome.runtime.getURL(VIDEO_FILE); } catch (e) { log('getURL 失败，跳过视频状态机', e); return null; }

    getJSON(url).then(function (data) {
      if (stopped) return;
      var sites = (data && data.sites) || {};
      var cfg = null;
      var genericMode = false;
      for (var key in sites) {
        if (!Object.prototype.hasOwnProperty.call(sites, key)) continue;
        if (hostMatches(ctx.host, [key])) { cfg = sites[key]; log('命中视频站点配置', key); break; }
      }
      if (!cfg && settings.videoAggressive && data && data.generic) {
        cfg = data.generic;
        genericMode = true;
        log('未命中站点，启用 aggressive generic 模式');
      }
      if (!cfg) { log('非视频站点且未开启激进模式，不启动视频状态机'); return; }
      machineStop = runMachine(cfg, genericMode, ctx);
    }).catch(function (e) { log('video-sites.json 加载失败', e); });

    return function stop() {
      stopped = true;
      if (machineStop) { try { machineStop(); } catch (e) { log('停止视频状态机失败', e); } }
    };
  }

  function runMachine(cfg, genericMode, ctx) {
    var selVideos = cfg.video || 'video';
    var adStateSels = Array.isArray(cfg.adState) ? cfg.adState : [];
    var skipSels = Array.isArray(cfg.skip) ? cfg.skip : [];
    var pauseCfg = cfg.pauseAd || {};
    var pauseContainers = Array.isArray(pauseCfg.containers) ? pauseCfg.containers : [];
    var pauseClose = Array.isArray(pauseCfg.close) ? pauseCfg.close : [];
    var actions = Array.isArray(cfg.actions) ? cfg.actions : [];
    var maxAdSeconds = (typeof cfg.maxAdSeconds === 'number' && cfg.maxAdSeconds > 0) ? cfg.maxAdSeconds : 180;

    var stopped = false;
    var states = new WeakMap();       // video -> {rate, muted, rateByUs, mutedByUs, pendingRates, counted, lastSeekAt, seekedOnce}
    var touchedVideos = [];           // WeakMap 不可遍历，另存一份用于还原
    var clickedEls = [];              // 我们点过的按钮（退出广告态清理自定义属性）
    var episodeHides = [];            // 广告态内联隐藏的容器（退出广告态恢复）
    var adEpisode = false;            // 当前是否处于广告态
    var dirty = false;                // 是否改过页面（需要还原）
    var restoreTimer = 0;
    var lastHref = location.href;
    var moThrottleAt = 0;
    var strongSince = 0;              // 强广告态连续出现的起点（0 = 当前无强广告态）
    var suppressedKeys = [];          // P1-2 安全阀：超时后被忽略的强广告态标识，全部消失后才解除忽略

    function hasAction(name) { return actions.indexOf(name) >= 0; }

    function now() { return Date.now(); }

    /** 跳过按钮可点判定：规范要求可见（SPEC 8.2），额外放行两类安全情况：
     *  ① position:fixed（offsetParent 为 null 但确实可见，见 isVisible）
     *  ② 按钮被我们自己的隐藏规则遮住（如 YouTube 跳过按钮位于 .video-ads/.ytp-ad-module 内）——
     *     此时按钮虽 display:none，但 el.click() 依然有效，且它本身就是广告控件。 */
    function insideCosmeticHiddenLayer(el) {
      var sels = ctx.cosmeticSelectors || [];
      if (!el || typeof el.closest !== 'function') return false;
      for (var i = 0; i < sels.length; i++) {
        try { if (el.closest(sels[i])) return true; } catch (e) { /* 忽略无效选择器 */ }
      }
      return false;
    }

    function isClickable(el) {
      if (!el || el.nodeType !== 1) return false;
      try { if (el.disabled) return false; } catch (e) { /* 忽略 */ }
      if (isVisible(el)) return true;
      return insideCosmeticHiddenLayer(el);
    }

    /** P1-2/P3 广告态元素存在性：「非空」且（可见 或 被我们自己的隐藏规则遮住）。
     *  我们注入的 display:none 会让 getComputedStyle 判不可见，若只看 isVisible，状态机会完全失灵
     *  （而这正是本扩展最常见的运行状态）；非空判定用于挡掉常驻的空广告容器 ——
     *  P3：可见分支同样要求非空，否则「可见的空广告容器」会被误判为广告态。 */
    function adElementPresent(el) {
      return isNonEmpty(el) && (isVisible(el) || insideCosmeticHiddenLayer(el));
    }

    function clickElement(el) {
      try {
        if (!el || el.nodeType !== 1) return false;
        if (el.disabled) return false;
        if (el.dataset && el.dataset.adcleanerClicked === '1') return false;   // 同一按钮不重复点
        if (el.dataset) el.dataset.adcleanerClicked = '1';
        clickedEls.push(el);
        el.click();
        return true;
      } catch (e) { log('点击失败', e); return false; }
    }

    /** P0：把 video 登记进 touchedVideos（restore() 后会清空该列表，故每次进入广告态都要重新登记）。
     *  用 indexOf 去重，避免 restore() 对同一 video 重复还原。 */
    function trackTouched(v) {
      if (touchedVideos.indexOf(v) < 0) touchedVideos.push(v);
    }

    function stateOf(v) {
      var s = states.get(v);
      if (s) { trackTouched(v); return s; }   // P0：已有 state 也必须重新登记（上一片段结束时列表已被清空）
      s = {
        rate: safeRate(v),
        muted: !!v.muted,
        rateByUs: false,
        mutedByUs: false,
        lastSetMutedAt: 0,
        lastSetMuted: false,
        pendingRates: [],
        counted: false,
        lastSeekAt: 0,
        seekedOnce: false
      };
      states.set(v, s);
      trackTouched(v);
      try {
        v.addEventListener('ratechange', function () {
          // 先判断是不是我们自己的赋值：命中 pendingRates 则忽略，避免把 16 当成用户设置
          var cur = safeRate(v);
          for (var i = 0; i < s.pendingRates.length; i++) {
            if (Math.abs(s.pendingRates[i].rate - cur) < 0.01) {
              s.pendingRates.splice(i, 1);
              return;
            }
          }
          if (s.rateByUs) { s.rateByUs = false; s.rate = cur; }   // 用户自己改了：以用户为准，不再还原
        });
        v.addEventListener('volumechange', function () {
          if (!s.mutedByUs) return;
          if (now() - s.lastSetMutedAt < 250) return;             // 我们刚设的，忽略
          if (!!v.muted !== s.lastSetMuted) { s.muted = !!v.muted; s.mutedByUs = false; }
        });
      } catch (e) { log('绑定 video 事件失败', e); }
      return s;
    }

    function safeRate(v) {
      try { return (typeof v.playbackRate === 'number' && isFinite(v.playbackRate)) ? v.playbackRate : 1; }
      catch (e) { return 1; }
    }

    function setRate(v, s, rate) {
      try {
        var before = safeRate(v);
        var at = now();
        s.pendingRates.push({ rate: rate, at: at });
        while (s.pendingRates.length > 4) s.pendingRates.shift();
        try { v.playbackRate = rate; } catch (e) { log('设置 playbackRate 失败', e); }
        var back = safeRate(v);
        if (Math.abs(back - rate) < 0.01) {
          s.rateByUs = true;
          dirty = true;
        } else {
          // 站点限制倍速：忽略（不改 s.rate，也不标 rateByUs，避免还原时把用户倍速写坏）
          s.rateByUs = false;
          log('站点限制倍速（请求', rate, '实际', back, '），忽略');
        }
        if (before !== back) log('倍速', before, '->', back);
      } catch (e) { log('setRate 异常', e); }
    }

    function setMuted(v, s, val) {
      try {
        v.muted = val;
        s.lastSetMuted = !!v.muted;
        s.lastSetMutedAt = now();
        if (!!v.muted === !!val) { s.mutedByUs = true; dirty = true; }
      } catch (e) { log('设置 mute 失败', e); }
    }

    /** seek：仅当 readyState>=1、时长为有限值且 >1；直播（Infinity）禁止（SPEC 8.2） */
    function trySeekToEnd(v, s) {
      try {
        if (now() - s.lastSeekAt < 1500) return;
        if (v.readyState < 1) return;
        var d = v.duration;
        if (!isFinite(d) || d <= 1) return;
        var cap = Math.min(maxAdSeconds, SEEK_HARD_CAP_SECONDS);
        if (d > cap) { log('时长', d, 's 超过 seek 上限', cap, 's，判定为正片/SSAI，不 seek'); return; }
        if (v.currentTime >= d - 0.5) return;
        s.lastSeekAt = now();
        dirty = true;
        v.currentTime = d - 0.1;
        log('seek 到广告末尾', d.toFixed(1));
      } catch (e) { log('seek 失败', e); }
    }

    function shortSeek(v, s) {
      try {
        if (!isFinite(v.duration) || v.duration <= 1) return;
        var target = Math.min(v.currentTime + GENERIC_SHORT_SEEK_SECONDS, v.duration - 0.5);
        if (target <= v.currentTime + 0.5) return;
        dirty = true;
        v.currentTime = target;
        log('aggressive：短 seek', target.toFixed(1));
      } catch (e) { log('短 seek 失败', e); }
    }

    function pickVideo() {
      var list = queryAll(selVideos);
      var best = null;
      var bestScore = -1;
      for (var i = 0; i < list.length; i++) {
        var v = list[i];
        if (!v || v.tagName !== 'VIDEO') continue;
        var score = 0;
        if (!v.paused && !v.ended) score += 2;                  // 优先正在播放的
        if (isFinite(v.duration) && v.duration > 1) score += 1;  // 优先时长明确的
        if (score > bestScore) { best = v; bestScore = score; }
      }
      return best;
    }

    /** 检测广告态；matched 为命中的 adState 选择器，strong 表示「正在播的就是广告」。
     *  P1-2：存在性用 adElementPresent（可见 或 被我们遮住的非空元素），与 isClickable 对齐。 */
    function detectAdState() {
      var matched = [];
      var keys = [];
      var firstEl = null;
      for (var i = 0; i < adStateSels.length; i++) {
        var els = queryAll(adStateSels[i]);
        for (var j = 0; j < els.length; j++) {
          if (adElementPresent(els[j])) {
            matched.push(adStateSels[i]);
            keys.push(adStateSels[i]);
            if (!firstEl) firstEl = els[j];
            break;
          }
        }
      }
      var pauseVisible = false;
      var pauseKeys = [];
      for (var k = 0; k < pauseContainers.length; k++) {
        var pe = queryAll(pauseContainers[k]);
        for (var q = 0; q < pe.length; q++) {
          if (adElementPresent(pe[q])) {
            pauseVisible = true;
            pauseKeys.push('pause:' + pauseContainers[k]);
            keys.push('pause:' + pauseContainers[k]);
            if (!firstEl) firstEl = pe[q];
            break;
          }
        }
      }
      var strong = false;
      var strongKeys = [];
      for (var m = 0; m < matched.length; m++) {
        if (WEAK_AD_STATES.indexOf(matched[m]) < 0) { strong = true; strongKeys.push(matched[m]); }
      }
      if (pauseVisible) { strong = true; strongKeys = strongKeys.concat(pauseKeys); }
      return { present: keys.length > 0, strong: strong, matched: matched, keys: keys, strongKeys: strongKeys, el: firstEl };
    }

    function clickSkipButtons() {
      var clicked = 0;
      for (var i = 0; i < skipSels.length; i++) {
        var els = queryAll(skipSels[i]);
        for (var j = 0; j < els.length; j++) {
          if (!isClickable(els[j])) continue;
          if (clickElement(els[j])) clicked++;
        }
      }
      if (clicked) { ctx.pending += clicked; log('点击跳过按钮', clicked, '个'); }
      return clicked;
    }

    /** 暂停广告：优先点关闭按钮；无关闭按钮时，对「名字里明确带 ad/pause」的容器做临时内联隐藏 */
    function closePauseAd() {
      var containers = [];
      for (var i = 0; i < pauseContainers.length; i++) {
        var els = queryAll(pauseContainers[i]);
        for (var j = 0; j < els.length; j++) {
          if (adElementPresent(els[j])) containers.push(els[j]);      // P1-2：被我们遮住的暂停广告层也要处理
        }
      }
      if (!containers.length) return false;
      var closed = 0;
      for (var k = 0; k < pauseClose.length; k++) {
        var btns = queryAll(pauseClose[k]);
        for (var q = 0; q < btns.length; q++) {
          if (!isClickable(btns[q])) continue;
          if (clickElement(btns[q])) closed++;
        }
      }
      if (!closed) {
        for (var m = 0; m < containers.length; m++) {
          var c = containers[m];
          try {
            if (c.getAttribute && c.getAttribute('data-adcleaner-episode') === '1') continue;  // 已隐藏过，不重复记录
            var name = (c.id || '') + ' ' + (c.className && c.className.baseVal !== undefined ? c.className.baseVal : (c.className || ''));
            if (!/(^|[\s._-])(ad|ads|advert|pause)([\s._-]|$)/i.test(String(name))) continue;  // 名字不像广告层就不动
            c.setAttribute('data-adcleaner-episode', '1');
            c.style.setProperty('display', 'none', 'important');
            episodeHides.push(c);
            dirty = true;
          } catch (e) { log('隐藏暂停广告层失败', e); }
        }
      }
      return true;
    }

    function handleAd(info) {
      // 跳过按钮：所有配置都尝试（存在且可点才点）
      clickSkipButtons();
      // 暂停广告关闭
      if (hasAction('pause-close')) { try { closePauseAd(); } catch (e) { log('closePauseAd 异常', e); } }
      // 动 video：只有强广告态才允许
      if (!info.strong) return;
      var v = pickVideo();
      if (!v) return;
      var s = stateOf(v);
      if (hasAction('mute')) setMuted(v, s, true);
      if (hasAction('speed')) setRate(v, s, 16);
      if (hasAction('seek')) trySeekToEnd(v, s);
      if (!s.counted) { s.counted = true; ctx.adEvents++; ctx.pending += 1; log('检测到视频广告，已静音/加速'); }
    }

    /** aggressive generic：只在「整页有且仅有一个 video 在播放、时长≤maxAdSeconds、用户未暂停」时动作 */
    function tickGeneric() {
      var vids = queryAll('video');
      if (vids.length !== 1 || document.hidden) { if (dirty) endEpisode(); return; }
      var v = vids[0];
      var ok = !v.paused && !v.ended && v.readyState >= 1 && isFinite(v.duration) && v.duration > 1 && v.duration <= maxAdSeconds;
      if (!ok) { if (dirty) endEpisode(); return; }
      var s = stateOf(v);
      if (hasAction('mute')) setMuted(v, s, true);
      if (hasAction('speed')) setRate(v, s, 16);
      if (!s.seekedOnce) { s.seekedOnce = true; shortSeek(v, s); }
      if (!s.counted) { s.counted = true; ctx.adEvents++; ctx.pending += 1; log('aggressive：疑似广告视频，静音+加速'); }
      adEpisode = true;
    }

    function endEpisode() {
      if (restoreTimer) return;
      adEpisode = false;
      restoreTimer = setTimeout(function () {
        restoreTimer = 0;
        restore();
      }, RESTORE_DELAY_MIN + Math.floor(Math.random() * RESTORE_DELAY_SPAN));
    }

    /** P1-2 安全阀（忽略侧）：若当前广告态包含任一被超时忽略的标识，则继续忽略；
     *  被忽略的标识全部从页面上消失后才解除忽略（即「消失后再次出现」才重新处理）。 */
    function isSuppressed(info) {
      if (!suppressedKeys.length) return false;
      for (var i = 0; i < suppressedKeys.length; i++) {
        if (info.keys.indexOf(suppressedKeys[i]) >= 0) return true;
      }
      suppressedKeys = [];
      log('被忽略的强广告态已消失，恢复处理');
      return false;
    }

    /** P1-2 安全阀（超时侧）：强广告态连续存在超过该站点 maxAdSeconds → 立即强制还原并忽略。
     *  防止站点常驻（空/非空）广告容器导致正片被永久静音 + 16x。 */
    function strongAdTimedOut(info) {
      if (!info.strong) { strongSince = 0; return false; }
      var t = now();
      if (!strongSince) { strongSince = t; return false; }
      if (t - strongSince <= maxAdSeconds * 1000) return false;
      suppressedKeys = info.strongKeys.slice();
      strongSince = 0;
      adEpisode = false;
      if (restoreTimer) { try { clearTimeout(restoreTimer); } catch (e) { /* 忽略 */ } restoreTimer = 0; }
      try { restore(); } catch (e) { log('超时强制还原失败', e); }
      log('强广告态已持续超过 maxAdSeconds(' + maxAdSeconds + 's)，强制还原并忽略该状态，直到其选择器消失');
      return true;
    }

    /** 精确还原用户状态 + 清理自定义属性（SPEC 8.2：300–1200ms 内完成） */
    function restore() {
      for (var i = 0; i < touchedVideos.length; i++) {
        var v = touchedVideos[i];
        var s = states.get(v);
        if (!s) continue;
        try {
          if (s.mutedByUs) { v.muted = s.muted; s.mutedByUs = false; s.lastSetMuted = !!v.muted; s.lastSetMutedAt = now(); }
          if (s.rateByUs) { setRate(v, s, s.rate); s.rateByUs = false; }
        } catch (e) { log('还原 video 状态失败', e); }
        s.counted = false;
        s.seekedOnce = false;
        s.pendingRates = [];
      }
      dirty = false;
      touchedVideos = [];
      for (var j = 0; j < clickedEls.length; j++) {
        try {
          if (clickedEls[j].dataset) delete clickedEls[j].dataset.adcleanerClicked;
        } catch (e) { /* 忽略 */ }
      }
      clickedEls = [];
      for (var k = 0; k < episodeHides.length; k++) {
        try {
          episodeHides[k].style.removeProperty('display');
          episodeHides[k].removeAttribute('data-adcleaner-episode');
        } catch (e) { /* 忽略 */ }
      }
      episodeHides = [];
      log('广告态结束，已还原用户状态');
    }

    function resetForSpa() {
      if (restoreTimer) { try { clearTimeout(restoreTimer); } catch (e) { /* 忽略 */ } restoreTimer = 0; }
      try { restore(); } catch (e) { log('SPA 还原失败', e); }
      states = new WeakMap();
      touchedVideos = [];
      clickedEls = [];
      episodeHides = [];
      adEpisode = false;
      dirty = false;
      strongSince = 0;
      suppressedKeys = [];
      log('SPA 导航，重置视频状态');
    }

    function tick() {
      if (stopped) return;
      try {
        if (location.href !== lastHref) { lastHref = location.href; resetForSpa(); }
        if (genericMode) { tickGeneric(); return; }
        var info = detectAdState();
        var suppressed = isSuppressed(info);       // 必须先调用：广告态完全消失时在此解除忽略
        if (!info.present || suppressed) {
          strongSince = 0;
          if (adEpisode || dirty) endEpisode();
          return;
        }
        adEpisode = true;
        if (!strongAdTimedOut(info)) handleAd(info);
      } catch (e) { log('tick 异常', e); }
    }

    var iv = setInterval(tick, TICK_MS);
    var mo = null;
    try {
      mo = new MutationObserver(function () {
        var t = now();
        if (t - moThrottleAt < 200) return;   // 节流：整页 class/style 变化可能非常频繁
        moThrottleAt = t;
        tick();
      });
      mo.observe(document, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    } catch (e) { log('视频 MutationObserver 失败', e); }
    tick();
    log('视频状态机已启动', genericMode ? '(generic/aggressive)' : '(站点配置)');

    return function stop() {
      stopped = true;
      try { clearInterval(iv); } catch (e) { /* 忽略 */ }
      if (mo) { try { mo.disconnect(); } catch (e) { /* 忽略 */ } }
      if (restoreTimer) { try { clearTimeout(restoreTimer); } catch (e) { /* 忽略 */ } restoreTimer = 0; }
      try { restore(); } catch (e) { log('停止时还原失败', e); }
    };
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  function main() {
    readSettings().then(function (settings) {
      ctx.host = normHost(location.hostname || '');
      broadcastSettings(settings);         // P1-1：无条件先广播（早于 enabled/白名单短路）
      watchSettings();                     // P3：即使当前被禁用也监听，重新开启无需刷新页面
      if (settings.enabled === false) { log('总开关为关闭，不注入任何东西'); return; }
      if (isWhitelisted(settings, ctx.host)) { log('命中白名单，不注入任何东西', ctx.host); return; }
      start(settings);
    }).catch(function (e) { log('启动失败', e); });
  }

  main();
})();
