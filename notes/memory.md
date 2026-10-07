# notes/ 项目记忆索引

> notes/ 是对内中文记录目录（`docs/` 留给未来对外 i18n 文档，暂不做）。
> **新会话先读本索引**，它指向全部权威文档；内容变化时同步更新本文件。
>
> 规范真源：[AGENTS.md](../AGENTS.md)（仓库导航）、[src/AGENTS.md](../src/AGENTS.md)（模块边界与 TS 口径）、[tests/AGENTS.md](../tests/AGENTS.md)（测试规范）；`notes/` 只放调研与实测记录。

| 文件 | 内容 |
| --- | --- |
| [dsh-plugin-dev.md](dsh-plugin-dev.md) | DSH 插件开发调研：挂载补丁语法、loader 模块解析、inject DI、真实事件/工具签名、沙箱架构、开发环与验证手段、历史教训 |
| [mounting.md](mounting.md) | dsh-mint 挂载与安装指南：bundle 自挂载、**skill 两形态（symlink/复制）与所有权守卫、卸载收尾**、workspace-write 下 mint 放行选项 |
| [mint-sandbox.md](mint-sandbox.md) | workspace-write 下 mint 执行放行：根因链、四方案对比、上游提案检索、B-v2 定案与工具化终局；跨项目门禁「本项目」=`-p <会话 cwd 项目>` 免确认 |
| [isolated-install.md](isolated-install.md) | 发布包隔离实测法（PNPM_HOME/DSH_HOME）：标准步骤、检查点、三个实证坑 |
| [install-check.md](install-check.md) | 安装/自动使用**快速自检清单**（1 分钟）：挂载行、dist 产物与 **skill 形态判定（`--status`）/卸载检查**、`mint` 工具/`[Mint]` 判定、**零授权验证**——跑相同 dogfooding 任务前先跑它 |
| [graph-memory-silent-mechanism.md](graph-memory-silent-mechanism.md) | graph-memory 静默运行（零授权）机制调研 + dsh-mint 迁移性评估：不经 bash、插件进程内跑 CLI/直写 db 的信任边界；方案 A 已落地为宿主 `mint` 工具 |
| [mint-skill-sync.md](mint-skill-sync.md) | mint 升级后 skill 复核法：`--help-llm` 对账 + 逐命令 `--help`（补 version 类参数）+ 对照上游 `src/cli`；本轮 0.8/0.9 坑位表 |
| [client-face.md](client-face.md) | 客户端面实测契约（0.2.0-rc.2）：右侧边栏 tab 类型与 body seat、`dsh.client` + `__ModuleLoader__` 产物、PLATFORM_MODULES、webServer 只读路由通道、**locale 双语机制与术语口径**/主题 token、**插件展示元数据（`readPluginMeta` + `exports` 门禁）**、验证手段与坑 |
| [client-architecture.md](client-architecture.md) | 客户端面**架构与数据流**：双半边/双产物、三条通道、一次列表请求的时序、状态归属、信任与暴露面、验证阶梯、0.2.0 边界（含 mermaid 图） |
| [session-cost-review.md](session-cost-review.md) | 一次真实会话的 token 复盘：mint 每请求注入预算与实测占比、工具结果分布、dsh-dev-dsh 使用效果与「仍需读源码」清单 |
| [delegation.md](delegation.md) | 子代理委派实测：继承 AGENTS.md/通用工具/`mint` 工具与 skill catalog、无 `[Mint]` 注入（`delegationDepth > 0` 跳过）、审批 pin `never` 不可提权、深度默认 1；故派活必须显式给目标/范围/验收/既有结论/禁令 |
| [injection-order.md](injection-order.md) | 注入顺序与 KV cache 核验（0.2.0-rc.2）：sections 与 contexts 是两套注册表、动态快照以 user 消息追加在请求尾部 → 「动态概览排在静态指引之前致前缀缓存失效」前提不成立；含代码位置与一分钟复核手法 |
| [todo-panel.md](todo-panel.md) | 宿主 todo 面板契约（0.2.0-rc.2）：`todo_write` 全量替换 + `todo/write` 会话事件、`todos` 投影**每 `turn/start` 重置**、`conversation.input.dock` 只读渲染、插件只在状态变更后提醒（子代理跳过）与实机验证手法 |
| [management-strategy.md](management-strategy.md) | **核心管理策略一页回看**：记录必须有/顺序可换、登记 ≠ 排期与开工点两种形态（条件式：确实要开工才锁 `planned`）、plan 绑定单向与门禁判据（已拆解的非终态 plan + 同 milestone 至多一个 running）、硬门禁 vs 软信号的分工（含非计划模式下 `exit_plan_mode` 的判定源与隔离事实）、进度可见、版本与收口、强制/提示边界表 |
| [plan-dag.md](plan-dag.md) | plan DAG 规格真源：`mint_plan_dag` 四动作（init/add/set/get）与错误路径、状态文件 `/tmp/mint/dag/<sessionId>.json` 契约与原子写/按 session 锁、subagent/start\|end 生命周期配对、右侧边栏并列 `plan-dag` tab 的 SVG 分层与**红绿灯状态**（pending 黄 / running 绿闪 / done+pass 绿 / done+fail 红）、`GET /dsh-mint/dag` 信封、落点与测试清单；**§4.7 = 实时指标**：token/时长取自子会话的 `tokenUsage`/`subagentTiming` 投影、`metrics`+`sampled_at` 信封、`?`/`-` 降级、紫色无常量 token 的原因；**§1.4.1 = 落盘 `samples`**（整份严格、单条宽松的校验与写时机）、**§7 = 实现落点与实测**（文件映射、根会话归属口径、自动打开契约；§7.6 = 调研 DAG 化；**§7.7 = 空图提醒按「gap」记一次、缺 config 的 schema 路径实证、只读库症状与宿主/ skill 两条诊断**）；**worktree 四动作已拆出**（见下一行） |
| [worktree-tool.md](worktree-tool.md) | 独立工具 `worktree` 的规格真源：工具名/前缀、四动作（create/list/merge/remove）与参数、`create` 记 `target`=当前分支、`merge` 的目标分支校验与冲突不裁决、`remove` 未合并拒绝、`list` 的仓库级输出与解析（`git worktree list --porcelain` + 命名空间过滤 + `merge-base --is-ancestor HEAD` + `git log -1 --format=%cI`）、失败降级文案（git 版本 + 共享工作区串行）、prune/保留现场**占位**、落点与测试清单 |
