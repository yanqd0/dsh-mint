# 挂载 @yanqd0/dsh-mint 到 DSH（对内记录）

dsh-mint 是 DSH 宿主插件（`@deepseek-ai/dsh`，cordis 插件系统）+ 内置 `mint`
skill。`@yanqd0/dsh-mint` 从自己的 `mint-faa` 依赖解析 `mint` CLI——无需全局安装。

## 前置条件

- DSH CLI（`@deepseek-ai/dsh`）
- 裸包名从 harness 自身 node_modules 解析（插件须装进 profile 的 node_modules）

## 1. 安装插件

```sh
dsh plugin --profile web add @yanqd0/dsh-mint   # 已发布包（同名双注册表：npmjs + GH Packages）
```

**安装即挂载**：本包自带 `dsh.bundle` 声明（包根 `cordis.patch.yml`），
`dsh plugin` 在 pnpm 之后按已装状态重算 `dsh.profile.bundles`，声明了
`dsh.bundle.patch` 的依赖自动进层栈——**无需手改 profile 的 cordis.patch.yml**。
dev 流程同样一条命令：

```sh
cd /path/to/dsh-mint
pnpm build
dsh plugin --profile web add ./
```

`dsh plugin` 实际在 `~/.dsh/profiles/web` 内跑 pnpm。pnpm 11 默认拦截该
profile 依赖链的构建脚本并报 `ERR_PNPM_IGNORED_BUILDS`。不需要手工改
`pnpm-workspace.yaml`，直接用 dsh 转发 pnpm 的批准命令：

```sh
dsh plugin --profile web approve-builds --all
dsh plugin --profile web add ./
```

若接受安装时允许所有构建脚本，也可一步完成：

```sh
dsh plugin --profile web add ./ --config.dangerouslyAllowAllBuilds=true
```

## 2. 挂载行（bundle 声明，通常无需手工操作）

包根 `cordis.patch.yml` 是本插件的挂载声明（`package.json` 的
`dsh.bundle.patch` 指向它，且列入 `files` 随包发布）：

```yaml
- insert:
    - id: mint
      name: '@yanqd0/dsh-mint'
      config: {}
```

**新插件必须用 `insert` 列表**——裸 `- id/name` 行是配置*覆盖*语义，会报
`patch: entry "mint" not found`。

**`config` 必须显式给**（空对象即可，全部走 zod 默认值）。缺 config 时宿主
校验插件导出的 zod object 会失败，profile 启动报：

```
dsh: plugin tree failed to load: failed to apply loader entry mint (@yanqd0/dsh-mint):
invalid config: - Required (at )
```

### 遗留：手写 profile patch（#5 时代的做法）

`~/.dsh/profiles/<profile>/cordis.patch.yml` 里手写的同一段 `insert` 仍然有效，
但**与 bundle 声明并存会重复挂载**，profile 直接起不来：

```
dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include):
duplicate loader entry id: mint
```

（实测：同一 profile 同时有 bundle 声明与该手写行时，`dsh web` 启动即报上错。
`dsh --profile web --dump-config` 只显示两行 `id: mint`、不报错——**dump 通过
不代表能启动**，须数 `id: mint` 出现次数。）

迁移：删掉 profile 里那段手写行，只留 bundle 声明：

```yaml
# 仅当不用 bundle 声明时才保留本段
- insert:
    - id: mint
      name: '@yanqd0/dsh-mint'
      config: {}
```

本地构建用构建产物**文件**路径（ESM 不导入目录，必须显式 `dist/index.js`）：

```yaml
- insert:
    - id: mint
      name: /path/to/dsh-mint/dist/index.js
      config:
        debug: false
```

相对路径（`./dist/index.js`）随 profile 目录解析。重启前用
`dsh --profile <profile> --dump-config` 验证：`mint` 行须出现、无 `patch:`
警告、且 `id: mint` **恰好一次**：

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # 必须是 1
```

## 3. 安装 skill（两种形态，同一机制）

> skill 单一真源是**本仓 `skill/`**（#38 起与 mint 子模块 git 层解耦）：`pnpm build` 把它拷进
> `dist/skill`，再由落盘同步写到 `~/.dsh/skills/mint`（rank 400，遮蔽 rank 500 的
> `~/.agents/skills`）。**机制只有一种，形态按场景分两种**（#151 / plan #32）：

| 形态 | 谁创建 | 目标 | 生效方式 | 场景 |
| --- | --- | --- | --- | --- |
| **symlink** | 显式命令（`scripts/install-dsh.sh` / `pnpm skill --link`） | `~/.dsh/skills/mint -> <repo>/dist/skill` | 改仓库 + `pnpm build` 即被读到，**无需重启**（provider 每次 `get()` 重读；watcher 默认 `followSymlinks`） | 本机 dev / dogfood |
| **复制** | 插件加载时的 content-sync（默认）与 `postinstall` | `~/.dsh/skills/mint`（真实目录） | 插件**下次加载**时整树比对重同步 → 要重启 harness | 打包安装（离线、自包含、与 profile 无关） |

- **symlink 只由显式命令创建**：运行时**永不覆盖 symlink**（dev 所有权）；悬挂或异主的只告警一行（#153）。
- **复制的所有权**：写入前先落标记 `.dsh-mint-skill`；「是不是本插件那份」= 有标记，或
  `SKILL.md` frontmatter `name: mint`（标记之前的老副本）。异主目录/普通文件一律保留 + 告警，
  `--force` 才接管（#153）。标记只是所有权凭据，不参与整树比对，所以一致时**不写任何文件**。
- **命令只有一个实现**：`scripts/install-dsh.sh` 是 `dist/install-skill.js` 的薄委派（默认
  `--link`），模式为 `--link` / `--copy` / `--uninstall` / `--status`，配 `--force`；等价写法
  `pnpm skill --<mode>`。`DSH_HOME` 生效；skill 由 `dsh-skill-filesystem` 以 `user-dsh` 源发现。
- **发布包（pnpm add）无需手工步骤**：`postinstall` 与插件加载时（`apply`）都会做一次 content-sync；
  pnpm 10+ 默认拦截依赖构建脚本（本仓库 `allowBuilds` 只放行 esbuild/mint-faa），postinstall 可能不跑，
  **插件加载时的补同步是保证路径**（skill-filesystem 每次 collect 现扫目录，首个会话即可发现）。
  任何失败只告警一行，绝不阻断安装或插件加载。

### 为什么保留落盘，而不是迁到随包 provider（#151）

- `~/.dsh/skills`(user-dsh **400**) 与 `~/.agents/skills`(user-agents **500**) **在 preset 层同层**，
  同层 rank 小者胜；随包 `ctx.skills.registerProvider` 落 **global 层**，**跨层被静默压过**，
  调 rank 无用（`packages/skill/skill-filesystem/src/index.ts` 的 root 表；dsh-dev-dsh
  `notes/evaluation.md` §8.11 探针表、`skill/references/develop/skill-plugins.md` §3–§4）。
- mint 是「多宿主共用同名」的 skill（mint 上游仓自带 `.agents/skills/mint`），**遮蔽是其语义的一部分**；
  dsh-dev-dsh 没有同名覆盖需求，才迁到随包 provider（其 plan #36 / #112–#114）。
- **残余风险**：项目级 `.agents/skills`(200) 与 `customSkillDirs`(300) 在同层仍压过本产物——
  在 mint 仓 cwd 的会话里生效的是项目版 skill。

### 卸载：dsh 没有插件卸载钩子（#151 / dsh-dev-dsh #118）

`dsh plugin remove` = 卸载 fiber + `pnpm remove`，之后**没有任何一方**清理 home；pnpm 不跑
`preuninstall`（pnpm#3276），`link:` 依赖连生命周期脚本都不跑。所以卸载要显式收尾：

```sh
# 1) 摘掉插件装的那份 skill（幂等；自家 symlink 只摘链，异主则保留并要求 --force）
node ~/.dsh/profiles/<p>/node_modules/@yanqd0/dsh-mint/dist/install-skill.js --uninstall
# 或仓库内：scripts/install-dsh.sh --uninstall / pnpm skill --uninstall
# 2) 再移除插件
dsh plugin --profile <p> remove @yanqd0/dsh-mint
```

包已经删掉时用手动兜底：**先确认**是插件副本（`head -2 ~/.dsh/skills/mint/SKILL.md` 显示
`name: mint`；若是 symlink 则只摘链接），再 `rm -rf ~/.dsh/skills/mint`。
`--status` 可随时看形态与是否一致。

## 4. 验证

- `dsh --profile <profile> --dump-config` 显示 `mint` 行、`id: mint` 计数为 1、
  无 `patch:` 警告（启动前检查）。**注意 dump 通过不等于能启动**：重复挂载只在
  真正 boot（`dsh web` / 会话）时才报 `duplicate loader entry id: mint`。
- 挂载行无错误加载（`dsh` 会话正常启动）。
- `~/.dsh/skills/mint/SKILL.md` 存在。
- 宿主面运行时签名优先 `cordis_inspect_list` / `cordis_inspect_query`，
  不凭硬编码示例。

**隔离验证法（不污染真实环境）**：`DSH_HOME=$(mktemp -d) dsh plugin --profile web
add link:<repo>`，再 `dsh --profile web --dump-config` / `dsh web --help`。空
DSH_HOME 会在临时目录里初始化 profile，安装、挂载、skill 同步全在 /tmp 内完成
（本次 #50 的 bundle 自挂载即用此法实测：装完自动进 `dsh.profile.bundles`，
boot 正常，skill 落到 `$DSH_HOME/skills/mint`）。

## 5. workspace-write 会话与 mint CLI

dsh-mint 自身功能（上下文注入、**`mint` 工具**、plan 绑定）以宿主信任子进程
方式直接 spawn mint CLI，任何会话模式都可用。模型**手动**跑 `mint ...` 的
shell 命令则受 DSH 文件沙箱约束：`workspace-write` 只允许写会话 workspace、
`/tmp` 与 `os.tmpdir()`（硬编码，见 `dsh-sandbox` `writableRoots`）。mint 的
数据库在 workspace 外（`$XDG_DATA_HOME/mint/…`），手动命令会被拒。

**0.1.0 默认路径 = 宿主 `mint` 工具（零授权）**：模型把 mint 参数数组交给
`mint({args:[...]})`，工具在插件进程内 spawn mint CLI → 不经 bash、不进沙箱、
无审批往返。skill 与注入指引均按此引导，正常情况下**不需要任何沙箱放行配置**。

**bash 兜底（B-v2 审批放行 gate，仅例外）**：若工具不可用而必须用 bash 跑 mint，
会话内首条 mint 命令被拒后按常规提权重试一次（`sandbox_permissions: danger-full-access` +
justification `mint`），用户批准后，同会话后续 mint bash 命令预置同样提权参数
即自动放行（详见 notes/mint-sandbox.md）。挂载行 `config: { autoApprove: true }`
时首次也免批（显式信任 mint CLI）。其余情况（复合命令、子代理等）退化到下表选项：

| 选项                              | 配置                                                                                                                                                                                                 | 效果                                                         |
| --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| **`mint` 工具（默认，无需配置）** | 无                                                                                                                                                                                                   | 模型经工具跑 mint：不经 bash、不进沙箱、零授权               |
| bash 兜底 B-v2 gate               | 无需配置；可选 `config: { autoApprove: true }`                                                                                                                                                       | 每会话一次批准后 mint 提权自动放行（见上；仅 bash 例外路径） |
| **项目内 db（推荐兜底）**         | `MINT_DB_PATH=$PWD/.mint/mint.db mint ...`（或按项目 export `XDG_DATA_HOME`；gitignore 该文件/目录）                                                                                                 | `mint *` 在 workspace-write 可用；沙箱边界不变               |
| 会话级 `danger-full-access`       | `/permission danger-full-access` 或 `DSH_PERMISSION_MODE`                                                                                                                                            | 全放开——边界最宽，谨慎用                                     |
| 额外可写根                        | 目前无法表达：可写根集合硬编码，且会话 cwd 恒覆盖配置 fallback 根（`dsh-sandbox-policy` `resolve()`）。双根（workspace + mint 数据目录）需上游 `deepseek-harness` 改动（上游已记为 deferred 开放项） | —                                                            |

## 5.1 两种运行方式（`mintEntry` / `MINT_ENTRY`）

插件有两种入口，用一个旋钮二选一：挂载行 `config: { mintEntry: <值> }`（优先）或环境变量
`MINT_ENTRY`；两者都在启动时读取。

| 模式 | 写法 | 实际跑什么 |
| --- | --- | --- |
| 依赖链（默认） | 不写，或 `mintEntry: dependency` | 插件包内 `node_modules/mint-faa/run-mint.js`（postinstall 下载的**已发布**二进制；缺失时 `run()` 按需下载——见下方 #45 口径） |
| 本地构建 | `mintEntry: ~/bin/mint`、绝对路径、或裸名 `mint`（走 `PATH`） | 直接 spawn 该可执行程序 |

- `dependency` 是哨兵：任一旋钮写了它都强制走依赖链，即使另一个旋钮有路径（开发 profile 钉在本地构建、
  仍要验证用户链时用）。
- `~` 会按 `os.homedir()` 展开（YAML 不过 shell）；裸名按原生二进制 spawn，由 `PATH` 解析。
- 依赖区间 `>=0.8.0 <1.0.0`：用户升级/新装即可取到区间内的新 `mint-faa`，无需本插件跟发；但 mint 仓库
  HEAD 的新子命令（尚未发布）经工具执行仍报 `unrecognized subcommand`——默认跑的是「插件依赖的 mint」，
  不是「你在开发的 mint」。
- **冷启动口径（#45）**：全新安装后 `mint-faa` 没有二进制，首次 `run()` 会 `rmSync` 安装目录再下载（该惰性
  路径不打进度日志），而 mint-faa 的安装**没有锁**——插件在会话启动时并行发 3 个 mint 调用（overview 的
  list / milestone list / -V），并发首次安装会互相破坏。故 `runMint` 取进程内「冷槽」：**首个**调用拿
  180 s 预算（`MINT_COLD_TIMEOUT_MS`），并发调用等它 settle 后才允许 spawn；只有冷启动**成功**才转热
  （后续 30 s），失败则下一次仍享冷预算。超时会带 `timedOut` 标记，工具面追加可行动提示
  （重试 / `mintEntry` 预热 / `node dist/check-mint-entry.js --mode dependency`）。

```yaml
- id: mint
  config:
    mintEntry: ~/bin/mint      # 本地构建 dogfood
    # mintEntry: dependency    # 反例：强制已发布的 mint-faa 链路
```

**解析口径（#66 起）**：插件先探测**自身包根**下的 `node_modules/mint-faa/run-mint.js`，再回落
`require.resolve('mint-faa/run-mint.js')`。原因是 DSH 下插件的裸包名由 harness/profile 解析作用域决定
（见 `dsh-plugin-dev.md`），`link:` 安装又不会把被 link 包的依赖装进 profile——只靠 `require.resolve`
曾导致工具直接报 `Cannot find module 'mint-faa/run-mint.js'`。探测失败时报错带可行动指引，`[Mint]` 概览
显示 `WARNING` 行。

无 DSH 也能自检两条链：

```sh
node dist/check-mint-entry.js --mode dependency
node dist/check-mint-entry.js --mode local --entry ~/bin/mint
```

注意：宿主面插件无 HMR，改 `dist/` 后需**重启 DSH 服务**才生效；只改入口路径（配置文件）同样在挂载时读取。

## 发布

同名双注册表发布（`@yanqd0/dsh-mint` 同发 npmjs 与 GitHub Packages）——见
`docs/RELEASING.md`（#8，未来 docs 工程）。
