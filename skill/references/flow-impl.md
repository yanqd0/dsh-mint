# 实现流程与门禁详解（flow-impl）

> 触发：进入写码实施。SKILL.md「不可跳过」是**门禁清单**，本文件解释为什么与怎么做。
> 状态机命令与批量细节见 `state-machine.md`；plan/milestone 规划见 `flow-planning.md`。

## 1. plan 绑定（单向）

**进计划模式的会话**在退出前必须有 mint plan；**建 mint plan 不要求计划模式**。
宿主 plan 与 mint plan 的对应只在这一侧成立：计划模式 ⟹ mint plan（退出时门禁），反向不成立。

- **计划模式序列**：在宿主 plan 模式里出方案 → 第一步建/挂对应 mint plan + 拆 issue（全 `open`）→
  **本会话确实要开工**才在退出前对「本 plan」的 issue 执行 `plan plan`（open → planned，退出口即开工点）→ 出计划模式。
  只登记建议、或拆出多个 plan 待用户拍板时**保持 `open`** 退出（0-running 逃生口放行）。
- **非计划模式序列**：`plan create`（挂当前 running milestone）→ 拆 issue → **先保持 `open`** →
  真正开工（第一个 issue 动手前）才 `plan plan` → 逐 issue `state start` → 改码。
  两条序列只差是否走宿主计划审批与退出门禁。**建好 plan ≠ 开工**：唯一会自然派生 `running` 的例外是
  把已在途（planned/dev/test）的 issue 挂进该 plan。
- **存量 plan 接管**：整体/多 issue 一次跑完 → **必须先进入宿主 plan 模式**再执行，**禁止 auto 模式直接跑完**；
  用户已点名**具体单个 issue** → 按指令直接 `state start`，不必先进计划模式。
- 门禁由插件 pre-execute 实现（见 `host-dsh.md`），判据三条：①项目里有**已拆解**的 mint plan
  （`running`，或 `open` 且已挂 ≥1 个 issue；空 plan 与完成态不算）；②同一 milestone 内 **至多一个 running plan**
  （>1 即被拒并点名 id；跨 milestone 是用户 `-f` 授权的并行版本，放行）；③非计划模式下调用它直接给可行动文案，不跑 mint。
- **被拒时怎么收敛**：①本次工作折进在跑的那条 plan（`plan attach`）；②那条 plan 属于别的会话 → 交回用户；
  ③它只是被新登记的 `open` issue 复活的旧 plan（`running` 也派生自 `{done|dropped} + open`）→ `plan detach` 释放；
  「停摆其排期」只能对其 `planned` 子项 `issue state reset`（`dev/test` 不可 reset，必须交回该会话）。

**为什么 `plan plan` 在退出口做不算违反「登记 ≠ 排期」**：「登记 ≠ 排期」约束的是**登记别处的新 issue**（建议一律留在 `open`）；
当前 plan 的 issue 在「本次工作开工」那一刻锁到 `planned`，计划模式退出口正是那一刻——
但**只有本次确实要开工**才锁；只登记、或等用户拍板先做哪条 plan，就留 `open`。

- **开工点先清 worktree**：真正动手前（`plan plan` 那一步）先 `worktree({action:"prune"})`——
  上一批的树按「保留现场」口径留在盘上（见 §4），这里是收掉它们的唯一时机；
  未合并 / 有未提交改动 / 不到 1 小时的会被保护下来（`worktree-exec.md` §7）。

## 2. 计划与归属

- 属已有 plan → `mint({ args: ["plan","attach","<plan>","<issue>"] })`。
- 不属任何 plan → 第一步 `mint({ args: ["plan","create","<标题>","--milestone","<当前 running id>"] })`，再拆 issue。
- 每个独立 phase 建 issue：
  - 改行为的 phase → `kind=requirement`，label `dev-clean`；
  - **纯文档/杂务/调研/CI → `kind=task`**（task 无 dev 态：planned → test → done）；
  - phase 已对应既有 issue（收口/合并 plan）→ **直接 attach，不重复建**。
- **开工点**统一排期锁定：`mint({ args: ["plan","plan","<plan>"] })`（open → planned）——
  **开工点 = 计划模式退出口，或非计划模式开始改码前**；
  **登记别处的新 issue 不预建 plan、不置 planned**（登记 ≠ 排期）。

## 2.5 并行批次执行

批次判据与派发协议见 `references/parallel-exec.md`（含 §1.1 重划与 §3.1 dev/test 节点对）；plan 阶段在这里已经产出 `## 并行批次`。
**分派边界**（哪些给子代理、哪些留主 agent）与全景 DAG 的分层见 `references/dag-exec.md`：
测试/验证/远程与命令调用类低 context 任务派子代理（更省 token、判定更客观），
总体评估、决策、流程控制与高 context 复杂任务留主 agent。

- 一 issue 一子代理（**dev/test 节点对** = 一级 dev 子代理 + 它的二级 test 子代理，`parallel-exec.md` §3.1）；
  一批在**同一条 assistant message** 里批量派 `subagent`：并行启动，不要一条条等；
  提示词禁令必须写全（子代理看不到本对话）。**派发纪律见 `parallel-exec.md` §3：一步一节点**
  （同批多路派发会让 `agent` 配对整体错位）。
- 子代理**只改自己白名单内的文件**；一切 mint 写与**主工作树**的 git 由主 agent **逐 issue 串行**做
  （避免 git index 竞态与互相夹带）；worktree 模式下由 dev 子代理在自己的树内 commit（`worktree-exec.md` §3）。
- 等待**不 `sleep`**、不轮询 `list_agents`：默认继续自己的独立工作，结算通知会自动到；
  真被阻塞才 `job_output(<id>, wait: true)`（**仅一次性后台 job**，不用于子代理）。
- 重命令（build / test:coverage / 装依赖）与串行独占生成物（`CHANGELOG.md`、lockfile）归主 agent。

## 3. 每个逻辑变更

**进度可见（宿主 todo 面板，人类看进度的入口）**：开工第一步（**每个 turn**）先用
`mint({ args: ["list","--plan","<plan>"] })` 取本 plan 的 issue 列表，写一份全量
`todo_write` 清单——**一项对应一个 issue**，条目文本 = `#<id>` + issue 标题（可带文件白名单），
如 `#<id> 插件：todo 同步提醒`。此后**每次 issue 状态变更后重写同一清单**：当前 issue 置
`in_progress`，`commit`/`close` 过的置 `completed`，未开工的留 `pending`。
宿主 `todos` 投影在**每个 `turn/start` 重置为空**，所以每个 turn 都要重写一次；
面板与 mint 状态不一致即视为未同步（插件在状态变更后会追加一行提醒，别忽略它）。

- **条目粒度禁令**：清单条目**不得写成批次**名（如「批次 1」「批次 2-B」）、
  **DAG 节点**名，或「串行/并行」标注——**批次只是执行分组，不是清单条目**（批次口径见
  `parallel-exec.md`）；清单里也不要出现与 issue 无关的条目（纯文档/杂务条目除外：它们本就是 issue）。
  写成批次名会与 mint 台账对不上，人类看进度面板会误判。

1. 改码前 `mint({ args: ["issue","state","start","<id>"] })`（planned → dev），**保持 dev**。
   - 自查：改码前确认该 issue 已 start；phase 结束用 `mint({ args: ["list","--plan","<plan>"] })` 复查。
   - 补救：已改码却没 start → 先 `state start` 再 `state commit`（避免非法转换）。
   - 同步 todo：该 issue 置 `in_progress`（清单其余项不动）。
2. 代码 commit 后立即 `mint({ args: ["issue","state","commit","<id>","--sha","<前7位>"] })`（dev → test）。
   - commit message 用 **Angular 前缀 + 中文描述**，**不带任何 mint ID**；issue↔commit 关联由 `state commit --sha` 登记（`worktree-exec.md` §3）。
   - sha 用 bash `git rev-parse --short=7 HEAD` 取；一个 issue 多个 commit **每次都登记**（只留最后一个 sha）。
   - 同步 todo：该 issue 置 `completed`。

## 4. 统一测试与收口

**两层，都不可省**：

① **节点内 UT**：各节点在**自己的 worktree 内**先跑**该节点相关的 UT**（命令形式与可行性见
`worktree-exec.md` §2/§3；判据轴见 `parallel-exec.md` §1）：红了在树内修，**不带红 merge**。
dev/test 对里这一步由**二级 test 子代理**做只读验收（结论写进最终回复并自己 `set` 它的 test 节点）；
**失败 → reopen 同一个 test 节点重派**（不新增节点、不加边，`dag-exec.md` §5）。

② **收口全量**：一个 plan 的**全部 commit 都 merge 进目标分支**后，主 agent 在**主工作树**跑一次**完整测试**
（`pnpm lint && pnpm check-types && pnpm test:coverage && pnpm build`），全绿才 `plan close`。

- **为什么两层都要**：节点内 UT 挡**单点红**（贴本次改动、秒级、merge 前就发现）；收口全量挡**跨节点集成红**
  （单节点各自绿，合起来仍可能红）。少任一层都会把一类红漏到最后。
- 同 plan 各 issue 先停在 **test**（不逐个 close）；收口全量绿 →
  `mint({ args: ["plan","close","<plan>","--test-cmd","<命令>"] })`（全部 test → done）。
- 失败 → `mint({ args: ["issue","state","retest","<id>","--test-cmd","<精确手法>"] })` 打回 dev →
  修复 → 新 commit → 新 `state commit`（新 sha）→ 再测；DAG 侧同步 **reopen 同一个 test 节点**（`dag-exec.md` §5），
  **不新增节点、不成环**。
- 跳过测试也要 commit 到 test，close 时 `--test-cmd not-tested`；**无 dev→done 捷径**。
- plan 的 issue 全 close 后自动派生 done（含 dropped → partial，属完成态）。
- 走 worktree 隔离的批次：**merge 之后**才 `state commit`（sha 取**目标分支**（开工时所在分支）merge 后的）；
  `plan close` 后**不清理** `active` worktree，**保留现场**（理由与三条保护见 `worktree-exec.md` §7），
  下一次开工点（`plan plan` 之前）用 `worktree({action:"prune"})` 按规则收旧的。

## 5. 复查

每个 phase 结束用 `mint({ args: ["list","--plan","<plan>"] })` 复查状态；违反门禁视为「未接管」，
下次 session 必须补登记。

## 6. 先跑后建：记录必须有，顺序可换

两种顺序都合法，**记录必须有**（写给未来的自己、隔壁项目的 agent 或人类看）：

- **先建再跑（默认）**：
  - 计划模式：进计划模式 → 建/挂 plan + 拆 issue →（**确实要开工才** `plan plan`）→ 出计划模式 →
    逐 issue `state start` → 改码；只登记就把 plan 与 issue 留在 `open` 再出模式。
  - 非计划模式：`plan create`（挂当前 running milestone）+ 拆 issue → **保持 `open`** →
    开工前才 `plan plan` → 逐 issue `state start` → 改码；**建 plan 不要求计划模式**。
  - 两条序列的开工点都**先 `worktree({action:"prune"})`** 收上一批留下的旧树（§1、§4）。
- **先跑后建（补登记）**：已在**无记录**状态下改了码/提交了 commit → 停下来补：
  建/挂 plan → 按实测现象与 commit 范围建 issue → `plan plan` → `issue state start <id>` →
  **对每个既有 commit 逐条** `issue state commit <id> --sha <前7位>`（sha 用 `git log --oneline` 回看）→
  统一测试 → `plan close`。
  - 补登记不是重写历史：`state commit` 记的就是当时那个 commit，几个就登记几条。
  - 已经跑完才发现根本没有 plan：第一件事是 `plan create`（挂当前 running milestone），
    别让 issue 散落（散落时转 `flow-sweep.md`）。

- plan 模式**内**可以写 mint（DSH 不裁剪工具目录），所以「出计划模式前建 plan + 拆 issue」是
  可执行的推荐第一步；反过来，本会话零 mint 写操作就 `exit_plan_mode`，结果里会附一条补登记提示
  （插件实现，见 `host-dsh.md`）。
