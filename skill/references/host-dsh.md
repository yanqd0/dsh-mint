# DSH 宿主集成（host-dsh）

> 本 skill 是 **DSH 单宿主版**：不读其它宿主的 agent reference。需要宿主侧事实时读本文件。

## 执行面

- **一律用宿主 `mint` 工具**：插件进程内 spawn mint，不经 bash、不进会话沙箱、零授权；
  `args` 即 CLI 参数数组，输出原生 TSV（页脚 `# Page x/y` 在 stdout）。
- 工具注册在 **root ctx（global layer）**，所有 agent 继承；**子代理也继承**，但子代理 approval 被
  pin 为 `never`，**bash 路径对子代理不可用**——子代理只能用 `mint` 工具。
- **子代理继承什么**：工作区 cwd、`AGENTS.md` 指令、通用工具、`mint` 工具与 skill catalog；但**没有 `[Mint]` 注入**
  （`delegationDepth > 0` 跳过），审批 pin `never` 且**不可提权**（跨项目写、工作区外写必失败）。
  故派活提示词须显式给目标/文件范围/验收/既有结论/禁令，不能指望它从父对话自取。
- 工具拒绝的根命令：`delete` / `import` / `sync` / `export` / `tui`，以及全局 `--db`；
  这些须经用户确认后走 bash（常规沙箱提权审批）。
- **本项目不带 `-p`**：目标项目默认取会话 cwd；`-p` / `--project` 只用于指向**别的**项目。
- `-p` / `--project`（写在**子命令之前**）是放行项：读直接放行；写操作同会话 + 同目标项目首次
  弹一次确认（`tools/pre-execute` 的 `ask`，文案含目标项目与动作），之后免问；目标项目不存在即拒绝。
  写的是本项目（`-p <本项目>`，等价于默认）时不算跨项目：**不弹确认**，工具结果会附一条「冗余」提示。
  bash 里可识别的裸 mint 命令走**同一个分类器**。口径见 `cross-project.md`。

## plan 绑定门禁

- 宿主 `exit_plan_mode` 的判据在 `src/planbind.ts`（`tools/pre-execute`），三条按序：
  1. 项目**没有已拆解的 mint plan** → 拒（`running`（有活跃子项），或 `open` 且已挂 ≥1 个 issue 都算已拆解；
     **空 plan 不算**，#59/#135）。被拒时按提示先 attach 至少一个 issue（`plan plan` 是开工点动作，不是门禁条件）。
  2. **同一 milestone 内 `running` 的 plan 多于一个** → 拒并点名 id（#140）。mint 只守 milestone，这条纪律只能由本仓立；
     收敛路径（折进在跑的 plan / 停摆其 `planned` 子项 / `plan detach` 复活它的 open issue）写进拒绝文案，见 `flow-impl.md` §1。
     计数含「曾运行」派生的 running（子项混 `done/dropped` + `open`）。
  3. **本会话不在计划模式**（宿主 `ctx.planMode.get(agent)` 报 `active === false` 且无 `pending`）→ 直接拒并给可行动文案，
     **不再白跑一次 mint spawn**（#142）。服务缺失、判定抛错、`pending` 选择一律 fail-open 落到上面两条。
- 门禁只管「项目里有没有已拆解的记录」与「一个 milestone 只跑一条 plan」；「是不是本会话的」交给下面两条软信号。
- **会话级软信号（#111）**：`exit_plan_mode` 放行后，若**本会话**没有任何本项目 mint 写操作，
  结果里会追加一条补登记提示（项目里的 running plan 可能不是本次工作的记录）。它只提示、不拦；
  见到提示按 `flow-impl.md` 的补登记路径处理。
- **非工具退出的软信号（#116）**：用户用 `/plan off` 或 GUI 切换离开计划模式时没有工具结果可挂，
  改由概览条件行承载同一条软信号——本会话离开计划模式且尚无 mint 写操作时，`[Mint]` 概览会
  **一次性**多出一行补登记提示；本会话一旦有 mint 写操作即消失。工具路径与概览路径互斥，
  不会重复提示（插件监听 `session/event` 的 `plan/mode{active:false}`）。

## 宿主 todo 面板（进度可见）

- `todo_write` 是**宿主**工具（`@deepseek-ai/dsh-tool-todo`），不是本插件的：每次调用向调用者会话
  追加一条 `todo/write` 快照，客户端（`dsh-client-ui-conversation`）把 `todos` 投影渲染在
  **输入区上方的进度面板**（`conversation.input.dock`）。面板是只读展示。
- 投影在**每个 `turn/start` 重置为 `null`**：一个 turn 里不写就没有面板；写一次后长期不更新，
  显示的进度就是过期的（人类据此误判，这就是 #119 的现象）。
- 插件只做**提醒**，不代写：`issue state` / `plan plan` / `plan close` 成功后在工具结果末尾追加
  一行「同步 todo」；子代理会话跳过（面板属于根 agent 的会话）。清单内容仍由模型写——
  它是实施步骤的拆解，不是 issue 行的镜像。
- 派生与同步口径见 `flow-impl.md` §3、`flow-session.md` §5。

## skill 安装与生效

- skill 安装到 `~/.dsh/skills/mint`（rank 400，遮蔽其它用户级 skill），由本插件 content-sync
  （按整树比对，改任一 reference 都会重同步）。
- 同步发生在插件加载时；**改完 skill 需重启 harness**，新会话才看到新内容。

## 模型可见文案分工

- 动态概览（issue 列表 + running milestone）与静态工具指引由插件 `systemPrompt` 注入承载；
  skill 不重复这些内容，只写流程与纪律。
- 注入在 **agent 创建**时挂到该 agent 的 ctx 上（宿主事件 `agent/created`；`agent/session-start`
  是 0.2.x 不存在的旧名，只作兼容回退）；**子代理会话不注入**（它继承 `mint` 工具即可）。
