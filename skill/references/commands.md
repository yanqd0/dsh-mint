# mint 命令参考（经 `mint` 工具调用）

> 标题/body 模板：`title-templates/` + `body-templates/`。
> **所有命令都经宿主工具 `mint` 调用**，本文写作 `mint({ args: [...] })`。
> 输出默认是 **TSV**（不是 JSON）；需要结构化才显式加 `--json`。
> 分页页脚是 `# Page x/y (N per page, M total)`，**写在 stdout**；`--no-page` 忽略分页。
> 任意子命令加 `--help` 查完整参数。`--help-llm` 是一页速查，但**会漏掉名为 `version` 的参数**
> （`milestone create/set --version`）——以 `--help` 为准。`-V` 带 build SHA（区分同版本不同构建）。

## add

```js
mint({ args: ["issue","add","标题",
  "--body","详细描述",
  "--kind","problem",
  "--priority","0",
  "--label","bug,firefox"] })
mint({ args: ["issue","add","标题","--force-new"] })   // 跳过去重，强制新建
```

- 去重：同项目标题模糊匹配，命中即**合并**（`hit_count+1`、label 并入）并提示 `Merged into issue #N`。
  合并**不可逆**；确认是不同 issue 时用 `--force-new`。
- 候选**只含 `plan_id=null` 的活跃 issue**：已挂 plan 的 issue 不参与自动去重 → 拆 phase 前人工比对标题。

## list（默认每页 5 条）

```js
mint({ args: ["list"] })                                   // 活跃 issue（TSV，≤5 条）
mint({ args: ["list","--all-states"] })                    // 含 done/dropped
mint({ args: ["list","--status","open","--priority","0"] })// 按状态+优先级筛选
mint({ args: ["list","--kind","requirement","--plan","7"] })// 按 kind / plan 筛选
mint({ args: ["list","--milestone","5"] })                 // 按有效 milestone 过滤（直接挂，否则所属 plan 的）
mint({ args: ["list","--label","host"] })                  // 按 label 筛选
mint({ args: ["list","--created-after","2026-08"] })       // 时间前缀：2026 / 2026-08 / 2026-08-10
mint({ args: ["list","--updated-after","2026-08-10"] })
mint({ args: ["list","--search","登录"] })                  // 文本过滤（title/body/status/id/kind/label 子串）
mint({ args: ["list","--page","2"] })                      // 翻页
mint({ args: ["list","--page-size","20"] })                // 每页 20
mint({ args: ["list","--no-page"] })                       // 全部列出（忽略分页）
mint({ args: ["plan","list","--milestone",""] })            // 空串 = 筛未挂 milestone 的 plan
mint({ args: ["plan","list","--milestone","5","--status","running"] })
```

TSV 列：`ID P Kind Status Title Labels Plan Updated`（`Plan` 形如 `#12`）。

## show / get

```js
mint({ args: ["show","42"] })   // TSV 列：ID Status Kind Priority Title Plan Milestone Labels TestCmd Dropped Commit Links Created Updated Body
mint({ args: ["issue","get","42","body"] })   // body 原文（裸值，换行/格式原样）
mint({ args: ["issue","get","42","title"] })  // 任意字段：title/status/priority/labels/test_cmd/plan_id/…
mint({ args: ["issue","get","42","milestone"] }) // 有效 milestone id（直接挂优先，否则所属 plan 的）
mint({ args: ["plan","get","12","body"] })
mint({ args: ["milestone","get","8","body"] })
mint({ args: ["issue","get","42","body","--json"] }) // 结构化 {"id","field","value"}
```

> **取 body 优先走 `get body`**：裸值最准。`show` 的 TSV 已含状态/标题/优先级等；
> 需要详情正文时用 `get body` 即可，不必 show。

容器反向查询（provenance：issue 从哪来、容器下有哪些 issue）：

```js
mint({ args: ["list","--milestone","5"] })            // 该 milestone 下的 issue（有效归属）
mint({ args: ["plan","show","12","--json"] })         // JSON 含 "issues":[...]
mint({ args: ["milestone","show","4","--json"] })     // JSON 含 "issues":[...]
```

## search

```js
mint({ args: ["search","登录"] })                        // ≤2 字符走 LIKE 兜底
mint({ args: ["search","priority dependency","--status","open"] })
mint({ args: ["search","keyword","--label","bug","--priority","0"] })
```

容器（plan/milestone）文本过滤用 list 的 `--search`：

```js
mint({ args: ["plan","list","--search","0.5.0"] })
mint({ args: ["milestone","list","--search","running"] })
mint({ args: ["plan","list","--search","#7"] })   // 按 id 过滤
```

## state（逐态推进）

```js
mint({ args: ["issue","state","plan","42"] })                     // open → planned
mint({ args: ["issue","state","start","42"] })                    // planned → dev（task: planned → test）
mint({ args: ["issue","state","commit","42","--sha","abc1234"] }) // dev → test
mint({ args: ["issue","state","close","42","--test-cmd","pnpm test"] }) // test → done
mint({ args: ["issue","state","retest","42","--test-cmd","pnpm test x"] }) // test → dev（测试失败打回）
mint({ args: ["issue","state","drop","42","--reason","不再需要"] })
mint({ args: ["issue","state","reopen","42"] })                   // done/dropped → open
mint({ args: ["issue","state","reset","42"] })                    // planned/dev/test → open
```

- `commit` 的 `--sha` **可省略**（默认当前 HEAD；非 git 目录必须显式给），
  `--test-cmd` 为可选信息项（登记测试命令，不改变状态）。
- 推荐仍显式传 sha：先用 bash `git rev-parse --short=7 HEAD` 取值。
- 详细状态机与硬约束见 `state-machine.md`。

## set / label / link

```js
mint({ args: ["issue","set","42","--title","新标题"] })
mint({ args: ["issue","set","42","--priority","1"] })
mint({ args: ["issue","set","42","--body","新 body"] })          // 整体替换；空串清空
mint({ args: ["issue","set","42","--body-append","追加一块"] })   // 尾部追加（不改旧内容）
mint({ args: ["issue","set","42","--body-file","/tmp/new.md"] }) // 从 UTF-8 文件读新 body
mint({ args: ["issue","set","42","--body-section","验证","--body","新内容"] })
// --body-section：按 ATX 标题精确匹配替换该节（保留标题行）；标题不存在报 section not found，不隐式新增

mint({ args: ["label","list","--all-states"] })            // 全部 label（含关联数 + 颜色）
mint({ args: ["label","set","docs","--color","#0075ff","--description","文档类"] }) // 改颜色/描述
mint({ args: ["issue","label","attach","42","docs"] })     // label 不存在则自动注册 + 自动配色
mint({ args: ["issue","label","attach","42","agent:dsh"] })// 参与者：agent: 前缀
mint({ args: ["issue","label","detach","42","docs"] })     // 摘除（不删 label 本体）

mint({ args: ["issue","link","create","42","solves","10"] })      // 42 解决了 10
mint({ args: ["issue","link","create","42","blocked-by","55"] })  // 42 被 55 阻塞
mint({ args: ["issue","link","create","42","related","30"] })
mint({ args: ["issue","link","list","42"] })
mint({ args: ["issue","link","remove","42","related","10"] })
```

body 编辑规则：`--body` / `--body-append` / `--body-file` **三选一**；`--body-section` 必须配
`--body`/`--body-file`，**不能**与 `--body-append` 同用。`plan set` 支持同样的 body 参数。
**改写/追加的纪律见 `body-editing.md`**（只动相关小节、回到模板形状、追加只记新证据）。

link 类型（**CLI 取值一律 kebab**）：`related` / `solves` / `duplicates` / `blocked-by` / `blocks`；
`blocked_by` 只出现在输出侧（JSON `rel`），**不能当参数**（传了报 exit 2 `invalid value`）。
blocked-by ↔ blocks 互逆；库中归一化为 blocks 存储，查询时自动派生反向。

## plan / milestone

```js
mint({ args: ["milestone","create","v0.4 TUI","--version","0.4.0","--body","范围…"] })  // --version 必填
mint({ args: ["plan","create","sprint-1","--body","目标…","--milestone","4"] })
mint({ args: ["milestone","show","4"] })
mint({ args: ["milestone","current"] })             // 当前唯一 running（0 个 / ≥2 个报错）
mint({ args: ["plan","show","12"] })
mint({ args: ["plan","attach","12","42"] })        // 挂 issue 到 plan（一次一个 issue，多个逐条执行）
mint({ args: ["plan","detach","12","42"] })
mint({ args: ["milestone","attach","4","42"] })    // 直接挂 issue 到 milestone（该 issue 不能属于 plan）
mint({ args: ["milestone","detach","4","42"] })

mint({ args: ["plan","plan","12"] })               // 批量排期：plan 下全部 open → planned
mint({ args: ["plan","close","12","--test-cmd","pnpm test"] }) // 批量收口：plan 下全部 test → done
mint({ args: ["plan","drop","12"] })               // 只允许空 plan（无 issue）；落手动终态，派生不复活
mint({ args: ["plan","set","12","--milestone","5"] }) // 移动 plan 到另一 milestone（两侧状态重算）
mint({ args: ["milestone","set","4","--title","新标题","--version","0.4.1","--body","新范围"] })
mint({ args: ["milestone","set","4","--status","done"] })   // 手动终态：发布 done / 取消 dropped
mint({ args: ["milestone","set","4","--status","running","--force"] }) // 并行多版本：唯一放行入口（须用户明确要求）
```

`milestone set --status` 语义：只有 `done`/`dropped` 是**手动终态**（不被派生覆盖）；
写 `open`/`running` 只是临时覆盖，后续任何子项变化会按子项集合重算。

**running 守卫（#104）**：任何**让 running 数增加**的写都会被拒——`--status running`、把在途
（planned/dev/test/done）plan/issue 挂进 open milestone（挂载或随后的 `state plan`/`state start`）。
错误文案直接给出放行命令；**唯一放行入口**是 `milestone set <ID> --status running --force`（`-f`），
**只有用户明确要求并行版本时才用**。`done`/`dropped` 减少 running 数，不受守卫限制。

## project（只读巡检）

```js
mint({ args: ["project","list"] })            // 扫描 data_dir/projects/ 下全部项目
mint({ args: ["project","show","1"] })        // 当前项目元数据
mint({ args: ["project","get","1","git"] })   // 字段：name/description/git/abs_dir/created_at/updated_at
```

`project create` / `project set` 会新建项目库或改项目元数据（跨项目/上下文漂移），默认不用；
确需时先向用户确认。

## 跨项目（`-p` / `--project`，须在子命令之前）

本项目操作**不带 `-p`**：目标项目默认取会话 cwd。只有写/读**别的**项目才用 `-p`：

```js
mint({ args: ["-p","dsh-dev-dsh","list","--status","open"] })                          // 读：直接放行
mint({ args: ["-p","dsh-dev-dsh","issue","add","<标题>","--label","docs,dsh-mint"] })  // 写：弹一次确认
mint({ args: ["-p","dsh-dev-dsh","issue","state","start","12"] })                      // 同会话同项目之后免问
```

- 只接受**项目名**（`projects/` 下的目录名），非路径；候选见 `mint({ args: ["project","list"] })`。
- 目标项目不存在 → 工具拒绝并给候选，**不会**新建项目库、不会落到本项目。
- `MINT_DB_PATH` 单文件模式不支持跨项目。
- 来源标注与触发条件见 `cross-project.md`。

## 不通过工具的操作（需用户显式确认后走 bash）

`delete`（物理删除，不可逆）、`import` / `sync`（跨机数据合并与同步）、`export`、`tui`，
以及 `--db`（单文件库，绕过会话项目上下文）。工具会直接拒绝。

```bash
# 仅在用户明确要求时执行；这些会走常规沙箱提权审批
mint sync pull
mint sync push --backend rclone --remote <remote>:/mint
mint delete issue 99
```

> 任意读命令若出现 `mint: hint: found unmerged data from machine(s): …`，说明本地视图不完整 →
> 先 `sync pull` 再下结论（同步流程见 `flow-sync.md`）。

## JSON 输出字段（仅显式 `--json` 时）

issue（实测 0.9.0-alpha.1）：

`id uid machine_id project title body kind status priority plan_id milestone_id test_cmd
dropped_reason last_commit_id hit_count labels links created_at updated_at`

link rel 值：`related / solves / solved-by / duplicates / duplicated-by / blocked_by / blocks`

## 数据位置

多项目库：`$XDG_DATA_HOME/mint/projects/<project>/<machine_id>.db`（每项目独立库，
按当前 cwd / git 库名定位）。显式 `--db` / `MINT_DB_PATH` 时退化为单文件模式。
