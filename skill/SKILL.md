---
name: mint
description: >-
  用 mint 管理开发 issue / plan / milestone（三层）。当用户描述 bug/问题/需求/遗留项/
  TODO/观察项/审查发现/计划/里程碑/milestone/sprint 等值得记录的内容时自动触发；
  无参数调用时接管 session，推测下一步开发计划。触发词：issue bug problem requirement
  todo leftover review plan milestone sprint 登记 记录 排期 修复 需求 问题 遗留 审查
  计划 里程碑 同步 推送 拉取 合并 下一步。
---

用 mint 管理开发 issue 与流程：**解析意图 → 选择流程（reference）→ 用 `mint` 工具执行 → 验证**。

可接收位置参数 `<description>`：一句话描述意图。未传参时进入**接管模式**（推测下一步开发计划）。
描述不明确时用文本反问澄清（本宿主没有弹窗式澄清工具）。

## 执行面：一律用 `mint` 工具

本 skill 的宿主是 DSH。mint 操作**只经宿主工具 `mint`**，不要写 bash 命令跑 mint：

```js
mint({ args: ["list"] })
mint({ args: ["issue", "add", "登录按钮点击无响应", "--kind", "problem", "--priority", "0"] })
mint({ args: ["issue", "state", "start", "42"] })
mint({ args: ["plan", "--help"] })
```

- `args` 就是 mint CLI 的参数数组（不含 `mint` 本身），原样透传。
- 该工具在 DSH 插件进程内执行：**不经 bash、不受文件沙箱约束、无需授权、不弹窗**。
- 输出是 mint 原生 **TSV**，不是 JSON。`list` 默认**每页 5 条**；需要更多用 `--page <N>` /
  `--page-size <N>` / `--no-page`（全部列出）。
- 任意子命令加 `--help` 查完整参数，例如 `mint({ args: ["issue", "state", "--help"] })`。
- 本 skill 的 reference 为紧凑起见写作 `args: ["issue","state","start","42"]`，
  **等价于** `mint({ args: ["issue","state","start","42"] })`。
- 工具**拒绝**这些操作（需用户显式确认后走 bash）：`delete` / `import` / `sync` / `export` / `tui`，
  以及 `--db` / `--project`（项目上下文由会话 cwd 决定）。

## 三层模型

| 层 | 是什么 | 与 DSH 的关系 |
|---|---|---|
| **issue** | 基础条目：一个问题或需求，六态生命周期 | 可执行的最小单位 |
| **plan** | 一次开发计划，下挂若干 issue | **对应 DSH 的 plan 模式**：宿主 plan ↔ mint plan 一一对应 |
| **milestone** | 项目功能版本（create 必带 `--version`） | 版本级目标；**同刻仅 1 个 running**，plan 与独立 issue **默认挂它** |

## 执行流程

1. **解析意图 → 选择流程**：从 `<description>`/对话上下文识别类型，`Read` 对应 reference：
   - **bug / 问题** → `references/flow-bug.md`（issue → 挂载 → link solves → 修复 → commit → close）
   - **需求** → `references/flow-requirement.md`（issue → 排期 → 挂 plan）
   - **审查/复查报告** → `references/flow-review.md`（观察项/已修复 bugfix → 登记 + 挂活跃 plan）
   - **遗留 / TODO / 观察项** → `references/flow-todo.md`（登记 + 默认挂当前 running milestone）
   - **版本 / 计划 / 里程碑** → `references/flow-planning.md`（milestone create / plan create + 拆 issues）
   - **条件分支**（挂载规则/无测试/非 git/二选一）→ `references/flow-conditions.md`
   - **同步/推送/拉取/合并** → `references/flow-sync.md`（多机数据同步；**须走 bash + 用户确认**）
2. **执行流程**：按 reference 用 `mint` 工具逐步推进（issue 创建 / 挂载 / link / 状态机推进），
   逐态推进并 `show` 验证。登记前先 `list` 查重（标题模糊匹配），不重复创建。
3. **执行排序**：有 `blocks` 其它 issue 的先行（被依赖者先完成，类比 make）；
   同层按 priority 升序（P0→P3），同 priority 按 id 升序。
4. **方案执行**（跨模块/多步骤方案）：按「方案执行登记」——第一步先建 mint plan（挂 milestone）+ 拆相关 issue，
   再执行方案；每个 issue 走状态机到 done（关联对应 commit）。

## 实现中（强制性——每次修改代码必须执行）

> 以下规则不因宿主 plan 机制 / 任何其他流程步骤而跳过。违反视为"未接管"，下次 session 必须补登记。

> **plan 双向绑定**：宿主 plan 机制 ⟷ mint plan 必须一一对应，消除脱钩。
> - 先进宿主 plan 模式 → 必建/挂对应 mint plan + 拆 issue（下方 step 0-1）。
> - **先有 mint plan（如接管模式从存量 plan 开始）→ 必须先进入宿主 plan 模式**，再逐步执行该 plan；**禁止 auto 模式直接跑完 mint plan**（会让 plan/issue 状态失控）。
> - 脱钩检测：宿主进入执行/auto 模式时，若当前 work 无对应 mint plan 或 mint plan 非 planned/dev，先补建/排期，再继续。
> - **机制保障**：dsh-mint 会拦截 `exit_plan_mode`——项目无活跃 mint plan 时直接拒绝退出。

0. **宿主 plan 机制审批通过后，判断该工作是否属于已有 mint plan**：
   - **属于**已有 plan → `mint({ args: ["plan","attach","<plan_id>","<issue_id>"] })` 挂入
   - **不属于**任何已有 plan → 第一步必须是 `plan create` 新建 plan（挂 milestone），再建 issue 并 attach
   - **绝不允许无 plan 直接写代码**：宿主 plan 机制必须有对应的 mint plan
1. **宿主 plan 机制审批通过后，第一件事不是写代码**：
   - 将宿主 plan 对应的 work 挂入 mint plan（step 0 已保证 plan 存在）
   - 为每个独立 phase 建 issue（kind=requirement，label `dev-clean`），`plan attach` 挂入
   - **挂入即排期锁定**：`mint({ args: ["plan","plan","<plan_id>"] })`（该 plan 下全部 open → planned；
     或逐个 `issue state plan <id>`）；宿主退出 plan 模式进入执行/auto 模式时统一 planned，plan 的 issue 不留 open
2. **每完成一个逻辑变更（对应一次或多次 commit）**：
   - **改码前门禁（强制）**：修改某 issue 对应代码前必须先 `issue state start <id>`（planned → dev）；
     改动期间该 issue 必须处于 `dev`（open/planned 直接改码 = 流程违反）。
     **自查**：每个 phase 改码前确认该 issue 已 `start`（dev）；实现后 `list --plan <id>` 复查状态与阶段匹配。
     **补救**：若已改码才发现未 start，先 `state start` 再 `state commit`（避免 invalid transition）
   - 修改代码 → **git commit 后立即**登记：
     `mint({ args: ["issue","state","commit","<id>","--sha","<前7位>"] })`（dev → test）
     —— sha 先经 **bash 的 git** 取到（`git rev-parse --short=7 HEAD`），再作为参数传入
   - 同一 issue 有多个 commit 时，**每次 commit 都执行一次 `state commit`**（只记最后一个 SHA，但流程上每次都要走）
3. **统一测试模式**（同 plan 多 issue，避免逐个 close 致中间态瞬移）：
   - 同 plan 的多个 issue 各自 commit 到 **test（停在 test）**，不立即 close
   - 全部到 test 后，统一跑测试命令
   - **全绿** → `mint({ args: ["plan","close","<plan_id>","--test-cmd","<命令>"] })` 统一 close
     （或逐个 `issue state close <id> --test-cmd ...`；无测试填 `not-tested`）
   - **失败** → `issue state retest <id> --test-cmd "<精确手法>"`（test→dev 打回，保留旧 SHA 标记失败）
     → 修复 → 新 commit → 新 `state commit --sha <新前7位>` → 再测试
   - retest 的 test-cmd 尽量精确（用例/文件/lint 命令）；省一次交互可用通用命令
4. **一个 phase 的全部 issue close 后**，plan 自动派生为 done（无需手动关 plan）；
   **若有 dropped issue，plan 派生为 partial——partial = {done,dropped} 混合，是完成态**（等同 done），非未完成。
5. **每完成一个 phase，必须 `mint({ args: ["list","--plan","<id>"] })` 确认当前计划下 issue 状态正确**。

## 接管模式（无参数调用）

无 `<description>` 参数时进入接管模式，代替用户初始化思考：

1. **概览**：`list` 拉当前 open/planned 概览（默认 TSV 5 条），
   `mint({ args: ["milestone","list","--all-states"] })` / `["plan","list","--all-states"]` 看规划现状。
2. **扫描 TODO/FIXME/XXX**：grep 项目代码标记（**这是代码扫描，用 bash 的 grep**），
   逐个转 issue（查重不重复，body 注明来源位置）。
3. **milestone 检查与建议**：对比现有 milestone 与项目状态，发现新版本规划迹象 → **和用户确认后**创建
   （重复则不问）。**唯一 running 约束**：同刻**有且仅有 1 个** milestone 为 running（当前开发目标）；
   发现 ≥2 running → 向用户列出并反问，确认后把远期置回 open
   （`mint({ args: ["milestone","set","<id>","--status","open"] })`）。
   **无 running** → 取最大版本按 semver 推测候选（收尾修复→patch、新功能面→minor、稳定后破坏性→major、
   已有 `-alpha.N` 线→同线递增）+ 一句理由 → **询问用户**选「置为 running」
   （`mint({ args: ["milestone","set","<id>","--status","running"] })`）还是「新建」；**不得自行置 running**。
4. **下一步计划建议**：按 blocks 拓扑排序（被依赖者优先），同层按 priority 升序推荐下一个应开发项，附理由。
   若存在 running 的存量 mint plan：提示「从该 plan 开始执行需先进入宿主 plan 模式」——plan 双向绑定，勿 auto 直接跑。
5. **声明接管**：后续 session 直接描述意图即可，skill 自动走 mint 流程。

## 输出与检索

- 默认输出 TSV（`show` 也是 TSV）：直接读，**不要假设是 JSON**。
- `list` 默认每页 5 条；查看更多用 `--page 2` / `--page-size 20` / `--no-page`。
- 取正文优先 `mint({ args: ["issue","get","<id>","body"] })`（裸值最准）；
  `show` 的 TSV 已含状态/标题/优先级等，需要详情正文时不必 show。
- 需要结构化时才显式加 `--json`（默认不用）。
- 详细命令清单见 `references/commands.md`；状态机与容器派生见 `references/state-machine.md`。

## 标题与 body 模板（省 token）

写 issue/plan/milestone 的标题与 body 时套模板，**只记 LLM 未知**：

- **不写已知**：公共知识/技能/常识不描述（如"issue 是待办"这类定义不写）
- **不瞎猜**：不明确的信息不虚构，写 `? 待确认 <简述>` 尾节；读取方看到后找用户确认，或按上下文准确推定后消除
- **标题**：≤60 字符（约 30 汉字）；语义见 `references/title-templates/`；**好标题可省 body**
- **body**：套 `references/body-templates/N.md` 模板，≤4 字段、每字段 ≤1 句、要点用 `-`。
  **禁止 `- [ ]` checkbox**（mint 轻量设计，agent 不二次改 body，checkbox 永远显未完成——拆解/要点用纯 `- ` 列表）。常用：
  - T1 bug：`**现象** / **位置**`
  - T2 需求：`**目标** / **要点**`
  - T6 plan：`## 目标 / ## 拆解 / ## 验收`

## 约束

- **去重已内置**：`add` 对同项目非终态 issue 做标题归一化+模糊匹配，重复自动合并（`hit_count+1`）。
- **开发完成必须 `issue state commit <id> --sha <SHA>`**；`close` 必填 `--test-cmd`（无测试填 `not-tested`）。
- **方案 vs 单点区分**：跨模块/多步骤方案 → 建 plan + 拆 issues；单点小改动/审查发现/观察项 → 只记 issue。
- **挂载规则**（`references/flow-conditions.md`）：**默认挂当前 running milestone**（属 plan 则挂 plan）；
  无 running → 按 semver 推测候选并**询问用户**（置为 running / 新建），**勿自行置位**；
  issue 二选一（属 plan 后不能直接挂 milestone）。
- **link**：被别的修改引入 → `link create <issue> solves <引入它的需求>`。
- **delete 是危险/不可逆操作**：工具已拒绝；确需时让用户显式经 bash 执行。issue 优先 `state drop`。
- **验证产物清理**：验证性操作产生的临时 issue/plan/milestone 验证后 `state drop` 清理（附 reason），不残留噪音。
- **label（attach 时机与命名）**：文档类修改 → `docs`；CI/构建 → `CI`；模块 label 按开发模块打
  （MCP/TUI/DB/CLI/plugin 等）；**参与者**用 `agent:` 前缀（本宿主为 `agent:dsh`）。
  label **必须英文**（除非用户明确要求打非英文词）、**上限 5 个**、尽量短、默认全小写；
  新 label 可补 `description`（尽量自解释）；**颜色自动生成**，无需手动指定。
- **版本不用 label**：版本经 plan→milestone 表达。
- **不主动清理 label**：除非用户明确要求。

## DSH 集成（本宿主专有）

- **零授权**：mint 由插件进程内 spawn，不经会话文件沙箱，因此**不会弹审批**，
  本 skill 不含任何沙箱提权指示。
- **上下文注入**：会话开始时注入 `[Mint] active issues` 概览（活跃 issue top 8 + running milestone，
  含「current milestone ⇒ 新 plan/独立 issue 默认挂它」指令行；无 running 时提示按 semver 推测并询问用户）；
  另有一条「工具优先」的固定指引。
- **plan 绑定门禁**：项目无活跃 mint plan 时，`exit_plan_mode` 会被拒绝（见上「plan 双向绑定」）。
- **子代理同样可用**：`mint` 工具注册在全局层，子代理继承；
  子代理 approval 被 pin 为 `never`，**bash 路径对子代理不可用**，只能走工具。
- **偶发 bash 兜底**：若工具不可用而必须用 bash 跑 mint，走常规沙箱提权审批（每会话首条需用户批准）。
  这只应是例外，不是默认路径。
- **code 模式**：若本 agent 使用 code tool presentation，`mint` 经 `run_code` SDK 调用，语义相同。
