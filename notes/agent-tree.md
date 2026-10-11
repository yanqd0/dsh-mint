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

| 问题     | 真源                                                                                                                                   | 为什么是它                                                                                                                               |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| 谁是谁   | 父会话自己的 `subagentCatalog` 会话投影：`[{id, createdAt, mode, label?}]`，**只列直接子级**                                           | 它是**父会话日志里的持久事实**，所以子代理结束、会话离开注册表之后，树形与标签仍然读得到；`label` 就是派发时的 description，不必再问别处 |
| 活不活   | `ctx.agents.get(id)?.status === 'running'`（Agent 上直接可读；`'idle' \| 'running'`）                                                  | catalog 是历史，存活度是此刻；宿主自己也是这么答的（`@deepseek-ai/dsh-client-ui-subagent` 的目录下拉读的就是它）                         |
| 花了多少 | `ctx.sessionProjections.stateOf(session, key)`：`tokenUsage`（四桶 + `last`）、**`contextPressure`**、`subagentTiming`、`sessionStats` | 与本仓 DAG 的 `dag-metrics.ts` 同一条读法；**同步、内存、按会话惰性 fold**                                                               |

读取路径是**同步**的（`stateOf`），不是宿主自带的 `listChildren`/`listDescendants`——后者走
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
  "warnings": ["root session is not live"],
}
```

- 形状是**扁平数组 + `parent`**（不是嵌套树）：客户端要按行排版，嵌套结构只会把「父缺失」
  「id 重复」这类坏数据的处理塞进序列化里。
- `warnings` 只在非空时出现；**根不在册、服务缺失、`stateOf` 抛错都是空树**，不是 404 也不是 500
  ——这条路由没有「文件不可读」那种态，只有「读不到」。
- **护栏**：`visited` 去重（防坏 catalog 的环）、`mode` 未知即丢、深度 ≤ 8、节点 ≤ 200；一个分支
  抛错只丢它自己。

## 5. 客户端

- **`SegmentedControl` 在面板内部切两个视图**（不是第三个侧边栏 tab 类型）：两个视图共用同一套
  `useId` 基础 id 与 `role="tabpanel"` 契约（与「正文预览 / 代码」同一个控件）。
- **两条读各按自己的路由轮询**，且**只有当前视图被读**；切回来立即补读一次。整份读数守卫
  （`sameSample`）对两者共用：DAG 比 `revision + sampled_at + metrics`，子代理树比节点 id →
  `{running, label 指纹, tokens, context, elapsed_ms}`。**子代理树的 `sampled_at` 不参与判定**——
  那条路由每次应答都会读一次钟，把它算进身份会让面板每 2s 白重渲一次。
- **走秒只对 running 行**，锚在信封的 `sampled_at` 上；一个共用的 1s 定时器。
- **hover 卡片**给完整 label、会话 id、`mode`、步数、`seenAt`，以及**该 agent 被哪些 DAG 节点
  认领过**（由容器从第一视图的文档里查 `node.agent` 现算，不新增路由字段）。
- **配色一律复用**：行盒子走 `agentRowStyle`（与 `dagNodeStyle` 同一套 `color-mix` + 满强度描边），
  running 脉动复用同一个 `dsh-mint-dag-pulse` class 与 keyframes，token 黄 / 时长紫就是
  `LIVE_TOKENS_COLOR` / `LIVE_TIME_COLOR`。肘线用 DAG 边那支 `--dsw-alias-border-l2`。

## 6. 已知限制

- **不落盘**：agent 树的读数只活在进程内存里，重启即丢（DAG 节点有 `samples` 落盘，子代理没有
  ——它没有「节点」这个宿主概念，落盘要额外发明一份文档）。子代理结束、会话离开注册表之后，
  它的读数就只剩这棵树上已经画出来的那一份。
- **一次都没被观测过就没有数字**：与 DAG 的 §7.6 同一条边界——面板不开、catalog 读不到，就没有
  读数可记。
- **`sessionQuery` 那条路没走**：宿主自己能用 `observeSession` 读到已经归档的会话 catalog；本插件
  只读内存状态，所以端到端的视界是「本进程见过的会话」。

## 7. 落点与测试

| 层           | 文件                                                                                                                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 宿主读树     | `src/dag/agent-tree/agent-tree.ts`（`collectAgentTree`；纯同步、无 I/O、无 `node:`）                                                                                                                  |
| 宿主路由     | `src/host/routes/internal/mint-handler.ts` 的 `sendAgents` + `readAgentTree` 缝；路由名在 `src/shared/route-paths.ts`                                                                                 |
| 线格式       | `src/shared/records.ts` 的 `AgentNodeView` / `MintAgentsPayload`；`DagNodeMetrics` 加 `context`                                                                                                       |
| 客户端纯逻辑 | `src/client/agent-tree-model.ts`（行/排版/单元格/摘要）、`src/client/dag-sampler.ts` 的 `agentSampleOf`                                                                                               |
| 客户端视图   | `src/client/DagBody.tsx`（容器 + 切换）、`DagGraphView.tsx`、`AgentTreeBody.tsx`                                                                                                                      |
| 测试         | `tests/unit/dag/agent-tree/agent-tree.test.ts`、`tests/unit/client/agent-tree-model.test.ts`、`tests/unit/host/routes.test.ts`（子代理树路由组）、`tests/unit/client/{dag-sampler,api,index}.test.ts` |

## 8. 实测

- **本机（2026-10-11）**：`pnpm lint` 0 error；`pnpm check-types` 0 error；`pnpm test`
  **54 文件 / 1095 用例全绿**；`pnpm build` 产出 `dist/index.js` + `dist/client.js`。
- **待重启复核（本轮未做）**：`/dsh-mint/agents` 是**宿主侧**路由，只在 harness 启动时随 bundle
  载入；当前进程里仍是旧 bundle，故 `curl` 答 404 `unknown-route`（实测）。重启 harness 后应得到
  200 + `nodes`，`session=../etc` / 缺参 → 400；客户端产物（`dist/client.js`）只需刷新页面。
- **待重启复核（人眼）**：面板内的 `SegmentedControl`、树的缩进与肘线、running 行的脉动、
  token 黄 / 时长紫在两个主题下的可读性、hover 卡片。
