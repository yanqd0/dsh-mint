# 挂载 dsh-mint 到 DSH（对内记录）

dsh-mint 是 DSH 宿主插件（`@deepseek-ai/dsh`，cordis 插件系统）+ 内置 `mint`
skill。`dsh-mint` 从自己的 `mint-faa` 依赖解析 `mint` CLI——无需全局安装。

## 前置条件

- DSH CLI（`@deepseek-ai/dsh`）
- 裸包名从 harness 自身 node_modules 解析（插件须装进 profile 的 node_modules）

## 1. 安装插件

```
npm install -g dsh-mint            # 已发布包（裸包名）
```

或直接挂本地构建（dogfooding），见下。

## 2. 挂载行

编辑 `~/.dsh/profiles/<profile>/cordis.patch.yml`。**新插件必须用 `insert`
列表**——裸 `- id/name` 行是配置*覆盖*语义，会报 `patch: entry "mint" not
found`：

```yaml
- insert:
    - id: mint
      name: dsh-mint
      config:
        debug: false
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
警告。

## 3. 安装 skill

`pnpm build` 产出 `dist/skill` 后：

```sh
scripts/install-dsh.sh          # symlink -> ~/.dsh/skills/mint（推荐）
scripts/install-dsh.sh --copy   # 复制安装
scripts/install-dsh.sh --uninstall
```

`DSH_HOME` 生效；skill 由 `dsh-skill-filesystem` 以 `user-dsh` 源发现。

## 4. 验证

- `dsh --profile <profile> --dump-config` 显示 `mint` 行且无 `patch:` 警告
  （启动前检查）。
- 挂载行无错误加载（`dsh` 会话正常启动）。
- `~/.dsh/skills/mint/SKILL.md` 存在。
- 宿主面运行时签名优先 `cordis_inspect_list` / `cordis_inspect_query`，
  不凭硬编码示例。

## 5. workspace-write 会话与 mint CLI

dsh-mint 自身功能（上下文注入、`mint_query`、plan 绑定）以宿主信任子进程
方式直接 spawn mint CLI，任何会话模式都可用。模型**手动**跑 `mint ...` 的
shell 命令则受 DSH 文件沙箱约束：`workspace-write` 只允许写会话 workspace、
`/tmp` 与 `os.tmpdir()`（硬编码，见 `dsh-sandbox` `writableRoots`）。mint 的
数据库在 workspace 外（`$XDG_DATA_HOME/mint/…`），手动命令会被拒，除非：

| 选项 | 配置 | 效果 |
| --- | --- | --- |
| **项目内 db（推荐）** | `MINT_DB_PATH=$PWD/.mint/mint.db mint ...`（或按项目 export `XDG_DATA_HOME`；gitignore 该文件/目录） | `mint *` 在 workspace-write 可用；沙箱边界不变 |
| 会话级 `danger-full-access` | `/permission danger-full-access` 或 `DSH_PERMISSION_MODE` | 全放开——边界最宽，谨慎用 |
| 额外可写根 | 目前无法表达：可写根集合硬编码，且会话 cwd 恒覆盖配置 fallback 根（`dsh-sandbox-policy` `resolve()`）。双根（workspace + mint 数据目录）需上游 `deepseek-harness` 改动 | — |

## 发布

npm 双名发布（npmjs `dsh-mint` + GitHub Packages `@yanqd0/dsh-mint`）——见
`docs/RELEASING.md`（#8，未来 docs 工程）。
