# mint 在 workspace-write 沙箱下执行放行调研

> 背景 issue：#23；本调研记录 #24。源码 fork：`../../deepseek/deepseek-harness`。

## 根因链

1. mint 全部子命令（含只读 `list`）以**读写模式**打开 sqlite db，db 落点
   `~/.local/share/mint/projects/<project>/mach-*.db`（`$XDG_DATA_HOME/mint`，workspace 外）。
2. macOS 沙箱方言 = Seatbelt：profile `(allow default)(deny file-write*)` 仅放行
   `writableRoots`（= workspaceRoot + `/tmp` + `os.tmpdir()`，硬编码）。读全放行，写只在根内。
3. mint 的 sqlite 写落在根外 → EPERM → bash 工具附加
   `[sandbox: file access denied under workspace-write mode]` 标记 → 模型只能逐次提权重试
   （`approveEscalation` → `ctx.approval.request` → 用户审批）。
4. 实验实锤：`cp ~/.local/share/mint/projects/dsh-mint/mach-*.db /tmp/mint-copy.db &&
   MINT_DB_PATH=/tmp/mint-copy.db mint list` 同会话 exit 0——db 落点进入写放行区即无痛。
5. 插件自身 `runMint()`（src/mint.ts，#18）直 spawn 不经沙箱、不受影响——痛点是
   **模型手动 bash 跑 mint** 逐次要审批。

## 源码位置（deepseek-harness）

- 写根推导：`packages/sandbox/sandbox/src/roots.ts` `writableRoots()`；
  策略接口 `src/index.ts` `SandboxExecutionPolicy`（仅 mode/workspaceRoot/sessionId）。
- 策略解析：`packages/sandbox/sandbox-policy/src/index.ts` `SandboxPolicyService.resolve()`——
  session cwd 即 workspace 边界；**无额外根配置口**。
- Seatbelt 方言：`packages/sandbox/sandbox-local/src/profiles.ts` `seatbeltProfileArgs()`；
  bwrap/landlock 同文件。
- 提权编排：`packages/sandbox/sandbox/src/escalation.ts` `approveEscalation()`——
  reason=`escalate sandbox to <mode>: <justification>`，**不带命令文本**。
- 审批分发：`packages/interaction/user-approval/src/index.ts` `ApprovalService.decide()`——
  `ctx.waterfall('approval/request', req, ...)`，任意插件可挂 answerer；
  req={agent, toolName, callId, reason, signal}。
- 工具 pipeline：`packages/core/tools/src/index.ts`——`tools/pre-execute`
  （allow/deny/ask，无改写）；`tools/post-execute` 的 `PostToolDecision` accept 可
  **替换 content 投影**；`ToolExecution.arguments` 含解析后参数。
- shell env：`packages/shell/shell-env/src/index.ts`——只管理 `DSH_*` 前缀变量，
  **无法注入 `MINT_DB_PATH`**。

## 方案对比

| 方案 | 做法 | 优点 | 代价/风险 |
|---|---|---|---|
| **A. post-execute 替换（推荐）** | dsh-mint 挂 `tools/post-execute`：bash + 严格 `^mint( \|$)` 命令 + 结果带 denial 标记 → `runMint()` 直 spawn → accept 替换 content | 零上游改动、沙箱不动、无审批弹窗、插件内闭环（复用 #18） | 命令解析必须严格（含 `;`/`&&` 等元字符不拦）；原调用 audit 仍是 denied 记录；denied 结果的 isError 语义需实载验证 |
| B. 审批 answerer 自动放行 | 挂 `approval/request`（prepend）：`req.reason` 匹配 `^escalate sandbox to danger-full-access: mint ` → allowed-once | 代码量最小 | 每调用整体 danger-full-access；匹配靠模型 justification 文本（可伪造）；审批链被绕过 |
| C. 上游额外写根 | deepseek-harness：`SandboxExecutionPolicy` 加 `writableRoots`，roots.ts 合并，seatbelt/bwrap/landlock/fs-fence 四处同步，composition 放行 `$XDG_DATA_HOME/mint` | 最正统：mint 原生跑在沙箱内、audit 干净、全项目受益 | 改动面大（四处方言+围栏+测试），需 fork 合并/发布；本机依赖上游版本 |
| D. 项目内 db | 显式 `MINT_DB_PATH=$PWD/.mint/mint.db`（见 notes/mounting.md §5） | 零代码、已验证可用 | 单文件模式（弃多项目目录）、数据落点改变需迁移、shell-env 无法默认注入 env → 非"无痛" |

备选/排除：工具化 mint（注册专用 tool 供模型调用）——可用但需改 skill 行为、不解决 bash 直跑；
会话级 `danger-full-access` / `ctx.shell.sandboxMode` 全局改——太宽；
`~/.local/share/mint/...` symlink 进 workspace——逐项目手工 + 脆弱。

## 上游提案检索（2026-08-30，gh 核实）

`deepseek-ai/deepseek-harness`：**issues 已禁用、PR 列表为零、discussions 无技术提案**——
公开渠道没有任何类似提案。但仓库内 `.agents/notes/` 设计档案有直接相关记录：

- `implemented/feature/2026-07-06-sandbox.md` L59/L72：**额外可写根（extra writable-root grants）
  是上游明确考虑过、两次推迟未做的开放项**（Landlock launcher 已支持 `--rw <path>`）；
  上游把 ad-hoc grants 定性为「escalation-scope 问题」，刻意留在核心沙箱词汇之外（ACP 的
  `additionalDirectories` 留在桥层）。→ C 方案若提 PR，会撞上这个被搁置的 scope 设计。
- 同 RFC L87 + approval 笔记 L90/L101：**`allow_always` 持久授权是正规 Deferred 开放项**，
  scope 候选明列 call/path/prefix/session/time-window——「command-prefix」正是 mint 场景。
- 同 RFC L145：**「同调用内自动重试」被明确 rejected**（"a hidden re-entry the log cannot
  reconstruct: one tool/call would have produced two executions"）——A 方案正是该反模式的变体。
- `proposed/feature/2026-06-30-pre-tool-input-rewrite.md`：上游对「历史/审计/呈现三者一致」
  的原则性坚持，佐证 A 的 audit 问题非审美而是设计冲突。

## 结论与后续（已定案）

- **0.1.0 收尾选 B-v2（已实施，plan #6）**：dsh-mint 宿主面挂审批放行 gate——
  每会话首条 mint 提权经用户批准一次，此后同会话 mint 命令预置提权自动放行、
  零弹窗零拒绝往返；每次放行落 approval 审计对，无 hidden re-entry（避开 L145 反模式）。
  `config: { autoApprove: true }` 可跨会话免批（显式信任 mint CLI）。
- **0.1.0 终局：宿主工具化（plan #7，已实施）** —— 见下「#38/#34/#39 之后的现状」。
  B-v2 gate **降为 bash 偶发兜底**（保留原样，不再承担零授权职责）。
- **上游贡献 B-v3/C**：`allow_always` scope 与 extra writable roots 均为上游自己的开放项，
  在 `../../deepseek/deepseek-harness` fork 提出需先解开 scope 设计——另立 issue 跟进，
  不在 0.1.0 阻塞路径上。

## #38/#34/#39 之后的现状（2026-09）

模型日常 mint 操作改走宿主工具 **`mint`**（`src/mint-tool.ts`）：execute 内经 `runMint` 在
**插件进程内** spawn mint CLI，不经 bash、不进会话文件沙箱 → **设计上零授权**。
skill 与模型可见文案全部改为工具形态（`src/context.ts` 的提权话术已删除并换成工具优先指引）。
引导走本仓 `skill/`（#38 起与 mint 子模块 git 层解耦），不再依赖上游 skill。

**修正旧结论「子代理被 pin 到 approval `never`，B-v2 不适用 ⇒ 子代理跑 mint 无解」**：
`mint` 工具注册在 root ctx（global layer），子代理一并继承；正因为子代理不能提权，
**工具路径是子代理唯一的可用路径**，缺口由此关闭。

上游设计张力仍然成立且本方案正面回应：上游 rejected 的「同调用内自动重试」（hidden re-entry）
是 post-execute 替换方案的形态；**注册宿主工具是显式能力**，模型直接调用，durable
`tool/call` + `tool/result` 审计完整（`notes/dsh/0.1.0/07`）——「零授权」来自换设计
（工具即能力、不进沙箱），不是绕过审批。
