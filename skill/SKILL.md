---
name: mint
description: >-
  用 mint 管理开发 issue / plan / milestone（三层）。当用户描述 bug/问题/需求/遗留项/
  TODO/观察项/审查发现/计划/里程碑/milestone/sprint 等值得记录的内容时自动触发；
  无参数调用时接管 session，推测下一步开发计划。触发词：issue bug problem requirement
  todo leftover review plan milestone sprint 登记 记录 排期 修复 需求 问题 遗留 审查
  计划 里程碑 同步 推送 拉取 合并 下一步。
---

用 mint 管理开发 issue 与流程：**解析意图 → 读 reference → 用宿主 `mint` 工具执行 → 验证**。
未传参即接管；**本项目操作不带 `-p`**，跨项目见路由表（`cross-project.md`）。

三层模型：**issue** 问题/需求（六态，最小执行单位）｜**plan** 一次开发计划，**非计划模式也可建**
（进计划模式的会话退出前必须已有它）｜**milestone** 功能版本（create 必带 `--version`；
**默认 1 个 running（`-f` 并行）**，plan 与独立 issue 默认挂它）。见 `state-machine.md`。

## 流程索引（按触发读；路径均在 `references/`）

| 触发 | reference |
|---|---|
| 登记：bug / 需求 / 遗留 / 审查发现 | `flow-bug.md`、`flow-requirement.md`、`flow-todo.md`、`flow-review.md` |
| 规划：版本 / 计划 / 拆解 / 分支决策 | `flow-planning.md`、`flow-conditions.md` |
| 写码实施：门禁 / 并行批次 / 状态机 | `flow-impl.md`、`parallel-exec.md`、`state-machine.md` |
| worktree 隔离并行 | `worktree-exec.md` |
| 调研 / 执行两阶段的 DAG 与分派 | `plan-dag.md`、`dag-exec.md` |
| 接管 / 收口 / 多机同步 | `flow-session.md`、`flow-sweep.md`、`flow-sync.md` |
| 命令 / 正文取值 / 模板 / body / label / 约束红线 | `commands.md`、`template-guide.md`、`body-editing.md`、`labels.md`、`constraints.md` |
| 跨项目登记 / 本宿主集成 | `cross-project.md`、`host-dsh.md` |

## 不可跳过（强制；见 `flow-impl.md`）

- **plan 绑定（单向）**：计划模式退出前项目里必须有**已拆解**的 mint plan（`exit_plan_mode` 被拒），
  且同一 milestone **至多一个 running plan**（>1 即被拒并点名）；建 plan 不要求计划模式。
  存量 plan 整体接管仍先进计划模式，禁止 auto 跑完。
- **并行批次**：plan 必带批次表（同批文件不相交）；见 `parallel-exec.md`。
- **记录必须有，顺序可换**（无 plan 不写码）：属已有 plan → `plan attach`；否则 `plan create` + 拆 issue；
  **提 issue 一律 open；`plan plan` 在开工点（含计划模式退出口）执行**。
- **改码前门禁**：先 `args: ["issue","state","start","<id>"]`（→ dev）；open 直接改码 = 违反。
- **commit 后立即**：`args: ["issue","state","commit","<id>","--sha","<前7位>"]`
  （sha 用 `git rev-parse --short=7 HEAD`）；统一测试与 `plan close` 见 `flow-impl.md`。
- **默认挂当前 running milestone**：无 running → 推测候选并**询问用户**，**不得自行置 running/`-f`**。
- `delete` / `sync` **须走 bash** 且先经用户确认（工具直接拒绝）。
