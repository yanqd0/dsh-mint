# notes/ 项目记忆索引

> notes/ 是对内中文记录目录（`docs/` 留给未来对外 i18n 文档，暂不做）。
> **新会话先读本索引**，它指向全部权威文档；内容变化时同步更新本文件。

| 文件 | 内容 |
| --- | --- |
| [dsh-plugin-dev.md](dsh-plugin-dev.md) | DSH 插件开发调研：挂载补丁语法、loader 模块解析、inject DI、真实事件/工具签名、沙箱架构、开发环与验证手段、历史教训 |
| [mounting.md](mounting.md) | dsh-mint 挂载与安装指南（含 workspace-write 下 mint 放行选项） |
| [mint-sandbox.md](mint-sandbox.md) | workspace-write 下 mint 执行放行：根因链、四方案对比、上游提案检索、B-v2 定案与 #38/#34/#39 后的工具化终局（#23/#24） |
| [isolated-install.md](isolated-install.md) | 发布包隔离实测法（PNPM_HOME/DSH_HOME）：标准步骤、检查点、三个实证坑（#30） |
| [install-check.md](install-check.md) | 安装/自动使用**快速自检清单**（1 分钟）：挂载行、dist/skill 产物、`mint` 工具/`[Mint]` 判定、**零授权验证**——跑相同 dogfooding 任务前先跑它 |
| [graph-memory-silent-mechanism.md](graph-memory-silent-mechanism.md) | graph-memory 静默运行（零授权）机制调研 + dsh-mint 迁移性评估：不经 bash、插件进程内跑 CLI/直写 db 的信任边界；方案 A 已落地为宿主 `mint` 工具 |
| [mint-skill-sync.md](mint-skill-sync.md) | mint 升级后 skill 复核法：`--help-llm` 对账 + 逐命令 `--help`（补 version 类参数）+ 对照上游 `src/cli`；本轮 0.8/0.9 坑位表（#70–#78） |
| [client-face.md](client-face.md) | 客户端面实测契约（0.2.0-rc.2）：右侧边栏 tab 类型与 body seat、`dsh.client` + `__ModuleLoader__` 产物、PLATFORM_MODULES、webServer 只读路由通道、locale/主题 token、验证手段与坑（#9/#10/#11） |
| [client-architecture.md](client-architecture.md) | 客户端面**架构与数据流**：双半边/双产物、三条通道、一次列表请求的时序、状态归属、信任与暴露面、验证阶梯、0.2.0 边界（含 mermaid 图） |
| [session-cost-review.md](session-cost-review.md) | 一次真实会话的 token 复盘：mint 每请求注入预算与实测占比、工具结果分布、dsh-dev-dsh 使用效果与「仍需读源码」清单 |
