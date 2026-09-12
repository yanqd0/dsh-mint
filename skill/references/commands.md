# mint 命令参考（经 `mint` 工具调用）

> 标题/body 模板：`title-templates/` + `body-templates/`。
> **所有命令都经宿主工具 `mint` 调用**，本文写作 `mint({ args: [...] })`。
> 输出默认是 **TSV**（不是 JSON）；需要结构化才显式加 `--json`。
> 任意子命令加 `--help` 查完整参数，如 `mint({ args: ["list","--help"] })`。

## add

```js
mint({ args: ["issue","add","标题",
  "--body","详细描述",
  "--kind","problem",
  "--priority","0",
  "--label","bug,firefox"] })
```

add 已内置去重（同项目标题模糊匹配），重复自动合并（`hit_count+1`）。

## list（默认每页 5 条）

```js
mint({ args: ["list"] })                                   // 活跃 issue（TSV，≤5 条）
mint({ args: ["list","--all-states"] })                    // 含 done/dropped
mint({ args: ["list","--status","open","--priority","0"] })// 按状态+优先级筛选
mint({ args: ["list","--kind","requirement","--plan","7"] })// 按 kind / plan 筛选
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

## show / get

```js
mint({ args: ["show","42"] })                 // 默认 TSV：ID/Status/Kind/Priority/Title/Plan/Labels/TestCmd/…/Body
mint({ args: ["issue","get","42","body"] })   // body 原文（裸值，换行/格式原样）
mint({ args: ["issue","get","42","title"] })  // 任意字段：title/status/priority/labels/test_cmd/plan_id/…
mint({ args: ["plan","get","12","body"] })
mint({ args: ["milestone","get","8","body"] })
mint({ args: ["issue","get","42","body","--json"] }) // 结构化 {"id","field","value"}
```

> **取 body 优先走 `get body`**：裸值最准。`show` 的 TSV 已含状态/标题/优先级等；
> 需要详情正文时用 `get body` 即可，不必 show。

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
mint({ args: ["issue","state","start","42"] })                    // planned → dev
mint({ args: ["issue","state","commit","42","--sha","abc1234"] }) // dev → test（--sha 必填）
mint({ args: ["issue","state","close","42","--test-cmd","pnpm test"] }) // test → done
mint({ args: ["issue","state","retest","42","--test-cmd","pnpm test x"] }) // test → dev（测试失败打回）
mint({ args: ["issue","state","drop","42","--reason","不再需要"] })
mint({ args: ["issue","state","reopen","42"] })                   // done/dropped → open
mint({ args: ["issue","state","reset","42"] })                    // planned/dev/test → open
```

`--sha` 的值先用 bash 的 `git rev-parse --short=7 HEAD` 取到，再作为参数传入。

详细状态机与硬约束见 `state-machine.md`。

## set / label / link

```js
mint({ args: ["issue","set","42","--title","新标题"] })
mint({ args: ["issue","set","42","--priority","1"] })

mint({ args: ["label","list","--all-states"] })            // 全部 label（含关联数 + 颜色）
mint({ args: ["issue","label","attach","42","docs"] })     // label 不存在则自动注册 + 自动配色
mint({ args: ["issue","label","attach","42","agent:dsh"] })// 参与者：agent: 前缀
mint({ args: ["issue","label","detach","42","docs"] })     // 摘除（不删 label 本体）

mint({ args: ["issue","link","create","42","solves","10"] })     // 42 解决了 10
mint({ args: ["issue","link","create","42","blocked_by","55"] })  // 42 被 55 阻塞
mint({ args: ["issue","link","create","42","related","30"] })
mint({ args: ["issue","link","list","42"] })
mint({ args: ["issue","link","remove","42","related","10"] })
```

link 类型：`related` / `solves` / `duplicates` / `blocked_by` / `blocks`。
blocked_by ↔ blocks 互逆；库中归一化为 blocks 存储，查询时自动派生反向。

## plan / milestone

```js
mint({ args: ["milestone","create","v0.4 TUI","--version","0.4.0","--body","范围…"] })  // --version 必填
mint({ args: ["plan","create","sprint-1","--body","目标…","--milestone","4"] })
mint({ args: ["milestone","show","4"] })
mint({ args: ["plan","show","12"] })
mint({ args: ["plan","attach","12","42"] })        // 挂 issue 到 plan（一次一个 issue，多个逐条执行）
mint({ args: ["plan","detach","12","42"] })
mint({ args: ["milestone","attach","4","42"] })    // 直接挂 issue 到 milestone（该 issue 不能属于 plan）
mint({ args: ["milestone","detach","4","42"] })

mint({ args: ["plan","plan","12"] })               // 批量排期：plan 下全部 open → planned
mint({ args: ["plan","close","12","--test-cmd","pnpm test"] }) // 批量收口：plan 下全部 test → done
```

## 不通过工具的操作（需用户显式确认后走 bash）

`delete`（物理删除，不可逆）、`import` / `sync`（跨机数据合并与同步）、`export`、`tui`，
以及 `--db` / `--project`（绕过会话项目上下文）。工具会直接拒绝。

```bash
# 仅在用户明确要求时执行；这些会走常规沙箱提权审批
mint sync pull
mint sync push --backend rclone --remote <remote>:/mint
mint delete issue 99
```

## JSON 输出字段（仅显式 `--json` 时）

`id title body kind status priority project_id project test_cmd dropped_reason
last_commit_id plan_id hit_count labels links created_at updated_at`

link rel 值：`related / solves / solved-by / duplicates / duplicated-by / blocked_by / blocks`

## 数据位置

多项目库：`$XDG_DATA_HOME/mint/projects/<project>/<machine_id>.db`（每项目独立库，
按当前 cwd / git 库名定位）。显式 `--db` / `MINT_DB_PATH` 时退化为单文件模式。
