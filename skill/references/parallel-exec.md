# 并行批次执行（parallel-exec）

> 触发：plan 下多条互不依赖的 issue，同批派发子代理并行。
> 命令经 `mint` 工具；状态机 `state-machine.md`。

## 1. 可并行判据（五轴全绿才同批）

| 轴 | 全绿（可同批） | 触发串行 |
|---|---|---|
| 文件 | 同批文件集两两不相交（含 README 中英对、测试夹具） | 文件被两 issue 触碰 |
| 共享生成物 | 无 | `dist/`、`coverage/`、lockfile、`CHANGELOG.md` 必须串行 |
| 命令 | 只读自检 | `pnpm build`、`test:coverage`、装依赖、重启 harness 归主 agent |
| git 与 mint 写 | 无 | 一律归主 agent |
| 语义依赖 | 互不知道对方接口 | B 的接口由 A 决定则串行 |

- 同一 issue 不拆给多人；子代理不得再派子代理（委派深度默认 1）。

## 2. plan 阶段产出：`## 并行批次`

宿主 plan 正文与 mint plan body 同源，段名精确为 `并行批次`：

    - 并行批次：#11、#12、#13（文件不相交）
    - 依赖批次：#14（依赖 #11）
    - 串行独占：主 agent（git/mint 写、build）

- 无并行也写「单批串行」+ 一句理由。
- `plan create --body` 就带该段；`plan set --body-section` 按标题精确匹配，找不到标题报 `section not found`。

## 3. 派发协议

- 一批在**同一条 assistant message** 里批量发 `subagent`（并行，不要逐个等）。
- 一 issue 一子代理；3–6 路为宜。
- 提示词五段：① 目标（含 issue 号）；② 允许改的文件白名单；③ 验收命令；④ 禁令（不 git、不 mint 写、不跑重命令、不动他人文件）；⑤ 输出契约（变更文件 + 验收输出摘要 + 未决点，不贴 diff）。
- 指针优于复述：issue body 用只读 `mint({ args: ["issue","get","<id>"] })` 取，不贴父对话、不复述 AGENTS.md。
- 拥有：工作区 cwd、AGENTS.md、bash/write/edit、`mint` 工具、skill catalog；缺少：父对话与 tool output、`[Mint]` 概览注入、提权能力。

## 4. 单写者职责

- 主 agent 独占 git 与 mint：子代理不 commit、不 `state`。
- 逐 issue：`git add -- <该 issue 的文件>` → commit → dev 类再 `git rev-parse --short=7 HEAD` → `issue state commit <id> --sha <前7位>`。
- 批内不并行跑 build / test:coverage / format：全局独占，主 agent 串行。
- 子代理只改文件，自检只用只读命令。

## 5. 等待与收尾（不 sleep）

- 不 sleep：禁止 bash `sleep` 与 `list_agents` 轮询。
- 默认不等：派发后做独立工作，结算通知自动到达。
- 真被阻塞才 `job_output(<id>, wait: true)`（仅一次性后台 job，不用于子代理）。
- 短活 `run_in_background: false`；跑偏用 `interrupt_agent`；答复前收齐仍相关任务，`job_kill` 无意义 job。

## 6. 失败与边界

- 审批 pin `never` 不可提权：跨项目 mint 写、工作区外写、装依赖必失败 → 交回主 agent。
- 兄弟子代理共享工作区，宿主不串行化保护，冲突靠第 1 节判据预防。
- 子代理看不到父对话且不保证加载本 skill → 禁令必须写进提示词。
- 结算通知不是返回值：不收 = 没做。
