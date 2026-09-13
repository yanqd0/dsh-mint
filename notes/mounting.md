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

## 3. 安装 skill

> skill 单一真源是**本仓 `skill/`**（#38 起与 mint 子模块 git 层解耦）：`pnpm build` 把它拷进
> `dist/skill`，再由下面两条路径同步到 `~/.dsh/skills/mint`（rank 400，遮蔽 rank 500 的
> `~/.agents/skills`）。

**发布包（pnpm -g）自动安装（#28）**：无需手工步骤——

- postinstall 调用 `dist/install-skill.js`，把 `dist/skill` 同步到
  `$DSH_HOME/skills/mint`（缺省 `~/.dsh`；内容一致则跳过，升级自动刷新）。
- pnpm 10+ 默认拦截依赖构建脚本（本仓库 `allowBuilds` 只放行了
  esbuild/mint-faa），全局 add 时 postinstall 可能不跑——**插件每次加载时
  （apply）会自动补同步**，skill-filesystem 每次 collect 现扫目录，首个会话
  即可发现。postinstall 对 npm 及放行构建脚本的 pnpm 生效。
- 目标已是 symlink 时不覆盖（dev 流程所有权），失败只告警、不阻断安装。

**dev 流程**（仓库内）：`pnpm build` 产出 `dist/skill` 后：

```sh
scripts/install-dsh.sh          # symlink -> ~/.dsh/skills/mint（推荐）
scripts/install-dsh.sh --copy   # 复制安装
scripts/install-dsh.sh --uninstall
```

`DSH_HOME` 生效；skill 由 `dsh-skill-filesystem` 以 `user-dsh` 源发现。

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

## 发布

同名双注册表发布（`@yanqd0/dsh-mint` 同发 npmjs 与 GitHub Packages）——见
`docs/RELEASING.md`（#8，未来 docs 工程）。
