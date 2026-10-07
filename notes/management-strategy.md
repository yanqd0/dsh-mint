# plugin + skill 核心管理策略（一页回看）

> 来源：mint plan #26（#132/#135/#136/#137/#138/#139）与更早的 #104/#111/#116/#117/#119/#128。
> 本文只记**策略与其边界**；命令细节与执行口径以 `skill/` 为单一真源（`SKILL.md` + `references/`）。

## 1. 一条主线：记录必须有，顺序可换

- 任何改码工作都必须对应 mint 里的记录（plan + issue）；**先建再跑**与**先跑后建（补登记）**都合法，
  顺序可换，记录不能缺。
- 记录服务三类读者：未来的自己、别的项目的 agent、人类。所以「人类看得见」也是策略的一部分（见 §5）。

## 2. 登记 ≠ 排期（#128）：状态只在开工点前进

- **登记 / 建议**（别处的新 issue、未来版本的想法）一律 `open`：写得多详细都只是建议，不是承诺的实施方案。
- **属于当前 plan 的 issue** 在**开工点**锁到 `planned`；**只有本次确实要开工**才锁。
- **开工点的两种形态**：计划模式退出口（对「本 plan」执行 `plan plan`）——且本会话确实要动手；或非计划模式开始改码前。
- **建 plan 之后保持 `open`**（#141）：非计划模式建的 plan、计划模式里拆出待用户拍板的 plan，都不在退出口锁排期。
  唯一例外：把**在途**（planned/dev/test）的 issue 挂进该 plan —— 容器派生必然让它变 `running`，不需要也拦不住。
- 于是 `plan plan` 的语义被收窄为「宣布开工」，不再是「登记动作」。

## 3. plan 绑定是单向的（#135/#136）

- 方向一（强制）：**进入计划模式的会话，退出前项目里必须有已拆解的 mint plan**，否则 `exit_plan_mode` 被拒。
- 方向二（不成立）：**建 mint plan 不要求计划模式**。计划模式只是宿主的审批通道，不是建 plan 的前提。
- 门禁判据（`src/planbind.ts` 的 `isDecomposedPlan`）：`running`（派生自活跃子项），或 `open` 且已挂
  ≥1 个 issue；**空 plan 拒**（#59）；`issue_count` 不可读时 fail-open（不关死退出）。
  - 为什么不要求「必须 running」：全 `open` 的 plan 派生 `open`（mint `src/container/derive.rs`），
    而 #128 又要求登记一律 `open` —— 两条撞在一起会让新会话**永远出不去**（#135）。
- 存量 plan 的**整体/多 issue 接管**仍须先进计划模式（防 auto 跑完）；用户点名的**单个 issue**可直接推进。
- **同 milestone 至多一个 running plan**（#140）：`>1` 拒并点名 id（`multiRunningCluster` 按 `milestone_id`
  分桶，跨 milestone 是用户 `-f` 授权的并行版本，放行）。判据只能看**项目级事实**：非计划模式的写与
  `/plan off` 都拦不住，所以它是退出口的硬门禁 + 项目级软纪律，**不是**项目不变量。计数含「曾运行」派生的
  running（`{done|dropped} + open`），因此被新 `open` issue 复活的旧 plan 也算，用 `plan detach` 释放。
- **非计划模式下的 `exit_plan_mode`**（#142）：插件判「本会话是否在计划模式」，`active === false` 时直接拒并给
  可行动文案（不白跑 mint）。判定源只能是 root 层达到的两条——会话投影
  `ctx.sessionProjections.stateOf(session,"plan").active`（宿主 `exit_plan_mode` 用的同一个值），
  或本插件从 `session/event` 观测到的 `plan/mode`（进程内、重启后未知）；
  **`ctx.planMode` 不可达**（plan-mode 挂在隔离的 cordis group 里，见 `presets/standard.patch.yml` 的
  `isolate: { planMode: true }`）。两条都读不到即 fail-open。

## 4. 硬门禁管「有没有」，软信号管「是不是」（#111/#116）

| 通道 | 回答的问题 | 强度 |
|---|---|---|
| `exit_plan_mode` 门禁（`planbind.ts`） | 项目里有没有已拆解的 mint plan | 拦（deny） |
| 工具结果补登记提示（#111） | 本会话零 mint 写就离开计划模式 | 提示 |
| 概览条件行（#116） | 非工具退出（`/plan off`、GUI 切换）同一条提示，一次性 | 提示 |

- 门禁看到的是**项目级**事实，无法判断「这个 plan 是不是本次工作的」；那正是软信号存在的理由。
- 两者都不判断工作质量：策略只保证「有记录 + 可见」，不保证「计划得好」。

## 5. 进度可见：宿主 todo 与 mint 状态一致（#119）

- 宿主 `todo_write` 的 `todos` 投影**每个 `turn/start` 重置为空**，所以进入实施的每个 turn 都要重写清单，
  并在每次 `issue state` 变更后同步（口径见 `skill/references/flow-impl.md` §3；契约见 `todo-panel.md`）。
- 插件在 `issue state` / `plan plan` / `plan close` 成功后追加一行同步提醒（子代理会话跳过，面板属根会话）。
- 清单由模型写：它是实施步骤的拆解，**不是 issue 行的镜像**。

## 6. 版本与收口

- **默认 1 个 running milestone**（并行多版本仅用户明确要求时 `milestone set --status running --force`，
  #104/#117）；plan 与独立 issue 默认挂它；无 running 时按 semver 推测候选并**询问用户**，不得自行置位。
- 同 plan 各 issue **停在 test**，到齐后统一跑测试 → `plan close --test-cmd "<命令>"`；
  失败 `issue state retest --test-cmd` 打回 dev。**无 dev→done 捷径**。
- plan 的完成由子项派生：全 done = `done`，{done, dropped} 混合 = `partial`（**完成态**）。

## 7. 边界表：什么被强制、什么只是提示

| 规则 | 强度 |
|---|---|
| 改码前 `state start`、commit 后 `state commit --sha` | 强制（CLI 状态机） |
| 计划模式退出前必须有已拆解的 mint plan | 强制（插件 deny） |
| 同 milestone 同时最多一个 running plan | 强制（插件 deny #140） |
| 非计划模式调 `exit_plan_mode` | 强制（插件 deny #142，不跑 mint） |
| 同 plan 统一测试后 `plan close` | 强制（CLI：test 才能 close） |
| 当前 plan 的 issue 在开工点锁 `planned` | 流程要求（skill 口径） |
| 登记别处的新 issue / 建议保持 `open` | 流程要求（skill 口径） |
| 本会话零写离开计划模式 → 补登记提示 | 软信号（提示不拦） |
| 宿主 todo 同步 | 提醒 + skill 口径（模型执行） |
| 无 running milestone | 必须问用户，不得自行置位 |

## 8. 变更来源

- #128 登记 ≠ 排期｜#135 门禁判据放宽｜#132 拒绝文案｜#136 单向绑定 + 开工点｜#137 派生表/口径对齐
- #138 SKILL.md 拆分重构（常驻面 3987 → 2999 B，上限 3200）｜#139 本文
- #104/#117 running 守卫｜#111/#116 软信号｜#119 进度可见
- #140 同 milestone 至多一个 running plan（分桶）｜#142 非计划模式下的 `exit_plan_mode`
- #141 建 plan 保持 `open`（开工点条件式：确实要开工才 `plan plan`）
