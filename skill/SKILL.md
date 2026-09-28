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
位置参数 `<description>` 是一句话意图；未传参进入**接管模式**；不明确时用文本反问澄清。

## 执行面：一律用 `mint` 工具

工具优先策略由常驻指引承载，参数/输出/分页/可用命令见工具描述（本文件不重复）；
本 skill 的 reference 一律写作 `args: [...]`，等价于 `mint({ args: [...] })`。

## 三层模型

- **issue**：一个问题或需求，六态生命周期；可执行的最小单位。
- **plan**：一次开发计划，下挂若干 issue；**对应 DSH 的 plan 模式**（宿主 plan ↔ mint plan 一一对应）。
- **milestone**：项目功能版本（create 必带 `--version`）；**同刻仅 1 个 running**，plan 与独立 issue **默认挂它**。

## 执行流程

1. **解析意图 → 选择流程**：`Read` 对应 reference（均在 `references/`）：bug/问题 `flow-bug.md`、
   需求 `flow-requirement.md`、遗留/TODO `flow-todo.md`、版本/计划/里程碑 `flow-planning.md`、
   审查 `flow-review.md`、条件分支 `flow-conditions.md`、多机同步 `flow-sync.md`（**须走 bash + 用户确认**）。
2. **执行**：按 reference 逐步推进（创建 / 挂载 / link / 状态机），逐态 `show` 验证；登记前先 `list` 查重。
3. **排序**：`blocks` 其它 issue 的先行；同层 priority 升序（P0→P3），同 priority 按 id 升序。
4. **方案执行**：跨模块/多步骤方案先建 mint plan（挂 milestone）+ 拆 issue，再执行；每个 issue 走到 done。

## 实现中（强制性——每次修改代码必须执行）

> 违反视为「未接管」，下次 session 必须补登记；命令与状态机细节见 `references/state-machine.md`。

- **plan 双向绑定**：宿主 plan ⟷ mint plan 一一对应。先有 mint plan（如从存量 plan 接管）时**必须先进入
  宿主 plan 模式**，**禁止 auto 模式直接跑完**；进入执行/auto 模式时若 work 无对应 mint plan 或该 plan
  非 planned/dev，先补建/排期。项目无活跃 mint plan 时 `exit_plan_mode` 直接被拒绝。
- **计划与归属**：属已有 plan → `args: ["plan","attach","<plan>","<issue>"]`，否则第一步 `plan create`
  （挂 milestone）。每个独立 phase 建 issue（kind=requirement，label `dev-clean`）并 attach，随后
  `args: ["plan","plan","<plan>"]` 批量置 planned（不留 open）。**无 plan 不得写代码**。
- **改码前门禁（强制）**：先 `args: ["issue","state","start","<id>"]`（planned → dev）并保持 `dev`；
  open/planned 直接改码 = 流程违反；漏 start 就补 `state start` 再 commit。
- **commit 后立即** `args: ["issue","state","commit","<id>","--sha","<前7位>"]`（dev → test）；sha 用 bash 的
  `git rev-parse --short=7 HEAD` 取；一个 issue 多个 commit 每次都要登记。
- **统一测试**：同 plan 各 issue 先停在 **test**，到齐后统一跑；全绿 `plan close <plan> --test-cmd "<命令>"`，
  失败 `issue state retest <id> --test-cmd "<精确手法>"` 打回 dev，修复后新 commit、新登记、再测
  （细节见 `references/state-machine.md`）。
- plan 的 issue 全 close 后自动派生 done（含 dropped 则 partial，属完成态）；每个 phase 用
  `args: ["list","--plan","<id>"]` 复查状态。

## 接管模式（无参数调用）

无 `<description>` 时接管，代替用户初始化思考：

1. **概览**：`list` 拉当前 open/planned；`milestone list --all-states` / `plan list --all-states` 看规划现状。
2. **扫描 TODO/FIXME/XXX**：用 bash 的 grep 扫代码标记，逐个转 issue（查重，body 注明来源）；
   细节见 `references/flow-session.md`。
3. **milestone 检查**：同刻**有且仅有 1 个** running。≥2 → 列出并反问用户，确认后把远期置回 open。
   **无 running** → 按 semver 推测候选（修复→patch、新功能→minor、破坏性→major、`-alpha.N` 同线递增），
   **询问用户**选「置为 running」还是「新建」；**不得自行置 running**。
4. **下一步建议**：按 blocks 拓扑排序（被依赖者优先），同层 priority 升序，附理由；有存量 mint plan 时
   提示「须先进入宿主 plan 模式」。
5. **声明接管**：后续直接描述意图即可。

## 输出与检索

- 取正文用 `args: ["issue","get","<id>","body"]`（裸值最准）；`show` 已含状态/标题/优先级。
- 命令清单见 `references/commands.md`；状态机与容器派生见 `references/state-machine.md`。

## 标题与 body 模板（省 token）

**只记 LLM 未知**：不写已知（公共知识/定义不描述）；不瞎猜（不明确写 `? 待确认 <简述>`）。

- **标题** ≤60 字符（约 30 汉字），语义见 `references/title-templates/`；**好标题可省 body**。
- **body** 套 `references/body-templates/N.md`：≤4 字段、每字段 ≤1 句、要点用纯 `- ` 列表；
  **禁止 `- [ ]` checkbox**（agent 不二次改 body，checkbox 永远显未完成）。

## 约束

- **方案 vs 单点**：跨模块/多步骤 → 建 plan + 拆 issue；单点小改/审查发现/观察项 → 只记 issue。
- **挂载规则**（细则见 `references/flow-conditions.md`）：**默认挂当前 running milestone**（属 plan 则挂
  plan）；无 running → 推测候选并**询问用户**，**勿自行置位**；issue 二选一。
- **link**：被别的修改引入 → `link create <issue> solves <引入它的需求>`。
- **delete 不可逆**：工具已拒绝，确需让用户显式走 bash；issue 优先 `state drop`。
- **验证产物清理**：验证性操作产生的临时 issue/plan/milestone 用 `state drop`（附 reason）清理。
- **去重已内置**：`add` 对非终态 issue 做标题模糊匹配，重复自动合并（`hit_count+1`）。
- **label 规范**见 `references/labels.md`；**版本不用 label**（经 plan→milestone 表达）。

## DSH 集成（本宿主专有）

- **plan 绑定门禁**：项目无活跃 mint plan 时 `exit_plan_mode` 被拒绝（见上「plan 双向绑定」）。
- **子代理**：`mint` 工具注册在全局层，子代理继承；其 approval pin 为 `never`，**bash 路径不可用**。
- 零授权、上下文注入口径由常驻指引与工具描述承载，本文件不重复。
