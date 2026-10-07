# worktree 隔离并行执行（worktree-exec）

> 触发：并行批次需要「每条 issue 一个**独立可验证的 commit**」，或共享工作区已被证明互相污染。
> 命令全部走 `worktree` 工具（`action:"create"|"merge"|"list"|"remove"|"prune"`）；批次判据见 `parallel-exec.md` §1，
> 派发与等待纪律见 `parallel-exec.md` §3、§5；收口见 `flow-impl.md` §4；保留现场与开工点清理见本文件 §7。

默认的并行批次是**共享工作区**：子代理只改自己白名单内的文件，git 提交与一切 mint 写由主 agent
逐 issue 串行做（`parallel-exec.md` §4）。本文件是它的**例外口径**——把每个节点放进自己的 git
worktree，子代理**在自己的 worktree 内** commit，主 agent 收齐后**按 issue 顺序** merge。

**merge 目标 = 开工（建树）时所在的分支**，通常就是你正在开发的**功能分支**，不一定是 `main`/`master`：
plan 常在功能分支上执行，worktree 就从那个分支的 HEAD 切出，merge 也合回那里。工具在 `create` 时把
该分支记进节点的 `worktree.target`，`merge`/`remove` 都按它判定（§3.5 的校验、§5 的「已合并」判据）。

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
| 子代理需要 `build` / 全量 `lint` / `check-types` / `test:coverage` / 装依赖 / 重启 harness | worktree 内 pnpm 会触发重装且常在沙箱失败；这些重命令仍归主 agent（**节点内 UT 不在此列**，见下） |

- **worktree 里不跑重命令**：新工作目录没有 `node_modules`，pnpm / tsc / 全量 `lint` 会重新解析依赖
  （`build` / `test:coverage` / 装依赖 / 重启 harness 同理）；它们是**资源竞争源**，一律归主 agent
  在主工作树、**merge 之后**串行跑。
- **允许：节点内 UT**。子代理**在自己的 worktree 内**跑**该节点相关的 UT**——用**主仓的 vitest 二进制**，
  在该 worktree 目录内执行 `node <repo>/node_modules/vitest/vitest.mjs run <该节点的测试文件…>`
  （或 `<repo>/node_modules/.bin/vitest run …`）；配置取该 worktree 里的 `vitest.config.ts`。
  可行是因为 worktree 落在 `<repo>/.git/dsh-mint/worktrees/<session前8位>/<node>`，从它沿目录向上
  就能走到 `<repo>/node_modules`；万一在某台机器上解析不到，退路是在该 worktree 内
  `ln -s <repo>/node_modules node_modules`（该树位于 `.git` 内，这个 symlink 不会出现在 `git status` 里）。
  **为什么现在允许**：UT 贴着本次改动，成本低（只跑指定文件、秒级），能在 merge **之前**挡住红；
  真正吃资源的是上面那批重命令，它们与收口全量仍归主 agent。
- 无 git 仓或 worktree 不可用 → **回退现有共享模式**，不是放弃并行。

## 3. 全流程（工具形态）

    （开工点：prune 旧树）→ create → 派活（提示词含 worktree 路径）→ 子代理在 worktree 内 commit
    → 子代理在 worktree 内跑该节点 UT（绿）→ merge → issue state commit --sha →（保留现场，收尾不删）

1. **建 worktree（主 agent，派发前）**：`worktree({action:"create", node:"a1", base:"<sha>"})`
   - 落点 `.git/dsh-mint/worktrees/<session前8位>/<node>`（`<common-git-dir>` 内部，
     `git status` 不可见，**无需** `.gitignore` 条目）；分支 `dsh-mint/wt/<session前8位>/<node>`。
     仓里若残留旧的 `.worktrees/`（#177 之前），手工删掉即可。
   - **一批的多个节点必须显式传同一个 `base`**（不同 base 的 commit 无法按序 merge）；
     `base` 取开工点的 `git rev-parse HEAD`。工具只校验 `base` 是本仓的 commit，
     **不会替你比对两个节点是否同 base**，这条靠口径守。
   - `create` 幂等：路径已是本仓注册的 worktree 就原样返回，重跑不重复建。
   - `create` 同时记下**开工时所在的分支**（`worktree.target`）：它就是该节点的 merge 目标，
     后续 merge/remove 都按它判定（§3.5/§5）。detached HEAD 下记成 `HEAD`，此时不校验。
   - 先 `set` 该节点 `running`（见 `plan-dag.md` §4.1），再 create，再派活。
2. **派活（一批在同一条 assistant message 里批量发）**：提示词五段不变（`parallel-exec.md` §3），
   **必须写明该节点自己的 worktree 路径**，并写明「在本 worktree 内 `git add` / `git commit`」。
   漏写路径 = 子代理在主工作树上改，隔离失效。
3. **子代理在自己的 worktree 内 commit**：
   - 允许：在**其 worktree 内** `git add` / `git commit`；commit message **以 `#<issue-id>` 起头**。
   - 仍禁止：`issue state`（一切 mint 写）、`build` / 全量 `lint` / `check-types` / `test:coverage` /
     装依赖 / 重启 harness、碰主工作树与别人的 worktree。
   - 一个 issue 多个 commit 也可以；merge 后 `state commit` 只登记最后一个 sha。
4. **子代理在自己的 worktree 内跑该节点 UT**（逐个节点，交回前）：
   - 在该 worktree 目录内跑 §2 那条命令（主仓 vitest + 该节点的测试文件），回报里给出**命令与输出摘要**。
   - **红了先在本树内修**（改码 → 补 commit → 重跑），修绿再交回；**不要**带红 merge——带上红 merge，
     单点红就混进收口全量里，定位成本高得多（§6、`flow-impl.md` §4）。
   - 只跑该节点的 UT：全量 `test:coverage` 与 `build` 仍归主 agent（§2）。
5. **merge（主 agent，收齐后）**：`worktree({action:"merge", node:"a1"})`
   - 合回**建树时所在的分支**（目标分支），不是无条件合回 `main`；仅当该分支的工作树**干净**时执行
     （`git merge --no-ff`）；**按 issue 顺序** merge（不是完成先后）。
   - **工具会校验**：当前 checkout 的分支必须 == 该节点 `create` 时记录的分支（`worktree.target`），
     不一致**直接拒绝**（不执行 merge），并给出「先 `git checkout <建树时的分支>` 再 merge（或重建该节点的
     worktree）」；缺记录（#189 之前的旧节点）与 detached HEAD 不做该校验。
   - 冲突不裁决（§5）。进度查看：`worktree({action:"list"})`。
6. **登记 sha（merge 之后）**：`mint({ args: ["issue","state","commit","<id>","--sha","<目标分支上的 sha>"] })`
   - sha 必须是**该目标分支 merge 后**的 sha（`git rev-parse --short=7 HEAD`，即在目标分支的工作树里读），
     不是 worktree 里的 sha。
7. **收尾不清理**：本批的树**保留现场**（§7）——要立刻丢掉某一棵才用
   `worktree({action:"remove", node:"a1"})`（未合并默认拒绝）。旧树由**下一次开工点**的
   `worktree({action:"prune"})` 按规则收。

## 4. 与文件白名单/串行判据的关系

- 判据**没有放松**：任一文件出现在**两个节点的白名单**里，两节点仍然**串行**（`parallel-exec.md` §1），
  不许以「worktree 里改的是不同目录」为由并进同一批。
- worktree 只给**已经判定可并行**的批次加一层目录隔离；语义依赖（B 的接口由 A 决定）照旧串行。
- plan body 的 `## 并行批次` 段照旧产出：worktree 是执行方式，不是新的批次维度。

## 5. 冲突与收尾

- **冲突不自动裁决**：merge 冲突时工具保留冲突态，给出冲突文件清单与 `git merge --abort` 的收场路径；
  由主 agent（或用户）决定怎么解，不猜、不自动取一边。
- 冲突的常见根因是白名单判据没守住（同一文件被两节点改）→ 先回 §4 复核批次表，再决定是否人工合并。
- worktree 落在 `<common-git-dir>` 内的 `dsh-mint/worktrees/`，`git status` 看不见它，**不需要**
  `.gitignore` 条目；旧的 `.worktrees/` 条目可以删掉（残留目录手工删）。
- **`plan close` 后保留现场，不清理**：收尾时**不**逐棵 `remove`，树原地留着（理由见 §7）。
  下一次开工点第一步用 `worktree({action:"prune"})` 按规则清理旧的；显式丢弃某一棵才用
  `remove`。`remove` 按记录的**目标分支**（`worktree.target`）判「已合并」，拒绝**尚未合并进该分支**
  的分支（避免丢掉唯一 checkout）：确认要丢弃才 `force:true`；`remove` 与 `prune` 都只删工作树、
  **不删分支**（分支可留可删，不删也不影响目标分支）。
- 两层测试与 `plan close` 照 `flow-impl.md` §4：各节点在自己的 worktree 内先跑该节点 UT（§2/§3），
  全部 merge 进目标分支后主 agent 在**主工作树**跑一次完整测试 → close（各 issue 停在 `test`）。

## 6. 与共享模式对照

| | 共享工作区（默认） | worktree 隔离（本文件） |
|---|---|---|
| 子代理改文件 | 主工作树 | 自己的 worktree |
| commit | 主 agent 逐 issue `git add -- <白名单>` | 子代理在 worktree 内 commit（`#<id>` 起头） |
| 主 agent | 直接 commit → `state commit` | `merge` → `state commit --sha <目标分支 sha>` |
| 适用 | 任意可并行批次 | ≥3 条独立 issue / 强要求一 issue 一 commit |
| 测试命令 | 主 agent | 节点内 UT 归子代理（用主仓 vitest，§2/§3）；`build` / 全量 `lint` / `test:coverage` 归主 agent |

## 7. 保留现场与开工点清理

**`plan close` 不清理 worktree**；旧树由**下一个开工点**的 `worktree({action:"prune"})` 按规则收。
这是有意选择的三段式：现场留着 → 开工点收旧的 → 本批再建新的。

① **为什么保留**：merge 进目标分支只说明「代码合了」，不代表「现场不再需要」。收尾之后常见两件事
仍需那棵树——回看这个节点到底改了什么（`git diff` 的主工作树版本已被后续提交冲淡）、以及回改
（`plan` 的 issue 被 `retest` 打回、或复查发现漏改）。`plan close` 那一刻正是最后一次会看它的时候，
在那里删掉等于把现场销毁；而树留在 `<common-git-dir>` 内，不进 `git status`，也不占主工作树。

② **为什么在开工点清**：留着不收会越积越乱（每批都多几棵，`list` 一屏放不下、名字相近易混）；
但也不该过早清（见 ①）。开工点是唯一自然的重置时刻：上一批已完全结束、这一批还没建，清掉旧的
正好给新树腾出干净的起点，也不会误删这一批正在用的树。

③ **三条保护**（任一命中即保留，`prune` 按顺序判）：**未合并**（分支还没进当前 HEAD，删了就只剩
分支可救）、**有未提交改动**（树里还有没 commit 的活）、**不到 1 小时**（刚建/刚动过，人可能还在看）。
年龄取「树目录 mtime 与分支头提交时间」的**较大者**；目录读不到（已被手工删）时按「年龄不可测」保留。
判定够格而 git 仍拒绝（权限等）时记「删除失败」并保留，**绝不 `--force`**。

④ **不删分支**：`prune` 只删工作树，分支一律留着——分支是回退与复看的唯一凭据，删树不等于丢工作。
`git worktree prune` 只清孤儿元数据（目录被手工删过时残留的登记），同样不动分支。

⑤ **怎么读输出**：首行 `prune：删除 N 棵，保留 M 棵；`，其下每棵一行——
`removed <会话前8位>/<节点> · <分支>` 或 `kept <会话前8位>/<节点> · <分支> · <原因>`，
原因是 `未合并 | 有未提交改动 | 不到 1 小时 | 年龄不可测 | 删除失败`。一条都没有时输出
`本仓没有可清理的 dsh-mint worktree`（空仓不是错误）。**`prune` 是仓库级动作**：它扫命名空间内的树，
不读 DAG、不需要节点、也不限于本会话；要立刻丢掉某一棵仍然用 `remove(node)`（可 `force:true`）。

## 8. 降级：worktree 不可用

- **判据**：`git --version` < 2.5，或 `git worktree …` 报 `unknown subcommand` / `is not a git command`，
  或沙箱直接拒绝该命令。**默认路径仍是 worktree**：不预检、也不因为「可能不行」提前退缩，**失败才降级**
  （工具在 `worktree add` / `worktree remove` 的失败文案里带上本机版本与本节指针，老 git 上
  `worktree({action:"list"})` 返回空表属正常——真正的失败在 `create` 那步暴露）。
- **动作**：回退共享工作区——子代理照旧执行，但 main **逐个派发**（一步一节点，不并行）；或 main 亲自依次
  执行（伪 DAG）。批次表（`parallel-exec.md` §1）**仍然有效**：谁和谁可以并行的判据没变，变的只是执行方式；
  子代理照旧只改白名单内的文件。
- **收口**：`state commit --sha` 取**主工作树（目标分支）**merge 后的 sha（降级时 = main 直接在该分支上
  为每个 issue 提交的 sha）；与 worktree 模式的差别只有「没有隔离目录」，两层测试（节点内 UT + 收口全量）
  与 `plan close` 照 `flow-impl.md` §4。
- **禁止**：目录不可解析时**不许**静默落到主工作树（丢掉隔离却不告诉任何人）；降级时**不许**并行派发
  （失去隔离后并行会互相污染，正是本文件要避免的事）。
