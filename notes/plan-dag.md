# plan DAG 规格真源（plan #31 / issue #148）

> 来源：mint plan #31 正文（`plan show 31 --json`，milestone 0.3.0 / #4，version 0.3.0）。
> 范围：宿主工具 `mint_plan_dag`（init/add/set/get）+ 状态文件 `/tmp/mint/dag/<sessionId>.json`
> + 只读路由 `GET /dsh-mint/dag` + 右侧边栏并列新 tab（`kind=plan-dag`）。
> **worktree 动作（create/list/merge/remove）已从本工具拆出**，成为独立的 `worktree` 工具：
> 规格真源见 [worktree-tool.md](worktree-tool.md)，操作流程见 `skill/references/worktree-exec.md`。
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
| `tokens` | 否 | 节点 token 数；**宿主在子代理收尾时实测并写入（优先）**，模型仍可显式传，被实测覆盖；**main 给自己的节点收尾不填**（那是整会话累计，见 §7.8.3） |
| `note` | 否 | 子代理回给 main 的结论原文；tooltip 显示，可滚动 |
| `updated_at` | 是 | 该节点最后一次变更时间 |

### 1.4.1 文档级 `samples`（宿主实测样本，plan #35 / #167）

节点里的 `tokens` 是**节点级的那一个数**（模型自报，或被 own 路径的宿主实测覆盖，见 §1.4）；宿主实测样本另存一层，避免两种语义混在一起：

```json
{ "samples": { "<node id>": { "tokens": 28067, "elapsed_ms": 3231, "at": 1786000000000 } } }
```

- `at` = 该样本的采样时刻（宿主 epoch ms）；`tokens`/`elapsed_ms` 与线上 `DagNodeMetrics` **同语义**。
- **校验是「整份严格、单条宽松」**：`samples` 不是对象 → 整份文档不可读；某条自身的字段非法（`at` 缺失/负数/小数、已出现的数字字段非法）→ **只丢该条**，图照常渲染；条目里一个数字都没有也丢。无 `samples` 的旧文档解析后**不产生该键**（round-trip 不变）。
- **谁写**：只有生命周期与路由的补写路径（`updateDag` 里手工 merge，见 §3/§4.7）；`src/dag/dag.ts` 自己不写，`applyDagWrite` 靠 spread 原样保留已有 `samples`。写实现见 #168。
  - **`set → done` 的两条路径**：子代理收尾自己的节点（**own 路径**）时测量键是**调用者自己的会话**，读数落 `samples`，并把同一个 token 数写进节点 `tokens`（**同一次** `updateDag`，`revision` 只 +1，实测优先于自报）；main 收尾一个曾配过子代理的节点时退回节点 `agent`，只写 `samples`；main 给自己的节点（没有 `agent`）收尾不测。
- **为什么落盘**：子代理结束、`ctx.agents.get(id)` 不再返回 session 之后，实测值否则会整份消失（#166 的真机实测）。

### 1.5 缺失与损坏的容错

- **文件缺失 = 「本会话暂无 DAG」的正常状态，不是错误**：读取方不报错、不刷错误日志。
- `version` 不识别或 JSON 解析失败 → 客户端显示「DAG 不可读」+ 文件路径，**不崩溃**。

## 2. 工具面 `mint_plan_dag`

> 本工具只管**图**：`init` / `add` / `set` / `get`。节点级 git worktree（建/列/合/清理）是
> 另一个工具 `worktree`，规格见 [worktree-tool.md](worktree-tool.md)——两族动作改动的东西不同
> （一份 `/tmp` 文档 vs 真实工作树），合成一个工具会让 schema 与描述同时装两套词汇。

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
- **`set → done` 的测量键**：优先取**调用者自己的会话**（子代理收尾自己的节点时它必然活着，不受注册表释放与 §7.8.1 的配对错位影响，且**不要求节点有 `agent`**）；`callerId === 根会话`（main 自己）时退回节点 `agent`（旧路径，只写 `samples`）；节点没有 `agent` 就不测——main 自有节点的整会话累计对「该节点开销」没有意义（§7.8.3）。

## 4. 客户端可视化

### 4.1 新 tab 类型

- `id = '@yanqd0/dsh-mint:plan-dag'`、`kind = 'plan-dag'`、`priority: 'builtin'`。
- guide 条目 `order = 40`，排在既有 mint 条目（30）之后。
- **与 mint 面板并列，不改 mint 面板**；body seat 沿用 `sidebar.right.pane.tab`。

### 4.2 路由与信封

- `src/shared/route-paths.ts` 的 `ROUTE_NAMES` 加 `dag`；`GET /dsh-mint/dag?session=<id>`（只读）。
- 信封：`{ ok: true, dag: DagView | null, revision, warnings? }`。
- **文件缺失 → 200 + `dag: null`**（不是 404）。
- `session` 非法（不匹配 §1.1 正则）→ 拒绝，不拼路径。

### 4.3 渲染

- SVG 图；**宿主不下发布局**，客户端按 `depends_on` **拓扑分层、自上而下**，同层等距。
- 节点圆角矩形 + 折线边；框内**两行**：`label` 在上，下面一行是实测 `token` 与时长（见 §4.7）。
- 悬停 tooltip：状态/结论**徽章行**、完整 `title`、实测 token 与时长（缺失时退回节点 `tokens`）、`note`（结果原文，可滚动）。

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
- **宿主侧**：`src/dag/dag-metrics.ts`（`tokenTotal` / `activeElapsedMs` / `nodeMetrics` / `mergeMetrics` /
  `measureDagNodes`；`readDagMetrics` 是它的薄封装），由 `/dsh-mint/dag` 调用；**只发实测过的字段**——
  缺失就是缺失，绝不写 0 猜测。
- **信封**：`metrics: {<node id>: {tokens?, elapsed_ms?, at?}}` 与 `sampled_at`（宿主 epoch ms）
  **只在非空时出现**；无 `agents`/`sessionProjections`、会话已消失、文件缺失/不可读、投影形状漂移 → 一个字段都不出现。
  条目**没有 `at` = 本轮实测**（钟是 `sampled_at`）；**有 `at` = 文档里的落盘样本**（#167/#168，钟是 `at`）。
- **回落顺序（#168/#166 修正版）**：`measureDagNodes` 先实测（并**顺手记进进程内缓存**）、实测缺失再用
  **文档样本**、文档也没有才用**缓存里最后一次读数**；因此子代理结束后仍能看到实测值（带 `at`），只是不再增长。
  落盘时机：`mint_plan_dag` 的 `set → done`，以及路由的兜底补写（「文档没有该节点样本 + 本轮量不到它」即写，
  每 session+node 每进程一次，`at` 用**测量时刻**）。**`subagent/end` 测不到**（真机实测：注册表先放掉子会话），
  所以它只负责 settle，不再是可靠落盘点。`set → done` 的测量键优先取**调用者自己的会话**
  （子代理收尾自己节点时必然活着），只有 main 收尾时才退回节点 `agent`；own 路径同时把实测 token 写进节点
  `tokens`（§7.8.3 的 L2）。
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

- `src/dag/dag.ts`（纯数据 + 校验 + 分层）
- `src/dag/dag-store.ts`（文件读写、原子写、按 session 锁）
- `src/dag/dag-tool.ts`（`mint_plan_dag`：init/add/set/get）
- `src/dag/dag-lifecycle.ts`（subagent 配对）
- `src/dag/worktree-tool.ts`（独立的 `worktree` 工具：create/list/merge/remove；git 层在
  `src/dag/dag-worktree.ts`）

### 5.2 宿主扩展

- `src/index.ts` 挂 `installPlanDag(ctx)`
- `src/shared/route-paths.ts` 的 `ROUTE_NAMES` 加 `dag`
- `src/host/routes.ts` 加只读 handler
- `src/shared/records.ts` 加 `DagView`

### 5.3 客户端

- 扩展 `src/client/index.tsx`（第二个 tab 类型 + body）
- 新增 `src/client/DagBody.tsx`、`src/client/dag-model.ts`、`src/client/dag-copy.ts`
- 扩展 `src/client/api.ts`（加 `dag()`）、`src/client/styles.ts`（样式与 keyframes）

### 5.4 测试与文档

- 新增 `tests/unit/dag/dag.test.ts`、`tests/unit/dag/dag-tool.test.ts`、`tests/unit/client/dag-model.test.ts`
- 新增 `tests/unit/dag/worktree-tool.test.ts`（工具面）、`tests/unit/dag/dag-worktree.test.ts`（git 层）
  与规格文档 `notes/worktree-tool.md`
- 扩展 `tests/unit/host/routes.test.ts`（只读断言 + 缺失文件 200/null）、`tests/unit/client/api.test.ts`、
  `tests/unit/shared/route-paths.test.ts`（漂移守卫）、`tests/guard/client-bundle.test.ts`（不回归）
- 文档：`notes/client-face.md` 补「自动打开 tab」契约段、`notes/memory.md` 索引、
  `README.md` + `README.zh.md` 面板描述各加一句

### 5.5 验收

- `pnpm lint && pnpm check-types && pnpm test` 全绿。
- `mint_plan_dag` 四动作与全部错误路径有用例；`worktree` 的四动作同理（见 `notes/worktree-tool.md`）。
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
  （plan #34 落地，见 §4.7）。节点 `tokens` 仍是可选字段（模型自报，own 路径下由宿主实测覆盖，§1.4），
  现在只作**降级**用：实测缺失时 tooltip 显示它。
- **实测的读取窗口**：子代理结束后若其 agent 已不在 `ctx.agents` 注册表，该节点取不到时长与实测 token
  （见 §4.7 末尾），属已知边界而非 bug。
- **客户端产物不走 HMR**：改 `src/client/**` 必须重建 `dist/client.js` 并**重启 harness + 刷新页面**。

## 7. 实现落点与实测（plan #31 开工记录）

> issue 拆分：#150 宿主核心（数据模型 + 状态文件 + 线上类型/路由名，**接口冻结批**）、
> #155 宿主工具 + 生命周期 + 路由、#156 客户端面板。批次 2 的两条并行改互不相交的文件。
> 端到端结论（面板四态、自动打开）**需要重启 harness 后**才有：宿主 bundle 与 client 产物都只在启动时加载。

### 7.1 与本文规格的偏差（有意）

- `src/shared/records.ts` + `src/shared/route-paths.ts` 划给「宿主核心」批（接口冻结）：否则客户端批必须改宿主文件，
  两条并行就不成立。
- **不新建 `src/client/dag-copy.ts`**：`dag.*` 文案并入 `src/client/copy.ts`——`ZH` 是 key 集真源、
  `EN` 靠 `satisfies Record<CopyKey, string>` 编译期穷尽，拆第二份字典会破坏该不变量。
- 信封多两个字段：`file`（面板显示「不可读 + 路径」）与 `autoOpen`（把挂载行 `openDagTab` 回传给浏览器
  半边——客户端只有 HTTP 通道，这是唯一能知道开关的地方）。
- `/dsh-mint/dag` **不做在线会话门禁**（本文只要求校验 sessionId 形状）：它按**文件**取数、不 spawn mint CLI，
  所以不适用其余路由的 `session → cwd → 项目` 解析。
- `src/dag/dag.ts` 是**纯模块**（禁 `node:` 导入、不用 Node-only 的字节长度全局），因为客户端 bundle 会内联它
  （`dagLayers` 单一真源）；`tests/unit/dag/dag.test.ts` 有源码守卫。字节长度用 `TextEncoder`，两个 realm 都有。

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
| 纯数据/校验/分层 | `src/dag/dag.ts`（`DagDoc`/`DagAction`/`parseDagAction`/`applyDagWrite`/`parseDagDoc`/`dagLayers`/`findCycle`/`unknownDependencies`/`dagSummary`） |
| 文件层 | `src/dag/dag-store.ts`（`DAG_DIR`/`dagFilePath`/`readDag`/`updateDag`：临时文件 + `rename`、按会话 promise 锁、损坏文件不覆盖） |
| 工具面 | `src/dag/dag-tool.ts`（`mint_plan_dag`，root ctx 注册；根会话上溯；执行器与注册分离）；worktree 动作已拆到 `src/dag/worktree-tool.ts`（见 [worktree-tool.md](worktree-tool.md)） |
| 生命周期 | `src/dag/dag-lifecycle.ts`（`subagent/start` 回填 agent、`subagent/end` 兜底 `done+fail+stopReason`；不自动建节点） |
| 路由 | `src/host/routes.ts`（`/dsh-mint/dag` + `MintRouteDeps.dagDir/openDagTab`）、`src/shared/route-paths.ts`、`src/shared/records.ts` |
| 客户端 | `src/client/dag-model.ts`（分层/几何/配色）、`src/client/DagBody.tsx`（SVG + tooltip + 2s 轮询）、`src/client/dag-open.ts`（5s 探测 + 唯一性判据）、`src/client/{index,api,copy,styles,types}.ts(x)` |

### 7.4 实测

- **已完成（本机，2026-10-07）**：`pnpm lint` 0 error；`pnpm check-types` 0 error；
  `pnpm test:coverage` → **33 文件 / 668 用例全绿**，总覆盖率 96.13%（lines/statements）、91.41%（branches），
  新文件：`src/dag/dag.ts` 100%、`src/dag/dag-store.ts` 96.3%、`src/dag/dag-tool.ts` 98.9%、`src/dag/dag-lifecycle.ts` 87.4%、
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

- 落点：`src/dag/dag-metrics.ts`（`tokenTotal` / `activeElapsedMs` / `nodeMetrics` / `readDagMetrics`）、
  `src/host/routes.ts` 的 `MintRouteDeps.readDagMetrics` 缝 + `sendDag` 发布、`src/client/dag-model.ts`
  （`nodeMetricsMap` / `formatCount` / `formatSeconds` / `liveElapsedMs` / `dagStatusTone` / `DAG_COPY_KEYS`、
  `DAG_NODE_H` 34→44）、`src/client/styles.ts`（`LIVE_TOKENS_COLOR` / `LIVE_TIME_COLOR` /
  `dagLiveTokensStyle` / `dagLiveTimeStyle` / `DAG_NODE_METRICS`）、`src/client/DagBody.tsx`
  （`NodeMetricsLine` + 详情卡徽章行 + 1 s 走秒 + 整份读数守卫）。
- 已实测（本机）：`pnpm lint` / `pnpm check-types` 0 error；`pnpm test` **34 文件 / 727 用例全绿**；
  `pnpm test:coverage` 总覆盖率 96%+，`src/dag/dag-metrics.ts` 100% statements（唯一未覆盖分支是
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

- 落点：`src/dag/dag.ts`（`DagSample` / `samples` 校验 / `sampleOf`）、`src/dag/dag-metrics.ts`
  （`mergeMetrics` / `measureDagNodes` / `rememberMeasurement` / `lastMeasurement` / `clearMeasurements`）、
  `src/dag/dag-lifecycle.ts`（`subagent/end` 落盘，导出 `readAgentMetrics` / `withSample`）、
  `src/dag/dag-tool.ts`（`set → done` 落盘）、`src/host/routes.ts`（兜底补写 + `flushedSamples` 记账）、
  `src/client/{dag-model,DagBody,copy}`（`at` 校验、落盘样本不跑秒、`dag.measuredAt` 标注）、
  `src/host/plan-mode.ts`（从 `planbind.ts` 抽出的 `planModeState`）、`src/dag/dag-plan-reminder.ts`（空 DAG 软提醒，
  由 `installDagPlanReminder` 在 `src/index.ts` 挂载）、`skill/references/{plan-dag,flow-planning}.md`。
- 口径（本轮拍板）：实测值**落盘进文档**（不是只在内存缓存）；调研阶段**一律 DAG 化**（不再按「有无并行价值」取舍）。
- 已实测（本机）：`pnpm lint` / `pnpm check-types` 0 error；`pnpm test` **36 文件 / 786 用例全绿**；
  `src/dag/dag.ts` / `src/dag/dag-metrics.ts` 行覆盖 100%。
- **产物级端到端实测（构建后的 `dist/index.js`，假 ctx）**，也是本 plan 最关键的一条：
  - 子会话还活着时：信封给出实时 `metrics`（不带 `at`）；
  - **触发 `subagent/end`：真机与探针都显示 `agents.get(childId)` 已经取不到 agent**（注册表先于
    `end` 事件释放），所以「结束时测一次」这条路**永远拿不到数**——原先 #168 的落盘钩子因此不生效；
  - 修正后的路径成立：**每次实时读数都记进进程内缓存**，之后无论节点怎么终结，路由都会把缓存里的读数
    （连同**测量时刻** `at`，不是写入时刻）补写进文档 → 子会话消失后的下一次答案返回
    `{"n1":{"tokens":3700,"elapsed_ms":…,"at":…}}`（探针实测），且 `samples` 落盘。
  - 兜底写入的触发条件因此从「节点仍 `running`」改为「**文档没有该节点的样本、且本轮量不到它**」——
    与节点状态解耦，因为宿主的 settle 会把节点先置成 `done`。
- **真机第二轮（重启后，本会话实测）**：`e2e` 节点置 `running` → 派子代理 → 子代理结束后，
  信封**仍有**实时 `metrics`（`{"e2e":{"tokens":13712,"elapsed_ms":3232,"at":…}}`），而 DAG 文件里
  `samples` 始终是 `null` → 说明**宿主在子代理结束后仍然保留该子会话可读**（与第一轮"`end` 时取不到"
  并不矛盾：那是 `end` 事件当下的窗口，之后注册表仍在）。于是「等实测消失再落盘」永远不会触发，
  **重启就会丢掉所有实测值**。
- **修正 #2（本轮）**：落盘判据改为**不再等实测消失**——每次实测后都落一次，但对 `running` 节点**节流**
  （`SAMPLE_WRITE_MS = 10s`：测量时长至少推进 10 s 且 token 有变化才重写；`done` 节点只写一次），
  写入的是**测量时刻** `at`。至此「面板看到数」与「文档留下数」解耦，重启不再丢样本。
- **真机第三轮（重启新 bundle 后，本会话实测）——三条路径全部实证**：
  1. **工具 `set done` 落盘**：子代理自己把节点标 `done` → 文件里立刻出现
     `samples.p2 = {tokens: 13930, elapsed_ms: 2127, at: …}`。
  2. **路由边测边落盘 + 节流**：面板开着（我用同频 curl 模拟）跑一个 11.5 s 的节点，磁盘上能看到
     `samples.p3` 随时间**逐次推进**（`{0, 1532}` → `{62456, 11524}`），即 10 s 节流下的增量重写真的发生。
  3. **落盘样本成为回落来源**：`p2` 的 session 离开注册表后，信封仍返回
     `metrics.p2 = {tokens, elapsed_ms, at}`（来自文档样本，不是实测）。
- **真机暴露的最后一条约束（设计如此，非缺陷）**：路由/面板是唯一的测量入口——**一次请求都没有**在子会话
  活着时读过它，就没有任何读数可落盘（本轮 `p3` 第一次就是这样：子代理跑完、无请求，样本为空）。所以
  「不打开面板的会话」不会留下实测样本；这也说明"实测值只在被观测时成立"是这套机制的真实边界。
- **仍留给人眼确认**：面板上 `done` 节点的「实测于 <时间>」标注、落盘样本不跑秒、`running` 且无读数时显示
  `?`（本会话里那个 `e2e` 临时节点正是这个形态）；以及紫/黄在浅深主题的可读性。
- skill 侧实测：`grep -n "进计划模式\|空图\|0 节点" skill/references/plan-dag.md` 命中新触发语与新增 §3.1；
  `skill/SKILL.md` 未改（路由行与新纪律不冲突，`tests/guard/skill-doc.test.ts` 仍 23 passed）。

### 7.7 plan #33：空图提醒的第二次机会 + 两条「误判成坏掉」的宿主提示

> issue：#171（空图软提醒不重复）、#53（挂载行缺 config）、#60（bash 兜底只读库），
> 以及 skill 侧 #157/#158、#159/#160 的提醒文案。触发：plan #33 的调研期真的踩了一次
> 「收到空图提醒 → `init` → 忘了 `add` → 面板与提醒一起消失」（用户当场发现）。

- **真机现象与根因（#171）**：本会话 DAG 文件在 `init` 后是 `nodes: []`，而面板自动打开的判据是
  「本会话 DAG **≥1 节点**」（`src/client/dag-open.ts` `shouldOpenDag`）——0 节点等于没有图、也没有面板，
  这是 #165/§3.1 早已记录的边界。**但** `src/dag/dag-plan-reminder.ts` 的注释写着「空图的会话故意不记为已提醒」，
  实现却是无条件 `remember(sessionId)`：提醒只在会话的**第一次**工具调用出现，`init` 之后不再有第二次。
  注释与实现相反 → 独立的 #171。
- **口径（本轮拍板）**：提醒记的是**状态**不是次数——「没有 DAG」与「有 DAG 但 0 节点」是两个 gap，
  各提醒一次；落到 ≥1 节点后彻底安静。实现为 `Map<sessionId, 'missing'|'empty'>`（值就是「上次提醒的是哪个 gap」），
  原来「每会话一次」的语义被这条取代；`MAX_REMINDED_SESSIONS` 只作内存上界，命中即先删再插入，
  越界淘汰最旧会话。文案拆成两条：`DAG_PLAN_REMINDER`（先 `init` 再落节点）、
  `DAG_EMPTY_REMINDER`（只差「先 `add` 一个节点」，不再重复 `init`）。
  实测：`tests/unit/dag/dag-plan-reminder.test.ts` 13 passed（新增「missing → empty 两次提醒」「同一 gap 不重复」
  「落节点后安静」三条路径）。
- **#53 实测（宿主同一条校验路径）**：cordis 的 `resolveConfig` 把挂载行**缺省**的 config 以 `undefined`
  直接交给 `Config['~standard'].validate`，**不做归一化**；`z.object({…})` 于是报
  `invalid config: - Required (at )`（issue 里的原文），而 `{}` 与 `.default({})` 之后都得到完整默认值。
  修法是 `z.object({…}).default({})`；测试就用 `Config['~standard'].validate(undefined)`（standard-schema 的
  返回值是 `Result | Promise<Result>`，用例内收窄到同步分支），红/绿自检=临时删掉 `.default({})` 即复现 `Required`。
  `cordis.patch.yml` 里「config 必须显式给」的过时注释同步改掉（`config: {}` 行保留，`package-manifest.test.ts` 守约）。
- **#60 实测**：workspace-write 下经 bash 跑 mint，**连只读命令**也报
  `mint: error: SQLite error: attempt to write a readonly database`（SQLite 打开库时即使只读也要写 journal），
  宿主 `mint` 工具与 `mint --db <可写目录>` 都正常。落点两条：`src/host/reminders.ts` 的
  `readonlyDbHintListener`（只扫结果文本里的 `READONLY_DB_SYMPTOM`，不看工具名/退出码；append 一句
  「用宿主工具 / 提权重试 / `--db` 指可写目录」）与 skill `host-dsh.md` §执行面 的同一症状记录。
- **skill 侧**：#157 把「无独立工作就地结束本轮 / 运行时以 follow-up 轮次唤醒 / `sleep` 把结算通知推迟到
  sleep 结束之后」写进 `parallel-exec.md` §5；#158 把「清单条目只写 issue，不得写成批次/DAG 节点名」
  写成显式禁令（`flow-impl.md` §3，`parallel-exec.md` §4 交叉引用）。
  实测：`tests/guard/skill-doc.test.ts` 23 passed（SKILL.md 字节预算未变，未动 SKILL.md）。
- **仍留给人眼确认**：本会话 DAG 面板由空变有节点后的自动打开（agent 无 DOM，无法自证）。

### 7.8 plan #36 调研：配对错位与 DAG 自测口径（#176）

> **只读调研，未改产品代码**。证据源：plan #33 那批 5 节点会话的 DAG 文件
> `/tmp/mint/dag/session-b14be033-d215-443e-b8d0-b5342d930d3e.json`（mtime `2026-10-07 15:33:16 +0800`，
> `revision 172`）与该会话的宿主日志
> `~/.dsh/sessions/--home-user-yanqd0-dsh-mint--/session-b14be033-…/session.v4.jsonl.zstd`（zstd 压缩，
> `zstd -dc` 后逐行 JSON），以及每个子会话自己的日志目录（同父目录下以子会话 id 命名）。

#### 7.8.1 一批多节点的 `subagent/start` ↔ 节点配对为何整体错位

**机制（代码）**：`claimNextNode`（`src/dag/dag-lifecycle.ts:85-94`）从节点数组**末尾向前**扫，认领第一个
`status === 'running' && agent === undefined` 的节点；`installDagLifecycle` 把它挂在 `subagent/start`
（`src/dag/dag-lifecycle.ts:282-290`，`write(parent, doc => claimNextNode(doc, String(info.id), now))`）。
于是「谁配谁」由两个**外部顺序**相乘决定：① 数组里还剩哪些 running-无 agent 节点；② 宿主
`subagent/start` 的**发射顺序**（不是模型派发的顺序）。`n7` 当时也是 running-无 agent，但它在数组里排在
a 批之前，所以永远轮不到它——判据是**位置**，不是「最近 set running」。

**宿主不提供关联信息（判定依据）**：`SubagentRunInfo` 只有 `{ runId, provider, id, local }`
（宿主 checkout `…/@deepseek-ai/dsh-subagent@0.2.0-rc.2/lib/types/types.d.ts:71-86`），
`SubagentRunEndInfo` 再加 `stopReason` / `lastAssistantMessage`；两个 emit 点
（`observeRun`，`lib/index.js:268-280`；`createActivationObserver.start`，同文件 `:306`）都只发这个
`identity`，第二个参数 `parent`（一个活 Agent）只被 `createLifecycleEmitter` 拿来当 scoped dispatch 的
carrier，**不传给 listener**（它显式只调 `callback(info)`）。payload 里没有 callId、没有
description/label、也当然没有 DAG 节点概念。
→ **判定：宿主根本不提供「哪次派发 / 哪个节点」的关联信息，本仓的错位是设计边界而非用法 bug**。
（「哪次派发」还部分可查——父会话日志的 `subagent/catalog` 事件带 `{childId, label, mode}`，
`list_agents` 也给 `{id, label, status}`——但「哪个节点」只存在于模型自己的 `set` 里。）

**本轮实测（可复现）**：派发意图写在父会话 5 个 `subagent` 调用的【DAG 节点】段里（同一 `step=37`）：
`#157→a1`、`#158→a2`、`#159→a3`、`#53→a4`、`#90→a5`；节点在 `step=34`（早 32 s）已全部 `running`。
DAG 文件实际记的是：`a1←7d07d0ac`、`a2←3a3381e0`、`a3←9a5711cd`、`a4←66e77f36`、`a5←3301f89c`。
子代理真实身份取自各自日志第 2 行的 `subagent/descriptor.label`：`66e77f36=#157`、`7d07d0ac=#158`、
`3301f89c=#159`、`3a3381e0=#53`、`9a5711cd=#90`。宿主的 start 发射顺序取自父日志的
`subagent/catalog`（`seq` 依次 `508/509/511/512/513`）：`#159 → #157 → #90 → #53 → #158`。
把 claimNextNode 的规则套上去（a1..a5 全在 running、从后往前占位）：第 1 个 start 拿 `a5`、第 2 个拿
`a4`…第 5 个拿 `a1` → 预测 `a5←#159、a4←#157、a3←#90、a2←#53、a1←#158`，**与文件逐条相同**。
所以「整体错位」不是随机，而是「宿主发射顺序 × 从后往前占位」的一个置换；发射顺序又**不等于**工具调用
顺序（同一 step 里模型按 #157/#158/#159/#53/#90 派发，宿主按 #159/#157/#90/#53/#158 起跑）。

**连带损伤（数字也归错人）**：`samples` 由 `node.agent` 决定写进哪个节点——`saveSample`
（`src/dag/dag-lifecycle.ts:248-280`：`nodeOf(doc, agentId)` → `withSample(doc, node.id, …)`）与
`set → done` 的 `measuredNode`（`src/dag/dag-tool.ts:401-407`）用的是同一个键。实测：5 条样本的 `tokens`
**恰好等于被记那个 agent 的子会话当时的累计 token**（逐条 delta = 0，其它四支都不等，按「usage 四桶求和、
截至 `samples.<node>.at`」算）。本轮（plan #36）同样复现：`b1`（issue 172）的 `agent` 是 `872cb7dc`
（`label = "#173 面板透出 worktree"`，本该是 b2 的活），`b1` 的样本 `14597` 也正是 `872cb7dc` 当时的累计。

**复现步骤（只读）**：

```bash
S=session-b14be033-d215-443e-b8d0-b5342d930d3e
D=~/.dsh/sessions/--home-user-yanqd0-dsh-mint--
# ① 节点 ↔ 被记 agent
jq -r '.nodes[]|select(.agent)|"\(.id)\t\(.agent)"' /tmp/mint/dag/$S.json
# ② 被记 agent 的真实身份（子会话日志第 2 行的 descriptor.label）
zstd -dc $D/<agentId>/session.v4.jsonl.zstd | sed -n 2p | jq -r '.data.label'
# ③ 宿主 start 发射顺序（父会话日志里的 subagent/catalog）
zstd -dc $D/$S/session.v4.jsonl.zstd | jq -rc 'select(.type=="subagent/catalog")|"\(.time)\t\(.data.label)"'
# ④ 样本 ↔ 子会话累计：把 samples.<node>.tokens 与该 agent 的 usage 四桶累计（截至 samples.<node>.at）比对
zstd -dc $D/<agentId>/session.v4.jsonl.zstd | grep -o '"usage":{[^}]*}'
```

**推荐纪律（零改动，本轮不改代码）**：

1. **一步一节点一派发**：派发前**至少早一个 step** 把该节点的 `set running` 落地（同一 step 里的多个
   `set`/`subagent` 是并发工具调用，谁先到不保证——本轮 a 批是 step 34 全置 running、step 37 才派发，
   b 批是 step 14 置 b1、step 16 派 3 支），且保证此刻**只有一个** running-无 agent 节点。此时
   「最后一个」就是它，配对确定，`subagent/end` 的兜底结算与 `samples` 也都落在对的人身上。
2. **派发后显式校正**：从 `subagent` 结果或 `list_agents` 拿到子会话 id 后，
   `mint_plan_dag({action:"set", id:"<node>", agent:"<childId>"})`——`set` 的 `agent` 是**覆盖写**
   （`src/dag/dag.ts:713`），参数已在工具 schema 里（`src/dag/dag-tool.ts:106`）。代价：每节点多一次调用 + 需要
   一次 id/label 对应查询。
3. **或接受 `agent` 仅作参考**：不要拿 `subagent/end` 的兜底（`settleNode` 按 `node.agent` 定位，
   `src/dag/dag-lifecycle.ts:102-115`）判断节点成败，节点结论以子代理自己 `set` 的 verdict/note 为准；
   面板上的 `agent` 只当「有一支子代理在跑」的弱提示，`samples` 的数字不当作该节点自己的开销。
4. **（需用户拍板，另拆）** 若要把配对做成确定映射，只能请宿主在生命周期 payload 里补派发身份
   （如 `callId`/`label`），或让工具层把「本次派发的子会话」与工具调用关联——本仓改不了宿主，属上游需求。

#### 7.8.2 worktree 内 commit 的 sha 口径（#176）

**mint 侧语义**：`issue state commit <id> --sha <sha>` 写 `last_commit_id`；显式 `--sha` 在 git 仓库内做
存在性校验——**不存在** → 报错 `commit <s> not found in this repository`；**存在但不是 HEAD 祖先** →
只打警告 `mint: warning: <s> is not an ancestor of HEAD`（仍写入）；`--sha` 省略时取**当前 cwd 的 HEAD**
（非 git 目录报错）——mint 仓 `src/cli/issue/state.rs:110-127` 与 `src/git.rs:83-108`（`#477`）。
插件把 cwd 取成**调用会话的** `session.header.cwd`（本仓 `src/mint/mint-tool.ts:385`），所以「在 worktree 里跑
mint，HEAD 是节点分支头；在会话当前 checkout 的工作树里跑，HEAD 是**开工时所在分支（目标分支）**的头」——
**「取哪个 sha」首先是「在哪个 worktree、什么时候跑」**。

**口径（沿用既有 skill 口径 `worktree-exec.md` §5 / `flow-impl.md` §4，此处补自证）**：
取 **merge 落地之后、开工时所在分支（目标分支）的工作树 HEAD**，即 `--no-ff` 产生的那个 merge commit。

节点存储的 worktree 记录（`DagWorktree`）：`path` / `branch` / `base` / `state` / `merged_sha?`，以及
`target?`（#189）——**开工（建树）时所在的分支名**，即 merge 目标；`create` 写入，`merge`/`remove` 都带它
落盘，detached HEAD 时为 `'HEAD'`（该值视为「无可校验」，退回按当前 HEAD 判定）。

1. 节点分支里的 commit（在 worktree 内 `git rev-parse --short=7 HEAD`）**不登记**；它在 merge 后仍可
   `git show`，因为它就是 merge commit 的第二个父。
2. **登记时刻** = `merge` 命令成功返回后的**第一条命令**：`git rev-parse --short=7 HEAD` →
   `mint({ args: ["issue","state","commit","<id>","--sha","<前7位>"] })`。取与登记之间不得再落任何 commit。
3. 一个 issue 多个 commit：merge 把它们收进一个 merge commit → 「只登记最后一个 sha」天然满足；
   不要在 merge 前逐个登记（那会在 merge 前从目标分支看触发上面的 NotAncestor 警告，merge 后还得重登记）。

**自证四连（全部只读，在 merge 后、目标分支的工作树里执行）**：

```bash
git rev-parse --short=7 HEAD                 # ① 与登记值逐字符相同
git log -1 --format='%h %p %s' <sha>         # ② 两个父 + subject 形如 Merge branch 'node/a1'
git diff <sha>^1 <sha> --stat                # ③ 只列该节点的文件 = 该 issue 的改动
git rev-parse <sha>^2                        # ③' == worktree 里的分支头 sha（两条口径的关系）
git merge-base --is-ancestor <sha> HEAD; echo $?   # ④ 与 mint #477 同一条判定 → 0
```

④ 为 0 即「该 sha 是当前 HEAD 的祖先」，也就是 mint 不告警的条件；若在 merge **前**从会话当前工作树登记
worktree 的 sha，这条会非 0 并触发 `mint: warning: … is not an ancestor of HEAD`——这就是「时刻」的
机器判据。短 sha（前 7 位）足够：mint 只做 `rev-parse --verify` 存在性检查，存的是你给的字符串。
**边界**：merge 后若因冲突裁决又改代码 → 新 commit，需重新 `state commit`（口径仍是「只留最后一个」）；
若改用了 squash/ff 合并，则没有 merge commit（ff 时 HEAD 就是分支头，两条口径合一），自证 ② 的「两个父」
不再成立，需要按「HEAD 即分支头」读。

#### 7.8.3 DAG 怎么「自报 token 开销」（#176）

**先纠正前提**：同一份 DAG 文件（`revision 172`）里，20 个节点**全部没有 `tokens` 字段**（自报路径从未被
写过），`samples` 只有 6 条（`a1`–`a5`、`b1`），**剩下 14 条为空**（`n1`–`n8`、`a6`、`b2`–`b6`）——这 14 个
**全都没有 `agent`**。测量键就是 `node.agent`（`measuredNode`，`src/dag/dag-tool.ts:401-407`；路由侧同规则），
没有 `agent` 的节点**结构上不可能**有实测读数；有 `agent` 的节点则确实留下了样本。所以「面板没打开」
不是空样本的充分原因——**`set → done` 本身就是一条测量入口**（§7.6 第三轮已证；a1–a5 的样本就是它留下的）。
真正的两条缺口是：① 无 `agent` 的节点没有测量键；② 唯一的补充来源（`tokens` 自报）没人写，而宿主从不
自动写它（表里只有 `samples`）。

**方案（分层，从零改动到需上游）**：

- **L1 零改动（今天可用）**：让**节点的 owner 自己**在还活着的最后一步 `set done`（工具描述里已是这条纪律，
  `src/dag/dag-tool.ts:70`）——配对正确时 `persistNodeSample` 会测到它并把样本落盘（`at` = 测量时刻）；需要
  数字时再 `curl 'http://127.0.0.1:<port>/dsh-mint/dag?session=<root>'` 主动制造一次观测（§4.7/§7.6 已证
  路由读一次即落盘，`running` 节点 10 s 节流）。代价：数字只在「有 agent + 那一刻可读」时存在；无 `agent`
  的调研节点（`n1`–`n8` 这类）仍然空，而且错位未修时数字会归错节点。
- **L2 已落地（`set → done` 的 own 路径）**：在 `set → done` 的既有落盘路径上，测量键先取**调用者自己的
  会话**——子代理自测时它的 session 必然活着，不受注册表释放、路由/面板是否被访问影响，也不受 §7.8.1 的
  配对错位影响，且**不要求节点有 `agent`**；读数照旧写 `samples`，并把同一个 token 数**也写进节点的
  `tokens`**（面板的降级来源，§1.4/§4.7 已定义且已消费，**不需要新字段**）。这同时把「数字归错人」在
  **自报**这一层消掉（调用者才是它自己节点的权威）。三条边界：a) **只覆盖「由 owner 自己 `set done`」的
  节点**——main 代写、或 owner 崩了由 `subagent/end` 兜底收尾的节点仍无读数；b) 是收尾时刻的**采样**，
  不是最终账单（数字之后不再增长）；c) **main 自己的调研节点不填** `tokens`——读到的是整条主会话的累计，
  语义不对（要的是「该节点 running 期间的增量」，属新语义，另议）。退回旧路径（main 收尾一个曾配过子代理
  的节点）时只写 `samples`，节点 `tokens` 留给模型自报：两条路径的差别只在「这次读的是不是调用者自己的
  会话」（工具 schema 里 `tokens` 的描述已按此改写）。
- **L3 需宿主配合（另拆上游）**：在 `subagent/end` 的 payload 里带上子会话的 token/时长，这样
  「结束即终值」不再受注册表释放与观测时刻影响。现状 payload 没有这些字段
  （宿主 `lib/types/types.d.ts:88-105` 只有 `runId/provider/id/local/stopReason/lastAssistantMessage`）；
  要改 dsh 事件契约，本仓改不了 → 适合提给 `dsh-dev-dsh`。
- **不推荐写进 `note`**：`note` 是结论原文、按字节截断（`DAG_NOTE_MAX`），塞数字既不可结构化消费，也会
  挤掉结论；`tokens` 字段就是为此存在的。

**口径修正**：§7.6 末尾的「实测值只在被观测时成立」，准确表述是「只在**有一个活着的测量键、且真的有人读了
一次**时成立」。L2 已把「有人读」固定成「owner 收尾时的那次 `set`」，于是「面板开不开」不再是必要条件；
L3 才能把它变成「结束即有终值」。
