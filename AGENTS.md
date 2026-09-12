# CLAUDE.md: dsh-mint 项目导航

> 本文档是编程 AI 的项目导航：定位、硬约束与权威信息来源。

## 定位

DSH 插件：把 mint 接入 DSH 会话。宿主面 0.1.0：上下文注入、事件提醒、plan 绑定、mint_query 工具；客户端面 0.2.0：`conversation.view` 注册 mint tab（issue 面板）。

## 硬约束

- **依赖 mint CLI**（经 `mint-faa` 依赖解析入口执行），不直读 mint db；skill 安装走 `~/.dsh/skills/mint`（插件自有产物，rank 400 遮蔽其它用户级 skill）。
- **skill 单一真源 = 本仓 `skill/`**：构建时拷入 `dist/skill`，插件加载/安装时 content-sync 到 `~/.dsh/skills/mint`。**本仓与 mint 上游仓已 git 层解耦**（无子模块），skill 在本仓独立演进。
- **npm 同名双注册表发布**：`@yanqd0/dsh-mint` 同发 npmjs 与 GitHub Packages（scoped 名，GH Packages 天然要求 scope，无需发布时改名；见 docs/RELEASING.md）。
- **本仓本地安装进 DSH profile 用 dsh/pnpm 命令放行构建脚本**：`dsh plugin --profile web add ./` 会在 `~/.dsh/profiles/web` 下跑 pnpm，pnpm 11 默认报 `ERR_PNPM_IGNORED_BUILDS`。不要要求用户手工改 `pnpm-workspace.yaml`；应先用 `dsh plugin --profile web approve-builds --all`，再重跑 add；或直接 `dsh plugin --profile web add ./ --config.dangerouslyAllowAllBuilds=true`。
- **engines `node >=20`**；CI 统一 node 22。
- **宿主面不得有 client 构建依赖**；client bundle 须预构建（否则 MissingClientBundleError）。
- **小步快跑、小提交**：每个逻辑变更独立 commit（Angular 前缀）。
- **dogfooding**：用 mint 管理 dsh-mint 自身开发。
- **文档分工**：对外英文文档放 `docs/`（未来 i18n 工程，**暂不做**）；对内中文记录放 `notes/`（索引 `notes/MEMORY.md`，新会话先读）；README/CONTRIBUTING/CHANGELOG 维持英文。

## issue/计划管理（mint）

- issue/plan/milestone 由 mint CLI 管理（每项目独立 db）；流程见 mint skill。
- **改码前门禁**：改某 issue 的代码前必须 `mint issue state start <id>`（dev）；commit 后立即 `state commit <id> --sha <前7位>`；同 plan 统一测试后 `state close --test-cmd`。

## 架构事实（DSH 调研结论，写码前复核）

- 组合行裸包名从 **harness 自身 node_modules** 解析；相对路径 `./` 随预设目录走；绝对路径须指向**文件**（ESM 不导入目录）。**新插件必须 `insert:` 列表包裹**（裸 `- id/name` 是覆盖语义，报 `patch: entry not found`）；验证用 `dsh --profile web --dump-config`。
- 宿主面接口：`agent/session-start` 事件、`tools/post-execute`（enrich）、`tools/pre-execute`（allow/deny/ask）、`tools/result`、`systemPrompt.context/section`、`shell` 服务、`tools` 注册。
- 客户端面：package.json `dsh.client` 声明 + 预构建 bundle；Slot `conversation.view`（list 注册 id/order/label）；Host RPC 走 `harness.handle` / `host.call`（仅 lossless JSON）。

## 常用命令（工具链落地后启用）

```bash
pnpm dev           # 开发运行（tsx）
pnpm build         # 构建 → dist/
pnpm test          # 测试（vitest）
pnpm lint          # ESLint
pnpm check-types   # tsc --noEmit
```

## 文档导航

- `notes/MEMORY.md`：项目记忆索引（新会话先读）。
- `notes/DSH-PLUGIN-DEV.md`：DSH 插件开发调研（挂载/DI/事件签名/沙箱/开发环）。
- `notes/MOUNTING.md`：挂载与安装指南（含 workspace-write 下 mint 放行选项）。
- `docs/`：未来对外 i18n 文档（暂不做；RELEASING 属 #8）。
