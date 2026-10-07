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
- 同一 issue 不拆给多人；子代理不得再派子代理（委派深度默认 1）。

## 2. plan 阶段产出：`## 并行批次`

宿主 plan 正文与 mint plan body 同源，段名精确为 `并行批次`：

    - 并行批次：#11、#12、#13（文件不相交）
    - 依赖批次：#14（依赖 #11）
    - 串行独占：主 agent（git/mint 写、build）

- 无并行也写「单批串行」+ 一句理由。
- `plan create --body` 就带该段；`plan set --body-section` 按标题精确匹配，找不到标题报 `section not found`。

## 3. 派发协议

- 一批在**同一条 assistant message** 里批量发 `subagent`（并行，不要逐个等）——这里的「批量」是
  **执行分组**（几条活一起跑），不是「一条消息里同时点几路火」：派发顺序按下面「一步一节点」串行走。
- 一 issue 一子代理；3–6 路为宜；**一个节点一个 worktree**（worktree 批次见 `worktree-exec.md` §3）。
- 提示词五段：① 目标（含 issue 号）；② 允许改的文件白名单；③ **该节点 UT 命令 + 期望输出**
  （`node <repo>/node_modules/vitest/vitest.mjs run <文件…>`，在它自己的 worktree 内跑，见 `worktree-exec.md` §2）；
  ④ 禁令（不 git、不 mint 写、不跑重命令、不动他人文件）；⑤ 输出契约（变更文件 + 验收输出摘要 + 未决点，不贴 diff）。
- **一步一节点（本节的硬纪律）**：派发前把该节点 `set running`，且此刻只让**一个**节点处于
  `running` 且无 `agent`；下一个节点**下一条消息**再 `set running` + 派发。判据 = **派发的那一刻只有
  一个候选节点**（不是「同一条消息里 `set` 写在 `subagent` 前面」——同一条消息里的多个 `set`/`subagent`
  是并发工具调用，谁先到不保证）。
- **违反的代价**：宿主 `subagent/start` 的 payload 只有 `{runId, provider, id, local}`，**没有**
  「哪次派发/哪个节点」的关联；节点由宿主从数组**末尾**认领「最近的 `running` 且无 `agent`」。于是
  配对 = 「剩余候选 × 宿主发射顺序」的一个置换，而宿主 `subagent/start` 的**发射顺序不等于派发顺序** →
  一步把多个节点置 running 再同批派发，`agent` 与节点必然**整体错位**（机制与实测数字见
  `plan-dag.md` §7.8.1）。
- **确要同批并行派发**：接受 `agent` 字段**仅作参考**（面板弱提示）；节点成败以子代理自己 `set` 的
  `verdict` / `note` 为准，`samples` 的数字也不当作该节点自己的开销。
- 派发后从 `subagent` 结果或 `list_agents` 拿到子会话 id，可 `set agent` 显式校正（**覆盖写**）。
- **UT 绿才算这一路完成**；红了在树内修，不带红 merge。
- 指针优于复述：issue body 用只读 `mint({ args: ["issue","get","<id>"] })` 取，不贴父对话、不复述 AGENTS.md。
- 拥有：工作区 cwd、AGENTS.md、bash/write/edit、`mint` 工具、skill catalog；缺少：父对话与 tool output、`[Mint]` 概览注入、提权能力。

## 4. 单写者职责

- 主 agent 独占 git 与 mint：子代理不 commit、不 `state`。
- 主 agent 的宿主 todo 清单按 issue 粒度展开（一个 issue 一项）；子代理不写 `todo_write`，
  清单也不含 issue 之外的条目（口径见 `flow-impl.md` §3）。
- 清单条目仍按 issue 写（不得写成批次/DAG 节点名），口径见 `flow-impl.md` §3。
- 逐 issue：`git add -- <该 issue 的文件>` → commit → dev 类再 `git rev-parse --short=7 HEAD` → `issue state commit <id> --sha <前7位>`。
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

- 审批 pin `never` 不可提权：跨项目 mint 写、工作区外写、装依赖必失败 → 交回主 agent。
- 兄弟子代理共享工作区，宿主不串行化保护，冲突靠第 1 节判据预防。
- 子代理看不到父对话且不保证加载本 skill → 禁令必须写进提示词。
- 结算通知不是返回值：不收 = 没做。
