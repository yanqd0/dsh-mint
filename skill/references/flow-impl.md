# 实现流程与门禁详解（flow-impl）

> 触发：进入写码实施。SKILL.md「不可跳过」是**门禁清单**，本文件解释为什么与怎么做。
> 状态机命令与批量细节见 `state-machine.md`；plan/milestone 规划见 `flow-planning.md`。

## 1. plan 双向绑定（DSH 专有）

宿主 plan ⟷ mint plan **一一对应**，禁止脱钩：

- 先在宿主 plan 模式里出方案 → 第一步就是建/挂对应 mint plan + 拆 issue（见第 2 节）。
- 已有存量 mint plan（接管场景）→ **必须先进入宿主 plan 模式**再执行，**禁止 auto 模式直接跑完**。
- 项目无活跃 mint plan 时宿主 `exit_plan_mode` 直接被拒绝（门禁由插件 pre-execute 实现，见 `host-dsh.md`）。

## 2. 计划与归属

- 属已有 plan → `mint({ args: ["plan","attach","<plan>","<issue>"] })`。
- 不属任何 plan → 第一步 `mint({ args: ["plan","create","<标题>","--milestone","<当前 running id>"] })`，再拆 issue。
- 每个独立 phase 建 issue：
  - 改行为的 phase → `kind=requirement`，label `dev-clean`；
  - **纯文档/杂务/调研/CI → `kind=task`**（task 无 dev 态：planned → test → done）；
  - phase 已对应既有 issue（收口/合并 plan）→ **直接 attach，不重复建**。
- **开工时**统一排期锁定：`mint({ args: ["plan","plan","<plan>"] })`（open → planned）；
  **登记阶段不预建 plan、不置 planned**（#128：登记 ≠ 排期）。

## 2.5 并行批次执行

批次判据与派发协议见 `references/parallel-exec.md`；plan 阶段在这里已经产出 `## 并行批次`。

- 一批在**同一条 assistant message** 里批量派 `subagent`（一 issue 一个）：并行启动，不要一条条等；
  提示词禁令必须写全（子代理看不到本对话）。
- 子代理**只改文件**；git 提交与一切 mint 写由主 agent **逐 issue 串行**做
  （避免 git index 竞态与互相夹带）。
- 等待**不 `sleep`**、不轮询 `list_agents`：默认继续自己的独立工作，结算通知会自动到；
  真被阻塞才 `job_output(<id>, wait: true)`（**仅一次性后台 job**，不用于子代理）。
- 重命令（build / test:coverage / 装依赖）与串行独占生成物（`CHANGELOG.md`、lockfile）归主 agent。

## 3. 每个逻辑变更

1. 改码前 `mint({ args: ["issue","state","start","<id>"] })`（planned → dev），**保持 dev**。
   - 自查：改码前确认该 issue 已 start；phase 结束用 `mint({ args: ["list","--plan","<plan>"] })` 复查。
   - 补救：已改码却没 start → 先 `state start` 再 `state commit`（避免非法转换）。
2. 代码 commit 后立即 `mint({ args: ["issue","state","commit","<id>","--sha","<前7位>"] })`（dev → test）。
   - sha 用 bash `git rev-parse --short=7 HEAD` 取；一个 issue 多个 commit **每次都登记**（只留最后一个 sha）。

## 4. 统一测试与收口

- 同 plan 各 issue 先停在 **test**（不逐个 close），到齐后统一跑测试/lint。
- 全绿 → `mint({ args: ["plan","close","<plan>","--test-cmd","<命令>"] })`（全部 test → done）。
- 失败 → `mint({ args: ["issue","state","retest","<id>","--test-cmd","<精确手法>"] })` 打回 dev →
  修复 → 新 commit → 新 `state commit`（新 sha）→ 再测。
- 跳过测试也要 commit 到 test，close 时 `--test-cmd not-tested`；**无 dev→done 捷径**。
- plan 的 issue 全 close 后自动派生 done（含 dropped → partial，属完成态）。

## 5. 复查

每个 phase 结束用 `mint({ args: ["list","--plan","<plan>"] })` 复查状态；违反门禁视为「未接管」，
下次 session 必须补登记。

## 6. 先跑后建：记录必须有，顺序可换

两种顺序都合法，**记录必须有**（写给未来的自己、隔壁项目的 agent 或人类看）：

- **先建再跑（默认）**：进计划模式 → 建/挂 plan + 拆 issue + `plan plan` → 出计划模式 →
  逐 issue `state start` → 改码。
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
