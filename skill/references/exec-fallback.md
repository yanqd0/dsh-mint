# 受阻降级执行（exec-fallback）

> 触发：执行阶段撞到硬阻塞（**默认路径不读本文**）。默认形态见 `parallel-exec.md`；worktree 用法见 `worktree-exec.md`。

默认形态 = **节点级 worktree 并行**：一批无依赖节点各进自己的树，dev 子代理在树内 commit 并跑该节点
UT，main 按 issue 顺序 merge（`parallel-exec.md` §1、`worktree-exec.md` §3）。本文只收「走不成默认
形态」时怎么办。

## 1. 什么时候才读它

**默认形态与它的判据**（`worktree-exec.md` §1/§2 迁来）：

- 满足其一即用 worktree（不需要全满足）：并行批次 **≥3 条文件不相交 issue**；需要**每条 issue 一个
  可独立验证的 commit**；共享工作区**已被证明会互相污染**。
- **提交不变量**（最硬的判据）：每个 commit **单独**跑 `check-types` / `test` 都绿——共享模式下要靠
  main 手工拆分才成立，worktree 模式下天然成立。
- 白名单不相交仍是前提：worktree 只隔离工作目录，**不隔离语义**（接口依赖照旧串行，见 `worktree-exec.md` §4）。
- 何时**不用**：单点改 / 只派一个子代理；同文件串行链（白名单相交）；本 plan 改的正是 worktree 能力本体；
  非 git 仓 / worktree 不可用；子代理需要 `build` / 全量 `lint` / `check-types` / `test:coverage` /
  重启 harness（全仓重命令归 main）。

**判据是事后定位**：撞上才回来读本文，**不做事前预检分流**（默认路径不预检、也不因为「可能失败」提前
退缩）。命中任一条即降级：

| 阻塞 | 表现 |
|---|---|
| worktree `create` 失败 / 不可用 | `git --version` < 2.5；`git worktree …` 报 `unknown subcommand` / `is not a git command`；沙箱直接拒绝该命令；本仓不是 git 仓 |
| merge 冲突 | `merge` 保留冲突态，冲突文件清单交回（§3.4） |
| 白名单相交 | 派发或 merge 时才发现两个节点的白名单有交集（§3.2） |
| 宿主 `subagent.maxDepth < 2` | 二级委派被拒，dev/test 对没法分两级（§3.3） |
| 共享生成物在批内竞争 | `dist/`、`coverage/`、lockfile、`CHANGELOG.md` |
| 本 plan 改的正是 worktree 能力本体 | 工具面 / `prune` 策略这类本体（§2 的例外） |

- 老 git 上 `worktree({action:"list"})` 返回空表属**正常**（真正的失败在 `create` 那步暴露，失败文案里
  带本机版本与本文件指针）；同一条版本判据也适用于 `remove`。
- 工作目录不可解析时**不许**静默落到主工作树（丢掉隔离却不告诉任何人）。

## 2. 偏离默认的记录义务

**默认 = 节点级 worktree 并行。一旦偏离，必须在 plan body 的 `## 并行批次` 段补三列：
`相交文件` → `合成哪个节点` → `为什么合并不了`。缺任一列即视为没做这一步。**

- 补三列前先**试重划节点**：把文件集相交的多条 issue **合并成一个节点**（例：同改
  `tests/unit/dag/dag-tool.test.ts` 的两条 issue 合成一个节点、「`dag-worktree.ts` 的四处改动」合成
  另一个），直到节点之间文件集两两不相交，再看这批能否并行。
- **合并后仍相交 → 才判串行**；批次表必须能说明「为什么无法重划」（哪条相交、合成哪个节点、为什么
  合并不了）。只写一句「文件相交 → 串行」视为**没做**这一步。
- **例外「被改特性本身就是隔离机制」必须点名理由才生效**：本 plan 改的正是 worktree 能力（工具面、
  `prune` 策略这类本体）时，隔离手段自身不可用（策略还没定型，也不该在定型前用它）——走**共享工作区 +
  一步一节点**是**预期而非缺陷**，在批次表里写明这条理由即可，不算判据失灵；**不点名理由不得以此
  关掉 worktree**。
- 三列不是事前预检分流，而是**事后定位**：撞上才回来读本文、才回来补记。

## 3. 各情形流程

### 3.1 worktree 不可用 → 共享工作区

- 子代理照旧**逐个派发**（一步一节点，**不并行**）；**仅当委派不可能**（宿主 `subagent.maxDepth = 0`，
  即委派被禁用）时才由 main 亲自依次执行，否则无论单批还是单节点都仍然逐个派子代理
  （`parallel-exec.md` §1）。批次表（`parallel-exec.md` §1）**仍然有效**：谁和谁可以并行的判据没变，
  变的只是执行方式；子代理照旧只改白名单内的文件。
- git 与一切 mint 写归 main：逐 issue `git add -- <白名单>` → commit → `state commit --sha`。
- 节点内 UT 由子代理在**主工作树**内跑**同一批文件**（命令形式见 `worktree-exec.md` §2）。
- 降级时**不许并行派发**（失去隔离后并行会互相污染，正是 worktree 要避免的事）。

### 3.2 白名单相交 → 先合并节点

按 §2 先合并节点（例：同改 `tests/unit/dag/dag-tool.test.ts` 的两条 issue 合成一个节点）；**合并后
仍相交才判串行**，并把三列写进批次表。

### 3.3 宿主 `subagent.maxDepth < 2` → dev/test 对同会话收尾

dev/test 对由**同一个子代理**收尾：先按 dev 白名单改码提交，再在**同会话**内只读自检（不再派二级子
代理）；回报**同一四行块**（`parallel-exec.md` §3.2）。恢复路径（设置里把最大递归深度改回 2）由插件在
`mint_plan_dag` 回答与 `[Mint]` 概览里给出。

### 3.4 merge 冲突 → 不裁决

工具保留冲突态并给出冲突文件清单与 `git merge --abort` 的收场路径；**由 main（或用户）决定怎么解，
不猜、不自动取一边**，把冲突文件清单交用户。常见根因是白名单判据没守住（同一文件被两节点改）→ 先回
`worktree-exec.md` §4 复核批次表。

### 3.5 降级时的收口

`state commit --sha` 取**目标分支**（开工时所在分支，`worktree.target`）上的 sha——worktree 模式下是
**merge 之后**的 sha，共享工作区降级下是 main 在该分支上提交/合并之后的 sha；worktree 分支自己的 sha
不算。两层测试（节点内 UT + 收口全量）与 `plan close` 照 `flow-impl.md` §4。
