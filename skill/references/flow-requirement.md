# 需求处理流程（flow-requirement）

> 标题/body 模板：`title-templates/issue.md + body-templates/2.md、6.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

触发：用户描述需求/改进（"有个需求：Z"）。kind=requirement。

## 步骤

1. **登记**：先 `mint({ args: ["list","--search","<关键词>"] })` 查重 →
   `mint({ args: ["issue","add","<需求标题>","--body","<目标/范围>","--kind","requirement"] })`。
2. **挂载与排期**（flow-conditions 决策表；**挂载 ≠ 排期**，**登记 ≠ 开工**，#128）：
   - **登记一律 `open`**：不预建 mint plan、不置 planned；提前给出的方案最多算建议（写进 body 或对话）。
     **属于当前 plan** 的 issue 不在此列：它们在开工点（计划模式退出口，或非计划模式开始改码前）
     随 `plan plan` 一起转 `planned`（#135/#136）。
   - 已决定开工 → 拆入执行计划 → `mint({ args: ["plan","create","<执行计划>","--body","<body>","--milestone","<当前 running id>"] })`
     + `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })`。
   - 不拆 plan → **默认**挂当前 running milestone：
     `mint({ args: ["milestone","attach","<当前 running id>","<ISSUE>"] })`。
   - 无 running milestone → 按 flow-conditions 给候选 + **询问用户**后再挂。
   - 排期（可选，须用户确认要排进后续开发）：`mint({ args: ["issue","state","plan","<id>"] })`（open → planned）。
3. **推进**：开发时 `state start` → commit → close（同 bug 流程，含无测试/非 git 分支）。
   - **统一测试**：同 plan 多 issue 各自 commit 到 test（停在 test）→ 统一验证 →
     全绿 `mint({ args: ["plan","close","<PLAN>","--test-cmd","<cmd>"] })` 统一 close；
     测试失败 `mint({ args: ["issue","state","retest","<id>","--test-cmd","<精确手法>"] })` 打回（见 flow-bug）。
