# worktree 隔离并行执行（worktree-exec）

> 触发：并行批次需要「每条 issue 一个**独立可验证的 commit**」，或共享工作区已被证明互相污染。
> 命令全部走 `mint_plan_dag` 工具（`action:"wt"` / `action:"merge"`）；批次判据见 `parallel-exec.md` §1，
> 派发与等待纪律见 `parallel-exec.md` §3、§5；收口见 `flow-impl.md` §4。

默认的并行批次是**共享工作区**：子代理只改自己白名单内的文件，git 提交与一切 mint 写由主 agent
逐 issue 串行做（`parallel-exec.md` §4）。本文件是它的**例外口径**——把每个节点放进自己的 git
worktree，子代理**在自己的 worktree 内** commit，主 agent 收齐后**按 issue 顺序** merge。

代价与收益：多一条 merge 环节（冲突要人裁决），换来「一 issue 一 commit、可单独验证」与
「兄弟子代理绝不碰同一个工作目录」。

## 1. 何时用

满足其一即可（不需要全满足）：

| 判据 | 共享模式下为什么不行 |
|---|---|
| 并行批次 **≥3 条互不相交 issue** | 主 agent 要逐条 `git add -- <白名单>` 拆提交，条数一多极易夹带 |
| 需要**每条 issue 一个可独立验证的 commit** | 共享工作区的中间态混在一起，单个 commit 验不出单条 issue 的绿 |
| 共享工作区**已被证明会互相污染** | 宿主不串行化保护兄弟子代理（`parallel-exec.md` §6），污染只能事后发现 |

- **提交不变量**（最硬的判据）：每个 commit **单独**跑 `check-types` / `test` 都绿。
  共享模式下这条不变量要靠主 agent 手工拆分才成立，worktree 模式下天然成立。
- 白名单不相交仍是前提：worktree 只隔离工作目录，**不隔离语义**（接口依赖照旧串行，见 §4）。

## 2. 何时不用

| 情形 | 为什么 |
|---|---|
| 单点改 / 只派一个子代理 | 建 worktree + merge 的成本高于收益 |
| 同文件串行链（白名单相交） | 串行判据与 worktree 无关，见 `parallel-exec.md` §1 |
| 非 git 仓 / worktree 不可用 | 回退共享模式，本节不成立 |
| 子代理需要 `build` / `check-types` / `test:coverage` | worktree 内 pnpm 会触发重装且常在沙箱失败；重命令仍归主 agent |

- **worktree 里不做重命令**：新工作目录没有 `node_modules`，pnpm/tsc/vitest 会重新解析依赖；
  子代理自检只用只读命令（`read` / `grep` / `git status`），统一 `check-types` / `test`
  由主 agent 在主工作树、**merge 之后**串行跑。
- 无 git 仓或 worktree 不可用 → **回退现有共享模式**，不是放弃并行。

## 3. 全流程（工具形态）

    create → 派活（提示词含 worktree 路径）→ 子代理在 worktree 内 commit
    → merge → issue state commit --sha → wt remove

1. **建 worktree（主 agent，派发前）**：`mint_plan_dag({action:"wt", op:"create", node:"a1", base:"<sha>"})`
   - 落点 `.worktrees/<session前8位>/<node>`；分支 `dsh-mint/wt/<session前8位>/<node>`。
   - **一批的多个节点必须显式传同一个 `base`**（不同 base 的 commit 无法按序 merge）；
     `base` 取开工点的 `git rev-parse HEAD`。工具只校验 `base` 是本仓的 commit，
     **不会替你比对两个节点是否同 base**，这条靠口径守。
   - `create` 幂等：路径已是本仓注册的 worktree 就原样返回，重跑不重复建。
   - 先 `set` 该节点 `running`（见 `plan-dag.md` §4.1），再 create，再派活。
2. **派活（一批在同一条 assistant message 里批量发）**：提示词五段不变（`parallel-exec.md` §3），
   **必须写明该节点自己的 worktree 路径**，并写明「在本 worktree 内 `git add` / `git commit`」。
   漏写路径 = 子代理在主工作树上改，隔离失效。
3. **子代理在自己的 worktree 内 commit**：
   - 允许：在**其 worktree 内** `git add` / `git commit`；commit message **以 `#<issue-id>` 起头**。
   - 仍禁止：`issue state`（一切 mint 写）、`build` / `test:coverage`、碰主工作树与别人的 worktree。
   - 一个 issue 多个 commit 也可以；merge 后 `state commit` 只登记最后一个 sha。
4. **merge（主 agent，收齐后）**：`mint_plan_dag({action:"merge", node:"a1"})`
   - 仅当主工作树**干净**时执行（`git merge --no-ff`）；**按 issue 顺序** merge（不是完成先后）。
   - 进度查看：`mint_plan_dag({action:"wt", op:"list"})`。
5. **登记 sha（merge 之后）**：`mint({ args: ["issue","state","commit","<id>","--sha","<主分支上的 sha>"] })`
   - sha 必须是**主分支 merge 后**的 sha（`git rev-parse --short=7 HEAD`），不是 worktree 里的 sha。
6. **清理**：`mint_plan_dag({action:"wt", op:"remove", node:"a1"})`（收尾见 §5）。

## 4. 与文件白名单/串行判据的关系

- 判据**没有放松**：任一文件出现在**两个节点的白名单**里，两节点仍然**串行**（`parallel-exec.md` §1），
  不许以「worktree 里改的是不同目录」为由并进同一批。
- worktree 只给**已经判定可并行**的批次加一层目录隔离；语义依赖（B 的接口由 A 决定）照旧串行。
- plan body 的 `## 并行批次` 段照旧产出：worktree 是执行方式，不是新的批次维度。

## 5. 冲突与收尾

- **冲突不自动裁决**：merge 冲突时工具保留冲突态，给出冲突文件清单与 `git merge --abort` 的收场路径；
  由主 agent（或用户）决定怎么解，不猜、不自动取一边。
- 冲突的常见根因是白名单判据没守住（同一文件被两节点改）→ 先回 §4 复核批次表，再决定是否人工合并。
- `.worktrees/` **必须**在 `.gitignore` 里：它是本地执行产物，不能进主分支、也不能被 `git add` 夹带。
- **`plan close` 后清理 `active` worktree**：逐个 `op:"remove"`，`wt list` 不应再剩 `active` 项。
  `remove` 拒绝**尚未合并进主线**的分支（避免丢掉唯一 checkout）：确认要丢弃才 `force:true`；
  它只删工作树、不删分支（分支可留可删，不删也不影响主分支）。
- 统一测试与 `plan close` 照 `flow-impl.md` §4：各 issue 停在 `test` → 主工作树统一跑 → close。

## 6. 与共享模式对照

| | 共享工作区（默认） | worktree 隔离（本文件） |
|---|---|---|
| 子代理改文件 | 主工作树 | 自己的 worktree |
| commit | 主 agent 逐 issue `git add -- <白名单>` | 子代理在 worktree 内 commit（`#<id>` 起头） |
| 主 agent | 直接 commit → `state commit` | `merge` → `state commit --sha <主分支 sha>` |
| 适用 | 任意可并行批次 | ≥3 条独立 issue / 强要求一 issue 一 commit |
| 重命令 | 主 agent | 主 agent（worktree 内不跑） |
