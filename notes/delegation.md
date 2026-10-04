# 子代理委派实测（delegation）

> 实测结论，非教程：只记 LLM 靠常识猜不到的事。pin 版本：宿主 `dsh 0.2.0-rc.2` + `dsh-mint 0.3.0-alpha.1`，实测日期 2026-10-04。
> 方法：spawn 一个**只读探针子代理**，令其自报 cwd、是否收到工作区指令、完整工具清单、是否有 `skill`/`mint` 工具、是否有 `[Mint]` 注入、能否看到父对话。
> 探针会话 id `a0384f2c-91cf-47c8-a294-781cb5e803ae`。

## 实测事实

| 维度 | 结论 |
| --- | --- |
| 继承 | 工作区 cwd（`/home/user/yanqd0/dsh-mint`）、`AGENTS.md` 工作区指令（以 `<system-reminder>` 形式到达）、27 个通用工具（含 `bash`/`write`/`edit`/`glob`/`grep`/`read`/`web_*`）、`skill` 工具 + 10 个 skill 的 catalog（含 `mint`）、**`mint` 工具**、运行时策略快照 |
| 缺少 | 父 agent 的对话历史 / 推理 / tool output、用户原话、任何 `[Mint]` 开头的注入 |
| 深度 | 委派深度默认 1：子代理不能再派子代理（`subagent`/`workflow` 仍在工具清单里，调用只得到出错结果） |
| 审批 | 权限在启动时固定，approval pin `never`：审批一律自动拒绝、**会话内不可提权** → 跨项目 mint 写、工作区外写都会失败 |

- **`mint` 工具确实可用**（不是只有 catalog 条目）：探针实测 `mint({"args":["list","--page-size","1"]})` 返回原生 TSV。
- **无 `[Mint]` 注入是有意为之**：出处 `src/context.ts` 的 `installOverviewChannel()`——`agent/created` 监听里遇到 `agent.session.header.delegationDepth > 0`（即 `origin: 'subagent'`）直接 return，跳过整个概览 + 指引注入（省三次 mint spawn；子代理继承 `mint` 工具已够用）。
- 因此「工具清单里有 `subagent`/`workflow`」**不代表**子代理能再委派；同理 `bash` 在清单里，但需要审批的命令对子代理一律失败。

## 对派活口径的影响

派活提示词必须**显式**给全五件事，不要指望子代理从上下文里自己捡：

1. **目标**：要产出什么、写到哪儿（具体文件路径）。
2. **文件范围**：允许改哪几个文件，逐一点名。
3. **验收**：怎么算完成（自检命令、期望输出）。
4. **既有结论与已排除方案**：父对话里的调研结果、试过且不行的路子——子代理看不到父对话，不写就等于让它重走一遍。
5. **禁令**：不 `git add/commit/push/checkout/stash`、不碰 `.git`、不调 mint 写命令、不装依赖、不跑构建/测试/格式化等。

另：子代理**收不到用户原话**，凡涉及用户意图的判断必须由父 agent 下传；子代理**不能提权**，需要写工作区外或跨项目 mint 写时，只能把该动作留给父 agent 或用户。
