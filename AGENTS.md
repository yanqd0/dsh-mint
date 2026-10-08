# dsh-mint 项目导航

## 定位

DSH 插件：把 mint 接入 DSH 会话。宿主面 0.1.0：上下文注入、事件提醒、plan 绑定、`mint` 工具（mint CLI 全命令面，插件进程内执行、零授权）；客户端面 0.2.0：右侧边栏 mint 面板（issue/plan/milestone 只读视图，与【工作区文件】【新建终端】并列）。

## 硬约束

- **依赖 mint CLI**（经 `mint-faa` 依赖解析入口执行），不直读 mint db；skill 落到 `~/.dsh/skills/mint`（插件自有产物，rank 400 遮蔽其它用户级 skill）。
- **skill 单一真源 = 本仓 `skill/`**：构建时拷入 `dist/skill`，再由**落盘同步**写到 `~/.dsh/skills/mint`（按**整树**比对，改任一 reference 都会重同步）。**本仓与 mint 上游仓已 git 层解耦**（无子模块），skill 在本仓独立演进。
- **skill 两形态**：**dev/dogfood = 符号链接**（`scripts/install-dsh.sh` / `pnpm skill --link` 建 `~/.dsh/skills/mint -> <repo>/dist/skill`，改完 `pnpm build` 即生效、无需重启）；**打包安装 = 整树复制**（默认；加载时同步，故要重启）。运行时**永不覆盖 symlink**；复制写入前落所有权标记 `.dsh-mint-skill`，异主目录/普通文件保留 + 告警（`--force` 才接管）。**不迁随包 provider**：它落 global 层，赢不了 preset 层同层的 `~/.agents/skills`（400/500 的 rank 只在同层裁决）。
- **卸载必须显式收尾**：dsh 没有插件卸载钩子、pnpm 不跑 `preuninstall`（该宿主缺口已跨项目登记在 dsh-dev-dsh），`dsh plugin remove` 之后 skill 会残留。先 `scripts/install-dsh.sh --uninstall`（守卫式：自家副本删目录、自家 symlink 只摘链、异主保留 + `--force`）再 remove；包已删则确认 `head -2 …/SKILL.md` 后手动 `rm -rf`。形态与一致性用 `--status` 判定（勿用 `diff -rq`：标记文件是正常差异）。
- **skill 拆分原则**：`skill/SKILL.md` 只保留「常驻机制 + 意图路由 + 不可延迟的硬门禁」。按触发条件才生效的**分支内容**（接管模式、实现流程详解、宿主专属、同步、收口、模板/body 纪律等）一律拆到 `skill/references/`，SKILL.md 只留一行指针；**较大的独立主题同样拆出**。新增内容默认先落 reference，只有确需每轮都生效的才进 SKILL.md。SKILL.md 字节上限与 reference 孤儿检查由 `tests/guard/skill-doc.test.ts` 守（当前 ≤3200 B）。**勿对 `skill/**/*.md` 跑 prettier**：表格填充（对齐空格/长破折号）会撑破 3200 B 预算。
- **npm 同名双注册表发布**：`@yanqd0/dsh-mint` 同发 npmjs 与 GitHub Packages（scoped 名，GH Packages 天然要求 scope，无需发布时改名；见 docs/RELEASING.md）。
- **本仓本地安装进 DSH profile 用 dsh/pnpm 命令放行构建脚本**：`dsh plugin --profile web add ./` 会在 `~/.dsh/profiles/web` 下跑 pnpm，pnpm 11 默认报 `ERR_PNPM_IGNORED_BUILDS`。不要要求用户手工改 `pnpm-workspace.yaml`；应先用 `dsh plugin --profile web approve-builds --all`，再重跑 add；或直接 `dsh plugin --profile web add ./ --config.dangerouslyAllowAllBuilds=true`。
- **自带 `dsh.bundle` 挂载声明**：包根 `cordis.patch.yml`（`insert` 语义）+ `package.json` 的 `dsh.bundle.patch`，且该文件须列入 `files` 随包发布——`dsh plugin --profile <p> add` 装完即按已装状态把本包写进 `dsh.profile.bundles`，**无需手改 profile 的 `cordis.patch.yml`**；手写 `insert:` 是遗留做法，与 bundle 并存会重复挂载。契约由 `tests/guard/package-manifest.test.ts` 守住。
- **engines `node >=20`**；CI 统一 node 22。
- **小步快跑、小提交**：每个逻辑变更独立 commit（Angular 前缀）。
- **dogfooding**：用 mint 管理 dsh-mint 自身开发。
- **文档分工**：`README.md`（英）与 `README.zh.md`（中）是**必须同步的双语对**——改一侧即改另一侧，两侧同结构、同小节顺序、顶部各带语言切换相对链接（`tests/guard/readme.test.ts` 守标题序列、互链与内链可达）；README **面向使用者**（装 / 用 / 配 / 卸 + 能力概览），开发者内容进 `CONTRIBUTING.md`（英，人类开发者），不重复 AGENTS.md/notes 已有口径；对外英文文档放 `docs/`（未来 i18n 工程，**暂不做**）；对内中文记录放 `notes/`（索引 `notes/memory.md`，新会话先读）；CONTRIBUTING/CHANGELOG 维持英文。

## issue/计划管理（mint）

- issue/plan/milestone 由 mint CLI 管理（每项目独立 db）；流程见 mint skill。
- **默认挂当前 milestone**：新 plan / 独立 issue **默认挂当前 running milestone**（默认 1 个；
  并行多版本仅用户明确要求时用 `milestone set --status running --force` 开）；
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
  issue；空 plan 不放行），且同一 milestone **至多一个 running plan**（>1 被拒并点名 id；跨 milestone 的 `-f`
  并行版本放行）——门禁在 `src/host/planbind.ts`；但**建 mint plan 不要求计划模式**。开工点（计划模式
  退出口，或非计划模式开始改码前）对**本 plan** 的 issue 执行 `plan plan`（锁 `planned`）；登记到别的
  plan/milestone 的建议一律留 `open`（口径见 `skill/references/flow-impl.md`）。
  非计划模式下调用 `exit_plan_mode` 被插件直接拒并给可行动文案（不再白跑一次 mint）。

## 架构事实

```text
.
├── AGENTS.md                              # 本文件：仓库导航 + 硬约束 + issue/plan 流程
├── README.md / README.zh.md               # 面向使用者（装/用/配/卸），双语必须同步
├── CONTRIBUTING.md                        # 面向人类开发者的开发环与排障
├── docs/RELEASING.md                      # 对外发布 runbook（tag gate / 双注册表 / 失败处置）
├── package.json                           # 脚本；（部分）依赖清单
├── cordis.patch.yml                       # 自挂载声明，与 package.json 的 dsh.bundle.patch 配对
├── src/                                   # 宿主半边 + 客户端半边（模块边界与 TS 口径 → src/AGENTS.md）
├── tests/                                 # 单元与契约守卫（目录分层与用例规范 → tests/AGENTS.md）
├── skill/SKILL.md                         # 随包 skill 的内容真源（常驻机制 + 意图路由 + 硬门禁）
│   └── references/                        # 分支内容：流程、宿主专属、模板与 body 纪律
├── ...                                    # 其余 skill markdown：编号 body 模板与各流程 ref
├── notes/                                 # 对内中文调研与实测；入口 notes/memory.md（新会话先读）
│   └── ...                                # 其余调研与实测记录，见 notes/memory.md 索引
├── scripts/                               # 安装与构建：install-dsh.sh（含 --status/--uninstall）、build-*.mjs
├── locale/{en,zh}.json                    # 插件展示元数据（名称/说明）双语
└── ...                                    # 工具链与 CI：tsconfig / tsup / vitest / eslint / prettier / .github
```

## 常用命令（工具链落地后启用）

```bash
pnpm dev           # 开发运行（tsx）
pnpm build         # 构建 → dist/
pnpm test          # 测试（vitest）
pnpm lint          # ESLint
pnpm check-types   # tsc --noEmit
```
