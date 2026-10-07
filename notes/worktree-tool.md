# worktree 工具规格真源（`worktree`）

> 范围：宿主工具 `worktree`（`src/dag/worktree-tool.ts`）+ git 层
> （`src/dag/dag-worktree.ts`）+ 节点记录 `worktree`（`src/dag/dag.ts` 的
> `checkWorktree`）+ skill 侧流程 `skill/references/worktree-exec.md`。
> 本文件是**将来实现会话的规格真源**：只写事实与规格，不含实现代码（字段示例除外）。
> DAG 文档本身的契约见 [plan-dag.md](plan-dag.md)；客户端面板见 [client-face.md](client-face.md)。

## 0. 为什么独立成工具

worktree 动作原先挂在 `mint_plan_dag` 的 `action:"wt"` / `action:"merge"` 上。拆开的理由是
两族动作回答的问题不同：

- DAG 工具改的是一份 `/tmp` 下的小文档，每个动作都是**按会话加锁的读-改-写**；
- worktree 动作 spawn git、动真实文件系统，只把**结果**记到节点上；`list` 更是**仓库级**
  问题，不读 DAG、也不需要节点。

合在一起时，一份 schema 要同时装两套词汇（`op` 与 `action`、节点字段与 git ref），
一份描述要同时给两族动作排版面。拆开后 `mint_plan_dag` 只剩四个图动作，worktree 的四条
规则各自写清楚。旧调用（`action:"wt"`/`"merge"`）在 DAG 工具一侧得到**可行动的拒绝**
（点名新工具），不是含混的「action 不认识」。

## 1. 工具面

- 工具名 `worktree`；注册在**宿主 root ctx**（与 `mint`/`mint_plan_dag` 同席位）：零授权、
  插件进程内执行、子代理继承。
- 输出前缀 `[worktree] `；拒绝一律 `[worktree] 拒绝：<可行动文案>`。
- 返回值只给摘要（单棵 1–3 行；仓库级的 `list`/`prune` 最多 20 行 + 一行计数），
  不回灌全图、不贴 git 全量输出。

参数与动作（`parseWorktreeAction` 校验，非法组合给明确拒绝）：

| 动作 | 参数 | 语义 |
| --- | --- | --- |
| `create` | `node`（必需）、`base`（可选） | 从 `base`（缺省 HEAD）建节点分支与工作树，并把**当前分支**记成该节点的 `worktree.target` |
| `list` | 无 | 仓库级清单（见 §3），**不读 DAG、不需要节点** |
| `merge` | `node`（必需） | 把节点分支合回它记录的**目标分支** |
| `remove` | `node`（必需）、`force`（可选，布尔） | 清理工作树；**未合并默认拒绝** |
| `prune` | 无 | 仓库级按规则清理旧树（见 §5），**不读 DAG、不需要节点** |

- **非法组合**：`该动作需要 node`（create/merge/remove 缺 node）、`prune 不接受 node`、
  `base 只用于 create`、`force 只用于 remove`、`base 必须是非空字符串（commit / ref）`、
  `base 含控制字符`、`force 必须是布尔值`、`节点不存在：<id>`。节点 id 的校验复用 `dag.ts` 导出的
  `checkNodeId`（一份规则，不复制）。
- **`create`/`merge`/`remove` 需要本会话的 DAG 与节点**：没有文档 → 拒绝并提示先
  `mint_plan_dag({action:"init"})`（worktree 不进图就等于后面的收尾看不见它）；节点不存在 →
  拒绝。`repo`（仓库根）取**根会话**的 `session.header.cwd`；拿不到 → 拒绝并说明 worktree
  需要 git 仓库。
- **`list`/`prune` 是仓库级动作**：不读 DAG、不需要 session / 节点（`session` 传空串，路径与分支
  的 session 段来自 git 自己的登记），拿不到 `repo` 同样拒绝。

## 2. 落点与记录

- 落点 `<common-git-dir>/dsh-mint/worktrees/<session前8位>/<node>`，分支
  `dsh-mint/wt/<session前8位>/<node>`（`WORKTREE_SUBDIR` / `DEFAULT_WORKTREE_BRANCH_PREFIX`）。
  落在 git 公共目录内部，所以 `git status` 看不见它，**不需要** `.gitignore` 条目。
- 每个动作成功后把完整的 `DagWorktree` 记录写回该节点：`updateDag` + `revision + 1`
  （沿用既有 `persist` 手法——先做 git、再落盘，git 被拒时文档里不会留下半个声明）。
  字段：`path` / `branch` / `base` / `state`（`active`|`merged`|`conflict`|`removed`）/
  `merged_sha?` / `target?`。
- **`create` 记录 `target` = 当前分支**（开工时所在分支）。契约「merge 目标 = 建树时所在分支」
  就落在这个字段上：写它的是 `create`，用它的是 `merge`/`remove`（由工具层从节点记录带出，
  注入 git 层的 `WorktreeDeps.target`）。detached HEAD 时记成字面 `HEAD`，该值视为
  「无可校验」。
- **`merge` 校验目标分支**：当前 checkout 的分支必须 == 记录里的 `target`，不一致**直接拒绝**
  （不执行 merge），文案同时点名两个分支并给「先 `git checkout <建树时的分支>` 再 merge（或
  重建该节点的 worktree）」。缺记录（旧节点）与 detached 不做校验，避免旧 DAG 突然不可合并。
- **`merge` 冲突不裁决**：`git merge --no-ff` 停在冲突态，回传冲突文件清单与
  `git merge --abort` 的收场路径，并把 `state:'conflict'` + 完整的 `path`/`branch`/`base`
  落盘（空 `base` 会让整份 DAG 下次读取变成 unreadable——#177 的回归钉）。
- **`remove` 的未合并拒绝**：判据是 `merge-base --is-ancestor <branch> <target>`；不成立即
  拒绝，文案给 `force:true` 的出路。缺记录时 `target` 取**当前分支**（读不到才落字面
  `HEAD`，且不把它说成分支名）。`remove` 只删工作树，**不删分支**。

## 3. `list`：仓库级输出与解析

输出每行（`listLine`）：

```
  <session前8位>/<node> · <branch> · merged|unmerged · <tip 提交 ISO 时间> · <绝对路径>
```

- 最多 **20 行**，超出追加一行 `  …还有 N 条`；一条都没有时输出 `本仓还没有 dsh-mint worktree`。
- detached 的分支位写 `(detached)`，时间读不到写 `?`（格式不塌）。
- 数据来自 `git worktree list --porcelain` 的**分块解析**（`installedWorktrees(deps)`，
  `src/dag/dag-worktree.ts`）：
  - 块内字段：`worktree <path>` / `HEAD <sha>` / `branch refs/heads/<name>` / `detached` /
    `prunable`；`branch` 去掉 `refs/heads/` 前缀。
  - **只保留命名空间内的项**：路径必须正好是 `<commonGitDir>/dsh-mint/worktrees/<一层>/<一层>`
    （少一层 = 会话目录本身，多一层 = 别人的目录）。用户在仓里手工建的普通 worktree 不是本
    工具的东西，**不得**出现在清单里。
  - `session` = 路径的父目录名、`node` = 末段名。
  - `merged` = `merge-base --is-ancestor <branch> HEAD` 成功（与 `remove` 的收尾判据同源）。
    **刚建出来的树就在 HEAD 上，所以显示为 `merged`**——这是定义的结果，不是 bug：
    「unmerged」= 分支有自己的 commit。
  - `tipIso` = `git log -1 --format=%cI <branch>`（提交时间；失败给 `''`）。
  - 明细读不到就是 `false`/`''`，绝不让整张清单落空；`list` 自身从不报错，空仓也是 `ok`。
  - **按 `path` 排序后才返回**：`git worktree list` 的顺序随创建次序变，输出进模型上下文，
    同一状态必须给同一串行。
- 老 git（< 2.5）不认 `worktree` 子命令 → 空表（**真正的失败在 `create` 那步带降级文案暴露**）。

## 4. 失败与降级

- `worktree add` / `worktree remove` 失败时追加**单行**降级指引：本机 git 版本
  （`git --version`，读不到写「git 版本未知」）+ 「worktree 需要 git ≥ 2.5」+ 唯一可行动作
  「改走共享工作区**串行**：main 逐个派发子代理（一步一节点）或亲自依次执行」+ skill 指针。
  只在**失败之后**查版本（happy path 不付这次进程开销）。
- **绝不静默回落主工作树**：路径解析失败原样报错，丢了隔离必须让人知道。
- 本共享工作区里 worktree 是**串行资源**：`create`/`merge`/`remove` 只有 main agent 调，
  一步一节点派发、同批同 `base`（口径见 `skill/references/worktree-exec.md`）；`prune` 同样是
  main agent 在**开工点单独**跑的一次动作，不与建树/合并并发。

## 5. `prune`：开工点按规则清理（保留现场的收尾）

**口径**：worktree **保留现场**——`plan close` 不清理（`remove` 只在有人显式点名时用），旧树由
下一个**开工点**的 `prune` 收（为什么见 `skill/references/worktree-exec.md` §7）。`prune` 与 `list`
同为**仓库级**动作：不读 DAG、不需要 session / 节点，扫的是 git 自己登记的树。

判据按顺序短路，**任一命中即保留**并记因（决不从 `--force` 找补）：

| 顺序 | verdict | 判据 | 动作 |
| --- | --- | --- | --- |
| 1 | `unmerged` | `merge-base --is-ancestor <branch> HEAD` 失败；`branch` 为空（detached）同样算 | 保留 |
| 2 | `dirty` | 在该树路径下跑 `status --porcelain`，输出非空（**绝不 `--force`**，命令本身也会拒） | 保留 |
| 3 | `recent` | 年龄 < `minAgeMs`（缺省 `WORKTREE_MIN_AGE_MS = 3_600_000`，即 1 小时） | 保留 |
| 4 | `unmeasured` | 树目录 `statSync` 失败（已被手工删/权限），年龄无从判定 | 保留（宁可不删） |
| — | `removed` | 已合并 + 干净 + 够老 → `git worktree remove <path>`（**不带 `--force`**）成功 | 删树 |
| — | `failed` | 判定够格但 `worktree remove` 失败（错误不抛，记因保留） | 保留 |

- **年龄** = `nowMs`（缺省 `Date.now()`）− **max(树目录 `statSync(path).mtimeMs`, 分支头提交时间)**
  （`git log -1 --format=%ct <branch>` × 1000）；分支读不到时只用目录 mtime。取较大者是判据本身：
  只按 mtime 会让刚 checkout 过的旧树永远显新，只按提交时间会让「提交很早但刚才还在动」的树显老。
- **不删分支**：`prune` 只删工作树，分支一律留着（回退与复看的唯一凭据）；扫描结束后跑一次
  `git worktree prune` 清**孤儿元数据**（目录被手工删过时的残留登记，失败忽略）——它同样不动分支。
- **只碰命名空间内的树**：处理范围就是 `installedWorktrees(deps)` 返回的那批
  （`<commonGitDir>/dsh-mint/worktrees/<session8>/<node>`，正好两层深）。主工作树与用户在仓里手工建的
  普通 worktree **一律不碰**（与 §3 的过滤同源，一处收口）。
- **接口**：`pruneWorktrees(deps, { nowMs?, minAgeMs? })`（`src/dag/dag-worktree.ts`）→
  `PruneResult[]`（`{ path, session, node, branch, verdict }`，按 `path` 排序）；两个 option 只为测试存在。
- **输出**（`executeWorktreeTool` 的 `prune` 分支，总行数上限 20，超出追加 `  …还有 K 条`）：

  ```
  prune：删除 N 棵，保留 M 棵；
    removed <session前8位>/<node> · <branch>
    kept <session前8位>/<node> · <branch> · <原因>
  ```

  原因文案：`未合并 | 有未提交改动 | 不到 1 小时 | 年龄不可测 | 删除失败`。
  一条都没有（含空仓）时输出 `本仓没有可清理的 dsh-mint worktree`，仍是 `ok`。

## 6. 落点与测试

| 层 | 文件 |
| --- | --- |
| 工具面 | `src/dag/worktree-tool.ts`（`TOOL_NAME`/`WORKTREE_TOOL_DESCRIPTION`/`parseWorktreeAction`/`executeWorktreeTool`/`installWorktreeTool`；注册器与执行器分离） |
| git 层 | `src/dag/dag-worktree.ts`（`worktreeRoot`/`worktreePath`/`worktreeBranch`/`createWorktree`/`mergeWorktree`/`removeWorktree`/`installedWorktrees`/`pruneWorktrees`/`WorktreeDeps`） |
| 文档记录 | `src/dag/dag.ts`（节点 `worktree` 字段的读写校验 `checkWorktree`）、`src/dag/dag-store.ts`（`updateDag`） |
| 会话身份 | `src/shared/session-id.ts`（`sessionIdOf` / `rootSessionId`，两个工具共用） |
| 挂载 | `src/index.ts`（`installWorktreeTool(ctx)` 在 `installDagTool(ctx)` 旁） |
| 收尾提醒 | `src/dag/dag-worktree-sweep.ts`（`plan close` 后点名还在盘上的树，说明**保留现场** + 下一个开工点的 `prune`） |
| skill | `skill/references/worktree-exec.md`（唯一一份操作指南；保留现场与开工点清理见 §7） |

测试：

- `tests/unit/dag/worktree-tool.test.ts`：工具面全动作（create/幂等/未知节点/坏 action/无 DAG/
  无 repo/merge 与 sha/冲突落盘/remove 与 force/target 守卫/list 三态/20 行截断/prune 空仓与
  「做旧的删、未合并的留」），全部对**真实临时仓**跑生产 `runGit`，写盘落
  `mkdtempSync(tmpdir()…)`；做旧靠提交时 `GIT_*_DATE` + 树目录 `utimesSync`。
- `tests/unit/dag/dag-worktree.test.ts`：git 层域逻辑（含老 git 假 runner 的降级文案），
  以及 `pruneWorktrees` 的五个 verdict 分支（removed/unmerged/dirty/recent/unmeasured）。
- `tests/unit/dag/dag.test.ts`：节点 `worktree` 字段（含 `target`）的读写校验，以及
  `wt`/`merge` 两个老 action 被**重定向**的拒绝文案。
- `tests/guard/injection-size.test.ts`：`WORKTREE_TOOL_DESCRIPTION` 的每请求字节预算。
