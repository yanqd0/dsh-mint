# DSH 宿主集成（host-dsh）

> 本 skill 是 **DSH 单宿主版**：不读其它宿主的 agent reference。需要宿主侧事实时读本文件。

## 执行面

- **一律用宿主 `mint` 工具**：插件进程内 spawn mint，不经 bash、不进会话沙箱、零授权；
  `args` 即 CLI 参数数组，输出原生 TSV（页脚 `# Page x/y` 在 stdout）。
- 工具注册在 **root ctx（global layer）**，所有 agent 继承；**子代理也继承**，但子代理 approval 被
  pin 为 `never`，**bash 路径对子代理不可用**——子代理只能用 `mint` 工具。
- 工具拒绝的根命令：`delete` / `import` / `sync` / `export` / `tui`，以及全局 `--db` / `--project`；
  这些须经用户确认后走 bash（常规沙箱提权审批）。

## plan 绑定门禁

- 宿主 `exit_plan_mode` 在项目**无活跃 mint plan** 时被拒绝（对应 SKILL.md「plan 双向绑定」）。
- 门禁在 `tools/pre-execute` 实现；被拒时按提示先建/挂 mint plan 再退出计划模式。

## skill 安装与生效

- skill 安装到 `~/.dsh/skills/mint`（rank 400，遮蔽其它用户级 skill），由本插件 content-sync
  （按整树比对，改任一 reference 都会重同步）。
- 同步发生在插件加载时；**改完 skill 需重启 harness**，新会话才看到新内容。

## 模型可见文案分工

- 动态概览（issue 列表 + running milestone）与静态工具指引由插件 `systemPrompt` 注入承载；
  skill 不重复这些内容，只写流程与纪律。
