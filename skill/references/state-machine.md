# mint 状态机与容器派生

> **命令经 `mint` 工具执行**：表中 `args` 列即 `mint({ args: [...] })` 的参数数组。
> 阶段与硬约束由 mint CLI 决定，见 `mint({ args: ["issue","state","--help"] })`。

## 三层模型（从 SKILL.md 迁入）

- **issue**：问题/需求，六态；**最小执行单位**（活干在它上面）。
- **plan**：一次开发计划，下挂 issue；**对应 DSH plan 模式**（一一对应）。
- **milestone**：功能版本（create 必带 `--version`）；**默认 1 个 running（`-f` 并行）**，
  plan 与独立 issue 默认挂它。

issue 属 plan 后**不能**再直接挂 milestone（二选一）；plan 与 milestone 状态都是**派生**的
（见文末容器五态）。

## issue 六态

`open → planned → dev → test → done`（正向链路）+ `dropped`（终止）+ 回退/重开。
**`test` 状态语义 = testing（测试中/等待测试），不是"测试完成"。**

## 转换表

| 当前状态 | 动作 | 目标状态 | args | 约束 |
|---|---|---|---|---|
| open | plan | planned | `["issue","state","plan","<id>"]` | — |
| planned | start | dev | `["issue","state","start","<id>"]` | — |
| dev | commit | test | `["issue","state","commit","<id>","--sha","<SHA>"]` | `--sha` **可省**（默认读 HEAD；非 git 目录必填），写 last_commit_id；`--test-cmd` 可选（仅记录） |
| test | retest | dev | `["issue","state","retest","<id>","--test-cmd","<CMD>"]` | 测试失败打回；**保留 last_commit_id**（dev+旧 sha=失败标记）；**`--test-cmd` 必填**（尽量精确） |
| test | close | done | `["issue","state","close","<id>","--test-cmd","<CMD>"]` | **`--test-cmd` 必填**；测试全绿才推进 |
| planned/dev/test | reset | open | `["issue","state","reset","<id>"]` | 打回重做，**清空 test_cmd**（需重测） |
| done/dropped | reopen | open | `["issue","state","reopen","<id>"]` | 重开 |
| 任意 | drop | dropped | `["issue","state","drop","<id>","--reason","<TEXT>"]` | 可附理由，写入 dropped_reason |

## task kind 状态流（无 dev 态）

kind=task（杂务/文档/调研/CI 等不改行为的工程工作）复用六态但**跳过 dev**：

| 当前状态 | 动作 | 目标状态 | 说明 |
|---|---|---|---|
| planned | start | **test** | 跳过 dev，直接进入测试 |
| test | retest | **planned** | 无 dev 中间态，打回排期重新 start |
| dev | commit | — | **不可达**（task 永不进入 dev），报错 `invalid transition: task kind does not use git commit` |

其余转换（plan/close/reset/drop/reopen）与通用六态一致；problem/requirement 状态流不变。

## 硬约束（违反会被 CLI 拒绝 / 语义错误）

- **无 dev→done 捷径**：跳过测试也必须 `commit` 到 `test`，close 时 `--test-cmd` 填 `not-tested`。
- **commit 的 `--sha` 默认为当前 HEAD**：git 目录可省略；非 git 目录必须显式，否则报错
  `not a git repository (use --sha to record a commit explicitly)`。
- **close 必填 `--test-cmd`**：缺省/空白报错 `close requires --test-cmd (use 'not-tested' if tests were skipped)`。
- **reset 只作用于 planned/dev/test**；done/dropped 不能 reset（应 `reopen`）。
- **reopen 只作用于 done/dropped**；open 不能 reopen。
- `open` 不能直接 `start`（须先 `plan`）；`planned` 不能直接 `commit`（须先 `start`）；`open` 不能直接 `close`。
- 每次状态转换写 `updated_at`；`drop` 写 `dropped_reason`；`commit` 写 `last_commit_id`。

## 校验与示例

- 每次 `state` 操作后看退出码与 `{id,from,to}`；失败时 stderr 含原因，
  先 `mint({ args: ["show","<id>"] })` 确认当前状态再校正动作。
- 合法正向链路：
  `issue add` → `issue state plan N` → `issue state start N` → `issue state commit N --sha <SHA>` →
  `issue state close N --test-cmd "<cmd>"` → done。
- 放弃链路：`issue state drop N --reason "superseded by #12"` → dropped。

## 批量（变参多 id / plan 级）

- **变参多 id**：`["issue","state","<action>","<id>","<id>",…]` —— 逐个转换，
  非法转换 / issue 不存在跳过并注明，末尾汇总 `N transitioned, M skipped`；
  使用错误（缺 `--test-cmd`/`--sha`）中止。
  - `["issue","state","plan","42","43","44"]`
  - `["issue","state","commit","42","43","--sha","<SHA>"]`
  - `["issue","state","close","42","43","--test-cmd","<cmd>"]`
- **plan 级批量**：
  - `["plan","plan","<plan_id>"]`：该 plan 下全部 `open` issue → `planned`（**开工锁定**；**登记阶段不要用**，#128）。
  - `["plan","close","<plan_id>","--test-cmd","<cmd>"]`：该 plan 下全部 `test` issue → `done`（统一测试后统一 close）。
  - `["plan","drop","<plan_id>"]`：**只允许空 plan**（无 issue）→ dropped，并落 `manual_dropped` 标记；
    有 issue 时报错（先 `state drop` 子 issue 或迁走）。手动终态不会被派生复活。

## 容器（plan/milestone）五态派生（区别于 issue 六态）

plan/milestone 状态由**子项集合派生**（CLI 只读，非手动设置）。语义映射来自 mint
`src/container/derive.rs`（0.9.0-alpha.1）：issue `planned/dev/test` → 活跃，`open` → open，
`done`/`dropped` → 各自终态。

| 容器状态 | 派生条件 |
|---|---|
| running | 任一子项为 **planned/dev/test**；**或**子项里混有 done/dropped 与 open（非全终态，曾运行） |
| done | 全部 done |
| dropped | 全部 dropped |
| **partial** | **恰为 {done, dropped} 混合（无 open、无活跃）——是完成态**（等同 done） |
| open | **全部 open，或空 plan** |

> **全 `open` 的 plan 派生 `open`，不是 `running`**：`open` 不算「活跃」。#128 的登记态
> （建 plan + 拆 issue 全落 open）正落在这里，plan 绑定门禁与它按同一口径判（#135）。
>
> **判断 plan 是否完成看 issue 是否全终止（done/dropped）**，而非只看 status 标签；
> `partial` 即完成（含被吸收/废弃项），不要把 partial 当"未完成"。

## 手动状态覆盖的边界

- `milestone set --status`：只有 `done`（发布）/ `dropped`（取消）是**手动终态**，派生不覆盖；
  写 `open`/`running` 只是临时覆盖，后续任何子项变化都会按子项集合重算（`sync_milestone` 只对
  done/dropped 短路）。置位/降级后应 `milestone show` 复查，必要时先迁移子项（见 `flow-conditions.md`）。
- `plan drop`：走独立 `manual_dropped` 标记，空集合派生为 `open` 也不会把它复活；派生的 dropped
  （子 issue 全 dropped）无标记，会随后续状态变化重算。
