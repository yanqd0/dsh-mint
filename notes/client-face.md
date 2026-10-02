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
（**不接受浏览器给的路径**）。每次 CLI run 共享**本请求的一个 AbortController**（`RequestScope`），
浏览器断连即取消该请求的全部子进程——早先「一次 run 挂一个 `close` 监听」在 meta 的并行读下会撞
`MaxListeners`，且只能取消其中一个。

`/dsh-mint/meta` 是面板的**字典路由**（一次响应替代 N 次读）：`plan list --all-states`、
`milestone list --all-states`、`label list`（均 `--no-page`），加上 `placement`（issue → effective
milestone + 是否直连）。

> `list --json` **不含 body**，而 `show <id> --json` 同时给出列表字段与 body（还多一个 `milestone_id`）——
> 所以 issue 详情走 `show --json` 一次调用。

> **`list --json` 也不含 issue 的 effective milestone**（0.9.0-alpha.1 实测：只有 `plan_id`），
> label 的 color 更是只存在于 `label list`。所以 meta 的 placement 目前**逐 milestone 反查**
> （`list --all-states --milestone <M>`，上限 30，M 次 spawn），上游 mint 在 list 输出补上该字段即可
> 删除——已跨项目登记 **mint #503**（本项目 plan #15 记录）。同理 `plan list` 路由**不传**
> `--all-states`，故 milestone 详情的「包含 plan」用 meta 的 all-states plans 按 `milestone_id`
> 过滤，而不是再打一次 plans 路由（否则已收口的 plan 会消失）。

## 4. locale

- 仓外命名空间**只能用单语种非类型化形式**：`ctx.locale.register(ns, locale, dict)`。
  类型化双参形式要求「所有内置 locale 齐备」（双语平衡在注册期强制），且只适用于 merge 表内的 ns。
- 内置 locale id：`zh` / `en`。缺失的 key 会**直接显示 key 本身**，所以 0.2.0 把字典同时注册给
  `zh` 与 `en`（英文占位为中文），0.3.0 再换真英文（纯数据变更）。
- 切换语言会 bump revision；`title`/`description` thunk 与 `locale: NS` 的组件都会自动跟随。

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

## 7. 已知坑

- **banner 顶掉 `"use strict"`**：esbuild 的 banner 插在生成代码之前，文件级 `"use strict"` 会失去指令位置；
  我们在 banner 内部再写一次（函数体内），语义等价。
- **`exports` 与 `module` 必须由 banner 提供**：esbuild 的 CJS 输出会 `module.exports = __toCommonJS(...)`，
  所以 footer 必须 `return module.exports` 而不是 `return exports`。
- **React 绝不能打进包**：身份必须与 shell 的模块表一致，否则 hooks/context 立刻炸。
- **`dsh.client.inject` 缺失项静默跳过**：不要把它当门禁；真正的门禁是插件自身的 `exports.inject`。
- **CI 先测后构建**：任何「读 dist 产物」的测试都必须在测试内自行构建到临时目录（并清理）。
