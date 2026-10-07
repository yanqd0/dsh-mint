# 约束红线（constraints）

> 从 SKILL.md「约束」迁出。挂载/测试/git/link/kind 的**决策表**在 `flow-conditions.md`；
> label 规范见 `labels.md`。

## 不可逆操作

- **`delete` 不可逆**：工具直接拒绝。issue 优先
  `mint({ args: ["issue","state","drop","<id>","--reason","<TEXT>"] })`；
  空 plan 用 `mint({ args: ["plan","drop","<plan>"] })`；确需物理删除 → 用户显式确认后走 bash。
- **去重合并不可逆**：`add` 对活跃 issue 做标题模糊匹配（**只合并 `plan_id=null` 的候选**），命中即
  合并（`hit_count+1`、label 并入），无法拆回；确认是不同 issue 时用 `--force-new` 强制新建。
  已挂 plan 的 issue **不参与自动去重** → 拆 issue 前人工比对标题。

## 验证产物清理

验证性操作产生的临时 issue/plan/milestone，用 `state drop`（附 reason）/ `plan drop` /
`milestone set --status dropped` 清理。

## 方案 vs 单点

- 跨模块 / 多步骤 → 建 plan + 拆 issue（见 `flow-impl.md`）。
- 单点小改 / 审查发现 / 观察项 → 只记 issue。

## link

- 被别的修改引入（回归）→ `mint({ args: ["issue","link","create","<issue>","solves","<引入它的需求>"] })`。
- 依赖/阻塞用 `blocks` / `blocked-by`（**CLI 取值为 kebab**，方向与类型见 `flow-conditions.md`）。
- **版本不用 label**：版本经 plan → milestone 表达（见 `labels.md`）。
