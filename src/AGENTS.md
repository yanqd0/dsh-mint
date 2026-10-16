# 源码模块与 TS 口径

编码与测试的通用口径见本目录外：导航与硬约束在根 `AGENTS.md`，测试规范见 `tests/AGENTS.md`。

## 模块

每行注释给出该目录/文件能 import 的模块——依赖单向，`shared/` 不反向依赖：

```text
src/                                       # 宿主半边（TS）+ 客户端半边（浏览器）
├── shared/                                # 两侧共享纯数据/工具，无 src 内依赖
│   ├── records.ts                         # 宿主路由与面板共用的线格式
│   ├── route-paths.ts                     # 面板路由空间，两侧共读
│   ├── text.ts / git.ts                   # 文本谓词 / DAG worktree 用的 git 跑壳
│   └── session-id.ts / types.ts           # 结构面类型：宿主 Agent 会话身份、宿主服务形状
├── host/                                  # 会话集成，可 import shared 与 mint
│   ├── context.ts                         # [Mint] 概览注入与工具指引兜底
│   ├── subagent-depth.ts                  # 宿主 subagent.maxDepth 生效值探测与降级文案
│   ├── reminders.ts                       # 工具调用后的事件提醒
│   ├── planbind.ts / plan-mode.ts         # 计划模式退出/开工门禁 + 会话计划状态
│   ├── routes.ts                          # 面板只读 HTTP 路由（webServer 前缀；入口只再导出）
│   ├── routes/internal/                   # 按职责拆分：request-scope / list-policy / mint-handler / cli-surface / agent-snapshot（子代理树快照）
│   └── ...                                # session-ledger.ts：会话内 mint 写台账
├── dag/                                   # 依赖 shared + mint，并反向接 host
│   ├── dag.ts                             # DAG 数据层公开面（只再导出 dag/ 的实现）
│   ├── dag/internal/                      # 按职责拆分：model / validate / parse-action / parse-doc / write / graph
│   ├── agent-tree/                        # 子代理树：读父会话的 subagentCatalog 投影 + 注册表 + 会话投影；agent-tree-store.ts 是它的快照文件层（/tmp/mint/agents，与 dag-store 同形态）；agent-tree-capture.ts 是宿主子代理起止事件的抓拍（subagent/start|end → 链上逐会话写快照）
│   ├── dag-store.ts / dag-lifecycle.ts    # /tmp 文档读写与锁 / 子代理起止配对
│   ├── dag-tool.ts / worktree-tool.ts     # mint_plan_dag 与 worktree 两个宿主工具
│   └── ...                                # metrics / plan-reminder / worktree-sweep
├── mint/                                  # 可 import shared
│   ├── mint.ts / mint-tool.ts             # CLI 执行与 mint 工具注册
│   ├── cross-project.ts / ...-gate.ts     # -p 解析与跨项目写门禁
│   └── ...                                # approval-gate / mint-json / own-project / check-entry-cli
├── skill/                                 # 随包 skill 的安装与同步（≠ 仓根 skill/ 内容真源）
│   └── ...                                # install-skill(.ts/-cli.ts) / skill-cli
├── client/                                # 浏览器半边：只 import shared 与现成纯模块
│   ├── index.tsx                          # esbuild 预构建入口（dsh.client 产物）
│   ├── api.ts / model.ts / dag-model.ts   # fetch 通道 / 视图纯逻辑 / DAG 分层
│   ├── agent-tree-model.ts                # 子代理树的纯逻辑：行/排版/单元格/摘要
│   ├── body-view.ts                       # 正文模式（预览 / 原文代码块）与两模式的词条
│   ├── dag-open.ts                        # DAG tab 自动打开探测
│   └── ...                                # 面板组件：MintBody / Issue* / Container* / DagBody（DAG 面板容器）/ DagGraphView / AgentTreeBody / Rows / styles / types
└── index.ts                               # 宿主入口（tsup key index），装配全部 install*
```

## TypeScript 口径

工具已管的**不复述**：格式→`pnpm format:check`（prettier）；lint→ESLint（`recommendedTypeChecked` + 本仓追加规则）；类型→tsc（strict 系列）。只写工具管不到的：

- **命名**：文件 kebab-case、组件 `UpperCamelCase.tsx`；类型 `UpperCamelCase`（无 `I` 前缀）；宿主结构面 `*Like`、线格式 `*Payload`/`*View`；仅模块级常量 `CONSTANT_CASE`；`_` 前缀只表未使用（偏离 Google）。
- **类型**：对象形状 `interface`，联合/映射/工具类型 `type`；不用 `enum`（判别联合 + `as const`）；边界用 `unknown` + 类型谓词/zod；`as` 需注明理由，优先 `satisfies`；只读 `readonly T[]`。
- **null/undefined**：内部只用 `undefined`，`null` 限 mint 线格式与 Node 回调并在边界收口；默认 `x?: T`，需显式传 `undefined` 才 `x?: T | undefined`，别用 `x: T | undefined` 表达可省略。
- **模块**：相对导入带 `.js`；`src/**` 不用 default export；依赖单向，`shared/` 不反向依赖。
- **异步/错误**：故意不等的 Promise 用 `void p.catch(...)` 并写理由；`catch` 按 `unknown` 收口；校验/解析层返回 `T | { error: string }`，到请求/宿主边界才 `throw`。
- **注释**：判据式，不写默认注释。新增与改写一律中文（存量英文**动到才改**，不专门翻译）；**关键函数**给一行设计目的注释，**复杂关键函数**的步骤给精简编号注释，其余尽量不写；**禁止**复述类型或实现细节的 what 注释（例：`/** 节点的标签 */` 紧跟 `label: string`）；溯源写描述性引用（文件名 / 小节名 / 机制名），不写 mint 的 issue/plan/milestone ID。

## 文件限大与内部拆分

- **≤500 逻辑行是硬门禁**（ESLint `max-lines`，口径 = 跳过空行与纯注释行），**高于单一职责**：职责再单一，超限也必须拆；未超限的强内联模块可以不拆。测试文件另见 `tests/AGENTS.md`。
- **内部拆分**：超限文件**原地变目录**——入口文件仍叫 `x.ts`（只做再导出），实现按职责放 `x/internal/*.ts`。入口必须留成**文件**：NodeNext 对带 `.js` 扩展的说明符不做目录 index 查找（实测 `'./x.js'` 解析不到 `x/index.ts`），所以「`index.ts` + 同名目录」这一形式在本仓行不通。于是外部 import 说明符、TS 解析、dist 产物出口都不变，`eslint.config.mjs` 的 `max-lines` 按 `src/**/*.{ts,tsx}` 覆盖新文件，无需登记。
- 拆出的文件各自职责单一，依赖保持单向；测试侧同构（入口测试留 `tests/unit/<域>/x.test.ts`，子模块测试进 `tests/unit/<域>/x/internal/*.test.ts`，共享 fixture 落 `x/internal/helpers.ts`，见 `tests/AGENTS.md`）。
- 拆分后按「新模块清单」同步模块 tree 与全仓 `src/` 引用。

## 拆分与扩展

- 新一级目录：独立域且 ≥3 个生产文件；一级目录 >16 文件或出现明显子簇才切二级。
- 新模块清单：放文件 → 模块 tree 加行 → 全仓 `src/` 引用同步（根 `AGENTS.md`、`CONTRIBUTING.md`、`skill/`、`notes/`）→ 视需要加 tsup/vitest 配置。
- **`dist` 产物名是契约**：tsup entry 的 **key**（`index`/`install-skill`/`check-mint-entry`）与 `dist/client.js`、`dist/skill/` 被 `exports`、`install-dsh.sh`、postinstall 守卫引用；改源路径只改 entry 的 **value**。
- **`import.meta.url` 深度纪律**：运行时不依赖源码层级（见 `src/mint/mint.ts` 向上找 `package.json`）；测试统一用 `tests/helpers/repo.ts`。
- 宿主面不得有 client 构建依赖；client bundle 须预构建（否则 `MissingClientBundleError`）。
- 宿主/客户端契约（`insert:` 列表、宿主事件、root ctx 工具注册、`systemPrompt` 形态、`dsh.client`、sidebar seat、Host RPC、元数据门禁）见 `notes/dsh-plugin-dev.md`、`notes/client-face.md`。
