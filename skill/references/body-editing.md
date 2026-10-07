# body 改写与追加纪律（body-editing）

> 触发：需要修改既有 issue/plan 的 body（补齐验收、追加证据、修正结论）。
> 新建时的模板纪律见 `template-guide.md`；**`- [ ]` checkbox 始终禁止**。

## 能力（`issue set` / `plan set` 共用）

```js
mint({ args: ["issue","set","42","--body-section","验证","--body","- pnpm test 全绿"] })
mint({ args: ["issue","set","42","--body-append=- 复查：旧复现路径已失效"] })
mint({ args: ["issue","set","42","--body-file","/tmp/new-body.md"] })
mint({ args: ["issue","set","42","--body","全新正文"] })
```

- `--body` / `--body-append` / `--body-file` **三选一**；`--body ""` 清空整体正文。
- **值以 `-` 开头必须用等号形式**：`--body-append=- 证据一`（同理 `--body=- 首行`、`--body-section=…`）。
  空格形式会被 clap 当成选项，报 `error: unexpected argument '- ' found`；而 `--body-file` 与
  `--body-append` **不能同用**（三选一），所以追加以 `-` 开头的段落只有等号形式这一条路。
- `--body-section <HEADING>` 必须配 `--body`/`--body-file`，**不能**与 `--body-append` 同用；
  按 ATX 标题文字**精确匹配**（先 `issue get <id> body` 取准确标题），保留标题行，
  替换到下一个同级/更高级标题；**找不到标题直接报 `section not found`，不会隐式新增**。
- 围栏代码块内的 `#` 行不参与分节。

## 改写纪律（`--body-section` / `--body`）

- 只改与**本次工作**相关的小节，其余小节原样保留。
- 改写后必须回到 `body-templates/N.md` 形状：≤4 字段、每字段 ≤1 句、要点用纯 `- ` 列表。
- 只记 LLM 未知；无法确认的信息写 `? 待确认 <简述>`，不瞎猜。
- **不得删除自己无法确认的历史结论**；要推翻就改写该句并注明依据。
- 状态 / 版本 / 进度**不写进 body**：状态由状态机表达，版本经 plan → milestone 表达。

## 追加纪律（`--body-append`）

- 只追加**新的证据或结论**：验证手法与结果、回归证据、来源、决策变更。
- 不重述标题或既有字段；同一事实只记一次（追加前先读 body）。
- 每次一块，≤1 小节 / ≤3 行；追加后总量上限 = 4 字段 + 1 个证据块。
- **禁止** `- [ ]` checkbox；禁止把 append 当进度日志（无信息量的「继续处理中」不写）。
