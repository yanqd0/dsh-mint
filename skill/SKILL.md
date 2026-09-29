---
name: mint
description: >-
  用 mint 管理开发 issue / plan / milestone（三层）。当用户描述 bug/问题/需求/遗留项/
  TODO/观察项/审查发现/计划/里程碑/milestone/sprint 等值得记录的内容时自动触发；
  无参数调用时接管 session，推测下一步开发计划。触发词：issue bug problem requirement
  todo leftover review plan milestone sprint 登记 记录 排期 修复 需求 问题 遗留 审查
  计划 里程碑 同步 推送 拉取 合并 下一步。
---

用 mint 管理开发 issue 与流程：**解析意图 → 读对应 reference → 用 `mint` 工具执行 → 验证**。
位置参数 `<description>` 是一句话意图；未传参进入接管；不明确时用文本反问。

## 执行面

一律用宿主 `mint` 工具（零授权）；`args: [...]` 即 `mint({ args: [...] })`。

## 三层模型

- **issue**：问题/需求，六态生命周期；最小可执行单位。
- **plan**：一次开发计划，下挂 issue；**对应 DSH plan 模式**（宿主 plan ⟷ mint plan 一一对应）。
- **milestone**：项目功能版本（create 必带 `--version`）；**同刻仅 1 个 running**，plan 与独立 issue 默认挂它。

## 流程索引（按触发读）

| 触发 | reference |
|---|---|
| bug / 问题 | `references/flow-bug.md` |
| 需求 / 改进 | `references/flow-requirement.md` |
| 遗留 / TODO / 观察项 | `references/flow-todo.md` |
| 审查 / 审计 / 测试报告 | `references/flow-review.md` |
| 版本 / 计划 / 里程碑 / 拆解 | `references/flow-planning.md` |
| 写码实施（门禁详解） | `references/flow-impl.md` |
| 无参接管 | `references/flow-session.md` |
| 散落 issue 收口 | `references/flow-sweep.md` |
| 分支决策（挂载/测试/git/link/kind） | `references/flow-conditions.md` |
| 多机同步 | `references/flow-sync.md` |
| 命令 / 输出 / 字段 | `references/commands.md` |
| 状态机 / 容器派生 | `references/state-machine.md` |
| 标题 / body 模板纪律 | `references/template-guide.md` |
| label 规范 | `references/labels.md` |
| 约束红线（delete/清理/去重） | `references/constraints.md` |
| 本宿主集成 | `references/host-dsh.md` |

排序：`blocks` 其它 issue 的先行；同层 priority 升序（P0→P3），同 priority 按 id 升序。

## 不可跳过（强制；细节见 `references/flow-impl.md`、`references/state-machine.md`）

- **plan 双向绑定**：宿主 plan ⟷ mint plan 一一对应；无活跃 mint plan 时 `exit_plan_mode` 被拒。
  从存量 plan 接管时**必须先进入宿主 plan 模式**，禁止 auto 直接跑完。
- **无 plan 不写码**：属已有 plan → `plan attach`；否则 `plan create`（挂 milestone）+ 拆 issue +
  `plan plan` 锁定（不留 open）。
- **改码前门禁**：先 `args: ["issue","state","start","<id>"]`（planned → dev）；open/planned 直接改码 = 违反。
- **commit 后立即**：`args: ["issue","state","commit","<id>","--sha","<前7位>"]`
  （sha 用 bash `git rev-parse --short=7 HEAD`）。
- **统一测试**：同 plan 各 issue 停在 test，到齐后统一跑；全绿 `plan close <plan> --test-cmd "<命令>"`，
  失败 `issue state retest <id> --test-cmd "<精确手法>"` 打回 dev。
- **默认挂当前 running milestone**：无 running → 推测 semver 候选并**询问用户**，**不得自行置 running**。
- `delete` / `sync` **须走 bash** 且先经用户确认（工具直接拒绝）。

## 记录与检索

- 正文用 `args: ["issue","get","<id>","body"]`（裸值最准）；命令与输出见 `references/commands.md`。
- 标题/body 套模板、只记 LLM 未知：见 `references/template-guide.md`（禁 `- [ ]` checkbox）。
- 约束红线与 label：见 `references/constraints.md`、`references/labels.md`。
