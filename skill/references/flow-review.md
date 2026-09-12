# 审查/复查报告处理流程（flow-review）

> 标题/body 模板：`title-templates/issue.md + body-templates/5.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

触发：收到审查/审计/测试报告（如 code-reviewer / security-auditor / tester 的产出）。

## 步骤

1. **登记发现**（含已修复 bugfix）：非阻塞观察项 / 技术债 / 已知限制 →
   `mint({ args: ["issue","add","<标题>","--body","<说明 + 来源>","--kind","problem","--label","dev-clean:技术债"] })`，
   body 标注来源（如"code-reviewer 审查 <commit>"）。
   - 审查报告"未发现"不登记。
2. **挂活跃 plan**：报告属于当前方案/计划 →
   `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })`；否则不挂。
3. **推进**：
   - 已修复 → `mint({ args: ["issue","state","commit","<id>","--sha","<修复 commit>"] })` 后 close（审计轨迹）。
   - 待办 → `mint({ args: ["issue","state","plan","<id>"] })` 排期，留待后续。
4. **验证**：`mint({ args: ["show","<id>"] })` 确认 status 与 last_commit_id。
