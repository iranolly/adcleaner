// ==UserScript==
// @name         AdCleaner 清道夫（油猴版）
// @namespace    adcleaner.local
// @version      1.0.0
// @description  油猴版：**无网络层拦截**（无 DNR/无请求过滤），仅做页面层处理——元素隐藏 + 视频广告跳过 + 搜索广告清理 + 弹窗 guard（window.open 智能拦截）。数据与扩展版同源（tools/build-userscript.mjs 内联生成）。
// @author       AdCleaner
// @match        *://*/*
// @run-at       document-start
// @grant        none
// ==/UserScript==
/* AdCleaner userscript（由 tools/build-userscript.mjs 从 userscript/template.js 生成，请勿直接编辑 adcleaner.user.js）
 * =============================================================================
 * 数据内联：const AD_DATA = { cosmetics: <src/data/cosmetics.json>, videoSites: <src/data/video-sites.json> }
 * 样式内联：const AD_CSS = <extension/src/content/cosmetic.css 全文>（静态元素隐藏规则，构建时内联并校验）
 * 功能（SPEC 8.4）：
 *   1) 弹窗 guard = SPEC 7.1 的 smart 模式子集（不含 aggressive 合成点击部分；无设置界面，永远 smart）
 *   2) cosmetics 应用：host 后缀匹配 → 逐条 <style> 注入（坏选择器只丢弃自己）
 *   3) 视频状态机：SPEC 8.2 简化版（同样遵守「记录并精确还原用户静音/倍速」「只在明确广告态动 video」
 *      「直播/长时长禁止 seek」）。可选 aggressive generic 模式：localStorage['adcleaner.videoAggressive']='1' 时启用
 *      P1-2 安全阀（与扩展版一致）：广告态存在性 = 非空 且（可见 或 被我们自己的 CSS 遮住）；
 *      强广告态连续存在超过该站 maxAdSeconds（缺失回落 generic 180s）→ 强制还原并忽略，直到选择器全部消失。
 *   4) 搜索广告清理：Google/Bing/百度/搜狗/360/DuckDuckGo（内联选择器，元素内联隐藏 + debounce 扫描）
 *   5) 白名单：localStorage['adcleaner.whitelist']（JSON 数组，纯小写域名，后缀匹配）；命中即整体不执行
 * 统计上报：油猴版不要求（SPEC 8.4），故本文件没有统计逻辑。
 *
 * 与扩展版的关键差异：@grant none 下脚本运行在页面上下文，因此 window.open 代理在页面内生效；
 * 没有 chrome.storage / background，所有开关走 localStorage。
 * 限制：无法拦截网络请求（贴片广告下载仍会发生）、无法处理 YouTube SSAI/SABR 服务端合流广告、
 *       站点反广告拦截（检测 DOM 变化）风险与扩展版一致。
 */
(function () {
  'use strict';

  // ---- 构建期内联的数据（占位符由 tools/build-userscript.mjs 替换为 JSON）----
  const AD_DATA = {
  "cosmetics": {
    "version": "2026-09-29",
    "matchMode": "host-suffix",
    "note": "hosts 为后缀匹配：www.baidu.com 命中 baidu.com；hosts 为 [\"*\"] 表示所有站点。selectors 必须是浏览器原生 CSS（:has() 可用，Chrome>=111）。上游的 contains 类非标准伪类（abp 前缀写法与浏览器私写写法）已全部丢弃，未自造替代实现。所有选择器均为具体 id/class 或带结构约束（:has）的模糊类，禁止 class/id 子串匹配式宽泛写法。来源标注见各组 source 字段。",
    "groups": [
      {
        "hosts": [
          "baidu.com"
        ],
        "source": "EasyList China / AdGuard Chinese + 实测 2026-09-29",
        "note": "百度搜索结果页推广位 + 硬塞的推荐模块。tpl 为百度 SSR 稳定标识：recommend_list_san=右侧相关搜索、right_game_recommend=右侧热门游戏推荐、right_toplist1=百度热搜、recommend_list=结果里的为您推荐词块、app/rs=底部大家还在搜/相关搜索（实测 curl 抓取检索页核实）。a[class*=fengchaoContainer] 匹配的是具体类名前缀（百度凤巢专用），非词根模糊匹配。",
        "selectors": [
          "#content_left > div:has(.ec-tuiguang)",
          "#content_left > div:has(span[data-tuiguang])",
          "#content_right > div:has(span[data-tuiguang])",
          ".c-container:has(.t > a[data-landurl])",
          "div[data-key^=\"ad__\"]",
          "a[class*=\"fengchaoContainer\"]",
          ".ec_ad",
          ".ec-fc-ad-results",
          "#ecl-temai-general",
          "div[tpl=\"recommend_list_san\"]",
          "div[tpl=\"right_game_recommend\"]",
          "div[tpl=\"right_toplist1\"]",
          "div[tpl=\"recommend_list\"]",
          "div[tpl=\"app/rs\"]",
          "#rs_new"
        ]
      },
      {
        "hosts": [
          "sogou.com"
        ],
        "source": "EasyList China / w3 报告 C2（实测新发现）",
        "note": "搜狗结果页推广位。.ad-results 为实测新增（广告容器外框）。",
        "selectors": [
          ".ad_result",
          ".ad-results",
          "#PZL",
          "#PZR",
          "div[id^=\"ad_result_page1_\"]",
          ".tgad-box",
          ".js-ad-item",
          ".pop-tuiguang"
        ]
      },
      {
        "hosts": [
          "so.com",
          "haosou.com",
          "360.cn"
        ],
        "source": "EasyList China / AdGuard Chinese",
        "note": "360 搜索（so.com / haosou.com）推广位与右侧推广位。",
        "selectors": [
          ".g-a-noline[data-md*=\"sad\"]",
          "#e_idea_pp",
          "#e_idea_left",
          "#e_idea_frame_0",
          "#m-spread-left",
          "#so_kw-ad",
          ".res-mediav",
          ".atom-adv",
          "#so_bd-ad"
        ]
      },
      {
        "hosts": [
          "bing.com"
        ],
        "source": "EasyList / AdGuard Chinese",
        "note": "必应搜索结果页广告（左栏与右栏），aclk 链接为必应广告跳转特征。",
        "selectors": [
          "ol#b_results > li.b_algo:has(.b_title a[href^=\"https://www.bing.com/aclk?\"])",
          "ol#b_results > li:has(a[href^=\"https://www.bing.com/aclk?\"])",
          ".b_ad",
          ".pa_sb",
          ".mmaAdCard",
          ".top-ads-separator-enabled",
          ".b_bza_pole"
        ]
      },
      {
        "hosts": [
          "google.com",
          "google.com.hk",
          "google.com.tw",
          "google.co.jp",
          "google.co.uk",
          "google.de",
          "google.fr",
          "google.cn"
        ],
        "source": "uBlock Origin uAssets / EasyList",
        "note": "Google 搜索结果页广告（顶部/底部/右侧购物单元）。OcdnDb 等短类名为 Google 自己的广告容器标记。",
        "selectors": [
          "#tads[aria-label]",
          "#tadsb[aria-label]",
          ".uEierd",
          ".cu-container",
          "div[data-text-ad]",
          "a[href^=\"/aclk?sa=\"]",
          "div[data-is-ad=\"1\"]",
          ".commercial-unit-desktop-rhs",
          ".OcdnDb"
        ]
      },
      {
        "hosts": [
          "duckduckgo.com"
        ],
        "source": "EasyList",
        "note": "DuckDuckGo 常规结果页广告。",
        "selectors": [
          ".result--ad",
          "a[href*=\"duckduckgo.com/y.js?\"]",
          ".result__badge-wrap:has(button.badge--ad)"
        ]
      },
      {
        "hosts": [
          "lite.duckduckgo.com"
        ],
        "source": "EasyList",
        "note": "DuckDuckGo lite 版结果页广告行。",
        "selectors": [
          "tr.result-sponsored"
        ]
      },
      {
        "hosts": [
          "youtube.com"
        ],
        "source": "uBlock Origin uAssets / EasyList",
        "note": "YouTube 静态广告层（播放器广告 UI）。SSAI/SABR 服务端合流广告无法用 CSS 处理，见 guard-iso 视频状态机与 SPEC 0 节限制。",
        "selectors": [
          ".video-ads",
          ".ytp-ad-overlay-container",
          ".ytp-ad-module"
        ]
      },
      {
        "hosts": [
          "iqiyi.com"
        ],
        "source": "AdGuard Chinese / EasyList China",
        "note": "爱奇艺暂停广告层与黑屏广告层。",
        "selectors": [
          ".maxPauseAd-container",
          ".overlayAd-container",
          ".definitionAd-container",
          ".black-screen[data-cupid=\"adblock-blackscreen\"]"
        ]
      },
      {
        "hosts": [
          "v.qq.com"
        ],
        "source": "AdGuard Chinese / EasyList China",
        "note": "腾讯视频贴片/暂停/侧边广告层。仅按 v.qq.com 限定，避免影响 qq.com 其它页面。",
        "selectors": [
          ".txp_ad",
          ".txp_zt",
          ".txp_ad_center",
          ".game-switch-ad",
          ".player-side-ads"
        ]
      },
      {
        "hosts": [
          "youku.com"
        ],
        "source": "AdGuard Chinese / EasyList China",
        "note": "优酷暂停广告层、播放器广告层与历史记录页广告包裹。",
        "selectors": [
          "#youku-pause-container",
          ".youku-advertise-layer",
          "#player-advertise",
          "div[data-adext]",
          ".historyrecord_adwrap"
        ]
      },
      {
        "hosts": [
          "mgtv.com"
        ],
        "source": "AdGuard Chinese",
        "note": "芒果 TV 广告层。",
        "selectors": [
          ".as_stages-wrapper",
          "mango-ad-layer",
          "mango-ad-outter-layer"
        ]
      },
      {
        "hosts": [
          "sohu.com"
        ],
        "source": "AdGuard Chinese / EasyList China",
        "note": "搜狐视频贴片/底部广告位（#miaozhenad 为秒针广告容器）。",
        "selectors": [
          "#miaozhenad",
          ".middle-insert-ad",
          "#bottomBanner"
        ]
      },
      {
        "hosts": [
          "le.com"
        ],
        "source": "AdGuard Chinese",
        "note": "乐视视频广告层。",
        "selectors": [
          ".min_pause_img",
          ".ad_layer",
          ".broadcast-adv"
        ]
      },
      {
        "hosts": [
          "bilibili.com"
        ],
        "source": "AdGuard Chinese / uBlock Origin uAssets",
        "note": "B 站首页/动态/播放页广告卡片。最后一条用图标 path 前缀约束「推荐位中的广告卡」，避免误伤普通视频卡。",
        "selectors": [
          ".ad-report",
          ".ad-floor",
          ".gg-floor-module",
          ".bili-dyn-ads",
          ".eva-banner",
          ".adcard-content",
          ".ad-f",
          ".ad-e1",
          ".banner-card",
          ".index-promote",
          ".bili-video-card.is-rcmd:has(.bili-video-card__stats--icon > path[d^=\"M16.9122\"])"
        ]
      },
      {
        "hosts": [
          "*"
        ],
        "source": "uBlock Origin uAssets / EasyList（通用条目）",
        "note": "全站通用广告容器：Google GPT/AdSense、百度联盟。全部为广告专用 id 或属性，不使用模糊匹配。",
        "selectors": [
          "div[id^=\"div-gpt-ad\"]",
          "div[id^=\"google_ads_\"]",
          "div[id^=\"BAIDU_SSP__wrapper_\"]",
          "iframe[id^=\"google_ads_iframe\"]",
          "iframe[id^=\"aswift_\"]",
          "iframe[src*=\"googlesyndication.com\"]",
          "iframe[src*=\"pagead\"]",
          "ins.adsbygoogle",
          "[data-ad-slot]:not([data-ad-slot=\"\"])",
          "[data-google-query-id]:not([data-google-query-id=\"\"])",
          ".google-auto-placed",
          ".adsbygoogle[data-ad-status=\"unfilled\"]"
        ]
      },
      {
        "hosts": [
          "*"
        ],
        "source": "自研（基于 uBO/uAssets 通用条目 + :has 结构约束，2026-09-29）",
        "note": "有歧义的通用容器类名一律加 :has 结构约束：只有当容器内部确实含广告 iframe/AdSense 单元时才隐藏，避免误伤通知、登录等正常浮层。",
        "selectors": [
          ".overlay:has(> iframe[src*=\"googlesyndication.com\"])",
          ".popup-mask:has(iframe[src*=\"googlesyndication.com\"])",
          "#popups:has(iframe[src*=\"googlesyndication.com\"])",
          ".modal-ad:has(iframe[src*=\"doubleclick.net\"])",
          ".float-layer:has(iframe[src*=\"pagead\"])",
          ".ad-slot:has(ins.adsbygoogle)",
          ".ad-wrap:has(ins.adsbygoogle)",
          ".ad-container:has(ins.adsbygoogle)",
          ".ad-frame:has(iframe[src*=\"googlesyndication.com\"])"
        ]
      }
    ]
  },
  "videoSites": {
    "sites": {
      "youtube.com": {
        "video": "#movie_player video.html5-main-video, video.html5-main-video",
        "adState": [
          ".html5-video-player.ad-showing",
          ".html5-video-player.ad-interrupting",
          ".ytp-ad-player-overlay"
        ],
        "skip": [
          "button.ytp-skip-ad-button",
          "button.ytp-ad-skip-button-modern",
          "button.ytp-ad-skip-button",
          ".ytp-ad-skip-button-container button"
        ],
        "pauseAd": {
          "containers": [],
          "close": []
        },
        "maxAdSeconds": 999,
        "actions": [
          "click",
          "mute",
          "speed",
          "seek"
        ]
      },
      "iqiyi.com": {
        "video": "video",
        "adState": [
          ".maxPauseAd-container",
          ".overlayAd-container",
          ".definitionAd-container",
          ".cupid-panel"
        ],
        "skip": [
          ".pause-max-close-btn"
        ],
        "pauseAd": {
          "containers": [
            ".maxPauseAd-container",
            ".pause-max-video-mask"
          ],
          "close": [
            ".pause-max-close-btn"
          ]
        },
        "maxAdSeconds": 300,
        "actions": [
          "pause-close",
          "mute",
          "speed"
        ]
      },
      "v.qq.com": {
        "video": "video",
        "adState": [
          ".txp_ad",
          ".txp_zt",
          ".txp_ad_center"
        ],
        "skip": [
          ".txp_ad_skip_text",
          ".txp_ad_skip",
          ".txp_ad_active_close",
          ".txp_zt_close"
        ],
        "pauseAd": {
          "containers": [
            ".txp_ad_center"
          ],
          "close": []
        },
        "maxAdSeconds": 300,
        "actions": [
          "click",
          "mute",
          "speed",
          "seek"
        ]
      },
      "youku.com": {
        "video": "video",
        "adState": [
          "#youku-pause-container",
          ".youku-advertise-layer",
          "#player-advertise"
        ],
        "skip": [
          "#youku-pause-container [class*=close]",
          ".youku-advertise-layer [class*=close]"
        ],
        "pauseAd": {
          "containers": [
            "#youku-pause-container"
          ],
          "close": []
        },
        "maxAdSeconds": 300,
        "actions": [
          "pause-close",
          "click",
          "mute"
        ]
      },
      "mgtv.com": {
        "video": "video",
        "adState": [
          ".as_stages-wrapper",
          "mango-ad-layer",
          "mango-ad-outter-layer"
        ],
        "skip": [],
        "pauseAd": {
          "containers": [
            ".as_stages-wrapper"
          ],
          "close": []
        },
        "maxAdSeconds": 300,
        "actions": [
          "mute",
          "speed"
        ]
      },
      "sohu.com": {
        "video": "video",
        "adState": [
          "#miaozhenad",
          ".middle-insert-ad"
        ],
        "skip": [],
        "pauseAd": {
          "containers": [
            "#miaozhenad"
          ],
          "close": []
        },
        "maxAdSeconds": 300,
        "actions": [
          "mute",
          "speed"
        ]
      },
      "le.com": {
        "video": "video",
        "adState": [
          ".min_pause_img",
          ".ad_layer",
          ".broadcast-adv"
        ],
        "skip": [],
        "pauseAd": {
          "containers": [
            ".min_pause_img"
          ],
          "close": []
        },
        "maxAdSeconds": 300,
        "actions": [
          "mute",
          "speed"
        ]
      }
    },
    "generic": {
      "video": "video",
      "adState": [],
      "skip": [],
      "pauseAd": {
        "containers": [],
        "close": []
      },
      "maxAdSeconds": 180,
      "actions": [
        "mute",
        "speed"
      ]
    }
  }
};
  // ---- 构建期内联的静态 CSS（占位符由 tools/build-userscript.mjs 替换为 CSS 字符串）----
  // 与扩展版 manifest 静态注入的 extension/src/content/cosmetic.css 同源。
  const AD_CSS = "/* AdCleaner cosmetic.css\n * =============================================================================\n * 用途：manifest 静态注入的元素隐藏规则（content_scripts[].css），是 guard-iso.js\n *       异步注入 src/data/cosmetics.json 规则的同步补充。\n * 依据：SPEC.md 第 8 节 8.1；选择器来源为 EasyList / EasyList China / AdGuard Chinese /\n *       uBlock Origin uAssets（2026-09-29 快照核对）。\n * 原则：只隐藏「不带站点限定也不会误伤」的明确 id / class / 属性选择器。\n *       本文件刻意不使用任何「类名子串匹配」式写法（float / popup / banner / ad 等词\n *       一律不做子串或后缀匹配），因此不会命中正文、按钮、评论区、登录弹窗等正常内容。\n * 站点专属规则（含 :has 结构约束的）见 src/data/cosmetics.json。\n * 限制：纯 CSS，只能隐藏；不处理 JS 注入、不点关闭、不做遮罩解冻（由 guard-iso.js 负责）。\n */\n\n/* 1) 联盟广告容器与 iframe\n *    google_ads_iframe / aswift / googlesyndication / ins.adsbygoogle / data-ad-slot /\n *    div-gpt-ad / BAIDU_SSP 均为广告专用标识，命中即广告。 */\niframe[id^=\"google_ads_iframe\"],\niframe[id^=\"google_ads_frame\"],\niframe[name^=\"google_ads_iframe\"],\niframe[id^=\"aswift_\"],\niframe[src*=\"googlesyndication.com\"],\niframe[src*=\"pubads.g.doubleclick.net\"],\niframe[src*=\"adservice.google.\"],\niframe[src^=\"/pagead/\"],\ndiv[id^=\"div-gpt-ad\"],\ndiv[id^=\"google_ads_\"],\ndiv[id^=\"BAIDU_SSP__wrapper_\"],\nins.adsbygoogle,\n.google-auto-placed,\n[data-ad-slot]:not([data-ad-slot=\"\"]),\n[data-ad-client][data-ad-slot],\n[data-google-query-id]:not([data-google-query-id=\"\"]) {\n  display: none !important;\n}\n\n/* 2) 通用对联条 / 浮动广告位 / 弹窗层\n *    这些 id 与 class 是广告位专用命名，正文区域不会使用。 */\n#cs_left_couplet,\n#cs_right_couplet,\n.ad-couplet-common,\n.adv-couplets,\n#left_float,\n#right_float,\n#left_up_float_ad,\n#left_down_float_ad,\n#right_up_float_ad,\n#right_down_float_ad,\n.floatAd,\n.floating-ad,\n.tanchuang,\n#tanchuang,\n.pop-bottom {\n  display: none !important;\n}\n\n/* 3) 未填充的广告槽位\n *    AdSense 填充失败时会在容器上标记 data-ad-status=\"unfilled\"，隐藏可去掉空白占位。 */\n[data-ad-status=\"unfilled\"]:not([data-ad-status=\"\"]) {\n  display: none !important;\n}\n";

  var TAG = '[AdCleaner]';
  var WL_KEY = 'adcleaner.whitelist';
  var AGGRESSIVE_KEY = 'adcleaner.videoAggressive';

  var TICK_MS = 500;
  var SEEK_HARD_CAP_SECONDS = 240;
  var GENERIC_SHORT_SEEK_SECONDS = 10;
  var RESTORE_DELAY_MIN = 300;
  var RESTORE_DELAY_SPAN = 900;

  /** 弱广告态：广告 UI 覆盖在正片上（或语义不确定）→ 只交给 CSS/隐藏处理，绝不动 video */
  var WEAK_AD_STATES = [
    '.ytp-ad-overlay-container',
    '.ytp-ad-player-overlay',
    '.definitionAd-container',
    '.overlayAd-container',
    '.cupid-panel',
    '.as_stages-wrapper'
  ];

  /** 弹窗 guard（SPEC 7.1 smart 模式）：只拦明确的 popunder / 广告跳转关键词 */
  var POPUP_PATTERNS = [
    /popunder/i, /jspopunder/i, /popunderjs/i, /uptopopunder/i, /adcash/i, /\/aclk\?/i,
    /googleadservices\.com\/pagead/i, /googlesyndication\.com/i, /doubleclick\.net/i,
    /cpro\.baidu\.com/i, /pos\.baidu\.com/i, /cupid\.iqiyi\.com\/show2/i, /ad\.youku\.com/i, /adsmind\.gdtimg\.com/i
  ];
  /** 绝不拦截：登录/支付/客服/分享等正常弹窗（SPEC 7.1） */
  var POPUP_ALLOW = /oauth|login|passport|pay|checkout|kefu|customer|support|share/i;

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
        '.ad_result', '.ad-results', '#PZL', '#PZR', 'div[id^="ad_result_page1_"]', '.tgad-box', '.js-ad-item', '.pop-tuiguang'
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
  // 工具
  // ---------------------------------------------------------------------------

  function log() {
    try {
      var args = Array.prototype.slice.call(arguments);
      args.unshift(TAG);
      console.debug.apply(console, args);
    } catch (e) { /* 忽略 */ }
  }

  function normHost(input) {
    var v = String(input === undefined || input === null ? '' : input).trim().toLowerCase();
    if (!v) return '';
    v = v.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');
    v = v.split('/')[0].split('?')[0].split('#')[0].split('@').pop();
    return v.replace(/:\d+$/, '');
  }

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

  function readLocalJSON(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      if (!raw) return fallback;
      var val = JSON.parse(raw);
      return val === null || val === undefined ? fallback : val;
    } catch (e) { return fallback; }
  }

  function queryAll(sel) {
    try { return Array.prototype.slice.call(document.querySelectorAll(sel)); } catch (e) { return []; }
  }

  function isVisible(el) {
    if (!el || el.nodeType !== 1) return false;
    try {
      var cs = getComputedStyle(el);
      if (!cs || cs.display === 'none' || cs.visibility === 'hidden') return false;
      if (el.offsetParent === null && cs.position !== 'fixed') return false;
      return true;
    } catch (e) { return false; }
  }

  /** P1-2/P3 的「非空」判定：有子元素、有文本，或本身就是 iframe/video。
   *  用于挡掉常驻的空广告容器（可见或隐藏都算空；空容器不是广告态）。 */
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

  var injectedStyles = [];
  var inlineHiddenEls = [];

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

  function searchConfigFor(host) {
    for (var i = 0; i < SEARCH_GROUPS.length; i++) {
      var g = SEARCH_GROUPS[i];
      if (g.re && g.re.test(host)) return g;
      if (g.hosts && hostMatches(host, g.hosts)) return g;
    }
    return null;
  }

  // ---------------------------------------------------------------------------
  // 1) 弹窗 guard（smart；SPEC 7.1 子集，含 Function.prototype.toString 反指纹）
  // ---------------------------------------------------------------------------

  /** 弹窗 guard 是否已安装：用闭包布尔而不是 expando，
   *  避免在页面可见的 window.open 代理上留下 __adcleanerProxy 标记（反检测 / 不泄露自身特征）。 */
  var popupGuardInstalled = false;

  function installPopupGuard() {
    try {
      if (popupGuardInstalled) return;
      var origOpen = window.open;
      if (typeof origOpen !== 'function') return;
      var proxy = new Proxy(origOpen, {
        apply: function (target, thisArg, args) {
          try {
            var s = args.join(' ');
            if (!POPUP_ALLOW.test(s)) {
              for (var i = 0; i < POPUP_PATTERNS.length; i++) {
                if (POPUP_PATTERNS[i].test(s)) { log('已拦截广告弹窗', s.slice(0, 120)); return null; }
              }
            }
          } catch (e) { /* 匹配失败则放行 */ }
          return Reflect.apply(target, thisArg, args);   // 保留 this
        }
      });
      try {
        var origToString = Function.prototype.toString;
        var toStringProxy = new Proxy(origToString, {
          apply: function (target, thisArg, args) {
            // 两种调用形式都要挡：Function.prototype.toString.call(fn)（args[0]）与 String(fn)/fn.toString()（thisArg）
            if (args[0] === proxy || thisArg === proxy) return 'function open() { [native code] }';
            if (args[0] === toStringProxy || thisArg === toStringProxy) return 'function toString() { [native code] }';
            return Reflect.apply(target, thisArg, args);
          }
        });
        Function.prototype.toString = toStringProxy;
      } catch (e) { log('toString 反指纹失败', e); }
      var desc = null;
      try { desc = Object.getOwnPropertyDescriptor(window, 'open'); } catch (e) { /* 忽略 */ }
      try {
        Object.defineProperty(window, 'open', {
          value: proxy,
          writable: desc ? desc.writable !== false : true,
          enumerable: desc ? !!desc.enumerable : false,
          configurable: desc ? desc.configurable !== false : true
        });
      } catch (e) {
        window.open = proxy;   // 兜底
      }
      popupGuardInstalled = true;
      log('弹窗 guard 已安装');
    } catch (e) { log('弹窗 guard 安装失败', e); }
  }

  // ---------------------------------------------------------------------------
  // 2) cosmetics 应用
  // ---------------------------------------------------------------------------

  function isSupportedSelector(sel) {
    if (typeof sel !== 'string' || !sel || sel.length > 1024) return false;
    if (/:(?:-abp-)?contains\(/i.test(sel)) return false;
    return true;
  }

  var cosmeticSelectors = [];

  /** 注入构建期内联的静态 CSS（等价于扩展版 manifest 的 content_scripts.css，同步生效） */
  function injectStaticCss() {
    if (typeof AD_CSS !== 'string' || !AD_CSS.trim()) { log('静态 CSS 未内联，跳过'); return; }
    if (injectStyle(AD_CSS, 'adcleaner-cosmetic')) log('静态 CSS 已注入', AD_CSS.length, '字符');
  }

  function applyCosmetics(host) {
    var data = AD_DATA && AD_DATA.cosmetics;
    var groups = (data && Array.isArray(data.groups)) ? data.groups : [];
    for (var i = 0; i < groups.length; i++) {
      var g = groups[i];
      if (!g || !hostMatches(host, g.hosts)) continue;
      var list = Array.isArray(g.selectors) ? g.selectors : [];
      for (var j = 0; j < list.length; j++) {
        var sel = list[j];
        if (!isSupportedSelector(sel)) { log('丢弃不支持的选择器', sel); continue; }
        try { document.querySelector(sel); } catch (e) { log('无效选择器，丢弃', sel); continue; }
        cosmeticSelectors.push(sel);
        injectStyle(sel + '{display:none !important}');
      }
    }
    log('cosmetics 注入完成：选择器', cosmeticSelectors.length, 'host', host);
  }

  // ---------------------------------------------------------------------------
  // 3) 搜索广告清理（SPEC 8.3）
  // ---------------------------------------------------------------------------

  function startSearchCleanup(host) {
    var cfg = searchConfigFor(host);
    if (!cfg) return;
    var seen = new WeakSet();
    function pass() {
      var n = 0;
      for (var i = 0; i < cfg.selectors.length; i++) {
        var els = queryAll(cfg.selectors[i]);
        for (var j = 0; j < els.length; j++) {
          var el = els[j];
          if (seen.has(el)) continue;
          seen.add(el);
          try {
            el.style.setProperty('display', 'none', 'important');
            el.setAttribute('data-adcleaner-hidden', '1');
            inlineHiddenEls.push(el);
            n++;
          } catch (e) { /* 忽略 */ }
        }
      }
      if (n) log('搜索页广告已隐藏', n);
    }
    pass();
    var t0 = Date.now();
    var iv = setInterval(function () {
      try { pass(); } catch (e) { log('搜索清理扫描失败', e); }
      if (Date.now() - t0 > 20000) clearInterval(iv);
    }, 1000);
    var moTimer = 0;
    try {
      var mo = new MutationObserver(function () {
        if (moTimer) return;
        moTimer = setTimeout(function () { moTimer = 0; pass(); }, 250);
      });
      mo.observe(document, { childList: true, subtree: true });
    } catch (e) { log('搜索 MutationObserver 失败', e); }
    log('搜索清理已启动', host);
  }

  // ---------------------------------------------------------------------------
  // 4) 遮罩解冻（SPEC 8.1）：body 内联 overflow:hidden + 广告遮罩层
  // ---------------------------------------------------------------------------

  function startMaskUnfreeze() {
    var style = null;
    var ticks = 0;
    var iv = setInterval(function () {
      ticks++;
      try {
        var body = document.body;
        var attr = body ? (body.getAttribute('style') || '') : '';
        var mask = document.querySelector('.ad-mask, .popup-mask, #popups');
        if (body && /overflow\s*:\s*hidden/i.test(attr) && mask) {
          if (!style || !style.parentNode) {
            style = injectStyle('html,body{overflow:auto !important}', 'adcleaner-unfreeze');
            log('检测到广告遮罩锁定滚动，已注入解冻样式');
          }
        }
      } catch (e) { log('遮罩检查失败', e); }
      if (ticks >= 30) clearInterval(iv);
    }, 1000);
  }

  // ---------------------------------------------------------------------------
  // 5) 视频状态机（SPEC 8.2 简化版，安全规则与扩展版一致）
  // ---------------------------------------------------------------------------

  function startVideoMachine(host, aggressive) {
    var data = AD_DATA && AD_DATA.videoSites;
    if (!data) return;
    var sites = data.sites || {};
    var cfg = null;
    var genericMode = false;
    for (var key in sites) {
      if (!Object.prototype.hasOwnProperty.call(sites, key)) continue;
      if (hostMatches(host, [key])) { cfg = sites[key]; log('命中视频站点配置', key); break; }
    }
    if (!cfg && aggressive && data.generic) { cfg = data.generic; genericMode = true; log('启用 aggressive generic 模式'); }
    if (!cfg) { log('非视频站点且未开启激进模式，不启动视频状态机'); return; }
    runMachine(cfg, genericMode);
  }

  function runMachine(cfg, genericMode) {
    var selVideos = cfg.video || 'video';
    var adStateSels = Array.isArray(cfg.adState) ? cfg.adState : [];
    var skipSels = Array.isArray(cfg.skip) ? cfg.skip : [];
    var pauseCfg = cfg.pauseAd || {};
    var pauseContainers = Array.isArray(pauseCfg.containers) ? pauseCfg.containers : [];
    var pauseClose = Array.isArray(pauseCfg.close) ? pauseCfg.close : [];
    var actions = Array.isArray(cfg.actions) ? cfg.actions : [];
    var maxAdSeconds = (typeof cfg.maxAdSeconds === 'number' && cfg.maxAdSeconds > 0) ? cfg.maxAdSeconds : 180;

    var states = new WeakMap();
    var touchedVideos = [];
    var clickedEls = [];
    var episodeHides = [];
    var adEpisode = false;
    var dirty = false;
    var restoreTimer = 0;
    var lastHref = location.href;
    var moThrottleAt = 0;
    var strongSince = 0;              // P1-2 安全阀：强广告态连续出现的起点（0 = 当前无强广告态）
    var suppressedKeys = [];          // P1-2 安全阀：超时后被忽略的强广告态标识，全部消失后才解除忽略

    function hasAction(name) { return actions.indexOf(name) >= 0; }
    function now() { return Date.now(); }
    function safeRate(v) {
      try { return (typeof v.playbackRate === 'number' && isFinite(v.playbackRate)) ? v.playbackRate : 1; }
      catch (e) { return 1; }
    }

    function insideCosmeticHiddenLayer(el) {
      if (!el || typeof el.closest !== 'function') return false;
      for (var i = 0; i < cosmeticSelectors.length; i++) {
        try { if (el.closest(cosmeticSelectors[i])) return true; } catch (e) { /* 忽略 */ }
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
     *  我们注入的 display:none 会让 getComputedStyle 判不可见，只看 isVisible 会让状态机完全失灵
     *  （而这正是本脚本最常见的运行状态）；可见分支同样要求非空，避免空广告容器误判。 */
    function adElementPresent(el) {
      return isNonEmpty(el) && (isVisible(el) || insideCosmeticHiddenLayer(el));
    }

    function clickElement(el) {
      try {
        if (!el || el.nodeType !== 1) return false;
        if (el.disabled) return false;
        if (el.dataset && el.dataset.adcleanerClicked === '1') return false;
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
      s = { rate: safeRate(v), muted: !!v.muted, rateByUs: false, mutedByUs: false, lastSetMutedAt: 0, lastSetMuted: false,
            pendingRates: [], counted: false, lastSeekAt: 0, seekedOnce: false };
      states.set(v, s);
      trackTouched(v);
      try {
        v.addEventListener('ratechange', function () {
          var cur = safeRate(v);
          for (var i = 0; i < s.pendingRates.length; i++) {
            if (Math.abs(s.pendingRates[i].rate - cur) < 0.01) { s.pendingRates.splice(i, 1); return; }  // 我们自己的赋值
          }
          if (s.rateByUs) { s.rateByUs = false; s.rate = cur; }   // 用户改的 → 以用户为准
        });
        v.addEventListener('volumechange', function () {
          if (!s.mutedByUs) return;
          if (now() - s.lastSetMutedAt < 250) return;
          if (!!v.muted !== s.lastSetMuted) { s.muted = !!v.muted; s.mutedByUs = false; }
        });
      } catch (e) { log('绑定 video 事件失败', e); }
      return s;
    }

    function setRate(v, s, rate) {
      try {
        s.pendingRates.push({ rate: rate, at: now() });
        while (s.pendingRates.length > 4) s.pendingRates.shift();
        try { v.playbackRate = rate; } catch (e) { log('设置 playbackRate 失败', e); }
        if (Math.abs(safeRate(v) - rate) < 0.01) { s.rateByUs = true; dirty = true; }
        else { s.rateByUs = false; log('站点限制倍速，忽略'); }
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

    function trySeekToEnd(v, s) {
      try {
        if (now() - s.lastSeekAt < 1500) return;
        if (v.readyState < 1) return;
        var d = v.duration;
        if (!isFinite(d) || d <= 1) return;                       // 直播/未知时长：禁止 seek
        var cap = Math.min(maxAdSeconds, SEEK_HARD_CAP_SECONDS);
        if (d > cap) { log('时长超出 seek 上限，判定为正片/SSAI，不 seek'); return; }
        if (v.currentTime >= d - 0.5) return;
        s.lastSeekAt = now();
        dirty = true;
        v.currentTime = d - 0.1;
        log('seek 到广告末尾', d.toFixed(1));
      } catch (e) { log('seek 失败', e); }
    }

    function shortSeek(v) {
      try {
        if (!isFinite(v.duration) || v.duration <= 1) return;
        var target = Math.min(v.currentTime + GENERIC_SHORT_SEEK_SECONDS, v.duration - 0.5);
        if (target <= v.currentTime + 0.5) return;
        dirty = true;
        v.currentTime = target;
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
        if (!v.paused && !v.ended) score += 2;
        if (isFinite(v.duration) && v.duration > 1) score += 1;
        if (score > bestScore) { best = v; bestScore = score; }
      }
      return best;
    }

    /** 检测广告态；keys/strongKeys 供安全阀追踪「同一强广告态是否持续存在」。
     *  P1-2：存在性用 adElementPresent（非空 且 [可见 或 被我们遮住]），与 isClickable 对齐。 */
    function detectAdState() {
      var matched = [];
      var keys = [];
      for (var i = 0; i < adStateSels.length; i++) {
        var els = queryAll(adStateSels[i]);
        for (var j = 0; j < els.length; j++) {
          if (adElementPresent(els[j])) { matched.push(adStateSels[i]); keys.push(adStateSels[i]); break; }
        }
      }
      var pausePresent = false;
      var pauseKeys = [];
      for (var k = 0; k < pauseContainers.length; k++) {
        var pe = queryAll(pauseContainers[k]);
        for (var q = 0; q < pe.length; q++) {
          if (adElementPresent(pe[q])) {
            pausePresent = true;
            pauseKeys.push('pause:' + pauseContainers[k]);
            keys.push('pause:' + pauseContainers[k]);
            break;
          }
        }
      }
      var strong = false;
      var strongKeys = [];
      for (var m = 0; m < matched.length; m++) {
        if (WEAK_AD_STATES.indexOf(matched[m]) < 0) { strong = true; strongKeys.push(matched[m]); }
      }
      if (pausePresent) { strong = true; strongKeys = strongKeys.concat(pauseKeys); }
      return { present: keys.length > 0, strong: strong, matched: matched, keys: keys, strongKeys: strongKeys };
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
      if (clicked) log('点击跳过按钮', clicked, '个');
    }

    function closePauseAd() {
      var containers = [];
      for (var i = 0; i < pauseContainers.length; i++) {
        var els = queryAll(pauseContainers[i]);
        for (var j = 0; j < els.length; j++) { if (adElementPresent(els[j])) containers.push(els[j]); }   // P1-2：被我们遮住的暂停广告层也要处理
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
            var cname = (c.id || '') + ' ' + (c.className && c.className.baseVal !== undefined ? c.className.baseVal : (c.className || ''));
            if (!/(^|[\s._-])(ad|ads|advert|pause)([\s._-]|$)/i.test(String(cname))) continue;
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
      clickSkipButtons();
      if (hasAction('pause-close')) { try { closePauseAd(); } catch (e) { log('closePauseAd 异常', e); } }
      if (!info.strong) return;                       // 弱广告态绝不碰 video
      var v = pickVideo();
      if (!v) return;
      var s = stateOf(v);
      if (hasAction('mute')) setMuted(v, s, true);
      if (hasAction('speed')) setRate(v, s, 16);
      if (hasAction('seek')) trySeekToEnd(v, s);
      if (!s.counted) { s.counted = true; log('检测到视频广告，已静音/加速'); }
    }

    function tickGeneric() {
      var vids = queryAll('video');
      if (vids.length !== 1 || document.hidden) { if (dirty) endEpisode(); return; }
      var v = vids[0];
      var ok = !v.paused && !v.ended && v.readyState >= 1 && isFinite(v.duration) && v.duration > 1 && v.duration <= maxAdSeconds;
      if (!ok) { if (dirty) endEpisode(); return; }
      var s = stateOf(v);
      if (hasAction('mute')) setMuted(v, s, true);
      if (hasAction('speed')) setRate(v, s, 16);
      if (!s.seekedOnce) { s.seekedOnce = true; shortSeek(v); }
      if (!s.counted) { s.counted = true; log('aggressive：疑似广告视频，静音+加速'); }
      adEpisode = true;
    }

    function endEpisode() {
      if (restoreTimer) return;
      adEpisode = false;
      restoreTimer = setTimeout(function () { restoreTimer = 0; restore(); }, RESTORE_DELAY_MIN + Math.floor(Math.random() * RESTORE_DELAY_SPAN));
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
      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0; }
      try { restore(); } catch (e) { log('超时强制还原失败', e); }
      log('强广告态已持续超过 maxAdSeconds(' + maxAdSeconds + 's)，强制还原并忽略该状态，直到其选择器消失');
      return true;
    }

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
        try { if (clickedEls[j].dataset) delete clickedEls[j].dataset.adcleanerClicked; } catch (e) { /* 忽略 */ }
      }
      clickedEls = [];
      for (var k = 0; k < episodeHides.length; k++) {
        try { episodeHides[k].style.removeProperty('display'); episodeHides[k].removeAttribute('data-adcleaner-episode'); } catch (e) { /* 忽略 */ }
      }
      episodeHides = [];
      log('广告态结束，已还原用户状态');
    }

    function resetForSpa() {
      if (restoreTimer) { clearTimeout(restoreTimer); restoreTimer = 0; }
      try { restore(); } catch (e) { log('SPA 还原失败', e); }
      states = new WeakMap();
      touchedVideos = [];
      adEpisode = false;
      dirty = false;
      strongSince = 0;
      suppressedKeys = [];
      log('SPA 导航，重置视频状态');
    }

    function tick() {
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

    setInterval(tick, TICK_MS);
    try {
      var mo = new MutationObserver(function () {
        var t = now();
        if (t - moThrottleAt < 200) return;
        moThrottleAt = t;
        tick();
      });
      mo.observe(document, { subtree: true, attributes: true, attributeFilter: ['class', 'style'] });
    } catch (e) { log('视频 MutationObserver 失败', e); }
    tick();
    log('视频状态机已启动', genericMode ? '(generic/aggressive)' : '(站点配置)');
  }

  // ---------------------------------------------------------------------------
  // 启动
  // ---------------------------------------------------------------------------

  function main() {
    var host;
    try { host = normHost(location.hostname || ''); } catch (e) { host = ''; }
    if (!host) { log('无 hostname，退出'); return; }
    var whitelist = readLocalJSON(WL_KEY, []);
    if (!Array.isArray(whitelist)) whitelist = [];
    if (hostMatches(host, whitelist)) { log('命中白名单，直接退出', host); return; }
    var aggressive = readLocalJSON(AGGRESSIVE_KEY, false) === true || readLocalJSON(AGGRESSIVE_KEY, '') === '1';

    log('启动', host, 'aggressive=', aggressive);
    installPopupGuard();          // 先装弹窗 guard（document-start，越早越好）
    injectStaticCss();            // 扩展版由 manifest 注入的 cosmetic.css，油猴版构建时内联
    applyCosmetics(host);
    startMaskUnfreeze();
    startVideoMachine(host, aggressive);
    startSearchCleanup(host);
  }

  if (!AD_DATA) {
    log('数据未内联（模板未构建），退出');
  } else {
    main();
  }
})();
