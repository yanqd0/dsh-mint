# 条件分支决策表（flow-conditions）

> 标题/body 模板：`body-templates/11.md、14.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

供各 flow 在登记/推进时按场景选择。

## 挂载规则（**默认挂当前 running milestone**）

**默认口径**：所有 plan 与独立 issue **默认挂当前 running milestone**——同刻**有且仅有 1 个** running。
issue 二选一：属 plan 后不能直接挂 milestone。

| 场景 | 动作 |
|---|---|
| 有关联 plan（正在开发的计划） | `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })` |
| 无关联 plan | **默认**挂当前 running milestone：`mint({ args: ["milestone","attach","<当前 running id>","<ISSUE>"] })` |
| 新建 plan | `mint({ args: ["plan","create","<标题>","--milestone","<当前 running id>","--body","<body>"] })` |
| 无 running milestone | 先按下方「下一版本推测」给候选 → **询问用户**（置为 running / 新建）→ 再挂 |

## milestone 唯一性与下一版本推测

- **同刻有且仅有 1 个 running**（当前开发目标）。`mint({ args: ["milestone","list","--all-states"] })`
  发现 ≥2 running → 列出并反问；确认后**先迁移/排期其下子项**（把已完成的 plan/issue 移到当前 running：
  `mint({ args: ["plan","set","<plan>","--milestone","<当前 running id>"] })`，其余 plan/issue 先
  `issue state plan/reset` 回到 open），**再**把远期那个置回 open：
  `mint({ args: ["milestone","set","<远期 id>","--status","open"] })`，最后
  `mint({ args: ["milestone","show","<远期 id>"] })` **复查**——若又被派生回 running，说明其下仍有活跃子项，
  回到第一步继续迁移。
- **无 running 时**：取 `milestone list --all-states` 中的最大版本 M，给候选（每个附一句理由）：
  - 收尾修复 / 文档 → patch `x.y.(z+1)`
  - 新功能面 → minor `x.(y+1).0`（0.x 阶段 minor 即可含破坏性）
  - 稳定后破坏性 → major `(x+1).0.0`
  - 已有 `-alpha.N` 预发布线 → 同线递增 `-alpha.(N+1)`
- **先查现有 open milestone**：版本与候选一致 → 推荐**置为 running**（不重复创建）：
  `mint({ args: ["milestone","set","<id>","--status","running"] })`；版本不符才建议 `milestone create`。
- **必须问用户**：给候选 + 理由，由用户选「置为 running」还是「新建」；**不得自行置 running**。
- milestone/plan 状态本是**派生**的（子项集合决定、写入时级联同步）：`milestone set --status` 里
  **只有 `done`/`dropped` 是手动终态、不被派生覆盖**；写 `open`/`running` 只是临时覆盖，后续任何子项变化
  都会按子项集合重算。置位后应尽快把对应 plan/issue 挂进去，使派生结果与意图一致。

## 测试分支（close 的 test-cmd 必填）

| 场景 | test-cmd |
|---|---|
| 有测试的项目 | 实际测试命令（如 `pnpm test`） |
| 无测试的项目 | `not-tested` |

## git 分支（state commit --sha）

| 场景 | 处理 |
|---|---|
| git 仓库 | 默认读 HEAD（可省略 `--sha`；建议显式传 `git rev-parse --short=7 HEAD`） |
| 非 git 目录 / 普通目录 | 需显式 `--sha <SHA>`；无 commit 可考虑 `drop` / `reopen` |

## link 规则

| 场景 | 动作 |
|---|---|
| 被别的修改引入（回归） | `mint({ args: ["issue","link","create","<issue>","solves","<引入 issue>"] })` |
| 相关但不解决 | `mint({ args: ["issue","link","create","<issue>","related","<other>"] })` |
| 重复 | `mint({ args: ["issue","link","create","<issue>","duplicates","<existing>"] })` |
| 依赖 / 阻塞（本 issue 被 other 阻塞） | `mint({ args: ["issue","link","create","<issue>","blocked-by","<other>"] })` |

link 参数取值一律 **kebab**（`blocked-by`，不是 `blocked_by`；后者只在 JSON `rel` 输出里出现）。

## kind 选择（决定状态机是否含 dev 态）

| 场景 | kind |
|---|---|
| 缺陷 / 问题 | `problem` |
| 需求 / 改进 | `requirement` |
| 杂务 / 文档 / 调研 / CI（不改行为，**跳过 dev 态**） | `task` |
