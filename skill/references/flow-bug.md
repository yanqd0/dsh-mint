# bug 处理流程（flow-bug）

触发：用户描述发现 bug/问题（"发现一个 bug：X 导致 Y"）。kind=problem。

> 命令一律经 `mint` 工具：`mint({ args: [...] })`（见 SKILL.md「执行面」）。
> `list` 默认每页 5 条，要全量加 `--no-page`。

## 步骤

1. **登记**：先查重（标题模糊匹配）`mint({ args: ["list","--search","<关键词>"] })`；未重复 →
   `mint({ args: ["issue","add","<标题>","--body","<现象>/<位置>","--kind","problem"] })`。
   - 标题/body 模板：`title-templates/issue.md` + `body-templates/1.md`（≤4 字段、只记未知、不明确写 `? 待确认`）。
   - 若被别的修改引入（回归）→ 找到引入它的 issue →
     `mint({ args: ["issue","link","create","<bug_id>","solves","<引入 issue_id>"] })`。
2. **挂载**（按 flow-conditions 决策表，**默认挂当前 running milestone**）：
   - 有关联的 plan（正在开发的计划）→ `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })`。
   - 无关联 plan → `mint({ args: ["milestone","attach","<当前 running id>","<ISSUE>"] })`。
   - 无 running milestone → 按 flow-conditions 给候选 + **询问用户**后再挂。
3. **解决流程**：
   - `mint({ args: ["issue","state","plan","<id>"] })` →
     `mint({ args: ["issue","state","start","<id>"] })` → 修复代码 → git commit →
     `mint({ args: ["issue","state","commit","<id>","--sha","<前7位>"] })`（dev→test）→
     `mint({ args: ["issue","state","close","<id>","--test-cmd","<cmd>"] })`（test→done）。
   - **测试失败**：`mint({ args: ["issue","state","retest","<id>","--test-cmd","<精确手法>"] })`
     （test→dev 打回，保留旧 SHA 标记失败）→ 修复 → 新 commit → 新 `state commit`（新前7位）→ 再测。
   - **无测试项目**：commit 后 `mint({ args: ["issue","state","close","<id>","--test-cmd","not-tested"] })`。
   - **非 git 目录**（flow-conditions）：commit 需显式 `--sha`；无 commit 场景考虑 `drop` 或说明。
4. **验证**：`mint({ args: ["show","<id>"] })` 确认 done + last_commit_id 记录。
