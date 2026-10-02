# dsh-mint 安装与自动使用快速自检（1 分钟清单）

> 目的：回答「插件装了吗？挂载了吗？自动使用生效吗？mint 是否零授权？」
> 按序跑下面的命令，预期输出如标注；**全部符合即插件安装/自动使用正常**。
> 产生背景：本清单由一次 18 分钟的完整排查提炼而来（见 `dsh-plugin-dev.md`/`mounting.md`），
> 后续跑相同 dogfooding 任务时**先跑本清单，不要从头排查**。

## 0. 环境锚点

- GUI/会话运行的 profile：`~/.dsh/profiles/web`（`dsh web`）；session cwd 即插件挂载生效范围。
- 插件本地源：`/home/user/yanqd0/dsh-mint`（profile 里是 `link:` 指向本仓库）。
- mint CLI：入口优先级 = 挂载行 `mintEntry` > `MINT_ENTRY` > 依赖链；依赖链**先探测插件包根**
  的 `node_modules/mint-faa/run-mint.js`，再回落 `require.resolve`（`src/mint.ts`，不依赖 PATH）。
  为什么不能只靠 `require.resolve`：#66——DSH 下插件裸包名由 harness/profile 作用域解析，
  `link:` 安装不把被 link 包的依赖装进 profile，曾直接报 `Cannot find module 'mint-faa/run-mint.js'`。
  两条链各一条命令自检：`node dist/check-mint-entry.js --mode dependency` /
  `node dist/check-mint-entry.js --mode local --entry ~/bin/mint`。
  mint-faa 内嵌二进制走 GitHub release postinstall，失败可忽略：首次运行按需下载，插件给冷启动
  首调 180 s 预算并串行化并发首调（#45，详见 `mounting.md` §5.1）。

## 1. 安装：包在 profile 依赖里（预期：link 行）

```bash
grep -n "@yanqd0/dsh-mint" ~/.dsh/profiles/web/package.json   # 预期 "link:/home/user/yanqd0/dsh-mint"
ls -l ~/.dsh/profiles/web/node_modules/@yanqd0/dsh-mint        # 预期 symlink -> 仓库
```

若缺：`dsh plugin --profile web approve-builds --all` → `dsh plugin --profile web remove @yanqd0/dsh-mint`
→ `dsh plugin --profile web add ./`（pnpm 11 会拦构建脚本；**已记录的依赖必须删掉再加**才会补 bundle，
见 `mounting.md`、README 的 npm 一节；构建产物需要先 `pnpm build`）。

## 2. 挂载：cordis 组合树里有 mint 行（预期：出现 id: mint，无 patch: 警告）

```bash
grep -n "@yanqd0/dsh-mint" ~/.dsh/profiles/web/package.json   # 预期 dsh.profile.bundles 含本包
cat ~/.dsh/profiles/web/cordis.patch.yml      # 预期只有覆盖行 `- id: mint`（放 config），无手写 insert
dsh --profile web --dump-config 2>&1 | grep -A3 'id: mint'    # 组合树确认
```

坑（历史教训，别再踩）：
- 挂载行由**包自带的 bundle patch** 提供（包根 `cordis.patch.yml` + `package.json` 的
  `dsh.bundle.patch`，见 #50）：`dsh plugin add` 成功即把本包写进 profile 的 `dsh.profile.bundles`，
  **不需要**手写 `insert:`；手写 insert 与 bundle 并存会**重复挂载**。
- 裸 `- id/name` 是**覆盖**语义（profile 里那行 `- id: mint` 只用来放 `config`），
  行不存在时会报 `patch: entry not found`——所以别把它当成新增挂载的手段。
- 改完若配置不生效，重启 harness（GUI 进程）。

## 3. 产物：dist 与 skill 都在（预期：两处 SKILL.md 存在且一致，且 client bundle 在）

```bash
ls /home/user/yanqd0/dsh-mint/dist/index.js /home/user/yanqd0/dsh-mint/dist/skill/SKILL.md
ls /home/user/yanqd0/dsh-mint/dist/client.js                # #9：client 半边预构建产物
head -c 60 /home/user/yanqd0/dsh-mint/dist/client.js        # 应为 window.__ModuleLoader__.load(
ls ~/.dsh/skills/mint/SKILL.md                 # 插件 apply/postinstall 自动同步目标
diff -rq ~/.dsh/skills/mint /home/user/yanqd0/dsh-mint/dist/skill >/dev/null && echo "skill 一致"
```

坑：
- `exports: { ".": "./dist/index.js" }` —— **dist 不构建则加载即失败**。先 `pnpm build`。
- **新增 `dsh.client` 后必须重启 harness**：client 行只在启动扫描时入图；此后改 bundle 只需
  重新 `pnpm build` + 刷新页面（revision 由 mtime/ctime/size 推导）。
- `dist/client.js` 缺失 = `MissingClientBundleError`（宿主激活期直接报错）。
- `pnpm build` 前会跑 deps 检查触发 install；mint-faa postinstall 下载 GitHub release
  失败会让 install 非零退出 → 本机用
  `pnpm install --frozen-lockfile --ignore-scripts && pnpm build`。
- 仓库 **无 node_modules** → zod/mint-faa 解析失败（本仓库曾因从未 install 而全工具瘫痪）。
- **skill 单一真源 = 本仓 `skill/`**（#38 起与 mint 子模块 git 层解耦）：构建拷入 `dist/skill`，
  插件加载时 content-sync 到 `~/.dsh/skills/mint`（rank 400 `user-dsh`）。
- **手工清理（一次性）**：删掉 `~/.agents/skills/mint` 软链（rank 500，指向 mint 上游仓的旧
  skill）。rank 400 本已遮蔽 rank 500，但删掉可避免两个 mint skill 同时在目录里造成困惑。
  **注意别删 `~/.dsh/skills/mint`**——那是插件的同步产物。

## 3.1 客户端面：右侧边栏第三张 guide 卡片（#11/#12/#79）

重启 harness 并刷新页面后：

1. 打开右侧边栏 → `+`（新建侧边栏 tab）→ guide 应列出三张卡片：**工作区文件 / 新建终端 / Mint**。
2. 点 Mint → 出现标题为「Mint」的 tab；Issue 视图列出当前会话项目的 issue，可搜索、翻页、点开详情（含 body）。
3. 切到 Plan / Milestone 视图：列表 → 详情 → 点详情里的子 issue 可跳回 Issue 详情。
4. shape/契约自检（无需授权）：
   `cordis_inspect_query` client `Slots.listSubTree`，`root: "sidebar.right.pane.tab"` →
   occupants 应含 `@yanqd0/dsh-mint`。
5. 只读自检：面板全部数据走 `GET /dsh-mint/*`；宿主侧 argv 白名单见 `src/routes.ts`
   （`READ_ONLY_SUBCOMMANDS`），契约细节见 `client-face.md`。

## 4. 生效判定（自动使用，预期：工具/上下文出现）

- 会话工具列表出现 **`mint`**（宿主面 #34；旧的 `mint_query` 已删除）。
- systemPrompt 注入 `[Mint]` 概览块（宿主面 #3）+ 一条「工具优先」指引段落（#39）。
- 概览里出现 `[Mint] WARNING: mint 入口解析失败…` = 入口不可解析（修复见 §0 与 `mounting.md`
  §5.1），**不是**「项目里没有 issue」；概览首行的 `via …` 标签直接告诉你跑的是哪个 mint。
- 会话日志取证：`~/.dsh/sessions/<proj>/<id>/session.jsonl.zstd` 里查工具调用与上下文。

判定别只看日志文本里 grep 到 `mint`（本仓库文档/推理里会大量出现，易误判）。

## 5. 零授权验证（预期：全程无审批事件）

**默认路径 = 宿主 `mint` 工具**：`mint({args:["list"]})` 之类调用在插件进程内执行，
不经 bash、不进文件沙箱，**不产生任何 approval 事件**。

```bash
mint({args:["list"]})                       # 经工具调用：直接返回 TSV（≤5 条）
mint({args:["list","--page","2"]})          # 分页
mint({args:["issue","--help"]})             # 帮助文本
```

**验证口径**：新会话不跑任何 mint bash 命令，纯工具跑一遍 dogfood，然后查 session JSONL：

```bash
# 无 mint 相关授权往返，且有 mint 工具的 call/result
zstdcat ~/.dsh/sessions/**/session.jsonl.zstd | grep -c '"approval/'   # 预期 0（mint 相关）
zstdcat ~/.dsh/sessions/**/session.jsonl.zstd | grep -c '"mint"'       # 预期 >0（tool/call+result）
```

> telemetry 默认 DISABLED，不能作为证据；session JSONL 才是真相源（`notes/dsh/0.1.0/07,28`）。

**bash 兜底（B-v2 gate，仅例外路径）**：若工具不可用而必须 bash 跑 mint：
- 默认 `autoApprove: false`：**每会话首条 mint bash 命令**被沙箱拒后，按常规提权重试一次
  （`sandbox_permissions: danger-full-access` + justification `mint`），用户批准后该 agent
  同会话后续裸 `mint ...` 命令自动放行（gate 记忆，见 `notes/mint-sandbox.md`）。
- 只有「单条裸 `mint ...`（无 `;`/`&&`/引号/env 前缀）」才被 gate 识别；复合命令走常规提权审批。
- gate 是**兜底**，不是设计路径；诊断价值：若工具已装却仍逐条弹窗，先回 §2/§4 查插件是否加载。
