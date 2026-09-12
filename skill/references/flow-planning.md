# 版本规划与执行计划流程（flow-planning）

> 标题/body 模板：`title-templates/plan.md、milestone.md + body-templates/7.md、8.md、15.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

触发：版本 / 计划 / 里程碑 / milestone / plan / sprint / 拆解执行计划 / 方案执行。

## 步骤

1. **版本规划**（milestone = 项目功能版本）：
   - 先 `mint({ args: ["milestone","list","--all-states"] })`：**已有 running → 不新建**，新工作挂当前 running；
     **无 running → 按 flow-conditions 推测候选 + 询问用户**（置为 running 或新建；不得自行置位）。
   - 新建：`mint({ args: ["milestone","create","<版本标题>","--version","<V>","--body","<目标+范围+验收>"] })`
     —— `--version` 必填、语义化；按 version 查重，**重复则不加、不问**。
2. **执行计划**（plan = 一次开发计划，对应 DSH plan 模式）：
   `mint({ args: ["plan","create","<计划标题>","--body","<body>","--milestone","<RM>"] })`。
3. **拆 issues**：按计划子任务逐个
   `mint({ args: ["issue","add","<子任务>","--kind","requirement","--label","dev-clean"] })`
   + `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })` 挂入，
   **挂入后统一排期锁定**：`mint({ args: ["plan","plan","<PLAN>"] })`
   （plan 下 issue 一律 planned，不留 open）。
4. **方案执行登记**（跨模块/多步骤方案，含方案审批/plan 产出）：**第一步先建 mint plan + 拆 issues 再执行**；
   每个 issue 走状态机到 done（关联对应 commit）。
