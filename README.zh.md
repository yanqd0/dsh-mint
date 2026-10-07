# dsh-mint

[![npm](https://img.shields.io/npm/v/@yanqd0/dsh-mint.svg)](https://www.npmjs.com/package/@yanqd0/dsh-mint)
[![CI](https://github.com/yanqd0/dsh-mint/actions/workflows/ci.yml/badge.svg)](https://github.com/yanqd0/dsh-mint/actions)
[![codecov](https://codecov.io/gh/yanqd0/dsh-mint/graph/badge.svg)](https://codecov.io/gh/yanqd0/dsh-mint)

[English](README.md) | 中文

把 [mint](https://github.com/yanqd0/mint) 的事项跟踪装进 DSH 会话：每个会话一开始
就知道还有什么没做，每次改动都留下登记，宿主 plan 背后始终有一个 mint plan。

## 功能

- **会话上下文** —— 每个会话开头注入 `[Mint]` 概览：活跃 issue 前列、当前 running
  milestone，以及「新 plan 与独立 issue 默认挂它」的口径；`mint doctor` 的健康告警
  （陈旧 plan、空转 milestone）再多一行。
- **`mint` 工具，零授权** —— agent 经宿主工具使用完整 mint CLI：mint 在插件进程内
  spawn，不经 bash、不需要沙箱写权限、不弹审批；子代理同样继承。危险子命令（`delete`、
  `import`、`sync`、`export`、`tui`）与全局参数 `--db` 会被拒绝。
- **跨项目操作** —— 目标项目默认取会话 cwd，**本项目操作不带 `-p`**；`-p` / `--project`
  可在同一会话里读写另一个项目的台账：读直接放行，**写**操作首次弹一次确认（写明目标项目
  与动作），之后同一会话同一项目不再询问。
- **plan 绑定（单向）** —— 项目没有**已拆解**的 mint plan 时 `exit_plan_mode` 被拒，
  宿主计划模式不会与 mint plan 脱钩；但**建 mint plan 不要求计划模式**。
- **右侧边栏 mint 面板** —— 从 tab 栏的新建按钮打开，与「工作区文件」「新建终端」并列，
  以只读方式显示当前会话项目的 issue、plan 与 milestone。
- **plan DAG 面板** —— 与 mint 面板并列的第二个侧边栏 tab，画出 agent 用 `mint_plan_dag`
  记录的 plan 执行图：pending、running（边框闪烁）与已定论节点，各自显示宿主从子会话实测的
  token 数与执行时长（子代理结束后仍保留为带时刻的样本），悬停显示完整标题与结论原文；
  本会话一有 DAG 就自动打开，running 节点的时间在可见期间逐秒增长。
- **提醒** —— `git commit` 后提醒 agent 登记；mint 状态变更后提醒同步宿主 todo 面板。
- **内置 mint skill** —— 随包发布的 `mint` skill 在插件加载时装到 `$DSH_HOME/skills/mint`，
  无需手工安装 skill，agent 即知 issue/plan/milestone 流程。

## 环境要求

- DSH（`@deepseek-ai/dsh`）；宿主接口按 `0.2.0-rc.2` 验证
- Node.js >= 20
- 无需全局安装 mint：插件经自身的 `mint-faa` 依赖解析 mint CLI

## 安装

装进 profile 即完成挂载。本包自带 DSH bundle 声明（`dsh.bundle.patch`），
`dsh plugin` 会按已装状态重算 profile 的层栈——**没有任何 YAML 需要手工编辑**。
装完重启 DSH 生效：插件配置与 profile 的包解析表都在启动时确定。

### 从 npm 安装

```sh
dsh plugin --profile web add @yanqd0/dsh-mint \
  --allow-build=@yanqd0/dsh-mint --allow-build=mint-faa
```

`web` 是 `dsh web` 用的 profile，换成其它 profile 名同理。

`dsh plugin` 实际在 `~/.dsh/profiles/web` 内跑 pnpm。pnpm 默认拦截依赖的构建
脚本，而这次安装有两个：插件的 skill 安装、`mint-faa` 下载 mint 二进制。不带
`--allow-build` 时报 `ERR_PNPM_IGNORED_BUILDS`——**而且依赖已经写进 profile
清单**，所以单纯重跑不会再重算 profile 的 bundle 列表。若已经踩到，用下面这组
命令恢复：

```sh
dsh plugin --profile web approve-builds --all      # 批准并跑掉被拦的脚本
dsh plugin --profile web remove @yanqd0/dsh-mint   # 已记录的依赖要删掉后
dsh plugin --profile web add @yanqd0/dsh-mint      # 重新 add 才会写入挂载行
```

### 从 GitHub Packages 安装

同名 `@yanqd0/dsh-mint` 同时发布到两个注册表。GitHub Packages **即使公开包也
需要认证**：使用带 `read:packages` 权限的 classic personal access token。在
`~/.npmrc`（或 `~/.dsh/profiles/<profile>/.npmrc`）写入两行：

```
@yanqd0:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

之后按 npm 那节的方式安装。

### 验证

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # 必须是 1
```

`id: mint` 恰好出现一次、且没有 `patch:` 警告，即为挂载成功。

### 卸载

内置 skill 装在 profile 之外，所以移除插件**不会**带走它。两件事要一起做：

```sh
# 趁包还在（或从源码仓库：scripts/install-dsh.sh --uninstall）：
node ~/.dsh/profiles/web/node_modules/@yanqd0/dsh-mint/dist/install-skill.js --uninstall
dsh plugin --profile web remove @yanqd0/dsh-mint
```

包已经删掉时，先确认再手工清理（第 2 行是 `name: mint` 就说明是插件的副本；
若是符号链接则只摘链接、不跟随）：

```sh
head -2 "$HOME/.dsh/skills/mint/SKILL.md"
rm -rf "$HOME/.dsh/skills/mint"
```

## 用法

在 mint 管理的项目里开会话：首轮就注入 `[Mint]` 概览，内置 skill 会把
issue → plan → milestone 的流程教给 agent。日常用自然语言说需求（「下一步做什么」、
「把这个 bug 记下来」、「开始做 #42」）即可，agent 会用 `mint` 工具驱动 mint——
它覆盖 mint 的每一个子命令。

## 配置

在 profile 自己的 patch 层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）覆盖。
同 id 的条目**修补**已挂载的那一行，而不是再挂一次；没写的选项保持默认：

```yaml
- id: mint
  config:
    # mint 的沙箱提权（bash 兜底路径）不再询问——显式信任 mint CLI（默认 false）：
    autoApprove: true
```

日常只需要动 `autoApprove`。其余选项（`mintEntry`、`autoInstallSkill`、`debug`）
是开发用开关，见 [CONTRIBUTING.md](CONTRIBUTING.md)。

## 参与开发

欢迎提 issue 与 PR——开发环、完整配置与排障参考都在
[CONTRIBUTING.md](CONTRIBUTING.md)。编程 AI 从 [AGENTS.md](AGENTS.md) 开始，
`notes/` 放对内工程记录。

## 许可证

[MIT](LICENSE)
