# dsh-mint 安装与自动使用快速自检（1 分钟清单）

> 目的：回答「插件装了吗？挂载了吗？自动使用生效吗？workspace-write 下 mint 是否零/一次打扰？」
> 按序跑下面的命令，预期输出如标注；**全部符合即插件安装/自动使用正常**。
> 产生背景：本清单由一次 18 分钟的完整排查提炼而来（见 `DSH-PLUGIN-DEV.md`/`MOUNTING.md`），
> 后续跑相同 dogfooding 任务时**先跑本清单，不要从头排查**。

## 0. 环境锚点

- GUI/会话运行的 profile：`~/.dsh/profiles/web`（`dsh web`）；session cwd 即插件挂载生效范围。
- 插件本地源：`/home/user/yanqd0/dsh-mint`（profile 里是 `link:` 指向本仓库）。
- mint CLI：本机 dogfooding 用 `~/bin/mint`；mint-faa 内嵌二进制（GitHub release postinstall）
  失败**可忽略**（B-v2 gate 只放行 PATH 上单条 `mint ...`，不依赖 mint-faa 二进制）。

## 1. 安装：包在 profile 依赖里（预期：link 行）

```bash
grep -n "@yanqd0/dsh-mint" ~/.dsh/profiles/web/package.json   # 预期 "link:/home/user/yanqd0/dsh-mint"
ls -l ~/.dsh/profiles/web/node_modules/@yanqd0/dsh-mint        # 预期 symlink -> 仓库
```

若缺：`dsh plugin --profile web approve-builds --all && dsh plugin --profile web add ./`
（pnpm 11 会拦构建脚本，见 `MOUNTING.md`；构建产物需要先 `pnpm build`）。

## 2. 挂载：cordis 组合树里有 mint 行（预期：出现 id: mint，无 patch: 警告）

```bash
cat ~/.dsh/profiles/web/cordis.patch.yml      # 预期 insert 列表含 @yanqd0/dsh-mint
dsh --profile web --dump-config 2>&1 | grep -A3 'id: mint'    # 组合树确认
```

坑（历史教训，别再踩）：
- `dsh plugin add ./` **只是装依赖，不挂载**；必须手动写 `cordis.patch.yml` 的
  `- insert: [{ id: mint, name: '@yanqd0/dsh-mint', config: { debug: false } }]`。
- 裸 `- id/name` 行是**覆盖**语义，会报 `patch: entry not found`——新插件必须 `insert:` 包裹。
- 改完若配置不生效，重启 harness（GUI 进程）；本清单撰写时观察到写入 patch 后 skill
  同步立即发生，疑似热应用，但以重启为准（`DSH-PLUGIN-DEV.md`）。

## 3. 产物：dist 与 skill 都在（预期：两处 SKILL.md 存在）

```bash
ls /home/user/yanqd0/dsh-mint/dist/index.js /home/user/yanqd0/dsh-mint/dist/skill/SKILL.md
ls ~/.dsh/skills/mint/SKILL.md                 # 插件 apply/postinstall 自动同步目标
diff -rq ~/.dsh/skills/mint /home/user/yanqd0/dsh-mint/dist/skill >/dev/null && echo "skill 一致"
```

坑：
- `exports: { ".": "./dist/index.js" }` —— **dist 不构建则加载即失败**。先 `pnpm build`。
- `pnpm build` 前会跑 deps 检查触发 install；mint-faa postinstall 下载 GitHub release
  失败会让 install 非零退出 → 本机用
  `pnpm install --frozen-lockfile --ignore-scripts && pnpm build`（esbuild 平台二进制在
  `.pnpm` 内已就位，`--ignore-scripts` 不影响构建）。
- 仓库 **无 node_modules** → zod/mint-faa 解析失败（本仓库曾因从未 install 而全工具瘫痪）。

## 4. 生效判定（自动使用，预期：工具/上下文出现）

- 会话工具列表出现 `mint_query`（宿主面 #6）。
- systemPrompt 注入 `[Mint]` 概览块（宿主面 #3）。
- 会话日志取证：`~/.dsh/sessions/<proj>/<id>/session.jsonl.zstd` 里查工具调用与上下文。

判定别只看日志文本里 grep 到 `mint`（本仓库文档/推理里会大量出现，易误判）。

## 5. workspace-write 下 mint 放行（B-v2 gate，预期：零/一次打扰）

- 默认 `autoApprove: false`：**每会话首条 mint bash 命令**被沙箱拒后，按常规提权重试一次
  （`sandbox_permissions: danger-full-access` + justification `mint`），用户批准后该 agent
  同会话后续裸 `mint ...` 命令自动放行（gate 记忆，见 `notes/MINT-SANDBOX.md`）。
- 挂载行 `config: { autoApprove: true }` → 首次也免批（显式信任 mint CLI，跨会话）。
- 只有「单条裸 `mint ...`（无 `;`/`&&`/引号/env 前缀）」才被 gate 识别；复合命令走常规
  提权审批。
- 手动验证：跑一条 `mint list` → 被拒 → 同命令提权重试 → 成功；再跑另一条裸 mint 应
  不再弹窗（若仍逐条弹，说明插件未加载，回到 §2/§4）。
