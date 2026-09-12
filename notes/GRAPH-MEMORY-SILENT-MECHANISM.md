# graph-memory 静默运行机制调研 + dsh-mint 迁移性评估

> 目的：同为「在 workspace 外写文件」的宿主插件，graph-memory 从不触发沙箱授权弹窗，
> 而 dsh-mint 虽完成 B-v2 gate 测试，模型手动经 bash 跑 mint 时仍会走授权往返。
> 本文调研 graph-memory 的实现机制（来源：profile 已装 `graph-memory@1.6.0-beta.14` 源码
> 与其自带文档），并评估 dsh-mint 能否照搬。
> 结论先行：**能，且基建已在 —— 机制翻译过来就是「不经 bash、在插件进程内跑 mint CLI +
> 把操作暴露为宿主工具 + 让 skill/检查清单改走工具」**。graph-memory 只是把这件事做全了。

---

## 1. graph-memory 部署形态（它也是一种 dsh-mint 同类宿主插件）

- 挂载：作为 profile `dsh.profile.bundles` 里的一条 **bundle**（`"graph-memory": "github:adoresever/graph-memory"`）。
  包自带 `cordis.patch.yml`，注册入口 `graph-memory/dsh`（即 `dsh.ts`/`dist/dsh.js`）。
- DI 声明：`inject = ["tools","llm","systemPrompt","agentLoop","agents","sessions","credentials","tokenMeter"]`。
- 数据落点：`config.dbPath = dshHomePath('graph-memory/graph-memory.db')` =
  `~/.dsh/graph-memory/graph-memory.db`（better-sqlite3，`openDb()` 在 `apply()` 里直接打开）。
  位置同样在**会话 workspace 之外**（`~/.dsh/...`），与 mint 的 db（`$XDG_DATA_HOME/mint/...`）性质相同。

---

## 2. 它为何静默（零授权）—— 核心机制

> 一句话：graph-memory 的一切文件 IO 与模型调用都发生在**插件进程内**，而插件进程是
> host-trusted、**从不经过 `bash` 工具**，因此**根本不进入会话文件沙箱，也就没有授权一说**。

DSH 的沙箱/授权只包裹特定工具（bash/shell/file 这类会执行外部命令或碰外部文件的工具）。
宿主插件用 cordis DI + 事件钩子在 harness 主进程里跑，其自身写文件、`ctx.tools.register`
注册的工具、以及它自己 spawn 的子进程，都不受会话 `workspace-write` 沙箱约束。证据链：

1. **直写 DB**：`apply()` 顶部 `const db = openDb(config.dbPath)`，随后所有 `upsertNode`/
   `saveMessageOnce`/`markMessagesExtracted` 等同步落库，全程在插件进程内 —— 不经 Seatbelt/bwrap/landlock。
   实测：本 session 内 `~/.dsh/graph-memory/graph-memory.db-wal` 持续被改写，从无授权事件。
2. **事件驱动，无需模型主动触发**：挂 DSH 生命周期事件做背景抽取——
   - `session/event`：`turn/end` 后 `scheduleExtract()`，每个完成 turn 排一个**串行 worker**，
     读该 turn 的 user 问题 + 最终答复，用 `ctx.llm.stream()` 调抽取模型出结构化三元组再落库；
     `user/message` 时做挂接兜底；`request/header` 时记模型路由。
   - `agent/created` + `agent/session-start`：给具体 Agent 挂 `agent.ctx.on('agent/pre-step')`
     （graph-memory 注释点明：pre-step 走 agent 作用域，须挂在 `agent.ctx` 而非宿主 ctx —— 和
     dsh-mint `registerMintContext(agent.ctx)` 同一处教训）。
3. **召回 = 注入合成消息，不需要工具调用**：`agent/pre-step` 里 `recaller.recall(query)` 得到节点，
   拼成一段 `Historical memory is untrusted ...` 文本，构造一条 `source.kind='plugin', form='snapshot'`
   的 **user 合成消息**，`insertDshRecallBeforeCurrentUser()` 插到当前用户问题**之前** —— 这正是我们会话
   顶部看到的知识图谱 `<knowledge_graph>/<episodic_context>` 块。默认 `assistantTools:'none'` 都不开检索工具，
   自动召回就够用。
4. 附带的上下文滚动压缩 / 已完成 turn 工具轨迹投影：无 LLM 调用，走事件序列 shadow + token 计价。
5. 维护 tick：`maintenanceInterval` 计数触发 PageRank / 社区 / retention GC，定时后台跑。
6. 模型从不跑外部 CLI，也无需为一个写操作去「用 bash 提权」→ 授权往返**在设计上不存在**。

---

## 3. dsh-mint 现状 —— 已具备同款机制的一半，缺口在「覆盖面 + 行为引导」

dsh-mint 已经拥有的「不经沙箱执行 mint」的**全套基建**：

- `src/mint.ts runMint()`：`spawn(process.execPath, [mint-faa/run-mint.js, ...args], {cwd})`，
  在**插件自身进程**里直跑 mint CLI（源码注释 + `notes/MINT-SANDBOX.md` #18：插件子进程不经会话文件沙箱）。
- 已在三处复用、全部**零授权运行**：
  - `src/context.ts`：`agent/session-start` 时 `runMint(... list --json)` 注入 `[Mint]` 概览（等价 graph-memory 注入）；
  - `src/planbind.ts`：`tools/pre-execute` 对 `exit_plan_mode` 用 `runMint(plan list)` 做绑定门禁；
  - `src/mint-tool.ts`：注册宿主工具 `mint`（args 透传全命令面），execute 内 `runMint`
    （注释：plugin 进程不被会话沙箱约束）。

**缺口一（已修复，#34）：宿主工具曾只有 `mint_query` 一个只读工具。** 其余 model 日常要跑的
`issue add / state start|commit|close / plan create / plan attach / milestone create ...`
等状态操作没有任何宿主工具 → 模型只能退回 bash 跑 `mint <子命令>`。
现由 `mint` 工具覆盖全命令面（危险子命令白名单拒绝）。

**缺口二（已修复，#38/#35）：行为曾被 skill/检查清单「焊死」在 bash 上。** 自动安装的 `mint` skill
（当时源自 `mint/` 子模块，dsh-mint 只 content-sync `dist/skill` → `~/.dsh/skills/mint`）以及
`notes/INSTALL-CHECK.md`、`AGENTS.md` 全都指示「用 bash 跑 `mint ...`」。
现 skill 源已迁入本仓 `skill/`（与上游子模块 git 层解耦），并重写为 DSH 单宿主、以 `mint`
工具为唯一操作面；INSTALL-CHECK/AGENTS 口径同步过渡（#36）。

### 为什么 B-v2 之后「仍有授权问题」（治标）
- mint 所有子命令都以**读写模式**打开 db，落点在 workspace 外 → 模型 bash 跑 `mint` 必被
  `workspace-write` 沙箱拒 → 只能预置 `danger-full-access` 提权 → `approval/request`。
- `src/approval-gate.ts`（B-v2，#25）把这段从「每次弹窗」降到「**每会话首条真人批一次 + 会话内
  自动放行**」，但：
  - 每条 mint 命令仍落 `approval/asked` + `approval/decided` 审计对（只是 1–2ms 自动批）；
  - **跨新会话**首条仍要真人批准，除非 `config.autoApprove: true`；
  - gate 只认**单条裸** `mint ...`（无 `;`/`&&`/引号/管道），复合命令、子代理（pin 到 approval `never`）
    都不走 gate → 仍弹窗或失败；
  - 本质仍是「bash 跑外部 CLI + 提权」的隐式通道，非零设计。
- 早在 `notes/MINT-SANDBOX.md` 就把「**工具化 mint**」列为备选，但当时搁置，理由写的是
  「可用但需改 skill 行为、**不解决 bash 直跑**」—— 这正是本案的抓手：不解决 bash 直跑，
  是因为当时没同时改掉「让它去跑 bash」的那个 skill/文档。

---

## 4. 能否改用相同机制：可行，且推荐 —— 翻译对照

graph-memory 的做法对 mint 不能字面照搬：mint 项目硬约束是**依赖 mint CLI（--json）、不直读 mint db**，
所以不能像 graph-memory 那样 `openDb` 直写。但 graph-memory 机制的**信任边界本质**完全可迁移：

> graph-memory 免授权 = 「写文件/调模型在插件进程内完成，不经过 bash 工具」。
> 对 mint 翻译 = 「mint CLI 在插件进程内被 `runMint()` 调用，不经过 bash 工具」。
> 两者在 harness 眼里是同一种东西：**宿主插件可信任执行**。`runMint` 直跑一个能写 db 的 CLI，
> 并不比 graph-memory 直写 db 更越权 —— 都绕开了只包裹 bash 工具的会话沙箱。

因此 dsh-mint 对齐 graph-memory 的落地 = **把 model 日常要跑的 mint 子命令全部注册成宿主工具
（execute 内 `runMint`），并让 skill / 检查清单改走工具而不是 bash**。工具一经注册就由 agent loop
在宿主内执行、不进沙箱、**零授权**。**（已落地，#34 起为 `mint` 工具——单个 argv 透传工具覆盖
mint 全命令面，取代原先只读的 `mint_query`。）**

> 落地实况（2026-09）：`mint` 工具为**薄透传**——不注入也不改写任何 flag，输出即 mint 原生
> TSV（`list` 默认每页 5 条），`--help` 经同一工具自发现；白名单拒绝 `delete`/`import`/`sync`/
> `export`/`tui` 与 `--db`/`--project`。零格式逻辑使其对未来输出格式演进（如 TOON）天然兼容。

### 对比三方案

| 方案 | 做法 | 授权体验 | 代价 / 风险 |
|---|---|---|---|
| **A（对齐 graph-memory，推荐；已落地为 plan #7）** | 补宿主工具：读 + 状态机/plan/issue 写操作，execute 内 `runMint`；skill 与 INSTALL-CHECK 改指示「调用工具」 | **设计上零授权**（不再经 bash）；审计干净 | 需覆盖 mint 子命令面 + 重写 skill（已随 #38 解耦为**本仓 `skill/`**，不再依赖上游）与仓库内检查清单；仍有模型「图省事直接 bash」的偶然路径 → 保留 B-v2 兜底 |
| **B（现状，最小改）** | 沿用 B-v2，把挂载行 `config.autoApprove: true` 打开 | 跨会话免批、会话内自动 | 仍逐条落 ask/decided 审计；只认单条裸 mint；子代理/复合命令不管；治标 |
| C（上游根治） | 上游 extra writable-roots / `allow_always` scope（mint 官方 fork 曾搁置的开放项） | 最正统、全项目受益 | 需 fork 合入 + 依赖上游版本，非 0.1.0 路径（见 MINT-SANDBOX） |

### 迁移后仍保留的东西
- `runMint()`、事件钩子、context 注入、planbind、reminders **全部不动** —— 只增宿主工具 + 改引导文档。
- `approval-gate.ts` 作为**兜底保留**：模型偶发仍从 bash 跑裸 mint 时，本会话内仍自动放行，不回归。

---

## 5. 落地记录（方案 A 已实施，plan #7）

1. ~~抽通用宿主工具 + 类型化高频工具二选一~~ → **已定案：单一 `mint` 工具、argv 透传**，
   不做类型化工具组（避免与 CLI 演进漂移）；参考模板已从 `query.ts` 演化为 `src/mint-tool.ts`（#34）。
2. ~~改 skill 说明并重新 content-sync 子模块~~ → **skill 源已迁入本仓 `skill/`**（#38 取消子模块），
   并重写为 DSH 单宿主、工具优先（#35）。
3. `notes/INSTALL-CHECK.md` §5 已从「bash 放行验证」过渡为「**工具零授权验证**」（#36）。
4. 回归：新会话不 bash、纯工具跑完整 dogfood，取证看 session JSONL（telemetry 默认关）——见 #37。

## 速查（证据位置）
- graph-memory 入口：`~/.dsh/profiles/web/node_modules/graph-memory/{dsh.ts,index.ts}`（dsh.ts=DSH 适配）；
  事件挂接与召回注入见 `dsh.ts` 的 `session/event`/`agent/pre-step`/`compactBeforeStep`/`insertDshRecallBeforeCurrentUser`；
  运行库 `~/.dsh/graph-memory/graph-memory.db(-wal/-shm)`。
- dsh-mint：`src/mint.ts`（runMint）、`src/query.ts`（宿主工具范式）、`src/approval-gate.ts`（B-v2 兜底）、
  `notes/MINT-SANDBOX.md`（#23/#24 调研与四方案，本文承接其「工具化」被搁置项）。
