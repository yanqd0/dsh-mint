# label 规范

> 从 SKILL.md「约束」迁出（#62）：只在登记/挂载 issue 时需要，不必常驻正文。

## 命名

- 一律**英文**（除非用户明确要求打非英文词）、**全小写**、尽量短。
- 每个 issue **上限 5 个** label。
- 新 label 可补 `description`（尽量自解释）；**颜色自动生成**，无需手动指定。

## 常用 label（按开发内容选）

- 文档类修改 → `docs`；CI / 构建 → `CI`。
- 模块 label 按开发模块打（`MCP` / `TUI` / `DB` / `CLI` / `plugin` 等）。
- **参与者**用 `agent:` 前缀（本宿主为 `agent:dsh`）。

## 规则

- **版本不用 label**：版本经 plan → milestone 表达。
- **不主动清理 label**：除非用户明确要求。
- label 只是分类，不替代 plan/milestone 的排期语义。
