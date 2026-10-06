# 客户端面实测契约（DSH 0.2.0-rc.2）

> 本文是 dsh-mint 客户端面的**权威实测记录**：落点、产物形态、数据通道、验证手段。
> 与代码冲突时以**本机实测**为准（`cordis_inspect_*` + 已安装包产物），改码前先复核。
> 上游 `deepseek-harness` 的包 README 是最佳文档源；本文件只记结论与坑。

## 1. 落点：右侧边栏的 tab 类型

0.2.0 的右侧边栏不是 `conversation.view`。它有两个注册点，都在 `@deepseek-ai/dsh-client-ui-sidebar-right`：

**stage one — tab 类型**（`ctx.sidebarRightTabs.register`）：

```js
ctx.sidebarRightTabs.register({
  id: '@yanqd0/dsh-mint',        // 实现身份，唯一；也是 body/title seat 的 key
  kind: 'mint',                  // 类型判别符，openTab(kind) 用它
  priority: 'builtin',           // 'extension' | 'builtin' | 'fallback'（只影响地址认领）
  title: () => t('type.label'),  // tab chip 文本，开 tab 时定稿
  guide: [{                      // 「新建侧边栏 tab」选项；省略则不上 guide
    id: 'mint',
    order: 30,                   // files=10, terminal=20
    title: () => t('guide.title'),
    description: () => t('guide.description'),
    icon: IconChecklistOutlineRegular,
  }],
});
```

- `title` / `guide[].title` / `guide[].description` 是 **thunk**，每次投影重读 → 切语言免重注册。
- 页面类型（`patterns` 省略）只能 `openTab(kind)` 打开；`patterns` 是 `dsh-resource://` 地址 glob。
- guide 默认页规则：**恰有 1 个 guide entry 时点 `+` 直接开它**；0 个或多个则开 guide 列表。所以新增 entry 要保持「≥2」这一现状（当前 files + terminal + mint = 3）。

**stage two — body seat**（`sidebar.right.pane.tab`，key = `definition.id`）：

```js
ctx.slots.inject('sidebar.right.pane.tab', () =>
  ctx.slots.register(
    { name: 'sidebar.right.pane.tab', key: '@yanqd0/dsh-mint', locale: 'mint',
      inject: (sessionId) => ({ api: createApi(sessionId) }) },
    MintBody,
  ),
);
```

- `hooks.tabInfo` 由框架注入；组件内 `useTabInfo()` 得 `{ sidebar, panel, tab }`。
  `tab.actions.bindCommands({ refresh })` 绑定刷新命令；`tab.signal` 是 tab 记录存活期（abort 信号）；
  `tab.visible` 区分前台/后台会话。
- `locale: NS` 会给组件挂上框架管的 `t` seat，**代价是该命名空间必须已注册**（否则裸 key）。
- slot 的 standardProps 含 `sessionId`，注入函数也以 `sessionId` 为参数 —— 面板据此定位当前项目。

## 2. client bundle 形态与构建

`package.json` 的两处声明缺一不可：

```json
"exports": { ".": "./dist/index.js", "./client": "./dist/client.js" },
"dsh": {
  "bundle": { "patch": "./cordis.patch.yml" },
  "client": { "platform": "web", "inject": ["@deepseek-ai/dsh-client-ui-sidebar-right", "@deepseek-ai/dsh-client-locale"] }
}
```

- `dsh.client.inject` 是**需先到的其它插件包名**（loader 级图序），**不是服务名**；服务级等待由插件自身
  `exports.inject = ['slots','locale','sidebarRightTabs']` 负责。inject 里缺失的包会被**静默跳过**，
  所以声明的真实作用是「顺序 + 意图」，不是硬门禁。
- 产物必须是 loader 工厂（`scripts/build-client.mjs` 用 esbuild + banner/footer 生成）：

  ```js
  window.__ModuleLoader__.load({ id: '@yanqd0/dsh-mint', factory: (require) => {
  "use strict";
  var module = { exports: {} };
  var exports = module.exports;
  /* esbuild 的 CJS 输出 */
  return module.exports;
  } });
  ```

  `id` 与包名一致；`factory` 每次物化只跑一次（惰性：只有注册，没有副作用，副作用在 `apply` 里）。

- **只能 `require` 冻结的 PLATFORM_MODULES**（浏览器内核在启动时 seed）：
  `react`、`react/jsx-runtime`、`react-dom`、`react-dom/client`、`@deepseek-ai/cordis`、
  `@deepseek-ai/dsh-client-store`、`@deepseek-ai/dsh-client-ui-slots`、
  `@deepseek-ai/dsh-client-ui-primitives`、`@deepseek-ai/dsh-client-ui-dockkit`。
  其它请求必须写进 `dsh.client.external`（每个名字对应一个动态包行或静态表 key），否则物化即失败。
- **构建通道**：`pnpm build` = `tsup`（宿主面 ESM+dts）→ `node scripts/build-client.mjs`（浏览器面）→ `build-skill`。
  宿主面不得依赖 client 构建。
- **CI 顺序坑**：`pnpm test:coverage` 在 `pnpm build` **之前**跑，所以测试不得读仓库里的 `dist/client.js`；
  `src/client-bundle.test.ts` 调 `node scripts/build-client.mjs --outfile <tmp>` 再造伪 `window` 载入。

## 3. Host ↔ Client 数据通道

**静态（已安装）插件的 client 半边拿不到 Typert `remote`**：`@deepseek-ai/dsh-api-remotes` 的能力集由构建期
显式选择并 mount，仓外插件无法 join。`harness.handle` / `host.call` 是**动态 Cordis 包** runner
（`dsh-cordis-host-runner` + `dsh-cordis-client-runner`）的闭包符号面，与之无关。

在产做法（`dshmarket` 是活证）：宿主 `ctx.webServer.register` 出 JSON 路由 + 浏览器 `fetch`。

```js
ctx.inject(['webServer'], (scoped) => {
  scoped.effect(() => scoped.webServer.register({ kind: 'prefix', path: '/dsh-mint', handler }), 'label');
});
```

- `webServer` 是可选服务：无头/ACP 组合没有它，`ctx.inject` 只推迟这块，不影响其余能力。
- `(kind, path)` 重复注册抛错；`kind: 'prefix'` 独占该前缀下的全部路径。
- **前缀不能带尾斜杠**（已踩）：宿主匹配规则是
  `pathname === prefix || pathname.startsWith(prefix + '/')`（`dsh-host-webserver` 的 `match`）。
  注册 `/dsh-mint/` 只匹配 `/dsh-mint/` 与 `/dsh-mint//…`，`/dsh-mint/issues` 会**落到 fallback**
  （SPA 静态服务 → 空 body 404，面板上显示 `HTTP 404: (empty body)`）。注册 `/dsh-mint` 才对，
  且 `/dsh-mint-other` 不会被误吞。回归护栏在 `src/routes.test.ts`。
- 浏览器侧路径要用 `document.baseURI` 解析（反代子路径挂载时 `/xxx` 会 404）——见 `dshmarket` 的 `api()`。

dsh-mint 的路由表（全部 GET、只读）：`/dsh-mint/issues`、`/dsh-mint/issue`（`show --json` 全量，含 body）、
`/dsh-mint/plans`、`/dsh-mint/plan`、`/dsh-mint/milestones`、`/dsh-mint/milestone`、`/dsh-mint/meta`，
均带 `session=<SessionId>`，宿主经 `ctx.agents.get(sessionId)?.session.header.cwd` 解析项目目录
（**不接受浏览器给的路径**）。**前缀与路由名单只有一份**：`src/route-paths.ts`（`ROUTE_PREFIX` /
`ROUTE_NAMES` / `routePath` / `isRouteName`），宿主 `src/routes.ts` 与浏览器 `src/client/api.ts` 各自
派生——`src/route-paths.test.ts` 比对两表防漂移（#104）。每次 CLI run 共享**本请求的一个
AbortController**（`RequestScope`），
浏览器断连即取消该请求的全部子进程——早先「一次 run 挂一个 `close` 监听」在 meta 的并行读下会撞
`MaxListeners`，且只能取消其中一个。

`/dsh-mint/meta` 是面板的**字典路由**（一次响应替代 N 次读）：`plan list --all-states`、
`milestone list --all-states`、`label list`（均 `--no-page`），加上 `placement`（issue → effective
milestone + 是否直连）。

> **容器列表的结束态默认（#88）**：`plan list` / `milestone list` 自己只隐藏 `done`，`partial`
> （issue 已全部收口但未 released）与 `dropped` 仍会出现；而 `--status` 只接受单值（重复即 usage
> error），"open 或 running" 无法表达。所以 `/dsh-mint/plans` 与 `/dsh-mint/milestones` 的**默认**
> 路径读全表（`{kind} list --all-states --json --no-page`）→ 宿主按 `CONTAINER_END_STATES`
> 过滤 → `settledContainerPage` 自己重算 `page/page_size/pages/total` 并切片（`--no-page` 仍带
> mint 的**未过滤**计数，不能直接用）。`allStates=1` 或显式 `status` 才走 `buildListArgv` 的直通
> 形式（前者含 `--all-states`，分页交回 mint）。判据：mint 新增状态不在白名单里时**保持可见**。

> `list --json` **不含 body**，而 `show <id> --json` 同时给出列表字段与 body（还多一个 `milestone_id`）——
> 所以 issue 详情走 `show --json` 一次调用。

> **`list --json` 也不含 issue 的 effective milestone**（0.9.0-alpha.1 实测：只有 `plan_id`），
> label 的 color 更是只存在于 `label list`。所以 meta 的 placement 目前**逐 milestone 反查**
> （`list --all-states --milestone <M>`，上限 30，M 次 spawn），上游 mint 在 list 输出补上该字段即可
> 删除——已跨项目登记 **mint #503**（本项目 plan #15 记录，dsh-mint #90/#105 关联）。**当前缓解
> （#105）**：三张字典表每次请求实读，placement 这张昂贵的表按 (entry, cwd) 在宿主进程内缓存
> `PLACEMENT_TTL_MS`（默认 10s，`MintRouteDeps.now` 是测试时钟缝）；面板的显式刷新走
> `/dsh-mint/meta?...&refresh=1` 强制重扫（`createApi` 的 `meta(signal, fresh)`）。milestone 详情的
> 「包含 plan」仍用 meta 的 all-states plans 按 `milestone_id` 过滤，而不是再打一次计划路由（那里
> 只回应当前筛选下的分页，已收口的 plan 会消失）。

> **mint 的可空字段是「合法答案」，不是形状漂移（#94/#95/#96/#107/#108）**：`show --json` 的 issue /
> container `body`、plan/milestone 的 `version`、`label list` 的 `color` 都来自 `Option<…>`，未设时为
> `null`。守卫（`src/mint-json.ts` 的 `isStringOrNull`）接受 `null`，路由**原样透传**（`truncateBody(null)`
> 返回 `{body:null,truncated:false}`），由展示层消化：`hasBody(null)`/`BodyView` 显示空态、
> `containerMeta`/`milestoneVersionOf` 丢弃 `null` 版本、`labelBadge(label?.color ?? '')` 退回中性徽章。
> 千万不要把「要求 string」当严格性——那会把整条记录从列表里丢掉并报假的 `missing required fields`。

## 4. locale 与术语口径

### 4.1 注册与查找链

- 仓外命名空间**只能用单语种非类型化形式**：`ctx.locale.register(ns, locale, dict)`。
  类型化双参形式要求「所有内置 locale 齐备」（双语平衡在注册期强制），且只适用于 merge 表内的 ns。
- 内置 locale id：`zh` / `en`。查找链 = 当前语言 → 其 fallback 链（`zh`→`en`）→ `common` ns → 裸 key。
  **缺 key 直接显示 key 本身**：本仓不给占位、也不做中文回落（0.2.0 的 `en` 中文占位与
  `createTranslator` 的中文回落已在 0.3.0 删除）——译文缺失要响铃，不要静默出中文。
- `{name}` 插值由框架 `translate` 负责（`params` 里没有的名字原样保留），本仓不再自带 `interpolate`。
- 切换语言 bump revision：`title`/`description` thunk 与 `locale: NS` 的组件都会自动跟随，无需重注册
  （落点是 SlotOutlet 的 `useLocaleRevision`，0.2.0 实测，0.3.0 沿用）。
- **第三种语言**：`ctx.locale.addLanguage({id,label,fallback:'en'})` + `ctx.locale.register(NS,'ja',{…})`；
  没注册的语言由查找链逐 key 回退到 `en`，因此本项目不会出现裸 key。

### 4.2 词典与守卫（`src/client/copy.ts` + `copy.test.ts`）

- `ZH` 是 key 集真源（`as const`），`EN` 为 `as const satisfies Record<CopyKey, string>`：
  **缺 key / 多 key / 类型不符都是编译期错误**，无需运行期比对。
- `KEPT_IN_ENGLISH` 登记「两语言同文」的 key（mint 品牌 + `Issue`/`Plan`/`Milestone` +
  `container.plan`/`container.milestone`）；测试**双向**断言：登记项必同文、未登记项必不同文。
- 守卫：key 集一致、两条都非空、占位符集合一致、**英文宽度预算**
  （CJK/全角字符记 2 列；`width(EN) ≤ max(2×width(ZH), width(ZH)+12)`；逃生口 `WIDTH_EXEMPT`）、
  **无死 key**（每个 key 至少在 `src/client/**` 里出现一次 `'<key>'` 字面量）、
  **无游离中文**（该目录除 `copy.ts` 与测试外不得出现 CJK）。
- 宽度预算是实测门禁：英文同义句天然更长，而 guide 卡片（380px、11px、nowrap+ellipsis）、
  工具条与分页行都很窄；写英文时按预算收敛，超了先改文案再加逃生口。

### 4.3 术语口径

| 类别 | 口径 |
| --- | --- |
| 标签页/概念 | `Issue` / `Plan` / `Milestone` 两语言都英文（`view.*`、`container.*`，即 `KEPT_IN_ENGLISH`） |
| mint 数据 | issue 状态（`open`/`planned`/`dev`/`test`/`done`/`dropped`）、容器派生状态、kind（`problem`/`requirement`/`task`）、`P0`–`P3`、版本号、时间戳：**原样镜像 CLI**，不进词典（便于与 `mint` 输出逐字对账） |
| 面板自有词 | 按钮/字段名/提示/计数单位/已知错误码：走词典，中英各一份 |
| 失败与诊断 | 只有稳定错误码本地化（当前仅 `session-not-live` → `error.sessionNotLive`）；mint stderr、`mint-json` 形状告警、畸形请求文本**原样透传** |
| 计数 | `count.issue.one\|other` + `model.countKey(n)`：英文分单复数，中文两条同文 |
| 分隔符 | ` · `、`#`、`↳`、分数页码 `1/3` 等语言中立，不进词典（容器列表页脚保留分数，避免英文整句挤占工具条） |
| 宿主面文案 | 面向模型的注入/提醒/工具描述仍是中文，不在客户端词典范围；审批提示走宿主自有 `displayReason {en,zh}` |

## 5. 主题

只允许 `--dsw-*` token（`cordis_inspect_query` 的 client Theme provider 可列全量）：
`--dsw-alias-bg-base` / `bg-layer-1` / `bg-layer-2` / `bg-overlay`、`--dsw-alias-border-l1|l2`、
`--dsw-alias-label-primary|secondary`、`--dsw-alias-state-error|warn|success|idle-primary`、
`--dsw-alias-brand-primary`、`--dsw-specific-sidebar-fill`。
组件内样式用 React 元素渲染（卸载即移除），不新增构建期 CSS 通道。

## 6. 验证手段

1. **注册面**：`cordis_inspect_query` → client `Slots.listSubTree`，`root: "sidebar.right.pane.tab"`，
   看 occupants 是否含 `@yanqd0/dsh-mint`；`root: "sidebar.right.tab.guide"` 看 guide 链。
2. **产物面**：`src/client-bundle.test.ts`（伪 `__ModuleLoader__` 物化 + require 白名单）。
3. **实机面**：新增 `dsh.client` 后**必须重启 harness**（row 只在启动扫描时入图）；
   此后改 bundle 只需重新 `pnpm build` + 刷新页面（revision 由 mtime/ctime/size 推导，无内容哈希）。
4. profile 以 `link:` 安装时，`dist/client.js` 直接从工作区被服务。
5. **插件元数据面（headless，不依赖浏览器）**：直接调 DSH 的 reader 看宿主读到什么：

```bash
DSH_PKG="$(readlink -f "$(ls -1d "$HOME"/.nvm/versions/node/*/lib/v11/*/node_modules/@deepseek-ai/dsh | tail -n1)")"
node --input-type=module -e "
import { createRequire } from 'node:module';
const req = createRequire('$DSH_PKG/lib/bin.js');
const { readPluginMeta } = await import(req.resolve('@deepseek-ai/dsh-app-boot'));
console.log(JSON.stringify(readPluginMeta('@yanqd0/dsh-mint', 'file://$HOME/.dsh/profiles/web/package.json'), null, 2));
"
```

**改 `package.json`（exports / files / description）后必须重启 harness**：Node 内置 resolver 把解析过的
`package.json` 按**进程**缓存，mtime 变更不会让它失效（#127 的实测坑：磁盘上已修好，headless 复现通过，
但运行中的 harness 仍返回旧的 `ERR_PACKAGE_PATH_NOT_EXPORTED`）。**只改字典文本**（已导出子路径下的
`locale/*.json` 内容）才是按请求读盘、刷新页面即可。缓存实测（临时包，同进程内先失败后改写再解析）：

```bash
# 1) exports 只有 "."，解析 <pkg>/package.json → ERR_PACKAGE_PATH_NOT_EXPORTED
# 2) 同进程内给 exports 补上 "./package.json"
# 3) 再解析：CJS resolve 与 import.meta.resolve 仍然是 ERR_PACKAGE_PATH_NOT_EXPORTED（缓存住旧清单）
```

（`ls -1d` 的 `-d` 不能省：少了它会列目录内容，拿到 `package.json` 这种行。）

**而且要把浏览器页面真的重载一次**（#127 的第二个坑）：harness 重启期间旧页面只会自动重连，
插件面板的列表是**页面加载时取的快照**（`ensure()` 仅在 `idle` 时读、`load()` 不清缓存），
不重载就不会重取——实测「磁盘已修好 + headless 通过 + harness 重启过」之后页面仍为空，**F5 后才出现**。
判据（在出问题的那个页面上跑，浏览器自带登录态）：

```js
await fetch('/api/pluginManager/listBundles',{method:'POST',headers:{'content-type':'application/json'},
  body:JSON.stringify({type:'client-request',rpcId:'p',method:'pluginManager/listBundles',payload:{args:{}}})})
  .then(r=>r.json()).then(d=>console.log(d.result.value.find(b=>b.name==='<包名>')))
```

console 里已经带新 meta、页面却还是旧的 ⇒ 页面快照陈旧，刷新即可；
console 里也是旧值 ⇒ 服务端未生效，按上一段查 resolver 缓存 / 是否重启过 harness。

## 7. 已知坑

- **banner 顶掉 `"use strict"`**：esbuild 的 banner 插在生成代码之前，文件级 `"use strict"` 会失去指令位置；
  我们在 banner 内部再写一次（函数体内），语义等价。
- **`exports` 与 `module` 必须由 banner 提供**：esbuild 的 CJS 输出会 `module.exports = __toCommonJS(...)`，
  所以 footer 必须 `return module.exports` 而不是 `return exports`。
- **React 绝不能打进包**：身份必须与 shell 的模块表一致，否则 hooks/context 立刻炸。
- **`dsh.client.inject` 缺失项静默跳过**：不要把它当门禁；真正的门禁是插件自身的 `exports.inject`。
- **CI 先测后构建**：任何「读 dist 产物」的测试都必须在测试内自行构建到临时目录（并清理）。
- **声明 `exports` 就等于给展示元数据上门禁**（#127）：`readPluginMeta` 用 Node resolver 解析
  `<pkg>/package.json` 与 `<pkg>/locale/en.json`，缺这两个子路径时 `ERR_PACKAGE_PATH_NOT_EXPORTED`
  被 `optionalResourcePath` **静默吞掉**（无报错、无 placeholder），插件页只剩包名。见 §8。
- **修完 exports 必须重启 harness 才生效**（#127）：resolver 的 `package.json` 缓存按进程存活，
  **磁盘改好 + headless 复核通过 ≠ 运行中的 harness 变了**——「headless 已好、页面仍空」时先重启，别怀疑 UI。见 §6.5。

## 8. 插件展示元数据（插件页的标题/描述/图标）

【插件】界面（右侧边栏 **插件** 面板的包详情页、设置 → 插件 → **插件列表** 的卡片）里的标题与描述
都来自一个宿主 reader，与客户端半边无关：

- reader：`readPluginMeta(specifier, parentURL)`（`@deepseek-ai/dsh-app-boot`）；
  消费方 `dsh-host-plugin-inventory`（`pluginPackages.metaOf(row)`，逐 composition row）与
  `dsh-plugin-manager`（bundle 列表）。
- 解析**两条路径，都过 Node resolver**：
  - `` `${specifier}/locale/en.json` `` —— 决定「字典目录」；`en.json` **不存在就完全不会枚举该目录**，
    于是其余语言字典形同不存在（这是最先踩的坑：只放 `zh.json` 无效）。
    随后枚举同目录**全部** `.json`，文件名必须是语言 id（内置 `en` / `zh`），内容形如
    `{"meta":{"title":"…","description":"…"}}`；`textOf` 要求非空字符串，多一个野名字会让整条元数据变 `{error}`。
  - `` `${specifier}/package.json` `` —— 提供 `name`（title 兜底）、`description`（英文兜底）、`icon`。
- 产物形态：`title` / `description` 都是 `LocalizedText`（`{en, zh, …}`，`en` 必在），客户端用
  `locale.resolveText` 按当前语种取值；**没有 `meta` 时**客户端 `packageText` 退回完整包名、描述不渲染。
- **`exports` 是硬门禁**：包一旦声明 `exports`（本插件有 `"."` / `"./client"`），就必须显式加
  `"./package.json": "./package.json"` 与 `"./locale/*.json": "./locale/*.json"`，并把 `locale/*.json`
  写进 `files`；否则解析失败被静默吞掉（#127）。无 `exports` 的老包（如 `dsh-whale-widget`）
  走 legacy 解析反而正常——**「隔壁能显示」不代表自己的写法对**。
- 渲染落点：侧栏插件面板 `PackageDetail` 的 `<p class="detailDesc">`（根节点 `[data-plugin-detail="<包名>"]`）、
  标题行下的 `<code data-plugin-name>`；设置里的卡片是 `cardDescription`（2 行截断）。
- `icon`：manifest 内**相对路径**，SVG/PNG/JPEG/WebP，≤256 KiB，`realpath` 后须仍在 manifest 目录内；
  失败只丢图标、保留文字。
- 守卫：`src/package-manifest.test.ts` 的 `plugin display metadata` 组用**自引用解析**
  （`createRequire(join(ROOT,'package.json')).resolve('@yanqd0/dsh-mint/package.json')`）复刻同一条
  resolver 规则，无需安装 harness，即可在 CI 抓住门禁回归。
- **生效路径**：改了 `package.json`（exports / files / description）⇒ **重启 harness** 才生效（resolver 缓存，
  见 §6.5）；只改已导出字典的文本 ⇒ 刷新页面。**headless 自检通过不代表运行中的 harness 已更新**。

