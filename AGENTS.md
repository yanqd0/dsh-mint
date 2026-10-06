# CLAUDE.md: dsh-mint 项目导航

> 本文档是编程 AI 的项目导航：定位、硬约束与权威信息来源。

## 定位

DSH 插件：把 mint 接入 DSH 会话。宿主面 0.1.0：上下文注入、事件提醒、plan 绑定、`mint` 工具（mint CLI 全命令面，插件进程内执行、零授权）；客户端面 0.2.0：右侧边栏 mint 面板（issue/plan/milestone 只读视图，与【工作区文件】【新建终端】并列）。

## 硬约束

- **依赖 mint CLI**（经 `mint-faa` 依赖解析入口执行），不直读 mint db；skill 安装走 `~/.dsh/skills/mint`（插件自有产物，rank 400 遮蔽其它用户级 skill）。
- **skill 单一真源 = 本仓 `skill/`**：构建时拷入 `dist/skill`，插件加载/安装时 content-sync 到 `~/.dsh/skills/mint`（同步按**整树**比对，改任一 reference 都会重同步）。**本仓与 mint 上游仓已 git 层解耦**（无子模块），skill 在本仓独立演进。
- **skill 拆分原则**：`skill/SKILL.md` 只保留「常驻机制 + 意图路由 + 不可延迟的硬门禁」。按触发条件才生效的**分支内容**（接管模式、实现流程详解、宿主专属、同步、收口、模板/body 纪律等）一律拆到 `skill/references/`，SKILL.md 只留一行指针；**较大的独立主题同样拆出**。新增内容默认先落 reference，只有确需每轮都生效的才进 SKILL.md。SKILL.md 字节上限与 reference 孤儿检查由 `src/skill-doc.test.ts` 守（当前 ≤3200 B）。**勿对 `skill/**/*.md` 跑 prettier**：表格填充（对齐空格/长破折号）会撑破 3200 B 预算。
- **npm 同名双注册表发布**：`@yanqd0/dsh-mint` 同发 npmjs 与 GitHub Packages（scoped 名，GH Packages 天然要求 scope，无需发布时改名；见 docs/RELEASING.md）。
- **本仓本地安装进 DSH profile 用 dsh/pnpm 命令放行构建脚本**：`dsh plugin --profile web add ./` 会在 `~/.dsh/profiles/web` 下跑 pnpm，pnpm 11 默认报 `ERR_PNPM_IGNORED_BUILDS`。不要要求用户手工改 `pnpm-workspace.yaml`；应先用 `dsh plugin --profile web approve-builds --all`，再重跑 add；或直接 `dsh plugin --profile web add ./ --config.dangerouslyAllowAllBuilds=true`。
- **自带 `dsh.bundle` 挂载声明**：包根 `cordis.patch.yml`（`insert` 语义）+ `package.json` 的 `dsh.bundle.patch`，且该文件须列入 `files` 随包发布——`dsh plugin --profile <p> add` 装完即按已装状态把本包写进 `dsh.profile.bundles`，**无需手改 profile 的 `cordis.patch.yml`**；手写 `insert:` 是遗留做法，与 bundle 并存会重复挂载。契约由 `src/package-manifest.test.ts` 守住。
- **engines `node >=20`**；CI 统一 node 22。
- **宿主面不得有 client 构建依赖**；client bundle 须预构建（否则 MissingClientBundleError）。
- **小步快跑、小提交**：每个逻辑变更独立 commit（Angular 前缀）。
- **dogfooding**：用 mint 管理 dsh-mint 自身开发。
- **文档分工**：`README.md`（英）与 `README.zh.md`（中）是**必须同步的双语对**——改一侧即改另一侧，两侧同结构、同小节顺序、顶部各带语言切换相对链接；对外英文文档放 `docs/`（未来 i18n 工程，**暂不做**）；对内中文记录放 `notes/`（索引 `notes/memory.md`，新会话先读）；CONTRIBUTING/CHANGELOG 维持英文。

## issue/计划管理（mint）

- issue/plan/milestone 由 mint CLI 管理（每项目独立 db）；流程见 mint skill。
- **默认挂当前 milestone**：新 plan / 独立 issue **默认挂当前 running milestone**（同刻有且仅有一个）；
  无 running → 按 semver 推测候选并**询问用户**（`milestone set <id> --status running` 置位，或新建），**勿自行置位**。
- **在 DSH 会话里一律走宿主 `mint` 工具**（`mint({args:["issue","state","start","3"]})`）：插件进程内执行，
  不经 bash、不进沙箱、零授权。**不要用 bash 跑 mint** —— 那会触发沙箱拒绝与提权审批；bash 只作兜底
  （插件未装或工具不可用时），且只有可识别的裸 mint 命令会走同一道跨项目确认。
- **跨项目（`-p`/`--project`）**：**本项目操作一律不带 `-p`**（目标项目默认取会话 cwd，加了只会被当成跨项目）；
  确要指向别的项目时才写，且写在**子命令之前**；读直接放行，写操作首次弹一次确认（文案带目标项目
  与动作），同会话同目标项目之后免问；目标项目不存在即拒绝（不许 mint 静默新建项目库）；`autoApprove`
  只作用于沙箱提权，**不解除**这道门禁。口径见 `skill/references/cross-project.md`。
- **改码前门禁**：改某 issue 的代码前必须 `state start <id>`（dev）；commit 后立即 `state commit <id> --sha <前7位>`；
  同 plan 统一测试后 `plan close <plan> --test-cmd "<命令>"`。
- **plan 绑定（单向）**：进计划模式的会话退出前必须有**已拆解**的 mint plan（`running`，或 `open` 且已挂 ≥1 个
  issue；空 plan 不放行，门禁在 `src/planbind.ts`）；但**建 mint plan 不要求计划模式**。开工点（计划模式
  退出口，或非计划模式开始改码前）对**本 plan** 的 issue 执行 `plan plan`（锁 `planned`）；登记到别的
  plan/milestone 的建议一律留 `open`（#128/#135/#136，口径见 `skill/references/flow-impl.md`）。

## 架构事实（DSH 调研结论，写码前复核）

- 组合行裸包名从 **harness 自身 node_modules** 解析；相对路径 `./` 随预设目录走；绝对路径须指向**文件**（ESM 不导入目录）。**新插件必须 `insert:` 列表包裹**（裸 `- id/name` 是覆盖语义，报 `patch: entry not found`）；验证用 `dsh --profile web --dump-config`。
- 宿主面接口：`agent/session-start` 事件、`tools/post-execute`（enrich）、`tools/pre-execute`（allow/deny/ask）、`tools/result`、`systemPrompt.context/section`、`shell` 服务、`tools` 注册。
- **`mint` 工具注册在 root ctx（global layer）**：所有 agent 继承，子代理也继承（子代理 approval 被 pin `never`，bash 路径对它们不可用）。工具 execute 内经 `runMint` spawn mint，插件进程不受会话沙箱约束 → 零授权。
- 模型可见文案一律工具形态：动态概览用 `systemPrompt.context()`，静态工具指引用 `systemPrompt.section()`（order 110，落在 100–199 tool guidance band，KV cache 友好）。
- 客户端面：package.json `dsh.client`（`platform` + 需先到的**其它插件包名** `inject`）+ 预构建 `exports["./client"]`，产物必须是 `window.__ModuleLoader__.load({id, factory:(require)=>{…}})`；只能 `require` 浏览器内核冻结的 PLATFORM_MODULES（react / react-dom / cordis / dsh-client-store / ui-slots / ui-primitives / ui-dockkit），其余须声明 `dsh.client.external`。
- **客户端面落点**：右侧边栏 = `ctx.sidebarRightTabs.register({id,kind,title,guide})`（guide entry 即「新建侧边栏 tab」选项）+ body seat `sidebar.right.pane.tab`；不是 `conversation.view`。实测契约见 [notes/client-face.md](notes/client-face.md)。
- **Host RPC**：静态（已安装）插件的 client 半边**走宿主 `ctx.webServer` JSON 路由**（浏览器侧 `fetch`，`dshmarket` 在产先例）；`harness.handle` / `host.call` 只属于**动态 Cordis 包** runner，Typert `remote` 的能力集在构建期固定、仓外插件无法 join。
- **插件展示元数据**（【插件】页的标题/描述/图标）：宿主 `readPluginMeta`（`@deepseek-ai/dsh-app-boot`）经 Node resolver 读 `<pkg>/package.json` 与 `<pkg>/locale/<lang>.json`，**受 `exports` 门禁**且失败静默——包必须导出 `"./package.json"` 与 `"./locale/*.json"`（并列入 `files`），且**必须有 `locale/en.json`** 才会枚举字典目录；缺了它插件页只剩包名、无描述（#127，见 [notes/client-face.md](notes/client-face.md) §8）。

## 常用命令（工具链落地后启用）

```bash
pnpm dev           # 开发运行（tsx）
pnpm build         # 构建 → dist/
pnpm test          # 测试（vitest）
pnpm lint          # ESLint
pnpm check-types   # tsc --noEmit
```

## 文档导航

- `notes/memory.md`：项目记忆索引（新会话先读）。
- `notes/client-face.md`：**客户端面实测契约**（右侧边栏 seat、`dsh.client` 产物、webServer 路由通道、locale/主题、验证手段与坑）。
- `notes/dsh-plugin-dev.md`：DSH 插件开发调研（挂载/DI/事件签名/沙箱/开发环）。
- `notes/mounting.md`：挂载与安装指南（含 workspace-write 下 mint 放行选项）。
- `docs/RELEASING.md`：对外发布 runbook（tag gate、双注册表、Release notes、失败处置）；`docs/` 其余 i18n 工程暂不做。
