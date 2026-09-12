# dsh-mint 安装与自动使用快速自检（1 分钟清单）

> 目的：回答「插件装了吗？挂载了吗？自动使用生效吗？mint 是否零授权？」
> 按序跑下面的命令，预期输出如标注；**全部符合即插件安装/自动使用正常**。
> 产生背景：本清单由一次 18 分钟的完整排查提炼而来（见 `dsh-plugin-dev.md`/`mounting.md`），
> 后续跑相同 dogfooding 任务时**先跑本清单，不要从头排查**。

## 0. 环境锚点

- GUI/会话运行的 profile：`~/.dsh/profiles/web`（`dsh web`）；session cwd 即插件挂载生效范围。
- 插件本地源：`/home/user/yanqd0/dsh-mint`（profile 里是 `link:` 指向本仓库）。
- mint CLI：由插件经 `mint-faa` 依赖解析入口 spawn（`src/mint.ts`），**不依赖 PATH**；
  mint-faa 内嵌二进制走 GitHub release postinstall，失败可忽略（工具走 node 入口）。

## 1. 安装：包在 profile 依赖里（预期：link 行）

```bash
grep -n "@yanqd0/dsh-mint" ~/.dsh/profiles/web/package.json   # 预期 "link:/home/user/yanqd0/dsh-mint"
ls -l ~/.dsh/profiles/web/node_modules/@yanqd0/dsh-mint        # 预期 symlink -> 仓库
```

若缺：`dsh plugin --profile web approve-builds --all && dsh plugin --profile web add ./`
（pnpm 11 会拦构建脚本，见 `mounting.md`；构建产物需要先 `pnpm build`）。

## 2. 挂载：cordis 组合树里有 mint 行（预期：出现 id: mint，无 patch: 警告）

```bash
cat ~/.dsh/profiles/web/cordis.patch.yml      # 预期 insert 列表含 @yanqd0/dsh-mint
dsh --profile web --dump-config 2>&1 | grep -A3 'id: mint'    # 组合树确认
```

坑（历史教训，别再踩）：
- `dsh plugin add ./` **只是装依赖，不挂载**；必须手动写 `cordis.patch.yml` 的
  `- insert: [{ id: mint, name: '@yanqd0/dsh-mint', config: { debug: false } }]`。
- 裸 `- id/name` 行是**覆盖**语义，会报 `patch: entry not found`——新插件必须 `insert:` 包裹。
- 改完若配置不生效，重启 harness（GUI 进程）。

## 3. 产物：dist 与 skill 都在（预期：两处 SKILL.md 存在且一致）

```bash
ls /home/user/yanqd0/dsh-mint/dist/index.js /home/user/yanqd0/dsh-mint/dist/skill/SKILL.md
ls ~/.dsh/skills/mint/SKILL.md                 # 插件 apply/postinstall 自动同步目标
diff -rq ~/.dsh/skills/mint /home/user/yanqd0/dsh-mint/dist/skill >/dev/null && echo "skill 一致"
```

坑：
- `exports: { ".": "./dist/index.js" }` —— **dist 不构建则加载即失败**。先 `pnpm build`。
- `pnpm build` 前会跑 deps 检查触发 install；mint-faa postinstall 下载 GitHub release
  失败会让 install 非零退出 → 本机用
  `pnpm install --frozen-lockfile --ignore-scripts && pnpm build`。
- 仓库 **无 node_modules** → zod/mint-faa 解析失败（本仓库曾因从未 install 而全工具瘫痪）。
- **skill 单一真源 = 本仓 `skill/`**（#38 起与 mint 子模块 git 层解耦）：构建拷入 `dist/skill`，
  插件加载时 content-sync 到 `~/.dsh/skills/mint`（rank 400 `user-dsh`）。
- **手工清理（一次性）**：删掉 `~/.agents/skills/mint` 软链（rank 500，指向 mint 上游仓的旧
  skill）。rank 400 本已遮蔽 rank 500，但删掉可避免两个 mint skill 同时在目录里造成困惑。
  **注意别删 `~/.dsh/skills/mint`**——那是插件的同步产物。

## 4. 生效判定（自动使用，预期：工具/上下文出现）

- 会话工具列表出现 **`mint`**（宿主面 #34；旧的 `mint_query` 已删除）。
- systemPrompt 注入 `[Mint]` 概览块（宿主面 #3）+ 一条「工具优先」指引段落（#39）。
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
