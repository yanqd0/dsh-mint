# 需求处理流程（flow-requirement）

> 标题/body 模板：`title-templates/issue.md + body-templates/2.md、6.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

触发：用户描述需求/改进（"有个需求：Z"）。kind=requirement。

## 步骤

1. **登记**：先 `mint({ args: ["list","--search","<关键词>"] })` 查重 →
   `mint({ args: ["issue","add","<需求标题>","--body","<目标/范围>","--kind","requirement"] })`。
2. **排期**：确定目标版本 → 挂载（flow-conditions 决策表）：
   - 拆入执行计划 → `mint({ args: ["plan","create","<执行计划>","--body","<body>","--milestone","<RM>"] })`
     + `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })`。
   - 直接挂版本 → `mint({ args: ["milestone","attach","<RM>","<ISSUE>"] })`。
   - 未定 → 不挂，`mint({ args: ["issue","state","plan","<id>"] })` 标记已排期。
3. **推进**：开发时 `state start` → commit → close（同 bug 流程，含无测试/非 git 分支）。
   - **统一测试**：同 plan 多 issue 各自 commit 到 test（停在 test）→ 统一验证 →
     全绿 `mint({ args: ["plan","close","<PLAN>","--test-cmd","<cmd>"] })` 统一 close；
     测试失败 `mint({ args: ["issue","state","retest","<id>","--test-cmd","<精确手法>"] })` 打回（见 flow-bug）。
