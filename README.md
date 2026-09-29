# AdCleaner 清道夫

> 屏蔽 **①弹窗广告 ②视频开头/中插/暂停广告 ③搜索引擎广告** 的 Chrome / Edge (Manifest V3) 扩展，
> 附赠一个 Tampermonkey 油猴脚本作为备选方案。

- 网络层：`declarativeNetRequest`（DNR）静态规则集 + 会话白名单规则
- 页面层：`MAIN` / `ISOLATED` 两个内容脚本（元素隐藏、视频广告状态机、搜索广告清理、`window.open` 代理）
- 规则数据：由 `tools/build-rules.mjs` 从公开过滤列表（AdGuard / EasyList / CJX / Peter Lowe / uBO）**真实下载并转换为 DNR 规则**后提交到仓库

> 本项目以 GPL-3.0 开源发布（见 `LICENSE`）。内置规则集来自公开过滤列表，再分发或上架应用商店前请遵守各自的许可条款（见文末「许可与来源」）。

---

## 目录结构

```
adblocker/
├── SPEC.md                       规格书（权威，勿改）
├── README.md                     本文件
├── package.json                  构建脚本与 devDependencies
├── extension/                    扩展本体（加载这个目录）
│   ├── manifest.json             MV3 清单
│   ├── icons/icon16|32|48|128.png
│   ├── rulesets/                 base/cn/annoyances/popups/video/tracking + _sources.json
│   └── src/
│       ├── background.js         Service Worker：设置、规则集、白名单、统计、badge、消息
│       ├── popup/                popup.html / popup.css / popup.js
│       ├── options/              options.html / options.css / options.js
│       ├── content/              guard-main.js（MAIN world）、guard-iso.js、cosmetic.css
│       └── data/                 cosmetics.json、video-sites.json
├── tools/
│   ├── build-rules.mjs           下载 + 转换 + 后处理 + 校验规则集
│   ├── make-icons.mjs            零依赖手写 PNG 图标生成
│   ├── build-userscript.mjs      油猴脚本打包
│   ├── verify.mjs                零依赖自检（npm run verify）
│   ├── stub-dom.mjs              回归自测共享桩 DOM / 虚拟时钟 / 迷你选择器引擎
│   ├── selftest-guard-iso.mjs    guard-iso.js 回归自测（npm test）
│   └── selftest-userscript.mjs   油猴版构建产物回归自测（npm test）
└── userscript/adcleaner.user.js  生成的油猴脚本
```

---

## 安装（手动加载已解压扩展）

1. 安装依赖并生成产物（图标与规则集已提交，通常可直接跳到第 3 步）：

   ```bash
   npm install --include=dev     # 见下方「常见问题」
   npm run build:rules           # 下载真实过滤列表并生成 extension/rulesets/*.json
   npm run build:icons           # 生成 extension/icons/*.png（零依赖）
   npm run build:userscript      # 生成 userscript/adcleaner.user.js（可选）
   ```

2. （可选）自检：`npm run verify`（零依赖；等价于 `node --check` 全部 `.js/.mjs` + `JSON.parse` 全部 `.json` +
   规则集约束/禁区选择器/清单引用检查）。

   回归自测：`npm test`（零依赖桩 DOM，不需要浏览器；第一段直接跑 `extension/src/content/guard-iso.js` 源码，
   第二段跑 `userscript/adcleaner.user.js` 构建产物，故请先执行 `npm run build:userscript`）。覆盖双片段还原、
   安全阀超时、隐藏层广告态判定、stopAll 撤销与设置桥等回归。（自测脚本位于 `tools/`，属交付物。）

3. Chrome / Edge（**128 或更高版本**）打开 `chrome://extensions`（Edge 为 `edge://extensions`）→ 打开右上角「开发者模式」→
   点「加载已解压的扩展程序」→ 选择 **`adblocker/extension`** 目录。

4. 工具栏出现蓝色盾牌图标即安装成功；点击图标打开面板。

---

## 使用

### 工具栏面板（popup）

| 控件 | 说明 |
| --- | --- |
| 总开关 | 全局启用/停用。关闭时停用全部静态规则集并加一条全局 `allowAllRequests` 会话规则；内容脚本读到设置后直接退出（不隐藏任何元素） |
| 今日拦截 | 当天累计拦截次数（内容脚本上报，跨日自动清零，图标 badge 大于 999 显示 `999+`） |
| 暂停在此网站 | 把当前域名加入白名单（会话规则 `allowAllRequests`，优先级 100）。登录/支付类站点被误伤时用它 |
| 规则集开关 | 6 个规则集可单独启停：base / cn / annoyances / popups / video / tracking |
| 选项与白名单 | 打开完整选项页 |

### 选项页（options）

- 总开关、**视频激进模式**（默认关）、**弹窗激进模式**（默认关）
- 规则集开关与逐条说明
- 白名单编辑：每行一个域名（支持 `www.example.com`，自动小写、去协议/路径/端口，非法行会被忽略并提示）
- 规则来源与许可表：读取 `extension/rulesets/_sources.json`，含每个规则集的规则数、体积、抓取时间与是否走了种子兜底
- 清空今日统计
- 设置导出/导入（JSON 文本框）

### 默认设置（`chrome.storage.local["adcleaner.settings"]`）

```json
{
  "enabled": true,
  "whitelist": [],
  "rulesets": { "base": true, "cn": true, "annoyances": true, "popups": true, "video": true, "tracking": true },
  "videoAggressive": false,
  "popupAggressive": false,
  "stats": { "date": "2026-09-29", "dom": 0 }
}
```

---

## 更新规则

```bash
npm run build:rules                 # 重新下载并转换全部列表
node tools/build-rules.mjs --no-cache   # 忽略 .cache/rules 本地缓存，强制重新下载
```

脚本行为（`tools/build-rules.mjs`）：

1. 用 `fetch`（UA 伪装成 `curl/8.4.0`）下载各列表，每个来源都带备用 URL（GitHub raw → jsDelivr 镜像等）。
   完整的下载链是：**Node fetch（重试 1 次）→ curl（走系统代理，兼容直连被墙的 raw.githubusercontent.com）→ 备用 URL → 本地缓存**；
   实际走哪条通道会记录在 `_sources.json` 的 `fetchMethod` 字段里；
2. 用 `@adguard/dnr-converter`（devDependency，仅构建期）把每个列表转换成 DNR 规则；
3. 后处理：`priority` 归一（allow=30 / redirect=11 / 其余=10）→ 纯域名规则（`||domain^`）按 action 分组合并为一条 `condition.requestDomains` →
   **剔除 `requestDomains` 里的「单标签」（TLD，如 `com`/`top`/`click`）与 IP 字面量条目**（个别列表存在 `$domain=com` 这类 TLD 级约束，留着会误封整片 TLD；
   条目被剔空时整条规则丢弃，无论 block/allow）→ 完全重复规则去重 → 重新编号；
4. 校验：顶层必须是数组、单文件 ≤ 30000 条、正则 ≤ 1000 条且单条 ≤ 512 字符（超限丢弃并在控制台打印报告），
   并内置断言 `requestDomains` 中不得残留单标签/IP（违规则构建失败退出）：
5. 生成 `extension/rulesets/_sources.json`：每个来源一条 `{ file, sourceUrl, fetchedAt, license, ruleCount, status, ... }` 记录；
6. **兜底**：某列表下载或转换失败时，用脚本内硬编码的 SPEC 4.4 种子域名（约 150 个）生成同名规则集，控制台打印
   `FALLBACK USED: <列表名> <原因>`，退出码仍为 0，并在 `_sources.json` 中把该来源标为 `FALLBACK` / `FAILED` / `CONVERT_FAILED`；
   下载过的列表会缓存到 `.cache/rules/`（已在 `.gitignore` 中），网络不可用时作为最后手段使用（状态标为 `OK_CACHED`）。

**当前产物统计**（2026-09-29 构建，见 `_sources.json`）：

| 规则集 | 来源 | 规则数 | 正则 | 体积 |
| --- | --- | --- | --- | --- |
| base | Peter Lowe + uBO badware + SPEC 4.4 种子域 | 3939 | 0 | ~813 KB |
| cn | AdGuard Chinese（MV3 变体，含 EasyList China） | 6874 | 0 | ~891 KB |
| annoyances | CJX List（cjx-annoyance） | 621 | 0 | ~72 KB |
| popups | 手写（SPEC 4.1） | 4 | 0 | ~0.6 KB |
| video | 手写（SPEC 4.1） | 16 | 0 | ~2 KB |
| tracking | AdGuard URL Tracking | 2519 | 0 | ~587 KB |

合计 **13973 条规则**（Chrome 只保证同时启用 30,000 条静态规则，脚本内置总预算保护，超出时从最大文件尾部丢弃并打印报告）。
后处理安全过滤共剔除 **56 个单标签/IP 条目**、因剔空而丢弃 **31 条规则**（全部在 base.json；详见 `_sources.json` 的 `sanitize` 字段）。

---

## 已知限制

1. **YouTube 服务端合流广告（SSAI/SABR）无法根治**。客户端只能清 JSON 广告字段、给播放请求注入 `isInlinePlaybackNoAd`、对 SSAP 片段做 `seekTo`，属于尽力而为。
2. **国内视频站存在反广告拦截**：可能降级清晰度、提示「检测到广告拦截」或要求关闭扩展。可用 `video` 规则集开关或站点白名单临时规避。
3. **DNR 的能力边界**：只能做网络层拦截/重定向/改头，不能元素隐藏、不能注入 JS、没有 `$popup` 资源类型、不能改写响应体。因此弹窗、视频、搜索广告必须由内容脚本补足。
4. **`tracking` 规则集使用 `redirect` + `queryTransform`**，属 Chrome 定义的「非安全规则」；它不需要任何 web 访问资源，因此无需额外打包资源文件。
5. **弹窗拦截默认是「智能模式」**：只拦明确的弹窗域名/脚本特征，不会无差别拦 `window.open`，登录、支付、客服、分享类弹窗不受影响。开启「弹窗激进模式」后会额外拦截「合成点击 + `onclick` 内含 `window.open`」，可能误伤，默认关闭。
6. **`videoAggressive`（视频激进模式）默认关闭**：开启后对未知视频站也会静音 + 16 倍速，可能误伤正常视频。
7. 规则集体积较大（约 2.3 MB），首次安装/启用会占用一点内存；`unlimitedStorage` 权限用于存储设置与统计。
8. **需要 Chrome / Edge 128 或更高版本**（`manifest.json` 设为 `"minimum_chrome_version": "128"`）：`tracking` 规则集使用 `redirect.transform.queryTransform` 清理 URL 追踪参数，而该字段是 Chrome 128 才加入的；更旧的浏览器会在启用该规则集时报错。
   内容脚本（`src/content/guard-main.js`、`guard-iso.js`、`cosmetic.css` 与 `src/data/*.json`）均已落地，manifest 引用的文件齐全，可直接加载。
9. **规则后处理会剔除「单标签」与 IP 条目**：生成 `requestDomains` 时删除 TLD 级条目（如 `com`/`top`）与 IP 字面量，数组被剔空则整条规则丢弃；每次 `npm run build:rules` 的剔除数量与示例会写入 `extension/rulesets/_sources.json` 的 `sanitize` 字段与构建日志。
10. **设置桥消息可被同页脚本伪造**：MAIN world 的弹窗 guard 依赖 ISOLATED world 通过 `window.postMessage` 广播的 `adcleaner.settings`（载荷只有 `enabled`/`popupAggressive`/`whitelisted` 三个布尔）。同一页面的脚本可以伪造同 tag 的消息，从而让该页的弹窗 guard 失效（网络层 DNR 拦截不受影响）。这是 MAIN/ISOLATED world 之间靠 `window.postMessage` 通信的固有限制，已接受：不做额外加固（如随机 token），以免扩大注入面或与页面脚本产生新的指纹特征。

---

## 常见问题

- **`npm install` 后找不到 `@adguard/dnr-converter`**：本机（或 CI）的 npm 可能把 `omit` 配成了 `dev`。用
  `npm install --include=dev` 安装，或 `npm config delete omit` 后再装。`build:rules` 在缺少依赖时会给出明确报错。
- **`build:rules` 打印 `FALLBACK USED`**：说明该列表下载或转换失败，规则集已用种子兜底，扩展仍可用但覆盖面下降；原因会写入 `extension/rulesets/_sources.json` 的 `failures` 字段并在选项页提示。
- **某个网站坏了**（登录/支付/视频播放异常）：在面板上点「暂停在此网站」，或在选项页把域名加入白名单。
- **规则集要不要提交**：要。`extension/rulesets/*.json` 属于交付物，已生成并提交（详见 `_sources.json`）。

---

## 许可与来源

本项目整体以 **GPL-3.0** 发布（完整文本见 `LICENSE`）：自写代码（`tools/*.mjs`、`extension/src/**`、`extension/rulesets/{popups,video}.json`）包含在内；
**转换产物**（`base/cn/annoyances/tracking.json`）与**规则数据**的版权归各上游列表所有，条款如下：

| 来源 | 规则集 | 许可 | 说明 |
| --- | --- | --- | --- |
| AdGuard Chinese（chromium-mv3 filter 224，含 EasyList China） | cn | GPL-3.0（AdGuard）/ GPLv3+ & CC BY-SA（EasyList China） | 转换产物为 GPL-3.0 衍生数据 |
| AdGuard URL Tracking（ublock filter 17） | tracking | GPL-3.0 | — |
| CJX List（cjx-annoyance） | annoyances | LGPL-3.0 | — |
| Peter Lowe's Ad and tracking server list（pgl.yoyo.org） | base | 无 SPDX 标识 | 免费使用，需注明来源 |
| uBlock Origin uAssets（badware.txt） | base | GPL-3.0 | — |
| `@adguard/dnr-converter` | 构建期工具 | GPL-3.0 | 仅用于生成规则，不随扩展发布 |

> 本仓库已附完整 GPL-3.0 许可证文本；再分发（尤其是上架商店）前仍建议自行完成法务确认。

---

## 目录内的关键约定

- 规则集 id 必须与 `manifest.json` 的 `rule_resources[].id` 以及 `background.js` 中的 `RULESET_IDS` 保持一致：
  `base / cn / annoyances / popups / video / tracking`。
- 会话规则 id 规划：`1` 为全局放行（总开关关闭时），`1000+` 为白名单域名（最多 500 条）。
- popup / options 与后台之间只用 `chrome.storage.local` + runtime 消息，不假设页面长期打开。
