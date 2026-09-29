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
- 挂入后统一排期锁定：`mint({ args: ["plan","plan","<plan>"] })`（plan 下不留 open）。

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
