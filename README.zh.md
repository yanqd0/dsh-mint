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
  running milestone，以及"新 plan 与独立 issue 默认挂它"的口径；`mint doctor`
  报出健康告警（陈旧 plan、空转 milestone、停滞的 dev 工作）时，再多一行计数
  并指向该工具。
- **`mint` 工具，零授权** —— agent 经宿主工具使用完整 mint CLI：mint 在插件
  进程内 spawn，不经 bash、不需要沙箱写权限、不弹审批。子代理同样继承该工具
  （子代理的 bash 被 pin 为 `never`）。危险子命令（`delete`、`import`、
  `sync`、`export`、`tui`）与全局参数 `--db` 会被拒绝。
- **跨项目操作** —— 目标项目默认取会话 cwd，**本项目操作不带 `-p`**；`-p` /
  `--project`（写在子命令之前）可在同一会话里读写另一个项目的台账：读直接放行；
  **写**操作首次弹一次确认（写明目标项目与动作），之后同一会话同一项目不再询问。
  目标项目不存在时报候选清单而不是静默新建，且 `autoApprove` 不会让它免确认。
- **plan 双向绑定** —— 项目没有活跃 mint plan 时 `exit_plan_mode` 被拒，宿主
  plan 不会与 mint plan 脱钩；本会话对 mint **零写操作**地离开计划模式时，结果里会附
  一条补登记提示——项目里的 running plan 未必是本次工作的记录。
  **非工具退出**（`/plan off`、GUI 切换）没有工具结果可挂，改由 `[Mint]` 概览
  **一次性**多出一行同样的提示；本会话一旦有 mint 写操作即消失。
- **提醒** —— `git commit`（含经宿主 `uv` 工具执行的 `uv run git commit`）后提醒 agent
  登记（`issue state commit --sha`）；`issue state` / `plan plan` / `plan close`
  成功后提醒同步宿主 todo 面板（面板的 `todos` 投影每轮重置，不写就会显示过期进度）；
  提交失败不会误提醒；工具调用失败时提示登记 issue。
- **内置 mint skill** —— 随包发布的 `mint` skill 在插件加载时 content-sync 到
  `$DSH_HOME/skills/mint`，无需手工安装 skill，agent 即知 issue/plan/milestone
  流程。
- **bash 兜底 gate** —— bash 只是兜底：仅当工具不可用或插件未安装时才走。那时
  同一会话内首次 mint 沙箱提权批准一次、后续自动放行（`autoApprove: true` 连首次
  也不再询问）。插件正常加载时，可识别的 `mint -p <项目> …` 写命令与工具走**同一道**
  跨项目确认。

模型可见的文案（注入概览与提醒）目前是中文。

## 环境要求

- DSH（`@deepseek-ai/dsh`）；宿主接口按 `0.1.1-rc.2` 验证
- Node.js >= 20
- 无需全局安装 mint：插件经自身的 `mint-faa` 依赖解析 mint CLI
  （`>=0.8.0 <1.0.0`）——见[选择 mint 入口](#选择-mint-入口)。1.0.0 以前的任意
  `mint-faa` 版本都被信任，升级 `mint-faa` 无需本插件跟发；未发布的本地构建
  用 `mintEntry`/`MINT_ENTRY` 指定

## 安装

装进 profile 即完成挂载。本包自带 DSH bundle 声明（`dsh.bundle.patch`），
`dsh plugin` 会按已装状态重算 profile 的层栈——**没有任何 YAML 需要手工编辑**。
装完重启 DSH 生效：插件配置与 profile 的包解析表都在启动时确定。

从源码安装（`dsh plugin --profile web add ./`）是 link 目录而非复制，pnpm
**不会**把被 link 包自己的依赖装进 profile。插件会先探测自身包根下的
`mint-faa`，所以仓库里改过依赖后要先 `pnpm install`（再重启）依赖链才可用——
或者直接选本地构建。

### 从 npm 安装

```sh
dsh plugin --profile web add @yanqd0/dsh-mint \
  --allow-build=@yanqd0/dsh-mint --allow-build=mint-faa
```

`web` 是 `dsh web` 用的 profile，换成其它 profile 名同理。

`dsh plugin` 实际在 `~/.dsh/profiles/web` 内跑 pnpm。pnpm 默认拦截依赖的构建
脚本，而这次安装有两个：插件的 skill 同步、`mint-faa` 下载 mint 二进制。不带
`--allow-build` 时报 `ERR_PNPM_IGNORED_BUILDS`——**而且依赖已经写进 profile
清单**，所以单纯重跑不会再重算 profile 的 bundle 列表。若已经踩到，用下面这组
命令恢复：

```sh
dsh plugin --profile web approve-builds --all      # 批准并跑掉被拦的脚本
dsh plugin --profile web remove @yanqd0/dsh-mint   # 已记录的依赖要删掉后
dsh plugin --profile web add @yanqd0/dsh-mint      # 重新 add 才会写入挂载行
```

从未请求过本包的 profile 上跑 `approve-builds` 只会输出
"There are no packages awaiting approval"，什么都没批准。一次性放行写法是
`--allow-build=<pkg>`，但它只对**注册表**依赖按名匹配——`file:`/tarball 安装
（`dsh plugin --profile web add ./`）用不上；这种场景 pnpm 10/11 可用
`--config.dangerouslyAllowAllBuilds=true`，pnpm 12 已忽略该参数。

安装失败时插件**完全没挂载**：`dsh --profile web --dump-config` 不会打印
`id: mint`。装完按下节验证。

### 从 GitHub Packages 安装

同名 `@yanqd0/dsh-mint` 同时发布到两个注册表。GitHub Packages **即使公开包也
需要认证**：使用带 `read:packages` 权限的 classic personal access token。在
`~/.npmrc`（或 `~/.dsh/profiles/<profile>/.npmrc`）写入两行：

```
@yanqd0:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

之后同样一条命令安装——npm 那节的构建脚本步骤在这里同样适用：

```sh
dsh plugin --profile web add @yanqd0/dsh-mint \
  --allow-build=@yanqd0/dsh-mint --allow-build=mint-faa
```

### 从源码安装（开发）

```sh
git clone https://github.com/yanqd0/dsh-mint.git
cd dsh-mint
pnpm install && pnpm build
dsh plugin --profile web add ./
```

link 目录不需要构建脚本批准（pnpm 不为 `link:` 依赖跑生命周期脚本），所以挂载行
会立即写入；内置 skill 在插件加载时同步。

### 验证

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # 必须是 1
```

`id: mint` 恰好出现一次、且没有 `patch:` 警告，即为挂载成功。重复挂载（profile
里手写的 `insert` 行与 bundle 声明并存）会显示为 2 次，并在启动时报
`duplicate loader entry id: mint`。

### 选择 mint 入口

插件需要一个 mint 可执行程序：已发布的 `mint-faa` 薄封装（默认，跑它对应版本的
官方二进制）或本地构建的 mint。用一个旋钮二选一——挂载行的 `mintEntry` 选项，或
环境变量 `MINT_ENTRY`；两者同时存在时以挂载行为准。

| 模式           | 怎么选                                                                                                       | 实际跑什么                                                                                    |
| -------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------- |
| 依赖链（默认） | 不写，或 `mintEntry: dependency`                                                                             | 已安装插件包内 `mint-faa` 的 `run-mint.js`，它执行该 `mint-faa` 版本对应的官方 release 二进制 |
| 本地构建       | `mintEntry: ~/bin/mint`、绝对路径（如 `/path/to/mint/target/release/mint`）、或裸名 `mint`（走 `PATH` 查找） | 直接执行该可执行程序                                                                          |

任一旋钮写 `dependency` 都是**哨兵**：即使另一个旋钮写了路径，也强制走依赖链——
开发 profile 固定成本地构建、但仍要验证已发布链路时很有用。

```sh
# 会话实际会跑哪个 mint？（不需要 DSH）
node node_modules/@yanqd0/dsh-mint/dist/check-mint-entry.js --mode dependency
node node_modules/@yanqd0/dsh-mint/dist/check-mint-entry.js --mode local --entry ~/bin/mint
```

两条都会打印模式、入口标签（`mint-faa@<版本>`、`PATH:mint` 或解析后的构建路径）
和 `-V` 输出；入口跑不起来时以非零退出。注入的 `[Mint]` 行用的是同一个入口标签
（`…/target/release/mint`），因此 debug 与 release 构建可区分（#58）。

改完任一旋钮都要重启 DSH。依赖链首次调用时若安装没跑构建脚本（pnpm 默认拦截，
见「安装」），会先下载 mint 二进制——这一次可能超过 30 s 工具超时。

若 `mint` 工具报 `Cannot find module 'mint-faa/run-mint.js'`：说明 profile 里没有可用
的 `mint-faa`——要么它的构建脚本从未被批准（见「从 npm 安装」），要么在源码 link
安装下该依赖是上次 `pnpm install` 之后才加的。按上面重新安装并重启，或在仓库里跑
`pnpm install`；也可以直接把 `mintEntry` 指向本地构建。同样的故障会在 `[Mint]` 概览
里显示为 `WARNING` 行，而不是伪装成"项目里没有 issue"。

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

| 选项               | 默认值                    | 作用                                                                                                                                                   |
| ------------------ | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `autoApprove`      | `false`                   | mint 沙箱提权（bash 兜底路径）不再询问——显式信任 mint CLI。                                                                                            |
| `autoInstallSkill` | `true`                    | 插件加载时把内置 mint skill content-sync 到 `$DSH_HOME/skills/mint`。                                                                                  |
| `debug`            | `false`                   | 预留给插件的详细诊断输出。                                                                                                                             |
| `mintEntry`        | mint-faa 的 `run-mint.js` | 要运行的 mint CLI：`run-mint.js` 路径、原生 mint 二进制、`~/` 前缀路径、裸名（走 `PATH`），或 `dependency` 哨兵。见[选择 mint 入口](#选择-mint-入口)。 |

在 profile 自己的 patch 层（`~/.dsh/profiles/<profile>/cordis.patch.yml`）覆盖。
同 id 的条目**修补**已挂载的那一行，而不是再挂一次——没写的选项保持默认：

```yaml
- id: mint
  config:
    autoApprove: true
    # 用本地构建的 mint 做 dogfooding，而不是已发布的依赖
    # （`~` 会展开；裸名 `mint` 走 PATH 查找）：
    mintEntry: ~/bin/mint
    # mintEntry: dependency   # 反过来强制走已发布的 mint-faa 链路
```

环境变量 `MINT_ENTRY` 有同样效果、无需改 profile（两者同时存在时以 `mintEntry` 为准）。
两者都在启动时读取，改完任一都要重启 DSH。

## 路线图

`0.2.0` 补客户端面：**右侧边栏的 mint 面板**，从 tab 栏的新建按钮打开，与「工作区文件」「新建终端」并列。
面板以只读方式读取当前会话所在项目——issue（列表、筛选、详情）、plan 与 milestone（列表、详情）——
数据经宿主只读路由由 mint CLI 提供。`0.3.0` 把面板做成中英双语：面板自有文案两种语言各一份
（设置 → 通用 → 语言 里切换）；mint 自己的词汇——状态与 kind 值、`P0`–`P3`——两种语言都原样显示，
`Issue`/`Plan`/`Milestone` 作为 mint 关键概念保留英文。

## 开发

```sh
pnpm dev           # 用 tsx 运行插件入口
pnpm build         # tsup + skill 拷贝 → dist/
pnpm test          # vitest
pnpm lint          # ESLint
pnpm check-types   # tsc --noEmit
```

[`AGENTS.md`](AGENTS.md) 是给编程 AI 的项目导航（中文）：定位、硬约束与架构事实。
`notes/` 放对内中文工程记录；[`docs/RELEASING.md`](docs/RELEASING.md) 是对外的发布
runbook（`docs/` 其余 i18n 工作暂不做）。

## 许可证

[MIT](LICENSE)
