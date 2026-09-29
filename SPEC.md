# AdCleaner 规格书（权威版，2026-09-29）

本文件是唯一权威规格。所有实现以此为准；不要修改本文件。用户目标：屏蔽 ①弹窗广告 ②视频开头/中插/暂停广告 ③搜索引擎广告。
交付：Chrome/Edge MV3 扩展（主）+ Tampermonkey 油猴脚本（备）。

## 0. 已调研确认的关键事实（不要再重新调研）

- MV2 已死：Chrome 138 起禁用，2026-08-31 全部从商店下架。必须 MV3 + declarativeNetRequest（DNR）。
- DNR 限制：静态规则集最多 100 个 / 同时启用最多 50 个 / 保证 30,000 条；动态规则 30,000 条；正则 ≤1000 条且单条编译 <2KB（RE2，不支持 lookahead）。规则 JSON 为顶层数组，字段：id/priority/action/condition。
- DNR 不能做：元素隐藏、JS 注入、`$popup` 语义（无 popup resource type）、响应体改写。所以弹窗/视频/搜索广告必须 content script 配合。
- 弹窗拦截正确做法：MAIN world 覆写 `window.open`（含 `Function.prototype.toString` 反指纹 + `Reflect.apply` 保 this），或用站点级 `prevent-window-open(pattern)`；不要全站无差别拦截（会误伤登录/支付/客服弹窗）。
- 视频：YouTube 已服务端合流广告（SSAI/SABR），客户端只能：清 JSON 广告字段（adPlacements/adSlots/playerAds）、`Object.assign` 代理加 `isInlinePlaybackNoAd:true`、`.ad-showing` 状态机（点跳过/静音+16x）、SSAP 状态 seekTo 片段尾。国内站以「DOM 隐藏 + 跳过按钮自动点击 + 站点 JS 变量改写」为主；必须放行播放器 SDK 域（见 4.3）。
- 规则列表版权：AdGuard=GPL-3.0、EasyList=GPLv3+/CC BY-SA、CJX=LGPL-3.0、Peter Lowe 无 SPDX。README 必须列出来源与许可，注明本作品仅为个人使用，上架商店前需自行做法务确认。

## 1. 目录与文件所有权（严格按此，勿越界写文件）

```
adblocker/
├── SPEC.md                         orchestrator（勿改）
├── README.md                       fixer A
├── package.json                    fixer A（devDependencies: @adguard/dnr-converter）
├── extension/
│   ├── manifest.json               fixer A
│   ├── icons/icon16|32|48|128.png  fixer A（tools/make-icons.mjs 生成）
│   ├── rulesets/base.json          fixer A（生成并提交）
│   ├── rulesets/cn.json            fixer A
│   ├── rulesets/annoyances.json    fixer A
│   ├── rulesets/popups.json        fixer A（手写）
│   ├── rulesets/video.json         fixer A（手写）
│   ├── rulesets/tracking.json      fixer A
│   ├── src/background.js           fixer A
│   ├── src/popup/popup.html|css|js fixer A
│   ├── src/options/options.html|css|js fixer A
│   ├── src/content/guard-main.js   fixer B1（MAIN world）
│   ├── src/content/guard-iso.js    fixer B2（ISOLATED world）
│   ├── src/content/cosmetic.css    fixer B2
│   └── src/data/cosmetics.json     fixer B2
│   └── src/data/video-sites.json   fixer B2
├── tools/build-rules.mjs           fixer A
├── tools/make-icons.mjs            fixer A
├── tools/build-userscript.mjs      fixer B2
└── userscript/adcleaner.user.js    fixer B2（生成并提交）
```

## 2. manifest.json（fixer A，字段名照抄）

```json
{
  "manifest_version": 3,
  "name": "AdCleaner 清道夫",
  "version": "1.0.0",
  "description": "屏蔽弹窗、视频贴片/暂停广告、搜索引擎广告。规则来自 AdGuard/EasyList/CJX/Peter Lowe 等公开过滤列表。",
  "minimum_chrome_version": "111",
  "permissions": ["declarativeNetRequest", "storage", "unlimitedStorage"],
  "host_permissions": ["<all_urls>"],
  "background": { "service_worker": "src/background.js" },
  "action": {
    "default_popup": "src/popup/popup.html",
    "default_icon": { "16": "icons/icon16.png", "32": "icons/icon32.png" }
  },
  "options_page": "src/options/options.html",
  "icons": { "16": "icons/icon16.png", "32": "icons/icon32.png", "48": "icons/icon48.png", "128": "icons/icon128.png" },
  "declarative_net_request": {
    "rule_resources": [
      { "id": "base",       "enabled": true,  "path": "rulesets/base.json" },
      { "id": "cn",         "enabled": true,  "path": "rulesets/cn.json" },
      { "id": "annoyances", "enabled": true,  "path": "rulesets/annoyances.json" },
      { "id": "popups",     "enabled": true,  "path": "rulesets/popups.json" },
      { "id": "video",      "enabled": true,  "path": "rulesets/video.json" },
      { "id": "tracking",   "enabled": true,  "path": "rulesets/tracking.json" }
    ]
  },
  "content_scripts": [
    { "matches": ["<all_urls>"], "js": ["src/content/guard-main.js"], "run_at": "document_start", "world": "MAIN", "all_frames": true },
    { "matches": ["<all_urls>"], "js": ["src/content/guard-iso.js"], "css": ["src/content/cosmetic.css"], "run_at": "document_start", "all_frames": true }
  ],
  "web_accessible_resources": [
    { "resources": ["src/data/*.json"], "matches": ["<all_urls>"] }
  ]
}
```

## 3. 设置与存储（fixer A 定义，B1/B2 读取）

`chrome.storage.local` 键名固定为 `"adcleaner.settings"`：

```json
{
  "enabled": true,
  "whitelist": [],
  "rulesets": { "base": true, "cn": true, "annoyances": true, "popups": true, "video": true, "tracking": true },
  "videoAggressive": false,
  "stats": { "date": "2026-09-29", "dom": 0 }
}
```

- background 负责写；内容脚本启动时读一次 + 监听 `chrome.storage.onChanged`。
- `enabled=false` 时：background 用 `updateEnabledRulesets` 停用全部规则集，并加 session 规则 allowAllRequests；内容脚本读设置后直接退出（不隐藏任何东西）。
- 站点白名单：`updateSessionRules` 为每个域名加一条 `{priority:100, action:{type:"allowAllRequests"}, condition:{requestDomains:[d], resourceTypes:["main_frame"]}}`。
- 今日计数：内容脚本 `chrome.runtime.sendMessage({type:"domBlocked", n})` → background 累加 `stats.dom`（按日期重置）并 `action.setBadgeText`（数字 >999 显示 "999+"）。
- popup 通过消息 `{type:"getState"}`、`{type:"setSettings", settings}` 与 background 交互。

## 4. 规则集（fixer A）

### 4.1 tools/build-rules.mjs（必须真实运行并提交产物）

devDependency：`@adguard/dnr-converter`（GPL-3.0，仅构建期使用）。Node >= 18（本机 v24）。

流程：
1. 下载以下列表（每一步都要带 fallback URL；全部用 fetch，UA 可用 curl/14）：
   - cn.json 源：`https://filters.adtidy.org/extension/chromium-mv3/filters/224.txt`（AdGuard Chinese MV3 变体，已含 EasyList China）。fallback：`https://raw.githubusercontent.com/AdguardTeam/AdguardFilters/master/ChineseFilter/sections/adservers.txt` + `specific.txt` 拼合。
   - annoyances.json 源：`https://raw.githubusercontent.com/cjx82630/cjxlist/master/cjx-annoyance.txt`。fallback：`https://cdn.jsdelivr.net/gh/cjx82630/cjxlist@master/cjx-annoyance.txt`。
   - base.json 源：`https://pgl.yoyo.org/adservers/serverlist.php?hostformat=adblockplus&showintro=0&mimetype=plaintext` + `https://raw.githubusercontent.com/uBlockOrigin/uAssets/master/filters/badware.txt`。
   - tracking.json 源：`https://filters.adtidy.org/extension/ublock/filters/17.txt`（AdGuard URL Tracking）。
2. 用 `FilterConverter().convert([new Filter(id, text)], { combine: true })` 转换，取 `ruleset.serialize()` 解析为数组。每个输出文件独立转换。
3. 后处理（对转换产物）：
   - priority 归一：allow=30，redirect=11，其余（block 等）=10。
   - 纯域名合并：condition 中 `urlFilter` 满足 `^\|\|[a-z0-9_.-]+\^$` 且无其他字段（除 action/priority）的 block 规则 → 按「action+其余 condition 字段」分组，合并为一条 `condition.requestDomains: [...]`（去重）。
   - 去除完全重复规则（JSON.stringify 比较后去重），重新编号 id（从 1 递增，每个文件内唯一）。
   - 校验：数组顶层；条数 ≤30000；`regexFilter` 条数 ≤1000 且每条长度 ≤512；超限时丢弃并打印报告。
4. 手写规则集（不走转换）：
   - `popups.json`：纯 popunder 落地域名 block main_frame：
     `getpopunder.com, popunder.bid, popunderoctober.store, popunderstar.com, popunderz.com, popunderjs.com, uptopopunder.com`
     条件 `{requestDomains:[...], resourceTypes:["main_frame"], priority:10}`；再加 3 条脚本路径 block：
     `urlFilter:"/jspopunder.js"` / `urlFilter:"/popunder.min.js"` / `urlFilter:"/popunderpro/"`，`resourceTypes:["script"]`，priority 10。
   - `video.json`：以下全部手写（block 优先 10，allow 优先 30）：
     - block：`||cupid.iqiyi.com/show2?`、`||iqiyi.com/player/common/adflash`、`||iqiyi.com/player/common/rebull`、`||ad.youku.com/vp?`、`||atm.youku.com^`、`||cad.youku.com^`、`||da.mgtv.com^`、`||video.da.mgtv.com^`、`||pcvideoyf.titan.mgtv.com/pb/*.mp4`、`||ads.sohu.com^`、`||aty.sohu.com/v?`、`||m.aty.sohu.com^`、`||tv.sohu.com/upload/csad/`、`||ark.le.com/s?vid=`、`||api.bilibili.com/x/ad/`、`||cm.bilibili.com^`、`||adx.qq.com^`、`||gdt.qq.com^`、`||cm.l.qq.com^`、`||iwan-s.video.qq.com^`、`||ssp.qq.com/ad^`、`||ad.youku.com^`。
     - allow（必须存在，否则播放器可能挂）：`@@||cupid.iqiyi.com/mixer`（script, initiatorDomains:["iqiyi.com"]）、`@@||tb.mgtv.com/sdk/*/ad-sdk.js`（script, initiatorDomains:["mgtv.com"]）、`@@||union.video.qq.com/fcgi-bin/`（script, initiatorDomains:["qq.com"]）、`@@||vd.l.qq.com^`（initiatorDomains:["qq.com"]）、`@@||valipl.cp31.ott.cibntv.net^`（initiatorDomains:["youku.com"]）。
5. 生成 `extension/rulesets/_sources.json`：每行记录 {file, sourceUrl, fetchedAt(ISO), license, ruleCount}。
6. 失败兜底：若某个列表下载或转换失败，用脚本内硬编码的约 150 个域名种子（见 4.4）生成同名规则集，控制台明确打印「FALLBACK USED: <列表名> <原因>」，退出码仍为 0，并把失败信息写进 _sources.json。

### 4.2 npm scripts
`"build:rules": "node tools/build-rules.mjs"`, `"build:icons": "node tools/make-icons.mjs"`, `"build:userscript": "node tools/build-userscript.mjs"`（后者由 B2 创建；A 不要写这个文件，但可在 scripts 里预留 `"build": "npm run build:rules && npm run build:icons"`）。

### 4.3 DNS/许可注意
- `cupid.iqiyi.com`、`tb.mgtv.com/sdk`、`union.video.qq.com`、`vd.l.qq.com`、`valipl.cp31.ott.cibntv.net` 只允许按上面 allow 条件放行，不得整域封禁。
- README 许可表：AdGuard Chinese/URL Tracking = GPL-3.0；CJX = LGPL-3.0；Peter Lowe 无 SPDX（免费使用）；uBO badware = GPL-3.0。

### 4.4 种子域名（兜底 + base.json 附加，全部 block、priority 10）
pos.baidu.com cpro.baidu.com cbjs.baidu.com cpro.baidustatic.com mobads.baidu.com afd.baidu.com nsclick.baidu.com qzs.gdtimg.com adsmind.gdtimg.com gdtimg.com impdsp.meituan.com rtb.julang.taobao.com tanx.com atanx.alicdn.com alimama.cn mmstat.com miaozhen.com admaster.com.cn adbot.tw adbottw.net fam-8.net cdn.holmesmind.com ad.ettoday.net tagtoo.co adserve.work hm.baidu.com cnzz.com cnzz.net umeng.com talkingdata.com growingio.com sensorsdata.cn beacon.sina.com.cn log.byteoversea.com mon.byteoversea.com dsp-track-global.zmaticoo.com pagead2.googlesyndication.com tpc.googlesyndication.com partner.googleadservices.com adservice.google.com adserver.bing.com ads.msn.com pb.sogou.com google-analytics.com www.googletagmanager.com googletagmanager.com analytics.google.com doubleclick.net demdex.net agkn.com bluekai.com criteo.com taboola.com outbrain.com hotjar.com mixpanel.com segment.io amplitude.com adjust.com appsflyer.com adsrvr.org casalemedia.com pubmatic.com rubiconproject.com openx.net adnxs.com smartadserver.com rlcdn.com krxd.net quantserve.com scorecardresearch.com matomo.cloud beacon.sina.com.cn zhongziso.com 等（可自行补充同类已知广告域，但必须写进 _sources.json 的 seed 记录）。

## 5. background.js（fixer A）

- 首次安装 `onInstalled`：写入默认 settings（第 3 节）。
- 监听 `chrome.storage.onChanged`（settings）：
  - `enabled` 变化：启用/停用全部规则集（`updateEnabledRulesets`）；启用时恢复用户勾选的规则集。
  - `rulesets` 变化：对每个 id 调用 enable/disable。
  - `whitelist` 变化：重建 session rules（先 `updateSessionRules` 删除全部旧规则再添加）。
- 消息：
  - `{type:"getState"}` → 返回 settings。
  - `{type:"setSettings", settings}` → 合并写入（校验白名单格式：小写域名、去协议路径）。
  - `{type:"domBlocked", n}` → 累加 stats（跨日重置）+ 更新 badge。
- 全部 API 调用 try/catch；service worker 冷启动时也要保证规则集状态与 settings 一致（在 worker 启动时校正一次）。

## 6. popup 与 options（fixer A）

- 中文界面、无内联脚本、无远程资源、无第三方库。
- popup：总开关；当前站点「暂停在此网站」按钮（加入/移出白名单）；6 个规则集开关；今日拦截数；「选项」按钮。
- options：规则集开关+说明+来源/许可表（读 `rulesets/_sources.json`）；白名单编辑（每行一个域名）；视频激进模式开关（说明误伤风险）；清空统计；设置导出/导入（textarea JSON）。界面简洁即可，功能必须可用。
- popup/options 的 JS 必须用 `chrome.storage.local` + runtime 消息，不允许假设页面长期打开。

## 7. guard-main.js（fixer B1，MAIN world，document_start）

目标：弹窗拦截 + 站点脚本变量改写 + YouTube 数据层补丁。零外部依赖，全部内联常量表。运行在所有 frame。

### 7.1 弹窗 guard（smart 默认；aggressive 由 settings.videoAggressive 控制？不，用独立开关）
- 用 `proxyApplyFn` 方式代理 `window.open`：保留原 descriptor（value/writable/enumerable/configurable），代理函数用 `Reflect.apply` 调用原函数；用 `WeakMap` + 覆写 `Function.prototype.toString` 让代理函数仍返回 `[native code]`（照抄 uBO 的 proxyToStringFn 思路，见下）。
- 模式匹配：`callArgs.join(' ')` 后匹配；默认模式表（正则）：`/popunder/i`、`/\/ad(s|click|server)?[\/?._-]/i` 太宽——不要用；只用明确表：
  `/popunder/i`, `/jspopunder/i`, `/popunderjs/i`, `/uptopopunder/i`, `/adcash/i`, `/\/aclk\?/i`, `/googleadservices\.com\/pagead/i`, `/googlesyndication\.com/i`, `/doubleclick\.net/i`, `/cpro\.baidu\.com/i`, `/pos\.baidu\.com/i`, `/cupid\.iqiyi\.com\/show2/i`, `/ad\.youku\.com/i`, `/adsmind\.gdtimg\.com/i`。
  匹配 → `return null`。
- `isTrusted===false` 的合成点击：**仅在 aggressive 模式**（新增设置项 `popupAggressive`，默认 false，README 说明）下，capture 阶段对「合成点击且目标或祖先带 `onclick` 且 onclick 属性文本含 `open(` 或 `window.open`」的事件 `stopImmediatePropagation()+preventDefault()`。
- 绝不拦截：带 `oauth|login|passport|pay|checkout|kefu|customer|support|share` 的 URL（模式匹配前先排除）。

### 7.2 scriptlet-lite（内联表：host → 规则数组）
支持原语（都要 try/catch，出错即放弃该规则，不影响页面）：
- `set-constant(path, value)`：沿 `window` 路径设置；中间对象缺失时每 500ms 重试，最多 5s；支持 `Object.prototype.xxx` 形式。
- `json-prune(paths[], opts)`：包装 `JSON.parse`；匹配当次页面的 fetch/XHR URL 时才改写（hook `fetch` 与 `XMLHttpRequest.prototype.open/send` + 响应文本替换/解析）。实现可以简化：对 fetch 用 clone().text() 解析 JSON 删字段再返回新 Response；对 XHR 用 redefining `responseText`（defineProperty on instance at readystatechange）实现，做不出就只覆盖 fetch 并记录限制。
- `no-fetch-if(re)`：匹配 URL 时返回被拒 Promise。
- `no-xhr-if(re)`：匹配时阻止 `send`。
- `adjust-setInterval(nameOrAll, match, mult)` / `adjust-setTimeout(...)`：包装定时器，按 match 命中则时间 × mult。
- `prevent-window-open`：复用 7.1 的代理，带 pattern。
- 自定义 `iqiyi-adSlots`：代理 `window.Object.assign`，当目标参数含 `adSlots` 数组时置空；同时删除 `playerResponse` 顶层 `adSlots`。
- 腾讯反绕过：当页面上有 json-prune 规则时，代理 `Node.prototype.appendChild` 与 `Element.prototype.insertAdjacentElement`，若新建的是无 src 的隐藏 iframe（`iframe[style*="display: none"]:not([src])`），把 `iframe.contentWindow.JSON = window.JSON`（我们的 hooks）。

内联表（host 后缀匹配，2026-09-29 依据 AdGuard/EasyList/uBO 原文）：
- `iqiyi.com`：
  - set-constant `Object.prototype.blackscreenDuration` = 1
  - set-constant `Object.prototype.parseXML` = `function(){}`
  - set-constant `QiyiPlayerProphetData.a.data` = `{}`（路径不存在就重试）
  - adjust-setInterval `adUI` 1000 → 0.02
  - iqiyi-adSlots（见上）
- `v.qq.com` / `qq.com`：
  - json-prune `["ads", "ad", "material.video"]`（fetch+XHR）
  - set-constant `CreativePlayerwebPlugin.AD_EVENT.AD_DESTROY` = `""`
  - set-constant `CreativePlayerwebPlugin.AD_EVENT.AD_LOAD_START` = `""`
- `youku.com`：
  - set-constant `Object.prototype.adData` = `{}`、`Object.prototype._adData` = `{}`
  - adjust-setTimeout 全部 ×0.02
- `le.com`：set-constant `isAdLoaded` = true、`Object.prototype.noAD` = true
- `bilibili.com`：json-prune `["data.cm_info.ads", "business_info.ad_desc"]`（fetch 优先）
- `youtube.com` / `m.youtube.com` / `music.youtube.com`：
  - set-constant `ytInitialPlayerResponse.adPlacements` = undefined（能设就设）
  - json-prune `["adPlacements","adSlots","playerAds"]`（fetch+XHR；对 `/youtubei/v1/player`、`/get_watch`、`playlist` 生效）
  - 代理 `window.Object.assign`：目标参数若含 `playerRequest`/`contentPlaybackContext` 对象，注入 `isInlinePlaybackNoAd: true`；否则透传
  - set-constant `ytcfg.data_.EXPERIMENT_FLAGS.all_web_enable_network_machine` = false（路径存在才设）
  - SSAP 跳过：`setInterval` 每 500ms 检查 `#movie_player.getStatsForNerds().debug_info` 以 `SSAP, AD` 开头 → `seekTo(getProgressState().duration)`；页面无播放器则跳过。整个循环包 try/catch。

### 7.3 质量要求
- 一律 `'use strict'` 的 IIFE；不污染全局；所有 hook 必须可失效回退（fn 抛错返回原行为）。
- 不得出现 `debugger`、不得 eval 远程代码。
- 文件头注释写明用途、依据来源、限制。

## 8. guard-iso.js + 数据（fixer B2，ISOLATED world，document_start）

启动流程：读 settings → 若 `enabled=false` 或 host 命中白名单 → 直接 return（不做任何事）。否则：
1. 立即注入 `cosmetic.css` 已由 manifest 完成；再 fetch `src/data/cosmetics.json`（chrome.runtime.getURL），host 后缀匹配规则组，等价 CSS 逐条 `<style>` 注入（每条独立，坏选择器不影响其他条）。
2. 启动视频状态机（视频站点或 aggressive 开启时）。
3. 启动搜索广告清理（命中搜索引擎域名时）。
4. 统计上报（去抖，≤ 每分钟 1 次）：统计本页隐藏/跳过的元素数与视频广告次数，`domBlocked` 消息。

### 8.1 cosmetics.json 格式
```json
{
  "version": "2026-09-29",
  "groups": [
    { "hosts": ["baidu.com"], "source": "EasyList China", "selectors": ["#content_left > div:has(.ec-tuiguang)"], "note": "" }
  ]
}
```
- hosts 用后缀匹配（`www.baidu.com` 命中 `baidu.com`）。
- selectors 必须是浏览器原生 CSS（已把 `:-abp-has()` 转成 `:has()`；含 `-abp-contains()` 的必须预先转成 JS 检查或丢弃）。**禁止**任何 `[class*="ad"]`、`[id*="ad"]`、裸 `[class*="float"]`、裸 `[class*="popup"]`、`[class*="banner"]` 这类宽泛选择器；模糊类必须带结构约束（如 `:has(iframe)`）或使用具体类名。
- 必须包含（来源：EasyList China / AdGuard Chinese / w3 报告 C2，已核对）：
  - 通用浮层/对联条（无站点限定的具体 id/class 放 cosmetic.css；有歧义的放这里并加 `:has` 约束）。
  - 搜索引擎（Google/Bing/百度/搜狗/360/DuckDuckGo）结果页广告选择器：见 8.3。
  - 视频站：见 8.2 附注。
  - Baidu：`#content_left > div:has(.ec-tuiguang)`、`#content_left > div:has(span[data-tuiguang])`、`#content_right > div:has(span[data-tuiguang])`、`.c-container:has(.t > a[data-landurl])`、`div[data-key^="ad__"]`、`a[class*="fengchaoContainer"]`、`.ec_ad`、`.ec-fc-ad-results`、`#ecl-temai-general`。
  - Sogou：`.ad_result`、`.ad-results`（实测新发现）、`#PZL`、`#PZR`、`div[id^="ad_result_page1_"]`、`.tgad-box`、`.js-ad-item`、`.pop-tuiguang`。
  - 360：`.g-a-noline[data-md*="sad"]`、`#e_idea_pp`、`#e_idea_left`、`#e_idea_frame_0`、`#m-spread-left`、`#so_kw-ad`、`.res-mediav`、`.atom-adv`、`#so_bd-ad`。
  - Bing：`ol#b_results > li.b_algo:has(.b_title a[href^="https://www.bing.com/aclk?"])`、`ol#b_results > li:has(a[href^="https://www.bing.com/aclk?"])`、`.b_ad`、`.pa_sb`、`.mmaAdCard`、`.top-ads-separator-enabled`、`.b_bza_pole`。
  - Google：`#tads[aria-label]`、`#tadsb[aria-label]`、`.uEierd`、`.cu-container`、`div[data-text-ad]`、`a[href^="/aclk?sa="]`、`div[data-is-ad="1"]`、`.commercial-unit-desktop-rhs`、`.OcdnDb`。
  - DuckDuckGo：`.result--ad`、`a[href*="duckduckgo.com/y.js?"]`、`.result__badge-wrap:has(button.badge--ad)`、`tr.result-sponsored`（lite 版，用 `lite.duckduckgo.com` host）。
  - 视频站静态隐藏（配合状态机）：youtube `.video-ads`、`.ytp-ad-overlay-container`、`.ytp-ad-module`；iqiyi `.maxPauseAd-container`、`.overlayAd-container`、`.definitionAd-container`、`.black-screen[data-cupid="adblock-blackscreen"]`；腾讯 `.txp_ad`、`.txp_zt`、`.txp_ad_center`、`.game-switch-ad`、`.player-side-ads`；优酷 `#youku-pause-container`、`.youku-advertise-layer`、`#player-advertise`、`div[data-adext]`、`.historyrecord_adwrap`；芒果 `.as_stages-wrapper`、`mango-ad-layer`、`mango-ad-outter-layer`；搜狐 `#miaozhenad`、`.middle-insert-ad`、`#bottomBanner`；乐视 `.min_pause_img`、`.ad_layer`、`.broadcast-adv`；B站 `.ad-report`、`.ad-floor`、`.gg-floor-module`、`.bili-dyn-ads`、`.eva-banner`、`.adcard-content`、`.ad-f`、`.ad-e1`、`.banner-card`、`.index-promote`、`.bili-video-card.is-rcmd:has(.bili-video-card__stats--icon > path[d^="M16.9122"])`。
  - 通用弹窗/浮层（具体到不会误伤的）：`#cs_left_couplet`、`#cs_right_couplet`、`.ad-couplet-common`、`.adv-couplets`、`#left_float`、`#right_float`、`#left_up_float_ad`、`#left_down_float_ad`、`#right_up_float_ad`、`#right_down_float_ad`、`.floatAd`、`.floating-ad`、`.tanchuang`、`#tanchuang`、`.pop-bottom`、`iframe[id^="google_ads_iframe"]`、`iframe[id^="aswift_"]`、`iframe[src*="pagead"]`、`iframe[src*="googlesyndication"]`、`ins.adsbygoogle`、`[data-ad-slot]:not([data-ad-slot=""])`。
  - 遮罩解冻：若页面出现 `body[style*="overflow: hidden"]` 且存在 `.ad-mask|.popup-mask|#popups` 类元素，注入 `html,body{overflow:auto !important}`（限时 30s 内每 1s 检查，退出后停止）。

### 8.2 video-sites.json + 状态机
```json
{
  "sites": {
    "youtube.com": {
      "video": "#movie_player video.html5-main-video, video.html5-main-video",
      "adState": [".html5-video-player.ad-showing", ".html5-video-player.ad-interrupting", ".ytp-ad-player-overlay"],
      "skip": ["button.ytp-skip-ad-button", "button.ytp-ad-skip-button-modern", "button.ytp-ad-skip-button", ".ytp-ad-skip-button-container button"],
      "pauseAd": { "containers": [], "close": [] },
      "maxAdSeconds": 999,
      "actions": ["click", "mute", "speed", "seek"]
    },
    "iqiyi.com": { "video": "video", "adState": [".maxPauseAd-container", ".overlayAd-container", ".definitionAd-container", ".cupid-panel"], "skip": [".pause-max-close-btn"], "pauseAd": { "containers": [".maxPauseAd-container", ".pause-max-video-mask"], "close": [".pause-max-close-btn"] }, "maxAdSeconds": 300, "actions": ["pause-close", "mute", "speed"] },
    "v.qq.com": { "video": "video", "adState": [".txp_ad", ".txp_zt", ".txp_ad_center"], "skip": [".txp_ad_skip_text", ".txp_ad_skip", ".txp_ad_active_close", ".txp_zt_close"], "pauseAd": { "containers": [".txp_ad_center"], "close": [] }, "maxAdSeconds": 300, "actions": ["click", "mute", "speed", "seek"] },
    "youku.com": { "video": "video", "adState": ["#youku-pause-container", ".youku-advertise-layer", "#player-advertise"], "skip": ["#youku-pause-container [class*=close]", ".youku-advertise-layer [class*=close]"], "pauseAd": { "containers": ["#youku-pause-container"], "close": [] }, "maxAdSeconds": 300, "actions": ["pause-close", "click", "mute"] },
    "mgtv.com": { "video": "video", "adState": [".as_stages-wrapper", "mango-ad-layer", "mango-ad-outter-layer"], "skip": [], "pauseAd": { "containers": [".as_stages-wrapper"], "close": [] }, "maxAdSeconds": 300, "actions": ["mute", "speed"] },
    "sohu.com": { "video": "video", "adState": ["#miaozhenad", ".middle-insert-ad"], "skip": [], "pauseAd": { "containers": ["#miaozhenad"], "close": [] }, "maxAdSeconds": 300, "actions": ["mute", "speed"] },
    "le.com": { "video": "video", "adState": [".min_pause_img", ".ad_layer", ".broadcast-adv"], "skip": [], "pauseAd": { "containers": [".min_pause_img"], "close": [] }, "maxAdSeconds": 300, "actions": ["mute", "speed"] }
  },
  "generic": { "video": "video", "adState": [], "skip": [], "pauseAd": { "containers": [], "close": [] }, "maxAdSeconds": 180, "actions": ["mute", "speed"] }
}
```
状态机规则（必须严格遵守）：
- tick 间隔 500ms + `MutationObserver`（attributeFilter:["class","style"]，subtree）。
- 进入广告态才动 video；每次只处理「正在播放且最可能为广告」的那个 video（优先 `!paused` 且 `duration` 有限的）。
- 跳过按钮：只点可见（`getComputedStyle` display/visibility 非 none/hidden、`offsetParent!==null`）且未 disabled 的。
- 先记录用户状态（每 video 一份：playbackRate、muted），广告消失后必须精确还原；`ratechange` 监听防止把自己设的 16 当成用户值。
- 静音+加速时设 `playbackRate=16`（若被限制则 ignore），`muted=true`。
- seek：仅当 `readyState>=1 && isFinite(duration) && duration>1`，`currentTime = duration - 0.1`；直播（duration Infinity）禁止 seek。
- 退出广告态后 300–1200ms 内完成还原，清掉自定义属性。
- SPA：tick 里检测 `location.href` 变化则重置全部状态。
- aggressive 模式（settings.videoAggressive=true）时启用 generic 配置：仅当「页面有且仅有一个 video 在播放，且 duration ≤ maxAdSeconds，且无用户暂停」时静音+加速+短 seek（不点击、不整段跳），否则完全不动。默认关闭。
- 所有动作 try/catch + console.debug 前缀 `[AdCleaner]`。

### 8.3 搜索清理（guard-iso 内嵌配置）
域名命中 google./bing.com/baidu.com/sogou.com/so.com/duckduckgo.com 时启用：
- selectors 用 8.1 对应条目（可在此处再列一遍实现，避免依赖 cosmetics 的异步）。
- 处理方式：`el.style.setProperty('display','none','important')` + `el.setAttribute('data-adcleaner-hidden','1')`（幂等），不要 remove DOM。
- 动态：MutationObserver（debounce 250ms）+ 前 20 秒每 1s 扫描一次，20 秒后只留 MutationObserver。
- 统计去重：按元素计数。

### 8.4 userscript（fixer B2）
- `tools/build-userscript.mjs` 读取 `src/data/cosmetics.json`、`src/data/video-sites.json` 与 `userscript/template.js`（B2 编写），把数据内联为 `const AD_DATA = {...}`，输出 `userscript/adcleaner.user.js`。
- 头部 `// ==UserScript==`：`@name AdCleaner 清道夫（油猴版）`、`@match *://*/*`、`@run-at document-start`、`@grant none`、`@noframes`（不开）；`@description` 说明油猴版无网络层拦截、功能为元素隐藏+视频广告跳过+搜索广告清理+弹窗 guard。
- 内容：弹窗 guard（7.1 的 smart 模式子集，不含 aggressive 依赖 settings 的部分）、cosmetics 应用、视频状态机（8.2 简化版）、搜索清理（8.3）、白名单用 `localStorage['adcleaner.whitelist']`（JSON 数组，默认空）。统计不要求。
- 生成物必须 `node --check userscript/adcleaner.user.js` 通过。

## 9. 验证与验收（reviewer 用）
1. `node --check` 全部 .js/.mjs；`JSON.parse` 全部 .json；PNG 头合法。
2. manifest 引用的每个文件都存在；规则集 id 与 background 中一致；每文件规则 ≤30000；正则 ≤1000；id 无重复。
3. 误伤禁区（grep 检查）：cosmetics.json 与 cosmetic.css 中不得有 `[class*="ad"]`、`[id*="ad"]`、裸 `[class*="float"]`、裸 `[class*="popup"]`、`[class*="banner"]`。
4. 代码审查：白名单/总开关在 guard-iso 生效；视频还原逻辑存在；`currentTime` 赋值有 finite 保护；window.open 代理不破坏 descriptor；无远程代码加载。
5. README：安装步骤（Chrome/Edge 加载已解压）、使用、已知限制（YouTube SSAI、国内站反广告拦截风险）、规则更新（npm run build:rules）、许可表。

## 10. 验收标准（本次任务）
- 扩展可被 Chrome/Edge「加载已解压的扩展程序」成功加载（manifest 校验通过）。
- 打开百度/搜狗/360/必应结果页：推广结果被隐藏。
- 打开爱奇艺/腾讯视频/优酷/芒果TV 播放页：暂停广告层被隐藏或关闭；贴片广告出现时被静音+加速/跳过（尽力而为）。
- 打开 YouTube 播放页：无「跳过按钮」的广告被静音+加速，可跳过广告被自动点击；SSAI 片段尽力 seek。
- 弹窗型站点（如装满 popunder 的站点）：不再弹出广告窗；正常登录/支付弹窗不受影响。
- 油猴脚本在 Tampermonkey 中安装后执行同样的页面层拦截。
