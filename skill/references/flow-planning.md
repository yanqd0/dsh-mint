# 版本规划与执行计划流程（flow-planning）

> 标题/body 模板：`title-templates/plan.md、milestone.md + body-templates/7.md、8.md、15.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

触发：版本 / 计划 / 里程碑 / milestone / plan / sprint / 拆解执行计划 / 方案执行。

## 步骤

1. **版本规划**（milestone = 项目功能版本）：
   - 先 `mint({ args: ["milestone","current"] })` 取当前唯一 running（**0 个 / ≥2 个时报错**，
     退回 `mint({ args: ["milestone","list","--all-states"] })` 看规划现状）：**有 running → 不新建**，
     新工作一律挂它；**无 running → 按 flow-conditions 推测候选 + 询问用户**（置为 running 或新建；不得自行置位）。
   - **已有 running 时不得再开第二个**（#104 守卫）：任何**让 running 数增加**的写（含
     `milestone set --status running`、把在途 plan/issue 挂进 open milestone）都会被 CLI 拒；
     唯一放行入口 `mint({ args: ["milestone","set","<ID>","--status","running","--force"] })`（`-f`），
     **只有用户明确要求并行版本时才用，skill 不得自行 `-f`**。
   - 新建：`mint({ args: ["milestone","create","<版本标题>","--version","<V>","--body","<目标+范围+验收>"] })`
     —— `--version` 必填、语义化；按 version 查重，**重复则不加、不问**。
2. **执行计划**（plan = 一次开发计划；**进计划模式的会话**在退出前必须有它，但**建 plan 不要求计划模式**，#136）：
   `mint({ args: ["plan","create","<计划标题>","--body","<body>","--milestone","<RM>"] })`
   —— 新建即 `open`：**只有开工点才**锁 `planned`（#141；见步骤 3）。
3. **拆 issues**：按计划子任务逐个建 issue —— 改行为的 phase 用 `--kind requirement`，
   **纯文档/杂务/调研/CI 用 `--kind task`**（task 无 dev 态：planned → test → done），
   统一 `--label dev-clean`：
   `mint({ args: ["issue","add","<子任务>","--kind","requirement","--label","dev-clean"] })`
   + `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })` 挂入；
   **phase 已对应既有 issue（收口/合并计划）直接 attach，不重复建**。
   **拆 issue 落 open**（#128：登记 ≠ 排期）：**开工点才** `mint({ args: ["plan","plan","<PLAN>"] })`
   批量锁定（open → planned）——开工点 = 计划模式退出口（且本次确实要开工），或非计划模式开始改码前；
   只登记/待用户拍板时 plan 与 issue **都保持 `open`**（#141）。
   注意 `plan plan` 批量锁本 plan 名下**全部** open 子项，所以 plan 里不要混别处的建议 issue。
4. **判并行批次**：按 `references/parallel-exec.md` §1 的判据（文件集两两不相交等五轴）给 issue 分批，
   把批次表写进 plan body 的 `## 并行批次` 段 —— `plan create --body` 时**就带该段**；
   细化用 `mint({ args: ["plan","set","<PLAN>","--body-section","并行批次","--body-file","<文件>"] })`
   （标题不存在报 `section not found`；以 `- ` 开头的值**必须经 `--body-file`**，
   直接 `--body "- …"` 会被 CLI 当成参数）；宿主 plan 正文同步该表。
   无并行机会写「单批串行」+ 一句理由；执行侧见 `flow-impl.md` 并行批次小节。
5. **方案定稿后出 DAG 全景**：正文定稿即**分界节点** —— 此前调研阶段的 DAG 是动态生长的
   （`references/plan-dag.md`：总分总、用户决策只落在两个「总」），此后是**静态全景**：节点=本 plan 的 issue、
   边=依赖，分层后写进同一 `## 并行批次` 段（不另立格式），低 context 任务派子代理、高 context/决策留 main
   （`references/dag-exec.md`）。
6. **方案执行登记**（跨模块/多步骤方案，含方案审批/plan 产出）：**开工第一步**才是建 mint plan + 拆 issues，
   然后执行；每个 issue 走状态机到 done（关联对应 commit）。**登记别处的新问题/需求不预建 plan**（#128）；
   计划模式只是宿主侧的审批通道，**不是建 plan 的前提**（#136）；建好仍为 `open`，开工点才 `plan plan`（#141）。

## 维护（改名 / 迁移 / 清理）

- **plan 迁移到别的 milestone**：`mint({ args: ["plan","set","<PLAN>","--milestone","<ID>"] })`
  （两侧 milestone 状态自动重算）。
- **milestone 元数据修订**：`mint({ args: ["milestone","set","<ID>","--title",…,"--version",…,"--body",…] })`。
- **空 plan 清理**：`mint({ args: ["plan","drop","<PLAN>"] })`（只允许无 issue 的 plan）。
- 清理验证产物与不可逆操作红线见 `constraints.md`。
