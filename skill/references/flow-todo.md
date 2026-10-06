# 遗留问题 / TODO / 观察项处理流程（flow-todo）

> 标题/body 模板：`title-templates/issue.md + body-templates/4.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

触发：用户提到遗留问题 / TODO / 改进点 / 观察项 / 技术债。

## 步骤

1. **登记**：先 `mint({ args: ["list","--search","<关键词>"] })` 查重 →
   `mint({ args: ["issue","add","<标题>","--body","<说明 + 来源>"] })`
   （问题=problem、改进=requirement、**杂务/文档/调研/观察项=task**）。
2. **挂载（默认挂载）**：属计划则 `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })`，
   否则**默认**挂当前 running milestone：`mint({ args: ["milestone","attach","<当前 running id>","<ISSUE>"] })`；
   无 running → 按 flow-conditions 给候选 + **询问用户**后再挂。
3. **排期（可选，须用户确认要做）**：`mint({ args: ["issue","state","plan","<id>"] })`（open → planned）
   标记已排期，留待后续开发；**登记后默认留 open，不顺手排期、不预建 plan**（#128：登记 ≠ 排期）。
