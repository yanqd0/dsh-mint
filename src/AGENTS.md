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
│   ├── reminders.ts                       # 工具调用后的事件提醒
│   ├── planbind.ts / plan-mode.ts         # 计划模式退出/开工门禁 + 会话计划状态
│   ├── routes.ts                          # 面板只读 HTTP 路由（webServer 前缀）
│   └── ...                                # session-ledger.ts：会话内 mint 写台账
├── dag/                                   # 依赖 shared + mint，并反向接 host
│   ├── dag.ts                             # DAG 数据层（纯函数，无 node: 依赖）
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
│   ├── dag-open.ts                        # DAG tab 自动打开探测
│   └── ...                                # 面板组件：MintBody / Issue* / Container* / DagBody / Rows / styles / types
└── index.ts                               # 宿主入口（tsup key index），装配全部 install*
```

## TypeScript 口径

工具已管的**不复述**：格式→prettier；lint→ESLint（`recommendedTypeChecked` + 本仓追加规则）；类型→tsc（strict 系列）。只写工具管不到的：

- **命名**：文件 kebab-case、组件 `UpperCamelCase.tsx`；类型 `UpperCamelCase`（无 `I` 前缀）；宿主结构面 `*Like`、线格式 `*Payload`/`*View`；仅模块级常量 `CONSTANT_CASE`；`_` 前缀只表未使用（偏离 Google）。
- **类型**：对象形状 `interface`，联合/映射/工具类型 `type`；不用 `enum`（判别联合 + `as const`）；边界用 `unknown` + 类型谓词/zod；`as` 需注明理由，优先 `satisfies`；只读 `readonly T[]`。
- **null/undefined**：内部只用 `undefined`，`null` 限 mint 线格式与 Node 回调并在边界收口；默认 `x?: T`，需显式传 `undefined` 才 `x?: T | undefined`，别用 `x: T | undefined` 表达可省略。
- **模块**：相对导入带 `.js`；`src/**` 不用 default export；依赖单向，`shared/` 不反向依赖。
- **异步/错误**：故意不等的 Promise 用 `void p.catch(...)` 并写理由；`catch` 按 `unknown` 收口；校验/解析层返回 `T | { error: string }`，到请求/宿主边界才 `throw`。
- **注释**：新增与改动用中文（存量英文不回改）；只写「为什么/不变量/契约」，不重复类型；溯源写描述性引用（文件名 / 小节名 / 机制名），不写 mint 的 issue/plan/milestone ID。

## 拆分与扩展

- 新一级目录：独立域且 ≥3 个生产文件；一级目录 >16 文件或出现明显子簇才切二级。
- 新模块清单：放文件 → 模块 tree 加行 → 全仓 `src/` 引用同步（根 `AGENTS.md`、`CONTRIBUTING.md`、`skill/`、`notes/`）→ 视需要加 tsup/vitest 配置。
- **`dist` 产物名是契约**：tsup entry 的 **key**（`index`/`install-skill`/`check-mint-entry`）与 `dist/client.js`、`dist/skill/` 被 `exports`、`install-dsh.sh`、postinstall 守卫引用；改源路径只改 entry 的 **value**。
- **`import.meta.url` 深度纪律**：运行时不依赖源码层级（见 `src/mint/mint.ts` 向上找 `package.json`）；测试统一用 `tests/helpers/repo.ts`。
- 宿主面不得有 client 构建依赖；client bundle 须预构建（否则 `MissingClientBundleError`）。
- 宿主/客户端契约（`insert:` 列表、宿主事件、root ctx 工具注册、`systemPrompt` 形态、`dsh.client`、sidebar seat、Host RPC、元数据门禁）见 `notes/dsh-plugin-dev.md`、`notes/client-face.md`。
