# dsh-mint

[![npm](https://img.shields.io/npm/v/@yanqd0/dsh-mint.svg)](https://www.npmjs.com/package/@yanqd0/dsh-mint)
[![CI](https://github.com/yanqd0/dsh-mint/actions/workflows/ci.yml/badge.svg)](https://github.com/yanqd0/dsh-mint/actions)
[![codecov](https://codecov.io/gh/yanqd0/dsh-mint/graph/badge.svg)](https://codecov.io/gh/yanqd0/dsh-mint)

[English](README.md) | 中文

把 [mint](https://github.com/yanqd0/mint) 的事项跟踪装进 DSH 会话：每个会话
一开始就知道还有什么没做，每次改动都留下登记，宿主 plan 背后始终有一个 mint
plan。

## 功能

- **会话上下文** —— 每个会话开头注入 `[Mint]` 概览：活跃 issue 前列、当前
  running milestone，以及"新 plan 与独立 issue 默认挂它"的口径。
- **`mint` 工具，零授权** —— agent 经宿主工具使用完整 mint CLI：mint 在插件
  进程内 spawn，不经 bash、不需要沙箱写权限、不弹审批。子代理同样继承该工具
  （子代理的 bash 被 pin 为 `never`）。危险子命令（`delete`、`import`、
  `sync`、`export`、`tui`）与全局参数 `--db` / `--project` 会被拒绝。
- **plan 双向绑定** —— 项目没有活跃 mint plan 时 `exit_plan_mode` 被拒，宿主
  plan 不会与 mint plan 脱钩。
- **提醒** —— `git commit` 后提醒 agent 登记（`issue state commit --sha`）；
  工具调用失败时提示登记 issue。
- **内置 mint skill** —— 随包发布的 `mint` skill 在插件加载时 content-sync 到
  `$DSH_HOME/skills/mint`，无需手工安装 skill，agent 即知 issue/plan/milestone
  流程。
- **bash 兜底 gate** —— 万一工具不可用，同一会话内首次 mint 沙箱提权批准一次，
  后续自动放行；`autoApprove: true` 连首次也不再询问。

模型可见的文案（注入概览与提醒）目前是中文。

## 环境要求

- DSH（`@deepseek-ai/dsh`）；宿主接口按 `0.1.1-rc.2` 验证
- Node.js >= 20
- 无需全局安装 mint：插件经自身的 `mint-faa` 依赖解析 mint CLI

## 安装

装进 profile 即完成挂载。本包自带 DSH bundle 声明（`dsh.bundle.patch`），
`dsh plugin` 会按已装状态重算 profile 的层栈——**没有任何 YAML 需要手工编辑**。
装完重启 DSH 生效。

### 从 npm 安装

```sh
dsh plugin --profile web add @yanqd0/dsh-mint
```

`web` 是 `dsh web` 用的 profile，换成其它 profile 名同理。

`dsh plugin` 实际在 `~/.dsh/profiles/web` 内跑 pnpm。pnpm 11 默认拦截依赖的
构建脚本并报 `ERR_PNPM_IGNORED_BUILDS`——用 pnpm 自己的批准命令放行（不必改
任何 YAML），再重跑安装：

```sh
dsh plugin --profile web approve-builds --all
dsh plugin --profile web add @yanqd0/dsh-mint
```

若接受安装时允许所有构建脚本，也可一步完成：

```sh
dsh plugin --profile web add @yanqd0/dsh-mint --config.dangerouslyAllowAllBuilds=true
```

### 从 GitHub Packages 安装

同名 `@yanqd0/dsh-mint` 同时发布到两个注册表。GitHub Packages **即使公开包也
需要认证**：使用带 `read:packages` 权限的 classic personal access token。在
`~/.npmrc`（或 `~/.dsh/profiles/<profile>/.npmrc`）写入两行：

```
@yanqd0:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

之后同样一条命令安装：

```sh
dsh plugin --profile web add @yanqd0/dsh-mint
```

### 从源码安装（开发）

```sh
git clone https://github.com/yanqd0/dsh-mint.git
cd dsh-mint
pnpm install && pnpm build
dsh plugin --profile web add ./
```

### 验证

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # 必须是 1
```

`id: mint` 恰好出现一次、且没有 `patch:` 警告，即为挂载成功。重复挂载（profile
里手写的 `insert` 行与 bundle 声明并存）会显示为 2 次，并在启动时报
`duplicate loader entry id: mint`。

## 用法

在 mint 管理的项目里开会话：首轮就注入 `[Mint]` 概览，内置 skill 会把
issue → plan → milestone 的流程教给 agent。日常用自然语言说需求（"下一步做什么"、
"把这个 bug 记下来"）即可，agent 会用 `mint` 工具驱动 mint——你也可以直接要求
下面这些调用：

| 你想要              | 背后的工具调用                                             |
| ------------------- | ---------------------------------------------------------- |
| 列出未完成 issue    | `mint({args:["list"]})` —— 一页 TSV，默认 5 条             |
| 登记一个 bug        | `mint({args:["issue","add","<标题>","--kind","problem"]})` |
| 开始做某个 issue    | `mint({args:["issue","state","start","42"]})`              |
| 测试通过后关掉 plan | `mint({args:["plan","close","7","--test-cmd","<命令>"]})`  |

任何子命令都可达，`mint({args:["<子命令>","--help"]})` 原样返回 mint 帮助。

## 配置

| 选项               | 默认值  | 作用                                                                  |
| ------------------ | ------- | --------------------------------------------------------------------- |
| `autoApprove`      | `false` | mint 沙箱提权（bash 兜底路径）不再询问——显式信任 mint CLI。           |
| `autoInstallSkill` | `true`  | 插件加载时把内置 mint skill content-sync 到 `$DSH_HOME/skills/mint`。 |
| `debug`            | `false` | 预留给插件的详细诊断输出。                                            |

在 profile 自己的 patch 层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）覆盖。
同 id 的条目**修补**已挂载的那一行，而不是再挂一次——没写的选项保持默认：

```yaml
- id: mint
  config:
    autoApprove: true
```

## 路线图

`0.2.0` 补客户端面：会话区里的 mint tab（issue 面板），由宿主 RPC 查询支撑。

## 开发

```sh
pnpm dev           # 用 tsx 运行插件入口
pnpm build         # tsup + skill 拷贝 → dist/
pnpm test          # vitest
pnpm lint          # ESLint
pnpm check-types   # tsc --noEmit
```

[`AGENTS.md`](AGENTS.md) 是给编程 AI 的项目导航（中文）：定位、硬约束与架构事实。
`notes/` 放对内中文工程记录，`docs/` 放未来的对外英文文档。

## 许可证

[MIT](LICENSE)
