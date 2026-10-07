# src/AGENTS.md — 源码模块与 TS 口径（面向 AI）

> 根 `AGENTS.md` 管仓库级硬约束与流程；本文件只管 `src/`：模块边界、TS 口径、拆分规则。测试规范见 `tests/AGENTS.md`。
> DSH 按触碰路径注入嵌套 AGENTS.md，与根文件共享字节预算 → 细节写 `notes/`。

## 模块

| 目录 | 是什么 | 可 import |
| --- | --- | --- |
| `shared/` | 两侧共享纯数据/工具：records、route-paths、text、git、session-id、types | 无 src 内依赖 |
| `host/` | 宿主装配与会话集成（context、reminders、planbind 等） | `shared/` |
| `dag/` | DAG 域：模型、落盘、metrics、生命周期、worktree | `shared/`（边到 host/mint：reminders、plan-mode、cross-project-gate） |
| `mint/` | mint CLI/工具面与门禁（mint、mint-tool、cross-project、approval-gate 等） | `shared/` |
| `skill/` | 随包 skill 的安装/同步（≠ 仓根 `skill/` 内容真源） | `shared/` |
| `client/` | 浏览器半边（esbuild 打包） | 只能 `shared/` 与无 Node 内置依赖的纯模块 |
| `index.ts` | 宿主入口（tsup key `index`） | 全部 |

## TypeScript 口径

工具已管的**不复述**：格式→prettier；lint→ESLint（`recommendedTypeChecked` + 本仓追加规则）；类型→tsc（strict 系列）。只写工具管不到的：

- **命名**：文件 kebab-case、组件 `UpperCamelCase.tsx`；类型 `UpperCamelCase`（无 `I` 前缀）；宿主结构面 `*Like`、线格式 `*Payload`/`*View`；仅模块级常量 `CONSTANT_CASE`；`_` 前缀只表未使用（偏离 Google）。
- **类型**：对象形状 `interface`，联合/映射/工具类型 `type`；不用 `enum`（判别联合 + `as const`）；边界用 `unknown` + 类型谓词/zod；`as` 需注明理由，优先 `satisfies`；只读 `readonly T[]`。
- **null/undefined**：内部只用 `undefined`，`null` 限 mint 线格式与 Node 回调并在边界收口；默认 `x?: T`，需显式传 `undefined` 才 `x?: T | undefined`，别用 `x: T | undefined` 表达可省略。
- **模块**：相对导入带 `.js`；`src/**` 不用 default export；依赖单向，`shared/` 不反向依赖。
- **异步/错误**：故意不等的 Promise 用 `void p.catch(...)` 并写理由；`catch` 按 `unknown` 收口；校验/解析层返回 `T | { error: string }`，到请求/宿主边界才 `throw`。
- **注释**：新增与改动用中文（存量英文不回改）；只写「为什么/不变量/契约」，不重复类型；`#NN` 溯源。

## 拆分与扩展

- 新一级目录：独立域且 ≥3 个生产文件；一级目录 >16 文件或出现明显子簇才切二级。
- 新模块清单：放文件 → 表格加行 → 全仓 `src/` 引用同步（根 `AGENTS.md`、`CONTRIBUTING.md`、`skill/`、`notes/`）→ 视需要加 tsup/vitest 配置。
- **`dist` 产物名是契约**：tsup entry 的 **key**（`index`/`install-skill`/`check-mint-entry`）与 `dist/client.js`、`dist/skill/` 被 `exports`、`install-dsh.sh`、postinstall 守卫引用；改源路径只改 entry 的 **value**。
- **`import.meta.url` 深度纪律**：运行时不依赖源码层级（见 `src/mint/mint.ts` 向上找 `package.json`）；测试统一用 `tests/helpers/repo.ts`。
- 宿主面不得有 client 构建依赖；client bundle 须预构建（否则 `MissingClientBundleError`）。
- 宿主/客户端契约（`insert:` 列表、宿主事件、root ctx 工具注册、`systemPrompt` 形态、`dsh.client`、sidebar seat、Host RPC、元数据门禁）见 `notes/dsh-plugin-dev.md`、`notes/client-face.md`。
