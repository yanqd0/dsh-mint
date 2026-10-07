# 并行批次执行（parallel-exec）

> 触发：plan 下多条互不依赖的 issue，同批派发子代理并行。
> 命令经 `mint` 工具；状态机 `state-machine.md`。

## 1. 可并行判据（五轴全绿才同批）

| 轴 | 全绿（可同批） | 触发串行 |
|---|---|---|
| 文件 | 同批文件集两两不相交（含 README 中英对、测试夹具） | 文件被两 issue 触碰 |
| 共享生成物 | 无 | `dist/`、`coverage/`、lockfile、`CHANGELOG.md` 必须串行 |
| 命令 | 只读自检 + **该节点 UT** | `pnpm build`、`test:coverage`、装依赖、重启 harness；**全量** `lint` / `check-types` 也归主 agent |
| git 与 mint 写 | 无 | 一律归主 agent |
| 语义依赖 | 互不知道对方接口 | B 的接口由 A 决定则串行 |

- **该节点 UT** = 只跑**该节点相关的测试文件**（不带 `--coverage`、不跑全量）：worktree 批次在自己的树内
  用主仓 vitest 跑（命令与落点见 `worktree-exec.md` §2），共享批次在主工作树内跑同一批文件。
  它只挡**单点红**，不替代 merge 后的收口全量（`flow-impl.md` §4）。
- 同一 issue 不拆给多人；**委派允许两级**——一级子代理可以再派它的**二级**子代理（典型用途 = dev/test
  节点对里的只读验收，见 §3.1），二级不得再往下派。受宿主 `subagent.maxDepth` 限制（本机设为 2；
  `0` 禁派、`1` 只允许直接子级，改设置**下一次委派**生效）。

### 1.1 触红先试重划，不要直接判串行

五轴里任一轴触红（尤其「文件」轴）时，**按文件归属试重划节点**：

1. 先把文件集**相交的多条 issue 合并成一个节点**（例：「`dag-worktree.ts` 的四处改动」合成一个节点、
   「`dag-tool.ts` 的三处改动」合成另一个），直到节点之间文件集两两不相交，再看这批能否并行。
2. **合并后仍相交 → 才判串行**；批次表必须能说明「**为什么无法重划**」（哪些 issue 相交、合成哪个节点、
   为什么合并不了）。只写一句「文件相交 → 串行」视为**没做**这一步。

- **例外：被改特性本身就是隔离机制**。当本 plan 改的正是 worktree 能力（或它的工具面、`prune` 策略这类本体）时，
  隔离机制自身不可用（策略还没定型，也不该在定型前用它）——此时走**共享工作区 + 一步一节点**是**预期而非缺陷**，
  在批次表里写明这条理由即可，不算判据失灵。
- **默认与取舍**：**≥3 条文件不相交 issue 时 worktree 模式是默认**（不是例外，见 `worktree-exec.md` §1）。
  「并行 vs 配对失真」的取舍判据：需要「一 issue 一个可独立验证的 commit」或节点间文件不相交 → 值得走 worktree
  并行（代价是必须守「一步一节点」的派发节奏，同批多路派发会让 `agent` 配对整体错位，见 §3）；只是图少几条
  消息、不需要单条 issue 单验 → 共享工作区串行就好，**不要为并行而接受配对失真**。

## 2. plan 阶段产出：`## 并行批次`

宿主 plan 正文与 mint plan body 同源，段名精确为 `并行批次`：

    - 并行批次：#<id>、#<id>、#<id>（文件不相交）
    - 依赖批次：#<id>（依赖 #<id>）
    - 串行独占：主 agent（git/mint 写、build）

- 无并行也写「单批串行」+ 一句理由；并写明是「重划后仍相交」还是「特性即隔离机制」（§1.1）。
- `plan create --body` 就带该段；`plan set --body-section` 按标题精确匹配，找不到标题报 `section not found`。

## 3. 派发协议

- 一批在**同一条 assistant message** 里批量发 `subagent`（并行，不要逐个等）——这里的「批量」是
  **执行分组**（几条活一起跑），不是「一条消息里同时点几路火」：派发顺序按下面「一步一节点」串行走。
- 一 issue 一子代理（**dev/test 节点对**另加它的二级 test 子代理，见 §3.1）；3–6 路为宜；
  **一个节点一个 worktree**（dev/test 对共用 dev 那棵，见 `worktree-exec.md` §3）。
- 提示词五段：① 目标（含 issue 号）；② 允许改的文件白名单；③ **该节点 UT 命令 + 期望输出**
  （`node <repo>/node_modules/vitest/vitest.mjs run <文件…>`，在它自己的 worktree 内跑，见 `worktree-exec.md` §2）；
  ④ 禁令（不 git、不 mint 写、不跑重命令、不动他人文件；**遇用户决策写进最终回复**，不调
  `ask_user_question`——子级会被 `DELEGATED_CALLER` 拒绝）；⑤ 输出契约（变更文件 + 验收输出摘要 + 未决点，不贴 diff）。
- **一步一节点（本节的硬纪律）**：派发前把该节点 `set running`，且此刻只让**一个**节点处于
  `running` 且无 `agent`；下一个节点**下一条消息**再 `set running` + 派发。判据 = **派发的那一刻只有
  一个候选节点**（不是「同一条消息里 `set` 写在 `subagent` 前面」——同一条消息里的多个 `set`/`subagent`
  是并发工具调用，谁先到不保证）。
- **dev/test 节点对是这条纪律的例外形态**：dev 节点被一级子代理认领后处于「`running` 且有 `agent`」，
  它再把自己这一对的 **test 节点** `set running` 并派二级子代理——任一时刻仍然只有**一个** `running`
  且无 `agent` 的节点，所以两节点可以**同时 `running`**（协议见 §3.1）。
- **违反的代价**：宿主 `subagent/start` 的 payload 只有 `{runId, provider, id, local}`，**没有**
  「哪次派发/哪个节点」的关联；节点由宿主**父感知**认领（优先 `depends_on` 指向父节点的候选，
  兜底才是数组**末尾**最近的 `running` 且无 `agent`，口径见 `plan-dag.md` §4.1）。于是配对 =
  「剩余候选 × 宿主发射顺序」的一个置换，而宿主 `subagent/start` 的**发射顺序不等于派发顺序** →
  一步把多个节点置 running 再同批派发，`agent` 与节点必然**整体错位**。
- **确要同批并行派发**：接受 `agent` 字段**仅作参考**（面板弱提示）；节点成败以子代理自己 `set` 的
  `verdict` / `note` 为准，`samples` 的数字也不当作该节点自己的开销。
- 派发后从 `subagent` 结果或 `list_agents` 拿到子会话 id，可 `set agent` 显式校正（**覆盖写**）。
- **UT 绿才算这一路完成**；红了在树内修，不带红 merge。
- 指针优于复述：issue body 用只读 `mint({ args: ["issue","get","<id>"] })` 取，不贴父对话、不复述 AGENTS.md。
- 拥有：工作区 cwd、AGENTS.md、bash/write/edit、`mint` 工具、skill catalog；缺少：父对话与 tool output、`[Mint]` 概览注入、提权能力。

### 3.1 dev/test 节点对（两级委派）

一个含「开发 + 测试」两阶段的 issue（issue 本身**不拆分**，它天然含两阶段）在 DAG 上落成**一对节点**：

| 节点 | 命名 | 谁执行 | 树 |
|---|---|---|---|
| 开发 | `<unit>d`（如 `w1d`） | **一级**子代理（main 派发） | 一对共用这一棵 |
| 验证 | `<unit>v`（如 `w1v`） | **它的二级**子代理（只读验收） | 同上（不另建） |

- **边只有一条**：`test 依赖 dev`（`add` 时 `depends_on`）；执行序、批次节奏**不写成边**（`plan-dag.md` §4）。
- **归属**：`init`/`add`/连边只由 main 做；子代理只 `set` 自己的节点，但**dev 子代理可以 `set` 它这一对的
  test 节点**（`running` / reopen）——这是 pair 内的委派，**不算越权建图**。
- **共用一棵 worktree**：`worktree` 记录落在 **dev 节点**（一对不建第二棵）；test 子代理只在该树内跑只读
  验收，不 commit、不 merge（`worktree-exec.md` §3）。
- **协议**：main `set` dev `running` → `create` 树 → 派一级 dev 子代理；dev 侧改写 + 在树内 commit →
  `set` 本对 test 节点 `running` → 用 `subagent` 派**自己的二级**子代理做只读验收（提示词写明只读、树路径、
  验收项、以及唯一允许的 `set` 就是它自己的节点）→ 二级子代理把结论写进**最终回复**并自己 `set` 本节点
  `done` + `verdict`（`pass`/`fail`）→ dev 子代理收齐后 `set` 自己 `done` 回报 main。
- **返工 = reopen 同一 test 节点**：test `fail` → dev 侧改写 → **补 commit** → `set` test 节点 `running`
  重派二级子代理；**不新增节点、不加边、不成环**（`dag-exec.md` §5）。
- **两级上限**：二级不得再往下派；受宿主 `subagent.maxDepth` 限制（本机设为 2）。

## 4. 单写者职责

- 主 agent 独占一切 mint 写与**主工作树**的 git：共享模式下子代理不 commit、不 `state`；
  worktree 模式下子代理只在自己的树内 commit（末条例外）。
- 主 agent 的宿主 todo 清单按 issue 粒度展开（一个 issue 一项）；子代理不写 `todo_write`，
  清单也不含 issue 之外的条目（口径见 `flow-impl.md` §3）。
- 清单条目仍按 issue 写（不得写成批次/DAG 节点名），口径见 `flow-impl.md` §3。
- 逐 issue：`git add -- <该 issue 的文件>` → commit → dev 类再 `git rev-parse --short=7 HEAD` → `issue state commit <id> --sha <前7位>`。
  - commit message 用 **Angular 前缀 + 中文描述**，**不带任何 mint ID**；issue↔commit 关联由 `state commit --sha` 登记（`worktree-exec.md` §3）。
- **dev/test 对的分工**（§3.1）：一级 dev 子代理改写 + 在共用的树内 commit（message 规则同上）；
  它的二级 test 子代理只读验收，把结论写进最终回复并自己 `set` test 节点，不 commit、不动文件。
- 批内不并行跑 build / test:coverage / format：全局独占，主 agent 串行。
- 子代理只改文件，自检默认只用只读命令。
- **节点内 UT 例外**：允许子代理在自己的 worktree 内跑指定 UT（主仓 vitest，口径见 `worktree-exec.md` §2）；
  其余重命令（`build` / 全量 `lint` / `check-types` / `test:coverage` / 装依赖 / 重启 harness）仍归主 agent。
- **worktree 例外口径**：需要「一 issue 一个可独立验证的 commit」（或共享工作区已互相污染）的批次，
  改走节点级 worktree——子代理在**自己的 worktree 内** commit **并跑该节点 UT**，主 agent 按 **issue 顺序
  merge** 后再 `state commit`；无 git 仓 / worktree 不可用时仍按本节共享模式。见 `worktree-exec.md`。

## 5. 等待与收尾（不 sleep）

- 不 sleep、不轮询 `list_agents`：禁止 bash `sleep`，也不要反复 `list_agents` 查子代理状态。
- 默认不等：派发后先做独立工作，结算通知自动到达。
- 无独立工作就地结束本轮：派发后若确实没有可继续做的独立工作，**就地结束当前轮次**，
  不要用 `sleep` 拖时间——运行时会在子代理结算时以 **follow-up 轮次**唤醒本 agent，
  结算通知随后自动到达。
- `sleep` 会把结算通知推迟到 `sleep` 结束之后（实测）：`sleep` 期间拿不到通知，
  只会更慢，同时白耗墙钟时间。
- 真被阻塞才 `job_output(<id>, wait: true)`（仅一次性后台 job，不用于子代理）。
- 短活 `run_in_background: false`；跑偏用 `interrupt_agent`；答复前收齐仍相关任务，`job_kill` 无意义 job。

## 6. 失败与边界

- **子代理遇用户决策：三步回流（唯一通道）**
  1. **子级**把「**问题 + 选项 + 建议 + 影响**」写进**最终回复**——子级调 `ask_user_question` 会被宿主以
     `DELEGATED_CALLER` 拒绝（只有运行时根 agent 能问；拒绝文案本身就要求把未决问题写进子级最终结果）。
  2. **根 agent** 把本轮攒下的决策**合并成一次** `ask_user_question`（见 `plan-dag.md` §2）。
  3. **mint 写由根 agent 自己执行**；需要子级继续跑时用 `send_message` 回投**同一 childId**（已结算则冷恢复
     同一 session，仅 continuable 可回投）。
- **为什么「mint 写归根 agent」不是偏好**：跨项目写的免问 grant 按 `sessionId + 项目` 记账，子代理是另一个
  session ⇒ 根 agent 已确认也**不传导**；子代理侧只能 fail closed。这是**唯一可行路径**，不是风格选择
  （口径见 `cross-project.md`「门禁与通道」）。
- 审批 pin `never` 不可提权：跨项目 mint 写、工作区外写、装依赖必失败 → 交回主 agent（同上）。
- 兄弟子代理共享工作区，宿主不串行化保护，冲突靠第 1 节判据预防。
- 子代理看不到父对话且不保证加载本 skill → 禁令必须写进提示词；**禁令里必须含「遇用户决策写进最终回复，
  不要调用 `ask_user_question`」**（五段提示词见 §3、`plan-dag.md` §3）。
- 结算通知不是返回值：不收 = 没做。
