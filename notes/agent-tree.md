# 子代理树（agent tree）

> 规格真源：plan-dag 面板的**第二个视图**。宿主侧落点在 `src/dag/agent-tree/`，客户端侧在
> `src/client/agent-tree-model.ts` + `AgentTreeBody.tsx`，路由是 `GET /dsh-mint/agents`。
> 相关：DAG 视图自身的规格见 [plan-dag.md](plan-dag.md)，面板路由面见
> [client-face.md](client-face.md)。

## 1. 它回答什么

`/dsh-mint/dag` 画的是**计划**（节点与依赖）；本视图画的是**谁在跑**（本次会话下，最多两级：
一级子代理 + 它派生的二级）。两者共享同一套节点盒子配色与测量色，所以看起来是同一块面板的
两种读法，而不是两个插件。

## 2. 三条数据真源（各自独立，不可混用）

| 问题     | 真源                                                                                                                                                                                             | 为什么是它                                                                                                                               |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 谁是谁   | 父会话自己的 `subagentCatalog` 会话投影的 **wire view**（`projections.snapshot(session, ['subagentCatalog'])` 的 `values.subagentCatalog`）：`[{id, createdAt, mode, label?}]`，**只列直接子级** | 它是**父会话日志里的持久事实**，所以子代理结束、会话离开注册表之后，树形与标签仍然读得到；`label` 就是派发时的 description，不必再问别处 |
| 活不活   | `ctx.agents.get(id)?.status === 'running'`（Agent 上直接可读；`'idle' \| 'running'`）                                                                                                            | catalog 是历史，存活度是此刻；宿主自己也是这么答的（`@deepseek-ai/dsh-client-ui-subagent` 的目录下拉读的就是它）                         |
| 花了多少 | `ctx.sessionProjections.stateOf(session, key)`：`tokenUsage`（四桶 + `last`）、**`contextPressure`**、`subagentTiming`、`sessionStats`                                                           | 与本仓 DAG 的 `dag-metrics.ts` 同一条读法；这些 unit **没有 `wire` 段，state 即 view**；**同步、内存、按会话惰性 fold**                  |

两条读法各走各的口：**树的形状与标签**走 `subagentCatalog` 的 **wire view**
（`projections.snapshot(session, ['subagentCatalog'])` 的 `values.subagentCatalog`）——宿主 `stateOf`
只给投影 **state**（catalog 的 state 是 `{inheritedEventCount, head}`），拿它当 catalog 读会永远答
「没有子级」，所以**不做 `stateOf` 回落**，`snapshot` 缺失即没有子级；**读数**（`tokenUsage` /
`contextPressure` / `subagentTiming` / `sessionStats`）仍走 `stateOf`——这些 unit 没有 `wire` 段，
state 即 view。两条都是**同步**的内存读法，不是宿主自带的 `listChildren`/`listDescendants`——后者走
`sessionQuery.observeSession`（异步观察 + 释放），对本面板 2s 一次的轮询来说过重。代价是
「子代理的 catalog 只有在那个会话对象还在手上时读得到」，这正是下面第 4 节的边界。

## 3. 口径（本仓定下的，不在上游）

- **`context` 是一种新的量**：`contextPressure.pressureTokens` = provider 报出的**最近一次请求**
  的提示词大小（未命中 + 命中 + 缓存写，**不含输出**）。它与 `tokens`（整条日志累计的账单口径）
  是两把尺子，故两个字段并存。降级顺序：`pressureTokens` → `tokenUsage.last.buckets` 的三桶之和
  → 缺席。**绝不写 0**：provider 还没报过 usage 时它就是「读不到」。
- **`main` 不发 `tokens`**：整条主会话的累计不是「这个节点花了多少」。宿主侧由
  `nodeMetrics({ kind: 'main' })` 直接不读四桶；面板侧再守一道（缺字段即不画）。
  `context`/`steps`/`elapsed_ms` 是全会话可比的量，main 照发。
- **`mode: 'unknown'` 的 catalog 条目不入树**：宿主自己把它们报成 `unsupported`
  （`listDescendants` 的诊断分支），那样的条目连 one-shot / continuable 都还没确定。它们在
  `counts.unsupported` 里计数——面板必须解释「为什么树上有东西没画出来」。
- **已被 catalog 记下、会话却没了的子代理照画**：它没有读数、也没有下一层，但仍然真实存在过。

## 4. 线格式与降级

```jsonc
{
  "ok": true,
  "nodes": [
    {
      "id": "<root>",
      "kind": "main",
      "depth": 0,
      "label": "main",
      "running": true,
      "metrics": { "context": 51000, "elapsed_ms": 123456, "steps": 210 },
    },
    {
      "id": "<child>",
      "parent": "<root>",
      "kind": "subagent",
      "depth": 1,
      "label": "审 tests",
      "mode": "one-shot",
      "running": true,
      "seenAt": 1786000000000,
      "metrics": {
        "tokens": 28067,
        "uncached_input": 1200,
        "cache_read": 26000,
        "cache_write": 300,
        "output": 567,
        "steps": 12,
        "elapsed_ms": 3231,
        "context": 26800,
      },
    },
  ],
  "counts": { "total": 3, "running": 2, "unsupported": 0 },
  "sampled_at": 1786000001000,
  "revision": 0,
  "warnings": ["root session is not live"],
}
```

- 形状是**扁平数组 + `parent`**（不是嵌套树）：客户端要按行排版，嵌套结构只会把「父缺失」
  「id 重复」这类坏数据的处理塞进序列化里。
- `warnings` 只在非空时出现；**根不在册、服务缺失、`snapshot` 缺失或抛错都是空树**，不是 404 也不是 500。
- **护栏**：`visited` 去重（防坏 catalog 的环）、`mode` 未知即丢、深度 ≤ 8、节点 ≤ 200；一个分支
  抛错只丢它自己。
- **live 优先、快照兜底**（两个方向各是三段之一）：
  1. 读到**非空实时树** → 答它（`revision: 0`，无 `stale`），并把这份读数落成快照（见 §4.1）；
  2. 实时树为空（会话已结束、注册表塌了、宿主重启过）而盘上有快照 → 答**快照**：`stale: true`、
     `file`（文档路径）、`revision`（文档版本）、`sampled_at`（那份文档的采样钟），且**逐节点把
     `running` 改成 `false`**——旧读数不能继续走秒，`counts.running` 随之归零；
  3. 两者都没有（文件缺失是正常态）→ 空树；只有快照文件**存在但读不动**（坏 JSON / 版本不符 /
     session 对不上）才回空树 + `warnings: ["unreadable agent tree: …"]`。
- 线格式的三处增量都是可选的：`revision` / `file` / `stale`——旧客户端读到 live 答案时它们缺席，
  行为不变。

### 4.1 快照文档（`/tmp/mint/agents/<sessionId>.json`）

- **两个写入来源，共用同一份判据**：① **面板轮询**该路由（与 DAG 的 `samples` 同形态）：每次拿到
  **非空**实时树就顺手写一份；② **宿主生命周期事件抓拍**：`src/dag/agent-tree/agent-tree-capture.ts`
  监听 `subagent/start` / `subagent/end`，对抓拍链上每个会话 `collectAgentTree` → `flushAgentSnapshot`
  （在 `src/index.ts` 与 `installDagLifecycle` 并列装配，**不经** `installMintRoutes`，所以面板不在的
  headless/ACP 组合也照旧抓拍）。
  两来源落在**同一个** `flushAgentSnapshot` 上，所以「值不值得写」只有一处口径：空树**绝不**写（它
  什么都没答，写下去只会把上一次好快照抹掉）。
- **抓拍链＝链上每个会话各写一份**：从事件里的子代理会话沿 `parentSession` 上溯的**全部可读祖先**，
  **不含子代理自己**（面板读的是父会话的树，子代理那张图是它的下一层）；注册表答不出下一跳就停，
  非法 id 跳过不写但**继续上溯**，`MAX_CAPTURE_HOPS = 16` 只用来切断坏注册表里的环。链里**根会话
  必然在内**：一级委派的直接父就是根，两级委派拿到 `[中间, 根]`。整条链共用事件到达时现读的同一个
  `sampledMs`，几份文档的 `sampled_at` 说的是同一时刻。
- 形状 `{ version: 1, session, revision, sampled_at, nodes }`：`revision` 从 1 起、只在**树真的变了**
  时才前进，`sampled_at` 存**这次读数的宿主钟**（不是写盘那一刻）。
- 「变没变」的判据排除 `elapsed_ms`：时长只增不减，把它算进来等于每次轮询都写盘。判据实现在
  `src/host/routes/internal/agent-snapshot.ts`。
- 读取校验整体严格（版本 / 会话 id / `revision` / `sampled_at` / 节点上限 200）、单节点宽松（坏节点
  整条丢，其余照画）；路径段先过 `isValidDagSession` 再拼，坏 id 抛 `AgentTreePathError`。原子替换
  （同目录临时文件 + `rename`、`0600`）与按会话 promise 锁照 `dag-store.ts`。

## 5. 客户端

- **`SegmentedControl` 在面板内部切两个视图**（不是第三个侧边栏 tab 类型）：两个视图共用同一套
  `useId` 基础 id 与 `role="tabpanel"` 契约（与「正文预览 / 代码」同一个控件）。
- **两条读各按自己的路由轮询**，且**只有当前视图被读**；切回来立即补读一次。整份读数守卫
  （`sameSample`）对两者共用：DAG 比 `revision + sampled_at + metrics`，子代理树比节点 id →
  `{running, label 指纹, tokens, context, elapsed_ms}`。**子代理树的 `sampled_at` 不参与判定**——
  那条路由每次应答都会读一次钟，把它算进身份会让面板每 2s 白重渲一次；**兜底快照的 `revision`
  参与判定**（它只在树真变了时才前进），于是 live ↔ 快照的切换与快照内部的一次重写都按它重渲。
- **走秒只对 running 行**，锚在信封的 `sampled_at` 上；一个共用的 1s 定时器。兜底快照的
  `sampled_at` 是过去那一刻，且节点已被改成 `running: false`，所以那棵树不起走秒。
- **stale 说明**：`stale === true` 时，子代理面板在树上方多一行「会话已结束，显示 HH:MM:SS 的快照」
  （`agents.stale`，钟点由客户端格式化）——旧值必须看起来像旧值，而不是像现状。
- **hover 卡片**给完整 label、会话 id、`mode`、步数、`seenAt`，以及**该 agent 被哪些 DAG 节点
  认领过**（由容器从第一视图的文档里查 `node.agent` 现算，不新增路由字段）。
- **配色一律复用**：行盒子走 `agentRowStyle`（与 `dagNodeStyle` 同一套 `color-mix` + 满强度描边），
  running 脉动复用同一个 `dsh-mint-dag-pulse` class 与 keyframes，token 黄 / 时长紫就是
  `LIVE_TOKENS_COLOR` / `LIVE_TIME_COLOR`。肘线用 DAG 边那支 `--dsw-alias-border-l2`。

## 6. 已知限制

- **起止两点一定留痕，中间读数仍靠观测**：宿主生命周期事件（`subagent/start` / `subagent/end`）会给
  链上每个会话写快照，**与面板开没开无关**——一次委派的头（挂上）与尾（结束）必定有文档。但**子代理
  运行期间**的中间读数仍只在面板轮询到该视图时落盘：整段没开过 DAG 面板（或面板一直停在 Nodes
  视图、从未切到 Subagents）时，只有起止两点可看，看不到中途的 token / 步数变化（这是本轮明确保留的
  边界）。与 DAG 的 `samples` 对照（见 [plan-dag.md](plan-dag.md) §7.6）：那边**没有起样本**——
  子代理挂上那一刻的读数不落盘；尾样本由 `set → done` 与 `subagent/end` 两条收尾路径写（与面板开没开
  无关），只有**运行期间的连续读数**才依赖面板轮询。本视图比它多「起点」这一路，缺的只剩中间的连续读数。
- **快照一律按已结束画**：会话结束后的那棵树里没有任何东西还在跑，故路由把 `running` 全部改成
  `false`；读者看到的是「最后一棵树的形状与读数」，不是一个仍在推进的现状。
- **`sessionQuery` 那条路没走**：宿主自己能用 `observeSession` 读到已经归档的会话 catalog；本插件
  只读内存状态 + 自己的快照文件，所以端到端的视界是「本进程见过的会话 ∪ 本进程写过的快照」。

## 7. 落点与测试

| 层             | 文件                                                                                                                                                                                                                                                                                                          |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主读树       | `src/dag/agent-tree/agent-tree.ts`（`collectAgentTree`；树的形状读 `subagentCatalog` 的 wire view（`snapshot`），读数读 `stateOf`；纯同步、无 I/O、无 `node:`）                                                                                                                                               |
| 宿主快照文件层 | `src/dag/agent-tree/agent-tree-store.ts`（原子写 + 按会话锁 + 三态读）、`src/dag/agent-tree/internal/parse-doc.ts`（文档校验）                                                                                                                                                                                |
| 宿主快照写入   | `src/host/routes/internal/agent-snapshot.ts`（「值不值得写」的判据 + 落盘）                                                                                                                                                                                                                                   |
| 宿主事件抓拍   | `src/dag/agent-tree/agent-tree-capture.ts`（`subagent/start` / `subagent/end` → 链上逐会话 `collectAgentTree` → `flushAgentSnapshot`）                                                                                                                                                                        |
| 宿主路由       | `src/host/routes/internal/mint-handler.ts` 的 `sendAgents` + `readAgentTree` / `agentsDir` 缝；路由名在 `src/shared/route-paths.ts`                                                                                                                                                                           |
| 线格式         | `src/shared/records.ts` 的 `AgentNodeView` / `MintAgentsPayload`（`revision` / `file` / `stale` 三处增量）；`DagNodeMetrics` 加 `context`                                                                                                                                                                     |
| 客户端纯逻辑   | `src/client/agent-tree-model.ts`（行/排版/单元格/摘要）、`src/client/dag-sampler.ts` 的 `agentSampleOf`                                                                                                                                                                                                       |
| 客户端视图     | `src/client/DagBody.tsx`（容器 + 两处切换 + stale 说明）、`DagGraphView.tsx`、`AgentTreeBody.tsx`                                                                                                                                                                                                             |
| 测试           | `tests/unit/dag/agent-tree/{agent-tree,agent-tree-store}.test.ts`、`tests/unit/dag/agent-tree/agent-tree-capture.test.ts`、`tests/unit/host/routes.test.ts`（子代理树路由组）、`tests/unit/host/routes/internal/agent-snapshot.test.ts`、`tests/unit/client/{agent-tree-model,dag-sampler,api,index}.test.ts` |

## 8. 实测

- **本机（2026-10-11）**：`pnpm lint` 0 error；`pnpm check-types` 0 error；`pnpm test`
  **54 文件 / 1095 用例全绿**；`pnpm build` 产出 `dist/index.js` + `dist/client.js`。
- **根因记录（`unknown-route`）**：`/dsh-mint/agents` 是**宿主侧**路由，只在 harness 启动时随
  bundle 的模块载入；ESM 模块缓存按进程存活，**磁盘上 dist 已含 `agents` 也不生效**——实测线上
  `curl` 答 404 `unknown-route` 时，`dist/index.js` 里的 `ROUTE_NAMES` 已含 `"agents"`、`sendAgents`
  也在，而进程启动时刻早于该路由的提交与构建时刻。**判据 = 比对进程启动时刻与 dist mtime**；修法只有
  重启 harness（客户端产物 `dist/client.js` 只需刷新页面）。headless 自检通过 ≠ 运行中的 harness 已更新
  （同一条口径见 [client-face.md](client-face.md) §6.5）。
- **待重启复核（人眼）**：面板内的两处 `SegmentedControl`、树的缩进与肘线、running 行的脉动、
  token 黄 / 时长紫在两个主题下的可读性、hover 卡片、以及**快照兜底**那一行说明（把会话结束后重开
  面板当作一次人工用例：应当看到「会话已结束，显示 …」+ 最后一棵树，且没有任何脉动）。
- **本轮（2026-10-16）**：口径同步，无逻辑改动（`notes/agent-tree.md` 的 §4.1 / §6 / §7 表 / §8 本条、
  `notes/memory.md` 的索引行、`src/AGENTS.md` 模块 tree 一行，以及
  `src/host/routes/internal/mint-handler.ts` 的一处过期注释）；本节历史数字未改。节点 UT
  `node node_modules/vitest/vitest.mjs run tests/unit/dag/agent-tree/agent-tree-capture.test.ts`
  → 1 file / 9 tests passed（7 个 `it`，非法 id 用 `it.each` 3 例）。收口全量
  （`pnpm lint && pnpm check-types && pnpm test:coverage && pnpm build`）由 main 在 plan 收口时跑，
  本节不记全量数字。
