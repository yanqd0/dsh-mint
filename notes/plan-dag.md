# plan DAG 规格真源（plan #31 / issue #148）

> 来源：mint plan #31 正文（`plan show 31 --json`，milestone 0.3.0 / #4，version 0.3.0）。
> 范围：宿主工具 `mint_plan_dag`（init/add/set/get）+ 状态文件 `/tmp/mint/dag/<sessionId>.json`
> + 只读路由 `GET /dsh-mint/dag` + 右侧边栏并列新 tab（`kind=plan-dag`）。
> 本文件是**将来实现会话的规格真源**：照做即可，不需要再做设计决策；只写事实与规格，
> 不含实现代码（字段示例除外）。客户端侧 seat / 产物契约见 [client-face.md](client-face.md)，
> 会话事件与只在状态变更后提醒的分工见 [todo-panel.md](todo-panel.md)。

## 1. 状态文件契约

### 1.1 路径与校验

- 路径固定为 `/tmp/mint/dag/<sessionId>.json`；目录不存在时按需创建。
- `sessionId` **必须先按 `^[A-Za-z0-9_-]{1,64}$` 校验，再拼接路径**；不匹配即拒绝，绝不拼路径
  （防目录穿越）。该串来自路由 query 的任意输入，是唯一的外部入口。
- 只保证**一次开机内持久**：重启或 `/tmp` 清理后文件消失，属正常态（见 §6）。

### 1.2 写与并发

- 写 = 先写同目录临时文件，再 `rename` 原子替换目标文件；读-改-写必须在**一个 tool 调用内**完成。
- 同进程内**按 sessionId 加一把 promise 锁**串行化读-改-写，防并行 tool 调用丢更新。
- 锁只在本插件进程内有效；同机多 harness 进程下退化（见 §6）。

### 1.3 文档结构

```json
{ "version": 1, "session": "<sessionId>", "title": "", "revision": 1,
  "created_at": "", "updated_at": "", "nodes": [], "edges": [["a", "b"]] }
```

| 字段 | 说明 |
| --- | --- |
| `version` | 固定 `1`；不识别即「DAG 不可读」 |
| `session` | 所属 sessionId |
| `title` | 文档标题，`init` 的 `title?` 写入 |
| `revision` | 每次写 +1；新建/重置后从 1 起，客户端据此判断是否需要重渲 |
| `created_at` / `updated_at` | 创建 / 最后写入时间 |
| `nodes` | 节点数组，字段见 §1.4 |
| `edges` | 边数组，元素为 `[from, to]` 二元组（节点 id） |

### 1.4 node 全字段

| 字段 | 必填 | 取值 / 语义 |
| --- | --- | --- |
| `id` | 是 | 文档内唯一 |
| `label` | 是 | ≤6 字，面板节点上显示 |
| `title` | 是 | 完整标题，悬停 tooltip 显示 |
| `phase` | 是 | `research` \| `exec` |
| `status` | 是 | `pending` \| `running` \| `done`（新建默认 `pending`） |
| `verdict` | 否 | `pass` \| `fail`，**仅终态（`status='done'`）**可有 |
| `depends_on` | 否 | 前置节点 id 数组（缺省为空） |
| `issue` | 否 | 关联 mint issue id |
| `agent` | 否 | 子代理 sessionId（由 §3 生命周期回填） |
| `tokens` | 否 | 可选，由 agent / 子代理在 `set` 时自报；**面板优先显示宿主的实测值**（§4.7），自报值只在实测缺失时退回 |
| `note` | 否 | 子代理回给 main 的结论原文；tooltip 显示，可滚动 |
| `updated_at` | 是 | 该节点最后一次变更时间 |

### 1.4.1 文档级 `samples`（宿主实测样本，plan #35 / #167）

节点里的 `tokens` 是**子代理自报**；宿主实测值另存一层，避免两种语义混在一起：

```json
{ "samples": { "<node id>": { "tokens": 28067, "elapsed_ms": 3231, "at": 1786000000000 } } }
```

- `at` = 该样本的采样时刻（宿主 epoch ms）；`tokens`/`elapsed_ms` 与线上 `DagNodeMetrics` **同语义**。
- **校验是「整份严格、单条宽松」**：`samples` 不是对象 → 整份文档不可读；某条自身的字段非法（`at` 缺失/负数/小数、已出现的数字字段非法）→ **只丢该条**，图照常渲染；条目里一个数字都没有也丢。无 `samples` 的旧文档解析后**不产生该键**（round-trip 不变）。
- **谁写**：只有生命周期与路由的补写路径（`updateDag` 里手工 merge，见 §3/§4.7）；`src/dag.ts` 自己不写，`applyDagWrite` 靠 spread 原样保留已有 `samples`。写实现见 #168。
- **为什么落盘**：子代理结束、`ctx.agents.get(id)` 不再返回 session 之后，实测值否则会整份消失（#166 的真机实测）。

### 1.5 缺失与损坏的容错

- **文件缺失 = 「本会话暂无 DAG」的正常状态，不是错误**：读取方不报错、不刷错误日志。
- `version` 不识别或 JSON 解析失败 → 客户端显示「DAG 不可读」+ 文件路径，**不崩溃**。

## 2. 工具面 `mint_plan_dag`

### 2.1 注册与形态

- 动作枚举 `action: "init" | "add" | "set" | "get"`。
- 注册在**宿主 root ctx**，与既有 `mint` 工具同席位：零授权、插件进程内执行、**子代理继承**。
- 返回值只给 **1–3 行摘要**，不回灌全图。

### 2.2 `init`

- 参数：`title?`。
- 语义：新建本会话文档；已存在则整份重置（旧节点/边丢弃，`created_at`/`updated_at` 重写，
  `revision` 从 1 重新计）。

### 2.3 `add`

- 参数：`nodes[]`（每项 `id` / `label` / `title` / `phase` / `depends_on?` / `issue?`）、`edges?`（`[from, to]`）。
- 校验与错误路径：
  - **未知依赖**（`depends_on` 或 `edges` 指向不存在的 id）→ 报错并**列出全部未知 id**，不写文件。
  - **成环** → 拒绝并**回显该环**（DAG 无环是硬约束），不写文件；自环同判为环。
  - 重复 `id`、`label` 超 6 字、`phase` 非枚举值 → 同样拒绝，不写文件。
- 动作本身是读-改-写，走 §1.2 的锁与原子写。

### 2.4 `set`

- 参数：`id` + `status`，可选 `verdict?` / `note?` / `tokens?` / `agent?`。
- 错误路径：
  - `id` 不存在 → 报错且**不改文件**。
  - `verdict` **仅 `status='done'` 合法**（值仅 `pass` / `fail`）；非终态传 `verdict` → 拒绝，不写文件。
  - `status` / `verdict` 非枚举值 → 拒绝，不写文件。
- 成功即更新该节点字段与 `updated_at`，并推进 `revision`。

### 2.5 `get`

- 参数：无额外必需参数（按会话取）。
- 返回**紧凑摘要**：节点数 / 边数 / 各状态计数 / 当前 `running` 列表，1–3 行。
- **不把全图塞回上下文**（沿用 `injection-size.test.ts` 的每请求预算纪律）；全图只经 §4 的路由给客户端。

## 3. 宿主生命周期配对

- 监听 `subagent/start` / `subagent/end`：宿主 `SubagentRunInfo` / `SubagentRunEndInfo` 含
  `runId`、`id`（子 sessionId）、`stopReason`（`end` 侧）。
- `start`：把 `id` 回填到**最近一个 `status='running'` 且 `agent` 为空**的节点。
- `end`：若目标节点仍为 `running` → 标 `verdict:'fail'`，并附 `stopReason`（写入节点 `note`，
  即结果原文）；这是「子代理崩了没收尾」的兜底。
- **不自动建节点**：没有任何节点可回填时只跳过，绝不为子代理新建节点——节点一律来自 `init`/`add`。

## 4. 客户端可视化

### 4.1 新 tab 类型

- `id = '@yanqd0/dsh-mint:plan-dag'`、`kind = 'plan-dag'`、`priority: 'builtin'`。
- guide 条目 `order = 40`，排在既有 mint 条目（30）之后。
- **与 mint 面板并列，不改 mint 面板**；body seat 沿用 `sidebar.right.pane.tab`。

### 4.2 路由与信封

- `src/route-paths.ts` 的 `ROUTE_NAMES` 加 `dag`；`GET /dsh-mint/dag?session=<id>`（只读）。
- 信封：`{ ok: true, dag: DagView | null, revision, warnings? }`。
- **文件缺失 → 200 + `dag: null`**（不是 404）。
- `session` 非法（不匹配 §1.1 正则）→ 拒绝，不拼路径。

### 4.3 渲染

- SVG 图；**宿主不下发布局**，客户端按 `depends_on` **拓扑分层、自上而下**，同层等距。
- 节点圆角矩形 + 折线边；框内**两行**：`label` 在上，下面一行是实测 `token` 与时长（见 §4.7）。
- 悬停 tooltip：状态/结论**徽章行**、完整 `title`、实测 token 与时长（缺失时退回自报 `tokens`）、`note`（结果原文，可滚动）。

### 4.4 四态配色（已核对主题 token）

节点**底色**由 `dagTone` 决定（下表）；tooltip 的**徽章**另用 `dagStatusTone`：`pending` 与 `running` 都取 `warn`
（徽章要一眼看到"在做什么"），只有 `done+fail` 取 `error`。

| 状态 | 节点底色 |
| --- | --- |
| `pending` | 黄 `--dsw-alias-state-warn-primary` |
| `running` | 绿 `--dsw-alias-state-success-primary` + 边框闪烁 |
| `done` + `pass` | 绿 `--dsw-alias-state-success-primary`（不闪） |
| `done` + `fail` | 红 `--dsw-alias-state-error-primary` |

实测数字另有自己的两种颜色，只上数字、不上单位：

| 量 | 颜色 |
| --- | --- |
| token 数字 | 黄 `--dsw-alias-state-warn-primary`（金钱语义，复用主题已有的 warn） |
| 时长数字 | 紫 `#8b76f6`（`styles.ts` 的 `LIVE_TIME_COLOR` 常量） |

> **为什么紫色是字面量**：本主题的 403 个 `--dsw-*` token 里没有紫色 alias——紫只出现在 onboarding 渐变
> 与 shiki 语法色。这与 `labelBadge` 接受 label 自带字面色的先例同一取舍；浅/深主题下的可读性靠人眼确认，
> 需要时改这一个常量。


### 4.5 闪烁与降级

- 面板内注入**一次** `<style>`（含 `@keyframes`），仅 `running` 节点挂 class。
- `prefers-reduced-motion: reduce` → 降级为静态描边。

### 4.6 刷新

- `useTabInfo().tab.visible` 为真时每 **2000 ms** 轮询；不可见时不轮询。
- 跳过写的判据是「**整份读数**与上次相同」：`revision` + `sampled_at` + 逐字段 `metrics` 全等（plan #34）；
  只比 `revision` 会让实时数字停住，只比 `sampled_at` 会让静止的图每 2 s 重渲一次。
- **走秒**：存在 `running` 且该节点有实测 `elapsed_ms` 时才起一个 **1 s** 本地定时器，把
  `sampled_at` 当锚算"最后一次采样又过了多久"；没有这样的节点、tab 不可见、组件卸载都会清掉它。
- `tab.signal` 中止在途请求；失败的一轮会忘掉上次读数，避免"恢复后样本未变"被跳过而停在错误页。
- **不做 SSE**。

### 4.7 实时指标：token 与执行时间（plan #34）

**真源 = 宿主会话投影，不是子代理自报**（dsh 子代理 UI 用的就是同一对值）：

| 量 | 投影 key | 算法 |
| --- | --- | --- |
| token | `tokenUsage`（`@deepseek-ai/dsh-token-meter`，`dsh-base` 已挂） | `totals.uncachedInputTokens + outputTokens + cacheReadTokens + cacheWriteTokens`（四桶不相交） |
| 时长 | `subagentTiming`（`@deepseek-ai/dsh-subagent`） | `settledMs + max(0, end - active.since)`，`end = 节点 running ? sampledMs : active.through`（与子代理 UI 的 `activityDuration` 同式） |

- 读取：`ctx.sessionProjections.stateOf(session, key)`——**同步、内存、按 session 惰性 fold**；
  key 未注册返回 `undefined`（不抛）。session 由 `ctx.agents.get(node.agent)?.session` 取，与
  `dag-lifecycle.ts` 读 `header.parentSession` 是同一条路径。
- **宿主侧**：`src/dag-metrics.ts`（`tokenTotal` / `activeElapsedMs` / `nodeMetrics` / `mergeMetrics` /
  `measureDagNodes`；`readDagMetrics` 是它的薄封装），由 `/dsh-mint/dag` 调用；**只发实测过的字段**——
  缺失就是缺失，绝不写 0 猜测。
- **信封**：`metrics: {<node id>: {tokens?, elapsed_ms?, at?}}` 与 `sampled_at`（宿主 epoch ms）
  **只在非空时出现**；无 `agents`/`sessionProjections`、会话已消失、文件缺失/不可读、投影形状漂移 → 一个字段都不出现。
  条目**没有 `at` = 本轮实测**（钟是 `sampled_at`）；**有 `at` = 文档里的落盘样本**（#167/#168，钟是 `at`）。
- **回落顺序（#168）**：`measureDagNodes` 先实测、实测缺失再用 `samples`；因此**子代理结束后仍能看到实测值**
  （`elapsed_ms` + `at`），只是不再增长。落盘时机：`subagent/end`（settle 之前）、`mint_plan_dag` 的 `set → done`、
  以及路由对「仍 running 但已测不到 agent」节点的兜底补写（每 session+node 每进程一次）。
- **客户端降级**：`nodeMetricsMap` 只保留「文档里还有该节点 + 字段是非负安全整数 + `at`（若有）合法」的项；
  `running` 且**完全没有**读数 → 时间位 `?`；`done` 且两者都没有 → `-`；`pending` → 整行不渲染。
- **走秒口径**：只对**本轮实测**的 `running` 节点跑秒（`elapsed_ms + max(0, browserNow - sampled_at)`，
  两个时钟不必同源）；**落盘样本不跑秒**，直接画宿主那次测量的数字，详情卡用 `dag.measuredAt` 标注采样时刻
  （`实测于 <本地时间>`）——宁缺勿假：不把陈旧样本当活的在涨，也不把它藏起来。
- **真机复核口径**：节点 `running` 时 `curl '/dsh-mint/dag?session=<sid>'` 应出现该节点的实时 `metrics`；
  子代理结束之后再 curl，同一节点应出现**带 `at`** 的 `metrics`，DAG 文件里出现 `samples`（见 §7.6）。

### 4.8 自动打开

- 沿用宿主先例（`dsh-client-ui-plan` 的 `PlanReviewOpen` 经 `ctx.sidebarRight.openTab` / `mounted` 自动开 review）。
- 新增挂载行 config `openDagTab`，**默认 true**：客户端 `apply` 首次探测到本会话有 DAG 就开**一次**，
  用一次性标记防反复抢焦点。
- `src/client/types.ts` 加 `sidebarRight` 最小结构类型；`src/client/index.tsx` 的 `inject` 加 `sidebarRight`。

### 4.9 文案

- 沿用 locale 命名空间 `mint`，新键统一 `dag.` 前缀；ZH/EN 双字典，沿用 `src/client/copy.ts` 纪律。
- plan #34 新增：`dag.liveTokens`（实测 token 行，占位 `{tokens}`）、`dag.seconds`（时长单位，ZH `秒` / EN `s`）；
  plan #35 新增 `dag.measuredAt`（落盘样本的采样时刻，占位 `{at}`）；键名在 `src/client/dag-model.ts` 的
  `DAG_COPY_KEYS` 里只写一次（`copy.test.ts` 的"无死 key"判据读源码文本）。

## 5. 落点与测试文件清单

### 5.1 宿主新增

- `src/dag.ts`（纯数据 + 校验 + 分层）
- `src/dag-store.ts`（文件读写、原子写、按 session 锁）
- `src/dag-tool.ts`（`mint_plan_dag`）
- `src/dag-lifecycle.ts`（subagent 配对）

### 5.2 宿主扩展

- `src/index.ts` 挂 `installPlanDag(ctx)`
- `src/route-paths.ts` 的 `ROUTE_NAMES` 加 `dag`
- `src/routes.ts` 加只读 handler
- `src/records.ts` 加 `DagView`

### 5.3 客户端

- 扩展 `src/client/index.tsx`（第二个 tab 类型 + body）
- 新增 `src/client/DagBody.tsx`、`src/client/dag-model.ts`、`src/client/dag-copy.ts`
- 扩展 `src/client/api.ts`（加 `dag()`）、`src/client/styles.ts`（样式与 keyframes）

### 5.4 测试与文档

- 新增 `src/dag.test.ts`、`src/dag-tool.test.ts`、`src/client/dag-model.test.ts`
- 扩展 `src/routes.test.ts`（只读断言 + 缺失文件 200/null）、`src/client/api.test.ts`、
  `src/route-paths.test.ts`（漂移守卫）、`src/client-bundle.test.ts`（不回归）
- 文档：`notes/client-face.md` 补「自动打开 tab」契约段、`notes/memory.md` 索引、
  `README.md` + `README.zh.md` 面板描述各加一句

### 5.5 验收

- `pnpm lint && pnpm check-types && pnpm test` 全绿。
- `mint_plan_dag` 四动作与全部错误路径有用例。
- 路由在文件缺失时返回 200 + `dag:null`。
- 面板四态配色与悬停信息（标题 / token / 结果原文）实测可见。
- `/tmp/mint/dag/` 文件缺失时面板不崩。

## 6. 边界与已知限制

- **`/tmp` 清理或重启** → 面板显示「暂无 DAG / 不可读 + 路径」，不刷错误；这是明列的容错需求，
  不做持久化补救。
- **非法 `sessionId`**（来自 route 的任意串）→ 拒绝，绝不拼路径。
- **并行 `add` / `set`** → 按 session 锁串行；锁只在本插件进程内有效，**同机多 harness 进程下退化**，
  属已知限制。
- **环 / 未知依赖 / 未知 node id / 非终态 `verdict`** → 工具拒绝并回显，不写文件。
- **token 采集（plan #31 的旧结论已作废）**：宿主 `sessionStats` 确实只有 turns / steps / 墙钟时间，
  但 `@deepseek-ai/dsh-token-meter` 另外注册了 **`tokenUsage`** 投影，`@deepseek-ai/dsh-subagent`
  注册了 **`subagentTiming`**；两者都能经 `ctx.sessionProjections.stateOf(session, key)` 按子会话读到
  （plan #34 落地，见 §4.7）。节点 `tokens` 仍是可选**自报**字段，现在只作**降级**用：实测缺失时 tooltip 显示它。
- **实测的读取窗口**：子代理结束后若其 agent 已不在 `ctx.agents` 注册表，该节点取不到时长与实测 token
  （见 §4.7 末尾），属已知边界而非 bug。
- **客户端产物不走 HMR**：改 `src/client/**` 必须重建 `dist/client.js` 并**重启 harness + 刷新页面**。

## 7. 实现落点与实测（plan #31 开工记录）

> issue 拆分：#150 宿主核心（数据模型 + 状态文件 + 线上类型/路由名，**接口冻结批**）、
> #155 宿主工具 + 生命周期 + 路由、#156 客户端面板。批次 2 的两条并行改互不相交的文件。
> 端到端结论（面板四态、自动打开）**需要重启 harness 后**才有：宿主 bundle 与 client 产物都只在启动时加载。

### 7.1 与本文规格的偏差（有意）

- `src/records.ts` + `src/route-paths.ts` 划给「宿主核心」批（接口冻结）：否则客户端批必须改宿主文件，
  两条并行就不成立。
- **不新建 `src/client/dag-copy.ts`**：`dag.*` 文案并入 `src/client/copy.ts`——`ZH` 是 key 集真源、
  `EN` 靠 `satisfies Record<CopyKey, string>` 编译期穷尽，拆第二份字典会破坏该不变量。
- 信封多两个字段：`file`（面板显示「不可读 + 路径」）与 `autoOpen`（把挂载行 `openDagTab` 回传给浏览器
  半边——客户端只有 HTTP 通道，这是唯一能知道开关的地方）。
- `/dsh-mint/dag` **不做在线会话门禁**（本文只要求校验 sessionId 形状）：它按**文件**取数、不 spawn mint CLI，
  所以不适用其余路由的 `session → cwd → 项目` 解析。
- `src/dag.ts` 是**纯模块**（禁 `node:` 导入、不用 Node-only 的字节长度全局），因为客户端 bundle 会内联它
  （`dagLayers` 单一真源）；`src/dag.test.ts` 有源码守卫。字节长度用 `TextEncoder`，两个 realm 都有。

### 7.2 口径（本轮用户拍板）

- **DAG 归属会话解析到根会话**：工具沿 `session.header.parentSession` 上溯（上限 16 跳 + visited 集合防环），
  子代理 `set` 写的**就是 main 会话那张图**；面板只读 main 会话文件。
- **`init` / `add` 不做身份硬拦**（只做数据校验），靠 skill 口径约束：
  `skill/references/plan-dag.md` §4.1——新增节点/连边归 main，子代理只 `set` 自己的节点、可 `get`。
- **自动打开**：客户端 5s 探测 `GET /dsh-mint/dag`；有 DAG（≥1 节点）且该会话尚无 `kind='plan-dag'` tab 就
  `openTab('plan-dag')`（页面类型同 kind 地址固定 → 唯一、不重复开）；宿主 `autoOpen:false`
  （挂载行 `openDagTab:false`）→ 永久停表；`document.visibilityState === 'hidden'` 时不请求。
  探测循环只在 `typeof document !== 'undefined'` 时启动（否则单测会留真实定时器）。
- 面板**数据**更新与自动打开解耦：`DagBody` 只在 `useTabInfo().tab.visible` 为真时每 2s 拉一次，
  `revision` 未变不重渲；**不做 SSE**（宿主无推送原语）。

### 7.3 落点

| 层 | 文件 |
| --- | --- |
| 纯数据/校验/分层 | `src/dag.ts`（`DagDoc`/`DagAction`/`parseDagAction`/`applyDagWrite`/`parseDagDoc`/`dagLayers`/`findCycle`/`unknownDependencies`/`dagSummary`） |
| 文件层 | `src/dag-store.ts`（`DAG_DIR`/`dagFilePath`/`readDag`/`updateDag`：临时文件 + `rename`、按会话 promise 锁、损坏文件不覆盖） |
| 工具面 | `src/dag-tool.ts`（`mint_plan_dag`，root ctx 注册；根会话上溯；执行器与注册分离） |
| 生命周期 | `src/dag-lifecycle.ts`（`subagent/start` 回填 agent、`subagent/end` 兜底 `done+fail+stopReason`；不自动建节点） |
| 路由 | `src/routes.ts`（`/dsh-mint/dag` + `MintRouteDeps.dagDir/openDagTab`）、`src/route-paths.ts`、`src/records.ts` |
| 客户端 | `src/client/dag-model.ts`（分层/几何/配色）、`src/client/DagBody.tsx`（SVG + tooltip + 2s 轮询）、`src/client/dag-open.ts`（5s 探测 + 唯一性判据）、`src/client/{index,api,copy,styles,types}.ts(x)` |

### 7.4 实测

- **已完成（本机，2026-10-07）**：`pnpm lint` 0 error；`pnpm check-types` 0 error；
  `pnpm test:coverage` → **33 文件 / 668 用例全绿**，总覆盖率 96.13%（lines/statements）、91.41%（branches），
  新文件：`src/dag.ts` 100%、`src/dag-store.ts` 96.3%、`src/dag-tool.ts` 98.9%、`src/dag-lifecycle.ts` 87.4%、
  `src/client/dag-model.ts`+`dag-open.ts` 89–100%；`pnpm build` → `dist/index.js` + `dist/client.js`
  （bundle 内已含 `mint_plan_dag` / `/dsh-mint/dag` / `plan-dag`）。
- **重启 harness 后实测（本机，2026-10-07，宿主换新 bundle 后）：**
  - 路由：`curl 'http://127.0.0.1:3081/dsh-mint/dag?session=<本会话 id>'` → **200** + `{ok:true,dag:{version,session,title,revision,nodes,edges},revision,file,autoOpen:true}`；
    不存在的会话 → **200 + `dag:null` + `file` + `autoOpen`**；`session=../etc` → **400**；无 `session` → **400**；
    损坏文件（`{ not json`）→ **200 + `dag:null` + `warnings:["unreadable dag: invalid JSON: …"]` + `file`**。
  - 工具实机：`mint_plan_dag({action:"get"})` → `[plan-dag] 节点 5，边 0：pending 1 / running 1 / done 3`（读的就是本会话文件）。
  - **生命周期回填 + 根会话归属（实机，最强的一条）**：加节点 `agentcheck` 并 `set running` → 派一个探针子代理，让它自己调
    `mint_plan_dag({action:"set",id:"agentcheck",status:"done",verdict:"pass",note:"…"})`：
    文件里该节点 `agent = <子会话 id>`（`subagent/start` 回填）、`status/verdict/note/tokens` 是**子代理写的**
    （`revision` 6→10，节点数 6）→ 归属解析到根会话成立，子代理无需 `init` 就写进了 main 的图。
  - **仍需人眼确认（agent 无 DOM 可自证）**：tab 自动打开（唯一）、四态配色（黄 pending / 绿闪 running /
    绿 done+pass / 红 done+fail）、悬停 tooltip（完整 `title`、`tokens`、`note` 原文）、
    `prefers-reduced-motion: reduce` 降级；浏览器若命中旧 `client.js` 缓存需硬刷新。

### 7.5 plan #34：实时指标落地与实测

> issue 拆分：#161 宿主投影读取 + 线上类型（接口冻结）、#162 路由信封、#163 客户端模型/样式/文案、
> #164 面板渲染。**客户端产物不走 HMR**：宿主的 `dist/index.js` 只在 harness 启动时载入，
> 所以新路由字段要**重启 harness** 才有；`dist/client.js` 重建后刷新页面即可。

- 落点：`src/dag-metrics.ts`（`tokenTotal` / `activeElapsedMs` / `nodeMetrics` / `readDagMetrics`）、
  `src/routes.ts` 的 `MintRouteDeps.readDagMetrics` 缝 + `sendDag` 发布、`src/client/dag-model.ts`
  （`nodeMetricsMap` / `formatCount` / `formatSeconds` / `liveElapsedMs` / `dagStatusTone` / `DAG_COPY_KEYS`、
  `DAG_NODE_H` 34→44）、`src/client/styles.ts`（`LIVE_TOKENS_COLOR` / `LIVE_TIME_COLOR` /
  `dagLiveTokensStyle` / `dagLiveTimeStyle` / `DAG_NODE_METRICS`）、`src/client/DagBody.tsx`
  （`NodeMetricsLine` + 详情卡徽章行 + 1 s 走秒 + 整份读数守卫）。
- 已实测（本机）：`pnpm lint` / `pnpm check-types` 0 error；`pnpm test` **34 文件 / 727 用例全绿**；
  `pnpm test:coverage` 总覆盖率 96%+，`src/dag-metrics.ts` 100% statements（唯一未覆盖分支是
  `dagDir ?? DAG_DIR` 的缺省值）；`pnpm build` 产出 `dist/index.js`（含 `sampled_at`）与 `dist/client.js`
  （含 `dsh-mint-dag-pulse`）。
- **已实测（产物级端到端，不经 GUI）**：用 `dist/index.js` 的 `apply` + 假 ctx（`agents.get` 返回带
  session 的对象、`sessionProjections.stateOf` 返回真实形状的 `tokenUsage`/`subagentTiming`）驱动
  `/dsh-mint/dag`：信封得到 `metrics.r1 = {tokens: 46600, elapsed_ms: 8999}`（= 1200+340+45000+60 与
  4000+(now-(now-5000))）且 `sampled_at` 为 number；无 agent 的节点与 pending 节点**都不出现在 metrics 里**；
  文件缺失时信封只有 `autoOpen,dag,file,ok,revision`（**没有** `metrics`/`sampled_at` 键）。
- **已实测（真机，harness 重启后）**：把本会话图里一个节点置 `running` 并派一个子代理 →
  `subagent/start` 回填 `agent`；同一时刻 `curl '/dsh-mint/dag?session=<本会话>'` 得到
  `metrics: {"liveprobe": {"tokens": 28067, "elapsed_ms": 3231}}` + `sampled_at`（number）——
  「子会话真值 → 宿主信封」这条路在真机成立（数字取自该子会话自己的 `tokenUsage`/`subagentTiming`）。
- **真机暴露的边界（已登记 #166）**：子代理**结束之后**，同一个子会话 id 再取 `agents.get(id)` 不再
  返回 agent，于是该节点的实测值整份消失（`done` 节点只剩自报 `tokens` 与 `note`）。所以实测时长
  目前**只覆盖 `running` 期间**；缓存/落盘的取舍见 #166。
- **仍留给人眼确认**：紫/黄在浅色与深色主题下的可读性、逐秒走秒的观感、`?` 与 `-` 的出现时机，
 以及 tab 自动打开（agent 无 DOM 可自证）。

### 7.6 plan #35：样本落盘与调研阶段 DAG 化

> issue 拆分：#167 文档 `samples` + 度量/合并（接口冻结）、#168 落盘钩子与陈旧样本口径、
> #169 skill 纪律 + 空 DAG 软提醒。触发：真机实测发现「子代理结束后实测值整份消失」（#166），
> 以及本轮计划模式的调研阶段**全程没有 DAG**（#165）。

- 落点：`src/dag.ts`（`DagSample` / `samples` 校验 / `sampleOf`）、`src/dag-metrics.ts`
  （`mergeMetrics` / `measureDagNodes` / `rememberMeasurement` / `lastMeasurement` / `clearMeasurements`）、
  `src/dag-lifecycle.ts`（`subagent/end` 落盘，导出 `readAgentMetrics` / `withSample`）、
  `src/dag-tool.ts`（`set → done` 落盘）、`src/routes.ts`（兜底补写 + `flushedSamples` 记账）、
  `src/client/{dag-model,DagBody,copy}`（`at` 校验、落盘样本不跑秒、`dag.measuredAt` 标注）、
  `src/plan-mode.ts`（从 `planbind.ts` 抽出的 `planModeState`）、`src/dag-plan-reminder.ts`（空 DAG 软提醒，
  由 `installDagPlanReminder` 在 `src/index.ts` 挂载）、`skill/references/{plan-dag,flow-planning}.md`。
- 口径（本轮拍板）：实测值**落盘进文档**（不是只在内存缓存）；调研阶段**一律 DAG 化**（不再按「有无并行价值」取舍）。
- 已实测（本机）：`pnpm lint` / `pnpm check-types` 0 error；`pnpm test` **36 文件 / 786 用例全绿**；
  `src/dag.ts` / `src/dag-metrics.ts` 行覆盖 100%。
- **待复核（需重启 harness）**：`subagent/end` 落盘在真机是否写出 `samples`（`end` 当下
  `agents.get` 是否仍有 session 未实测；若没有，兜底路径会在面板轮询时补一次）；以及面板上
  「实测于 <时间>」标注、落盘样本不跑秒的观感。
- skill 侧实测：`grep -n "进计划模式\|空图\|0 节点" skill/references/plan-dag.md` 命中新触发语与新增 §3.1；
  `skill/SKILL.md` 未改（路由行与新纪律不冲突，`src/skill-doc.test.ts` 仍 23 passed）。
