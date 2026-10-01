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

## 来源 label（跨项目登记）

- 跨项目登记时**追加来源项目名**作 label：小写、等于 mint 项目名（如 `dsh-mint`、`dsh-dev-dsh`）。
  对方据此筛「外部反馈」与「自发现」，并用 `mint({args:["-p","<项目>","list","--label","<来源>"]})` 反查。
- 来源 label 与内容 label 并列（例：`docs,dogfood,dsh-mint`），**不替代**内容 label；
  仍受「每个 issue 上限 5 个」约束——超出时先砍内容 label 里最弱的一个。
- 本项目自己的 issue **不打**来源 label；口径与判据见 `cross-project.md`。

## 规则

- **版本不用 label**：版本经 plan → milestone 表达。
- **不主动清理 label**：除非用户明确要求。
- label 只是分类，不替代 plan/milestone 的排期语义。
