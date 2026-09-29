/**
 * guard-main.js — AdCleaner MAIN world 守卫（fixer B1）
 * =====================================================================
 * 用途：在 document_start 同步安装页面级（MAIN world）防护，运行于所有 frame：
 *   ⓪ 设置桥 —— 接收 ISOLATED world（guard-iso.js）经 window.postMessage 推送的
 *      {tag:'adcleaner.settings', enabled, popupAggressive, whitelisted}；只接受
 *      e.source === window 的同窗消息，字段严格类型校验（缺省/类型不符一律忽略），
 *      与 chrome.storage / chrome.runtime 读取路径互为兜底；
 *   ① 弹窗 guard —— 代理 window.open（smart 默认 / aggressive 合成点击拦截）；
 *   ② scriptlet-lite —— set-constant / json-prune / no-fetch-if / no-xhr-if /
 *      adjust-setTimeout|setInterval / prevent-window-open / iqiyi-adSlots /
 *      腾讯隐藏 iframe JSON 反绕过 / YouTube SSAP 跳过。
 *
 * 依据来源：SPEC.md §7（表内规则逐条对应）；window.open 代理 + WeakMap +
 *   Function.prototype.toString 反指纹、scriptlet 语义参考 uBlock Origin
 *   (GPL-3.0) 与 AdGuard scriptlets (GPL-3.0) 的公开实现思路；本文件是不依赖
 *   任何库的最小化独立重写，不加载、不 eval 任何远程代码。
 *
 * 约束：零外部依赖、零 import、常量全部内联；关键 hook 同步安装（不等异步设置）。
 *   所有 hook 均 try/catch，出错静默回退到原行为，不把页面弄坏。
 *
 * 已知限制：
 *   - json-prune 对 XHR 仅支持 responseType ''/text/json；arraybuffer/blob 不改写。
 *   - json-prune 的 JSON.parse 包装只对具备 playerResponse 特征键（YouTube）的对象
 *     生效，其他站点只做网络层改写，避免误删站点数据。
 *   - YouTube SSAI 只能尽力 seekTo 到片段尾；youku 的 setTimeout 全域 ×0.02 属
 *     SPEC §7.2 规定的激进手段（此处另加 120s 上限保护超长心跳定时器），
 *     站点异常时可删除该条规则。
 *   - 腾讯 iframe 反绕过只在“插入时”即带 inline style="display:none" 且无 src
 *     的 iframe 上补 JSON 影子（与 SPEC §7.2 的选择器一致）；先插入后加样式的
 *     写法覆盖不到。
 *   - prevent-window-open 作为规则类型实现（pattern 追加进同一个 window.open
 *     代理）；SPEC §7.2 表内未给站点条目，默认全局模式表已覆盖全部站点。
 *   - 本文件不注入元素隐藏样式（由 guard-iso.js + cosmetic.css 负责）。
 *   - aggressive 合成点击拦截默认关闭，需 settings.popupAggressive === true。
 */
(function () {
  'use strict';

  /* ================================================================== *
   * 0. 常量、原生引用、小工具（必须在任何 hook 安装前捕获原生实现）
   * ================================================================== */

  var DEBUG = false;                 // true 时输出 [AdCleaner] 调试日志
  var TAG = '[AdCleaner]';
  var SETTINGS_KEY = 'adcleaner.settings';

  var hasOwn = Object.prototype.hasOwnProperty;
  var slice = Array.prototype.slice;

  var NATIVE = {};
  try {
    NATIVE.setTimeout = window.setTimeout;
    NATIVE.setInterval = window.setInterval;
    NATIVE.clearInterval = window.clearInterval;
    NATIVE.jsonParse = window.JSON && window.JSON.parse;
    NATIVE.jsonStringify = window.JSON && window.JSON.stringify;
  } catch (e) { /* 极端环境下忽略 */ }

  function log() {
    if (!DEBUG) return;
    try {
      var args = [TAG].concat(slice.call(arguments));
      console.debug.apply(console, args);
    } catch (e) { /* ignore */ }
  }

  function nativeTimeout(fn, ms) {
    try {
      if (typeof NATIVE.setTimeout === 'function') return NATIVE.setTimeout(fn, ms);
      return window.setTimeout(fn, ms);
    } catch (e) { return 0; }
  }

  function nativeInterval(fn, ms) {
    try {
      if (typeof NATIVE.setInterval === 'function') return NATIVE.setInterval(fn, ms);
      return window.setInterval(fn, ms);
    } catch (e) { return 0; }
  }

  function jsonParseNative(text) {
    try {
      if (typeof NATIVE.jsonParse === 'function') return NATIVE.jsonParse.call(window.JSON, text);
      return window.JSON.parse(text);
    } catch (e) { return null; }
  }

  function jsonStringifyNative(value) {
    try {
      if (typeof NATIVE.jsonStringify === 'function') return NATIVE.jsonStringify.call(window.JSON, value);
      return window.JSON.stringify(value);
    } catch (e) { return null; }
  }

  function currentHost() {
    try {
      return String(window.location && window.location.hostname || '').toLowerCase();
    } catch (e) { return ''; }
  }

  function hostMatches(host, suffix) {
    if (!host || !suffix) return false;
    if (host === suffix) return true;
    return host.length > suffix.length &&
      host.slice(-(suffix.length + 1)) === '.' + suffix;
  }

  function matchesAny(patterns, s) {
    if (!patterns || !patterns.length || !s) return false;
    for (var i = 0; i < patterns.length; i++) {
      try {
        if (patterns[i].test(s)) return true;
      } catch (e) { /* 坏正则忽略 */ }
    }
    return false;
  }

  /* ================================================================== *
   * 1. 设置状态（异步读取；同步安装 hook 时先按默认值工作）
   *    - 读不到设置 => 默认值（popupAggressive=false），不报错
   *    - 拿到 enabled=false 或命中白名单 => 所有 hook 运行时回退原行为
   * ================================================================== */

  var STATE = {
    enabled: true,
    popupAggressive: false,
    whitelisted: false,
    loaded: false
  };

  function isActive() {
    return STATE.enabled === true && STATE.whitelisted !== true;
  }

  function whitelistHas(host, list) {
    if (!host || !Array.isArray(list)) return false;
    for (var i = 0; i < list.length; i++) {
      try {
        var d = String(list[i] || '').trim().toLowerCase();
        if (!d) continue;
        if (hostMatches(host, d)) return true;
      } catch (e) { /* ignore */ }
    }
    return false;
  }

  function applySettings(s) {
    // s 为 null/非法（读取失败）时保持默认值，绝不因此报错。
    if (!s || typeof s !== 'object') { STATE.loaded = true; return; }
    try {
      if (typeof s.enabled === 'boolean') STATE.enabled = s.enabled;
      if (typeof s.popupAggressive === 'boolean') STATE.popupAggressive = s.popupAggressive;
      if (Array.isArray(s.whitelist)) STATE.whitelisted = whitelistHas(currentHost(), s.whitelist);
      // 设置桥（guard-iso.js）直接给出「本页是否白名单」的判定结果
      if (typeof s.whitelisted === 'boolean') STATE.whitelisted = s.whitelisted;
      if (STATE.popupAggressive === true && isActive()) ensureClickGuard();
      log('settings applied', JSON.stringify({
        enabled: STATE.enabled,
        popupAggressive: STATE.popupAggressive,
        whitelisted: STATE.whitelisted
      }));
    } catch (e) { /* ignore */ }
    STATE.loaded = true;
  }

  function loadSettings() {
    var settled = false;
    function finish(settings) {
      if (settled) return;
      settled = true;
      try { applySettings(settings); } catch (e) { /* ignore */ }
    }
    try {
      var storage = null;
      try {
        storage = (typeof chrome !== 'undefined' && chrome && chrome.storage &&
          chrome.storage.local) || null;
      } catch (e) { storage = null; }

      if (storage && typeof storage.get === 'function') {
        try {
          storage.get(SETTINGS_KEY, function (items) {
            var s = null;
            try { s = (items && items[SETTINGS_KEY]) || null; } catch (e) { s = null; }
            finish(s);
          });
          try {
            if (chrome.storage.onChanged &&
              typeof chrome.storage.onChanged.addListener === 'function') {
              chrome.storage.onChanged.addListener(function (changes) {
                try {
                  if (changes && changes[SETTINGS_KEY]) {
                    applySettings(changes[SETTINGS_KEY].newValue);
                  }
                } catch (e) { /* ignore */ }
              });
            }
          } catch (e) { /* ignore */ }
          return;
        } catch (e) { /* 落到 sendMessage 兜底 */ }
      }

      var rt = null;
      try {
        rt = (typeof chrome !== 'undefined' && chrome && chrome.runtime) || null;
      } catch (e) { rt = null; }

      if (rt && typeof rt.sendMessage === 'function') {
        try {
          rt.sendMessage({ type: 'getState' }, function (resp) {
            try { void rt.lastError; } catch (e) { /* 抑制 unchecked lastError */ }
            var s = null;
            try {
              if (resp && typeof resp === 'object') {
                s = (resp.settings && typeof resp.settings === 'object') ? resp.settings : resp;
              }
            } catch (e) { s = null; }
            finish(s);
          });
          return;
        } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
    finish(null);
  }

  /* ------------------------------------------------------------------ *
   * 1.1 设置桥：ISOLATED world（guard-iso.js）→ MAIN world（本文件）
   *   固定协议：window.postMessage({ tag:'adcleaner.settings',
   *     enabled:<bool>, popupAggressive:<bool>, whitelisted:<bool> }, '*')
   *   - 只接受 e.source === window 的同窗消息（跨窗口/iframe 消息一律忽略）；
   *   - 三个字段全部严格类型校验：非 boolean 一律当作「未提供」而忽略，不抛错；
   *   - 一个字段都没提供（或 tag 不符）时整条消息忽略；
   *   - 复用已有的 applySettings 更新 STATE（不重写 hook 逻辑），
   *     aggressive 打开时 applySettings 会自行补装合成点击拦截。
   *   chrome.storage / sendMessage 读取保持原样作为兜底，两者结果一致时互不干扰。
   * ------------------------------------------------------------------ */

  function applyBridgeSettings(data) {
    var patch = {};
    var provided = false;
    if (typeof data.enabled === 'boolean') { patch.enabled = data.enabled; provided = true; }
    if (typeof data.popupAggressive === 'boolean') {
      patch.popupAggressive = data.popupAggressive;
      provided = true;
    }
    if (typeof data.whitelisted === 'boolean') { patch.whitelisted = data.whitelisted; provided = true; }
    if (!provided) return;      // 缺省/类型不符 -> 忽略整条消息
    applySettings(patch);
    log('settings bridge applied', JSON.stringify(patch));
  }

  function onSettingsMessage(ev) {
    try {
      if (!ev || ev.source !== window) return;      // 只信同窗口的消息
      var data = ev.data;
      if (!data || typeof data !== 'object') return;
      if (data.tag !== 'adcleaner.settings') return;
      applyBridgeSettings(data);
    } catch (e) { /* ignore：坏消息不影响页面 */ }
  }

  function installSettingsBridge() {
    try {
      if (!window || typeof window.addEventListener !== 'function') return;
      window.addEventListener('message', onSettingsMessage, false);
    } catch (e) { log('installSettingsBridge failed', e && e.message); }
  }

  /* ================================================================== *
   * 2. 反指纹：被代理/包装的函数 toString 仍返回 [native code]
   * ================================================================== */

  var proxyMap = new WeakMap();   // wrapper|proxy -> 原函数

  function preserveFnShape(wrapper, orig) {
    try {
      if (typeof orig.name === 'string') {
        Object.defineProperty(wrapper, 'name', { value: orig.name, configurable: true });
      }
    } catch (e) { /* ignore */ }
    try {
      if (typeof orig.length === 'number') {
        Object.defineProperty(wrapper, 'length', { value: orig.length, configurable: true });
      }
    } catch (e) { /* ignore */ }
  }

  function installToStringHook() {
    try {
      var origToString = Function.prototype.toString;
      var patched = function toString() {
        try {
          var orig = proxyMap.get(this);
          if (typeof orig === 'function') return origToString.call(orig);
        } catch (e) { /* 落到原始分支 */ }
        return origToString.call(this);
      };
      // 让 patched 自己看起来也是原生的
      try { proxyMap.set(patched, origToString); } catch (e) { /* ignore */ }
      try {
        Object.defineProperty(Function.prototype, 'toString', {
          value: patched,
          writable: true,
          enumerable: false,
          configurable: true
        });
      } catch (e) {
        Function.prototype.toString = patched;
      }
    } catch (e) { /* ignore */ }
  }

  function proxyFn(orig, applyHandler) {
    var proxy = new Proxy(orig, { apply: applyHandler });
    try { proxyMap.set(proxy, orig); } catch (e) { /* ignore */ }
    return proxy;
  }

  /* ================================================================== *
   * 3. 弹窗 guard（window.open 代理 + 可选 aggressive 合成点击拦截）
   * ================================================================== */

  // 明确广告模式表（SPEC §7.1）。不要加入过宽模式，避免误伤。
  var POPUP_PATTERNS = [
    /popunder/i,
    /jspopunder/i,
    /popunderjs/i,
    /uptopopunder/i,
    /adcash/i,
    /\/aclk\?/i,
    /googleadservices\.com\/pagead/i,
    /googlesyndication\.com/i,
    /doubleclick\.net/i,
    /cpro\.baidu\.com/i,
    /pos\.baidu\.com/i,
    /cupid\.iqiyi\.com\/show2/i,
    /ad\.youku\.com/i,
    /adsmind\.gdtimg\.com/i
  ];

  // 绝不拦截：登录/支付/客服/分享等正常弹窗
  var SAFE_POPUP_RE = /(?:oauth|login|passport|pay|checkout|kefu|customer|support|share)/i;

  // prevent-window-open(pattern) 追加的模式（站点规则可扩展）
  var extraOpenPatterns = [];

  function openArgsToString(args) {
    var s = '';
    try {
      for (var i = 0; i < args.length; i++) {
        var a = args[i];
        if (a === null || a === undefined) continue;
        s += (typeof a === 'string' ? a : String(a)) + ' ';
      }
    } catch (e) { /* ignore */ }
    return s;
  }

  function shouldBlockOpen(args) {
    try {
      if (!isActive()) return false;
      var s = openArgsToString(args);
      if (!s) return false;
      if (SAFE_POPUP_RE.test(s)) return false;
      if (matchesAny(POPUP_PATTERNS, s)) return true;
      if (matchesAny(extraOpenPatterns, s)) return true;
    } catch (e) { /* ignore */ }
    return false;
  }

  function installOpenGuard() {
    try {
      var current = window.open;
      if (typeof current !== 'function') return;
      if (typeof Proxy !== 'function' || typeof Reflect === 'undefined') return;

      var desc = null;
      try { desc = Object.getOwnPropertyDescriptor(window, 'open'); } catch (e) { desc = null; }

      var proxy = proxyFn(current, function (target, thisArg, argsList) {
        try {
          if (shouldBlockOpen(argsList)) {
            log('blocked window.open', openArgsToString(argsList).slice(0, 200));
            return null;
          }
        } catch (e) { /* ignore */ }
        return Reflect.apply(target, thisArg, argsList);
      });

      var attrs = desc || { writable: true, enumerable: true, configurable: true };
      try {
        Object.defineProperty(window, 'open', {
          value: proxy,
          writable: attrs.writable !== false,
          enumerable: attrs.enumerable === true,
          configurable: attrs.configurable !== false
        });
      } catch (e) {
        window.open = proxy;   // 保底：descriptor 异常时退回直接赋值
      }
    } catch (e) { log('installOpenGuard failed', e && e.message); }
  }

  var clickGuardInstalled = false;

  function ensureClickGuard() {
    if (clickGuardInstalled) return;
    try {
      var target = window;
      if (!target || typeof target.addEventListener !== 'function') target = document;
      if (!target || typeof target.addEventListener !== 'function') return;
      clickGuardInstalled = true;
      target.addEventListener('click', onClickCapture, true);
    } catch (e) { clickGuardInstalled = false; }
  }

  // 仅 aggressive：拦截“合成点击 + 目标/祖先 onclick 文本含 open(”的弹窗触发
  function onClickCapture(ev) {
    try {
      if (!isActive() || STATE.popupAggressive !== true) return;
      if (!ev || ev.isTrusted !== false) return;
      var el = ev.target || null;
      var depth = 0;
      while (el && depth < 8) {
        depth++;
        if (typeof el.getAttribute === 'function') {
          var oc = null;
          try { oc = el.getAttribute('onclick'); } catch (e) { oc = null; }
          if (typeof oc === 'string' &&
            (oc.indexOf('open(') !== -1 || oc.indexOf('window.open') !== -1)) {
            try {
              if (typeof ev.stopImmediatePropagation === 'function') ev.stopImmediatePropagation();
            } catch (e) { /* ignore */ }
            try {
              if (typeof ev.preventDefault === 'function') ev.preventDefault();
            } catch (e) { /* ignore */ }
            log('blocked synthetic click -> open()');
            return;
          }
        }
        el = el.parentElement || null;
      }
    } catch (e) { /* ignore */ }
  }

  /* ================================================================== *
   * 4. 站点规则表（内联；host 后缀匹配，子域自动覆盖）
   * ================================================================== */

  var PRUNE_SPECS = [];          // { url: RegExp, paths: [string], guard?: [string] }
  var NO_FETCH_PATTERNS = [];    // RegExp[]
  var NO_XHR_PATTERNS = [];      // RegExp[]
  var ASSIGN_HANDLERS = [];      // (obj) => void，作用于 Object.assign 的 target+sources
  var TIMER_RULES = { setTimeout: [], setInterval: [] };

  // 与 DNR popups.json 对齐的纵深防御：popunder 端点不属于任何正常页面
  var POPUNDER_RE = /popunder|jspopunder|popunderjs|uptopopunder|adcash/i;
  NO_FETCH_PATTERNS.push(POPUNDER_RE);
  NO_XHR_PATTERNS.push(POPUNDER_RE);

  var SITE_RULES = [
    {
      // iqiyi.com（含 www./m. 等子域）
      hosts: ['iqiyi.com'],
      rules: [
        { type: 'set-constant', path: 'Object.prototype.blackscreenDuration', value: 1 },
        { type: 'set-constant', path: 'Object.prototype.parseXML', value: function () {} },
        { type: 'set-constant', path: 'QiyiPlayerProphetData.a.data', value: {} },
        { type: 'adjust-setInterval', match: /adUI/, delay: 1000, mult: 0.02 },
        { type: 'iqiyi-adSlots' },
        { type: 'no-fetch-if', url: /cupid\.iqiyi\.com\/show2/i }   // 与 video.json 的 block 一致
      ]
    },
    {
      // v.qq.com（后缀匹配同时覆盖 qq.com 其他子域）
      hosts: ['v.qq.com', 'qq.com'],
      rules: [
        { type: 'json-prune', url: /qq\.com/i, paths: ['ads', 'ad', 'material.video'] },
        { type: 'set-constant', path: 'CreativePlayerwebPlugin.AD_EVENT.AD_DESTROY', value: '' },
        { type: 'set-constant', path: 'CreativePlayerwebPlugin.AD_EVENT.AD_LOAD_START', value: '' },
        { type: 'no-xhr-if', url: /ssp\.qq\.com\/ad/i }
      ]
    },
    {
      hosts: ['youku.com'],
      rules: [
        { type: 'set-constant', path: 'Object.prototype.adData', value: {} },
        { type: 'set-constant', path: 'Object.prototype._adData', value: {} },
        // SPEC §7.2：全部 ×0.02；maxDelay 上限保护超长会话/心跳定时器（见文件头限制）
        { type: 'adjust-setTimeout', mult: 0.02, maxDelay: 120000 },
        { type: 'no-fetch-if', url: /ad\.youku\.com/i }
      ]
    },
    {
      hosts: ['le.com'],
      rules: [
        { type: 'set-constant', path: 'isAdLoaded', value: true },
        { type: 'set-constant', path: 'Object.prototype.noAD', value: true }
      ]
    },
    {
      hosts: ['bilibili.com'],
      rules: [
        { type: 'json-prune', url: /bilibili\.com\/(?:x\/|pgc\/)/i, paths: ['data.cm_info.ads', 'business_info.ad_desc'] }
      ]
    },
    {
      // m.youtube.com / music.youtube.com 由后缀匹配覆盖
      hosts: ['youtube.com'],
      rules: [
        { type: 'set-constant', path: 'ytInitialPlayerResponse.adPlacements', value: undefined },
        {
          type: 'json-prune',
          url: /(?:youtubei\/v1\/player|\/get_watch|playlist)/i,
          paths: ['adPlacements', 'adSlots', 'playerAds'],
          guard: ['videoDetails', 'streamingData', 'playabilityStatus', 'responseContext']
        },
        { type: 'yt-assign' },
        { type: 'set-constant', path: 'ytcfg.data_.EXPERIMENT_FLAGS.all_web_enable_network_machine', value: false },
        { type: 'yt-ssap' }
      ]
    }
  ];

  /* ================================================================== *
   * 5. scriptlet-lite 原语实现
   * ================================================================== */

  /* ---- 5.1 set-constant -------------------------------------------- */

  function setConstantNow(rule) {
    try {
      var parts = String(rule.path || '').split('.');
      if (!parts.length || !parts[0]) return true;

      var owner = null;
      var start = 0;
      if (parts.length >= 2 && (parts[0] === 'window' || parts[0] === 'self')) {
        owner = window; start = 1;
      } else if (parts.length >= 2 && parts[0] === 'Object' && parts[1] === 'prototype') {
        owner = Object.prototype; start = 2;
      } else {
        owner = window; start = 0;
      }
      if (start >= parts.length) return true;

      for (var i = start; i < parts.length - 1; i++) {
        var next = owner[parts[i]];
        if (next === null || next === undefined) return false;         // 中间对象未就绪 -> 重试
        if (typeof next !== 'object' && typeof next !== 'function') return true; // 类型不对 -> 放弃
        owner = next;
      }

      var last = parts[parts.length - 1];
      var value = rule.value;
      var prev = null;
      try { prev = Object.getOwnPropertyDescriptor(owner, last); } catch (e) { prev = null; }

      Object.defineProperty(owner, last, {
        get: function () {
          if (!isActive()) {
            // 扩展被停用/白名单命中：尽量交还原值
            if (prev) {
              if (typeof prev.get === 'function') {
                try { return prev.get.call(this); } catch (e) { /* ignore */ }
              } else if (hasOwn.call(prev, 'value')) {
                return prev.value;
              }
            }
            return undefined;
          }
          return value;
        },
        set: function () { /* 吞掉站点写回，脚本块语义要求常量 */ },
        enumerable: false,
        configurable: true
      });
      return true;
    } catch (e) {
      return true;   // 出现异常时不再重试，静默放弃该规则
    }
  }

  function scheduleSetConstant(rule) {
    var tries = 0;
    function attempt() {
      tries++;
      var ok = false;
      try { ok = setConstantNow(rule); } catch (e) { ok = true; }
      if (ok) { log('set-constant ok', rule.path); return; }
      if (tries < 10) nativeTimeout(attempt, 500);   // 最多 5s
    }
    attempt();
  }

  /* ---- 5.2 json-prune ---------------------------------------------- */

  function prunePath(root, path) {
    try {
      var parts = String(path).split('.');
      var node = root;
      for (var i = 0; i < parts.length - 1; i++) {
        if (!node || typeof node !== 'object') return false;
        node = node[parts[i]];
      }
      if (!node || typeof node !== 'object') return false;
      var last = parts[parts.length - 1];
      if (!hasOwn.call(node, last)) return false;
      var cur = node[last];
      if (Array.isArray(cur)) {
        if (cur.length === 0) return false;
        node[last] = [];
        return true;
      }
      try {
        delete node[last];
        return true;
      } catch (e) {
        try { node[last] = undefined; return true; } catch (e2) { return false; }
      }
    } catch (e) { return false; }
  }

  function pruneObjectInPlace(obj, specs) {
    var changed = false;
    try {
      for (var i = 0; i < specs.length; i++) {
        var paths = specs[i].paths || [];
        for (var p = 0; p < paths.length; p++) {
          if (prunePath(obj, paths[p])) changed = true;
        }
      }
    } catch (e) { /* ignore */ }
    return changed;
  }

  function pruneSpecsForUrl(url) {
    var out = [];
    if (!url) return out;
    for (var i = 0; i < PRUNE_SPECS.length; i++) {
      try {
        if (PRUNE_SPECS[i].url && PRUNE_SPECS[i].url.test(url)) out.push(PRUNE_SPECS[i]);
      } catch (e) { /* ignore */ }
    }
    return out;
  }

  // 文本层改写：返回 null 表示“未改动/不可解析”
  function pruneJSONText(text, specs) {
    try {
      if (typeof text !== 'string') return null;
      var t = text.replace(/^\uFEFF/, '');
      var i = 0;
      while (i < t.length && /\s/.test(t.charAt(i))) i++;
      var c = t.charAt(i);
      if (c !== '{' && c !== '[') return null;
      var obj = jsonParseNative(text);
      if (!obj || typeof obj !== 'object') return null;
      if (!pruneObjectInPlace(obj, specs)) return null;
      var out = jsonStringifyNative(obj);
      if (typeof out !== 'string') return null;
      return { changed: true, text: out, value: obj };
    } catch (e) { return null; }
  }

  /* ---- 5.3 fetch hook（json-prune + no-fetch-if） ------------------- */

  function fetchUrlOf(input) {
    try {
      if (typeof input === 'string') return input;
      if (input && typeof input === 'object') {
        if (typeof input.url === 'string') return input.url;
        if (typeof input.href === 'string') return input.href;
      }
    } catch (e) { /* ignore */ }
    return '';
  }

  function pruneFetchResponse(res, specs) {
    try {
      if (!res || typeof res !== 'object') return res;
      if (typeof res.clone !== 'function') return res;
      var status = typeof res.status === 'number' ? res.status : 200;
      if (status === 204 || status === 205 || status === 304) return res;

      var textPromise = null;
      try { textPromise = res.clone().text(); } catch (e) { return res; }
      if (!textPromise || typeof textPromise.then !== 'function') return res;

      return textPromise.then(function (text) {
        try {
          var pruned = pruneJSONText(text, specs);
          if (!pruned) return res;
          var headers = null;
          try {
            headers = new window.Headers();
            if (res.headers && typeof res.headers.forEach === 'function') {
              res.headers.forEach(function (v, k) {
                try { headers.append(k, v); } catch (e) { /* ignore */ }
              });
            }
            try { headers.delete('content-length'); } catch (e) { /* ignore */ }
          } catch (e) { headers = null; }

          var init = {
            status: status,
            statusText: typeof res.statusText === 'string' ? res.statusText : ''
          };
          if (headers) init.headers = headers;
          return new window.Response(pruned.text, init);
        } catch (e) { return res; }
      }).catch(function () { return res; });
    } catch (e) { return res; }
  }

  function installFetchHook() {
    try {
      var origFetch = window.fetch;
      if (typeof origFetch !== 'function') return;

      var wrapper = function fetch(input, init) {
        var url = '';
        try { url = String(fetchUrlOf(input) || ''); } catch (e) { url = ''; }
        try {
          if (url && isActive()) {
            if (matchesAny(NO_FETCH_PATTERNS, url)) {
              log('no-fetch-if', url.slice(0, 200));
              return Promise.reject(new TypeError('Failed to fetch'));
            }
            var specs = pruneSpecsForUrl(url);
            if (specs.length) {
              var p = origFetch.apply(this, arguments);
              if (p && typeof p.then === 'function') {
                return p.then(function (res) {
                  try { return pruneFetchResponse(res, specs); } catch (e) { return res; }
                });
              }
              return p;
            }
          }
        } catch (e) { /* ignore -> 原行为 */ }
        return origFetch.apply(this, arguments);
      };
      preserveFnShape(wrapper, origFetch);
      try { proxyMap.set(wrapper, origFetch); } catch (e) { /* ignore */ }
      window.fetch = wrapper;
    } catch (e) { log('installFetchHook failed', e && e.message); }
  }

  /* ---- 5.4 XHR hook（json-prune + no-xhr-if） ---------------------- */

  function makeEvent(type) {
    try {
      if (window.Event) return new window.Event(type);
    } catch (e) { /* ignore */ }
    return { type: type };
  }

  function installXhrHook() {
    try {
      var XHR = window.XMLHttpRequest;
      if (!XHR || !XHR.prototype) return;
      var proto = XHR.prototype;
      var origOpen = proto.open;
      var origSend = proto.send;
      if (typeof origOpen !== 'function' || typeof origSend !== 'function') return;

      var textDesc = null;
      var respDesc = null;
      try { textDesc = Object.getOwnPropertyDescriptor(proto, 'responseText'); } catch (e) { textDesc = null; }
      try { respDesc = Object.getOwnPropertyDescriptor(proto, 'response'); } catch (e) { respDesc = null; }
      if (!textDesc && !respDesc) return;   // 无法安全影子化，放弃 XHR 改写

      var urlMap = new WeakMap();

      // 影子 getter：在 send 之前装上，保证任何回调顺序下读到的都是改写后的响应
      function shadowResponse(xhr, specs) {
        var cache = { ready: -1, text: null, hasValue: false, value: null };

        if (textDesc && typeof textDesc.get === 'function') {
          try {
            Object.defineProperty(xhr, 'responseText', {
              configurable: true,
              enumerable: true,
              get: function () {
                var raw = textDesc.get.call(this);       // 保留原生异常行为
                if (typeof raw !== 'string' || raw.length === 0) return raw;
                if (cache.text !== null && cache.ready === this.readyState) return cache.text;
                var pruned = pruneJSONText(raw, specs);
                var out = pruned ? pruned.text : raw;
                cache.text = out;
                cache.ready = this.readyState;
                return out;
              }
            });
          } catch (e) { /* ignore */ }
        }

        if (respDesc && typeof respDesc.get === 'function') {
          try {
            Object.defineProperty(xhr, 'response', {
              configurable: true,
              enumerable: true,
              get: function () {
                var raw = respDesc.get.call(this);
                if (raw === null || raw === undefined) return raw;
                if (typeof raw === 'string') {
                  var prunedText = pruneJSONText(raw, specs);
                  return prunedText ? prunedText.text : raw;
                }
                if (typeof raw !== 'object') return raw;
                if (cache.hasValue) return cache.value;
                try { pruneObjectInPlace(raw, specs); } catch (e) { /* ignore */ }
                cache.hasValue = true;
                cache.value = raw;
                return raw;
              }
            });
          } catch (e) { /* ignore */ }
        }
      }

      var openWrapper = function open(method, url) {
        try {
          var u = '';
          if (typeof url === 'string') u = url;
          else if (url && typeof url === 'object' && typeof url.href === 'string') u = url.href;
          urlMap.set(this, u);
        } catch (e) { /* ignore */ }
        return origOpen.apply(this, arguments);
      };
      preserveFnShape(openWrapper, origOpen);
      try { proxyMap.set(openWrapper, origOpen); } catch (e) { /* ignore */ }

      var sendWrapper = function send() {
        try {
          var u = '';
          try { u = urlMap.get(this) || ''; } catch (e) { u = ''; }
          if (u && isActive()) {
            if (matchesAny(NO_XHR_PATTERNS, u)) {
              log('no-xhr-if', u.slice(0, 200));
              var self = this;
              nativeTimeout(function () {
                try { self.dispatchEvent(makeEvent('error')); } catch (e) { /* ignore */ }
                try { self.dispatchEvent(makeEvent('loadend')); } catch (e) { /* ignore */ }
              }, 0);
              return;   // 阻止发送
            }
            var specs = pruneSpecsForUrl(u);
            if (specs.length) shadowResponse(this, specs);
          }
        } catch (e) { /* ignore -> 原行为 */ }
        return origSend.apply(this, arguments);
      };
      preserveFnShape(sendWrapper, origSend);
      try { proxyMap.set(sendWrapper, origSend); } catch (e) { /* ignore */ }

      proto.open = openWrapper;
      proto.send = sendWrapper;
    } catch (e) { log('installXhrHook failed', e && e.message); }
  }

  /* ---- 5.5 adjust-setTimeout / adjust-setInterval -------------------- */

  function timerRuleMatches(rule, handler, timeout) {
    try {
      if (typeof rule.delay === 'number' && timeout !== rule.delay) return false;
      if (rule.match === null || rule.match === undefined) return true;
      var src = '';
      try {
        if (typeof handler === 'function') src = String(handler);
        else if (handler !== null && handler !== undefined) src = String(handler);
      } catch (e) { src = ''; }
      if (!src) {
        try { src = (handler && handler.name) || ''; } catch (e) { src = ''; }
      }
      try { return rule.match.test(src); } catch (e) { return false; }
    } catch (e) { return false; }
  }

  function installTimerHooks() {
    var kinds = ['setTimeout', 'setInterval'];
    for (var k = 0; k < kinds.length; k++) {
      (function (kind) {
        var rules = TIMER_RULES[kind];
        if (!rules || !rules.length) return;
        try {
          var orig = window[kind];
          if (typeof orig !== 'function') return;
          var wrapper = function (handler, timeout) {
            try {
              if (isActive() && typeof timeout === 'number' && rules.length) {
                for (var i = 0; i < rules.length; i++) {
                  var r = rules[i];
                  if (!timerRuleMatches(r, handler, timeout)) continue;
                  if (typeof r.maxDelay === 'number' && timeout > r.maxDelay) continue;
                  var args = slice.call(arguments);
                  var nd = Math.round(timeout * (typeof r.mult === 'number' ? r.mult : 1));
                  if (!isFinite(nd) || nd < 0) nd = 0;
                  args[1] = nd;
                  return orig.apply(window, args);
                }
              }
            } catch (e) { /* ignore -> 原行为 */ }
            return orig.apply(window, arguments);
          };
          preserveFnShape(wrapper, orig);
          try { proxyMap.set(wrapper, orig); } catch (e) { /* ignore */ }
          window[kind] = wrapper;
        } catch (e) { log('installTimerHooks failed', kind, e && e.message); }
      })(kinds[k]);
    }
  }

  /* ---- 5.6 Object.assign 代理（iqiyi-adSlots / YouTube 注入） -------- */

  function iqiyiAdSlotsHandler(obj) {
    try {
      if (!obj || (typeof obj !== 'object' && typeof obj !== 'function')) return;
      if (hasOwn.call(obj, 'adSlots') && Array.isArray(obj.adSlots) && obj.adSlots.length) {
        obj.adSlots = [];
      }
      var pr = obj.playerResponse;
      if (pr && typeof pr === 'object' && hasOwn.call(pr, 'adSlots')) {
        try { delete pr.adSlots; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  function ytAssignHandler(obj) {
    try {
      if (!obj || typeof obj !== 'object') return;
      var pr = obj.playerRequest;
      if (pr && typeof pr === 'object') {
        try { pr.isInlinePlaybackNoAd = true; } catch (e) { /* ignore */ }
        var cpc = pr.contentPlaybackContext;
        if (cpc && typeof cpc === 'object') {
          try { cpc.isInlinePlaybackNoAd = true; } catch (e) { /* ignore */ }
        }
      }
      var ctx = obj.contentPlaybackContext;
      if (ctx && typeof ctx === 'object') {
        try { ctx.isInlinePlaybackNoAd = true; } catch (e) { /* ignore */ }
      }
    } catch (e) { /* ignore */ }
  }

  function installAssignHook() {
    if (!ASSIGN_HANDLERS.length) return;
    try {
      var orig = Object.assign;
      if (typeof orig !== 'function') return;
      var wrapper = function assign() {
        try {
          if (isActive()) {
            for (var i = 0; i < arguments.length; i++) {
              var src = arguments[i];
              if (!src || (typeof src !== 'object' && typeof src !== 'function')) continue;
              for (var h = 0; h < ASSIGN_HANDLERS.length; h++) {
                try { ASSIGN_HANDLERS[h](src); } catch (e) { /* ignore */ }
              }
            }
          }
        } catch (e) { /* ignore */ }
        return orig.apply(this, arguments);
      };
      preserveFnShape(wrapper, orig);
      try { proxyMap.set(wrapper, orig); } catch (e) { /* ignore */ }
      Object.defineProperty(Object, 'assign', {
        value: wrapper,
        writable: true,
        enumerable: false,
        configurable: true
      });
    } catch (e) { log('installAssignHook failed', e && e.message); }
  }

  /* ---- 5.7 腾讯反绕过：隐藏 iframe 的 JSON 影子 ---------------------- */

  function installIframeJsonHook() {
    if (!PRUNE_SPECS.length) return;    // 仅在存在 json-prune 规则的站点启用
    try {
      var NodeCtor = window.Node;
      var ElementCtor = window.Element;
      if (!NodeCtor || !NodeCtor.prototype || typeof NodeCtor.prototype.appendChild !== 'function') return;

      var origAppend = NodeCtor.prototype.appendChild;
      var origInsert = (ElementCtor && ElementCtor.prototype &&
        typeof ElementCtor.prototype.insertAdjacentElement === 'function')
        ? ElementCtor.prototype.insertAdjacentElement : null;

      function patchIframe(node) {
        try {
          if (!node || node.nodeName !== 'IFRAME') return;
          var style = '';
          if (typeof node.getAttribute === 'function') {
            style = String(node.getAttribute('style') || '');
          } else if (node.style && typeof node.style.cssText === 'string') {
            style = node.style.cssText;
          }
          if (!/display\s*:\s*none/i.test(style)) return;
          if (typeof node.getAttribute === 'function' && node.getAttribute('src')) return;
          if (node.src) return;
          var cw = node.contentWindow;
          if (!cw) return;
          try {
            Object.defineProperty(cw, 'JSON', {
              value: window.JSON,
              writable: true,
              enumerable: false,
              configurable: true
            });
          } catch (e) {
            try { cw.JSON = window.JSON; } catch (e2) { /* ignore */ }
          }
        } catch (e) { /* ignore */ }
      }

      var appendWrapper = function appendChild(node) {
        var r = origAppend.apply(this, arguments);   // 先成功插入，再补 JSON 影子
        try { patchIframe(node); } catch (e) { /* ignore */ }
        return r;
      };
      preserveFnShape(appendWrapper, origAppend);
      try { proxyMap.set(appendWrapper, origAppend); } catch (e) { /* ignore */ }
      NodeCtor.prototype.appendChild = appendWrapper;

      if (origInsert) {
        var insertWrapper = function insertAdjacentElement(position, element) {
          var r = origInsert.apply(this, arguments);
          try { patchIframe(element); } catch (e) { /* ignore */ }
          return r;
        };
        preserveFnShape(insertWrapper, origInsert);
        try { proxyMap.set(insertWrapper, origInsert); } catch (e) { /* ignore */ }
        ElementCtor.prototype.insertAdjacentElement = insertWrapper;
      }
    } catch (e) { log('installIframeJsonHook failed', e && e.message); }
  }

  /* ---- 5.8 JSON.parse 包装（仅带 guard 的 spec，如 YouTube） ---------- */

  function installJSONParseHook() {
    try {
      var JSONObj = window.JSON;
      if (!JSONObj || typeof JSONObj.parse !== 'function') return;

      var guarded = [];
      for (var i = 0; i < PRUNE_SPECS.length; i++) {
        var sp = PRUNE_SPECS[i];
        if (sp.guard && sp.guard.length) guarded.push(sp);
      }
      if (!guarded.length) return;

      var origParse = JSONObj.parse;
      var wrapper = function parse() {
        var result = origParse.apply(this, arguments);
        try {
          if (isActive() && result && typeof result === 'object') {
            for (var i = 0; i < guarded.length; i++) {
              var spec = guarded[i];
              var marker = false;
              for (var g = 0; g < spec.guard.length; g++) {
                if (hasOwn.call(result, spec.guard[g])) { marker = true; break; }
              }
              if (!marker) continue;   // 不像目标结构 -> 完全不动
              for (var p = 0; p < spec.paths.length; p++) prunePath(result, spec.paths[p]);
            }
          }
        } catch (e) { /* ignore */ }
        return result;
      };
      preserveFnShape(wrapper, origParse);
      try { proxyMap.set(wrapper, origParse); } catch (e) { /* ignore */ }
      Object.defineProperty(JSONObj, 'parse', {
        value: wrapper,
        writable: true,
        enumerable: false,
        configurable: true
      });
    } catch (e) { log('installJSONParseHook failed', e && e.message); }
  }

  /* ---- 5.9 YouTube SSAP 跳过 ---------------------------------------- */

  var ssapStarted = false;

  function startSsapSkip() {
    if (ssapStarted) return;
    ssapStarted = true;
    nativeInterval(function () {
      try {
        var doc = window.document;
        if (!doc || typeof doc.getElementById !== 'function') return;
        var player = doc.getElementById('movie_player');
        if (!player || typeof player.getStatsForNerds !== 'function') return;
        var stats = player.getStatsForNerds();
        if (!stats) return;
        var info = stats.debug_info;
        if (Array.isArray(info)) info = info.join(' ');
        info = info === undefined || info === null ? '' : String(info);
        if (info.indexOf('SSAP, AD') !== 0) return;
        var st = typeof player.getProgressState === 'function' ? player.getProgressState() : null;
        var dur = st && typeof st.duration === 'number' && isFinite(st.duration) ? st.duration : 0;
        if (!(dur > 0)) return;
        if (typeof player.seekTo === 'function') {
          player.seekTo(dur);
          log('SSAP seekTo', dur);
        }
      } catch (e) { /* ignore */ }
    }, 500);
  }

  /* ================================================================== *
   * 6. 规则应用
   * ================================================================== */

  function applyRule(rule) {
    if (!rule || !rule.type) return;
    try {
      switch (rule.type) {
        case 'set-constant':
          if (hasOwn.call(rule, 'value')) scheduleSetConstant(rule);
          break;
        case 'json-prune':
          PRUNE_SPECS.push({
            url: rule.url || null,
            paths: rule.paths || [],
            guard: rule.guard || null
          });
          break;
        case 'no-fetch-if':
          if (rule.url) NO_FETCH_PATTERNS.push(rule.url);
          break;
        case 'no-xhr-if':
          if (rule.url) NO_XHR_PATTERNS.push(rule.url);
          break;
        case 'adjust-setTimeout':
        case 'adjust-setInterval':
          TIMER_RULES[rule.type === 'adjust-setTimeout' ? 'setTimeout' : 'setInterval'].push(rule);
          break;
        case 'prevent-window-open': {
          var ps = rule.patterns || (rule.pattern ? [rule.pattern] : []);
          for (var i = 0; i < ps.length; i++) extraOpenPatterns.push(ps[i]);
          break;
        }
        case 'iqiyi-adSlots':
          ASSIGN_HANDLERS.push(iqiyiAdSlotsHandler);
          break;
        case 'yt-assign':
          ASSIGN_HANDLERS.push(ytAssignHandler);
          break;
        case 'yt-ssap':
          startSsapSkip();
          break;
        default:
          break;
      }
    } catch (e) { log('applyRule failed', rule.type, e && e.message); }
  }

  function applyHostRules(host) {
    if (!host) return;
    for (var i = 0; i < SITE_RULES.length; i++) {
      var entry = SITE_RULES[i];
      if (!entry || !entry.hosts) continue;
      var matched = false;
      for (var j = 0; j < entry.hosts.length; j++) {
        if (hostMatches(host, entry.hosts[j])) { matched = true; break; }
      }
      if (!matched) continue;
      var rules = entry.rules || [];
      for (var k = 0; k < rules.length; k++) applyRule(rules[k]);
    }
  }

  /* ================================================================== *
   * 7. 启动（同步安装关键 hook，最后异步读设置）
   * ================================================================== */

  function boot() {
    installToStringHook();     // 必须最先，代理依赖它保持 [native code]
    installOpenGuard();        // 弹窗 guard：document_start 同步
    applyHostRules(currentHost());
    installFetchHook();
    installXhrHook();
    installTimerHooks();
    installAssignHook();
    installIframeJsonHook();
    installJSONParseHook();
    if (STATE.popupAggressive === true) ensureClickGuard();
    installSettingsBridge();   // ISOLATED world 设置桥：同步装好监听，不依赖 storage 读取
    loadSettings();            // 异步；失败按默认值（aggressive=false）
    log('booted on', currentHost());
  }

  boot();
})();
