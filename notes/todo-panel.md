# 宿主 todo 面板契约

> 实测版本：DSH `0.2.0-rc.2`（本地检出 `@deepseek-ai/dsh-tool-todo`、
> `dsh-client-ui-conversation`、`dsh-plan-mode`、`dsh-session`）。
> 本文件只记 LLM 读代码/试错才知道的事实；流程口径归 skill（`flow-impl.md` §3）。

## 1. 工具与事件

- `todo_write` 是**宿主**工具（`@deepseek-ai/dsh-tool-todo`），不是本插件的。
- `execute(args, exec)` 校验清单后调 `exec.agent.session.append('todo/write', { todos })`：
  **没有 `exec.agent` 的调用者直接被拒**（`todo_write requires an owning agent session`）。
- 参数是**全量替换**：`{ todos: [{ content, status }] }`，`status ∈ pending|in_progress|completed`；
  `content` 去空白后非空且唯一；`allowParallelInProgress` 为 false 时最多一个 `in_progress`（否则报错）。

## 2. 投影与渲染

- 会话投影注册名 `todos`（`ctx.sessionProjections.register`），`stateVersion: 2`，
  wire 视图是「整表或首写前的 `null`」。
- **`apply` 在 `turn/start` 把状态重置为 `null`**，只在 `todo/write` 时写入 ——
  所以一个 turn 内不写就没有面板；写一次后长期不更新，面板显示的就是过期进度。
  `turn` 的边界是「一轮用户输入」（`session` 事件的 `turn/start` 语义），不是每个 step。
- 渲染位置：`dsh-client-ui-conversation` 的 `conversation.input.dock`
  （`conversation-todo-dock`，order 0），只读，折叠态标题显示各状态计数。空表渲染 `null`（面板消失）。

## 3. 本插件的分工

- **只提醒，不代写**：`issue state` / `plan plan` / `plan close` 成功后，在工具结果末尾追加一行
  「同步 todo」（`src/host/reminders.ts` 的 `TODO_SYNC_REMINDER`）；失败结果与**子代理会话**
  （`header.delegationDepth > 0`）跳过——面板属于根 agent 的会话。
- 识别走 `invocationsOf`（`src/mint/cross-project-gate.ts`），mint 工具与 bash 兜底同一口径。
- 清单内容由模型写：它是**实施步骤的拆解**，不是 issue 行的镜像；插件无法知道模型的步骤划分。
- skill 侧口径：`skill/references/flow-impl.md` §3（开工每 turn 写一次 + 每次状态变更重写）、
  `flow-session.md` §5（接管时派生）、`parallel-exec.md` §4（子代理不写）。

## 4. 验证手法

- 单测：`tests/unit/host/reminders.test.ts`（识别 + enrich + 子代理静默）与内存态。
- 实机：写一次 `todo_write` → 输入区出现面板；同一 turn 内改动 issue 状态 → 工具结果末尾出现提醒；
  重写清单 → 计数随之变化；**开新的一轮输入后不写清单 → 面板消失**（turn 重置的判据）。
- 若面板始终不出现：先确认调用者真的是 agent（子代理会话的面板不在根会话里）。
