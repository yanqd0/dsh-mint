# notes/ 项目记忆索引

> notes/ 是对内中文记录目录（`docs/` 留给未来对外 i18n 文档，暂不做）。
> **新会话先读本索引**，它指向全部权威文档；内容变化时同步更新本文件。

| 文件 | 内容 |
| --- | --- |
| [DSH-PLUGIN-DEV.md](DSH-PLUGIN-DEV.md) | DSH 插件开发调研：挂载补丁语法、loader 模块解析、inject DI、真实事件/工具签名、沙箱架构、开发环与验证手段、历史教训 |
| [MOUNTING.md](MOUNTING.md) | dsh-mint 挂载与安装指南（含 workspace-write 下 mint 放行选项） |
| [MINT-SANDBOX.md](MINT-SANDBOX.md) | workspace-write 下 mint 执行放行：根因链、四方案对比、上游提案检索、B-v2 定案与 #38/#34/#39 后的工具化终局（#23/#24） |
| [ISOLATED-INSTALL.md](ISOLATED-INSTALL.md) | 发布包隔离实测法（PNPM_HOME/DSH_HOME）：标准步骤、检查点、三个实证坑（#30） |
| [INSTALL-CHECK.md](INSTALL-CHECK.md) | 安装/自动使用**快速自检清单**（1 分钟）：挂载行、dist/skill 产物、`mint` 工具/`[Mint]` 判定、**零授权验证**——跑相同 dogfooding 任务前先跑它 |
| [GRAPH-MEMORY-SILENT-MECHANISM.md](GRAPH-MEMORY-SILENT-MECHANISM.md) | graph-memory 静默运行（零授权）机制调研 + dsh-mint 迁移性评估：不经 bash、插件进程内跑 CLI/直写 db 的信任边界；方案 A 已落地为宿主 `mint` 工具 |
