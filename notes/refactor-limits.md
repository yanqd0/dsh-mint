# 文件限大与注释精简：规范落地、实测基线与坑位

> 背景：多条会话审计都指向同一件事——单文件越大、注释越碎，读一次就越贵，返工率越高。
> 本轮把「单一职责 + 文件限大 + 注释判据」写成规范并做成门禁，同时把超限文件真正拆掉。
> 权威口径在 `src/AGENTS.md`（编码/拆分）与 `tests/AGENTS.md`（测试镜像与注释），本文只记实测与理由。

## 0. 阈值为什么定 500（社区口径）

- [ESLint `max-lines`](https://eslint.org/docs/v9.x/rules/max-lines)：规则**默认 300**，且原文写明「虽然没有客观上限，但多数人同意不该到几千行；**常用建议区间是 100–500 行**」。
- [Google TypeScript Style Guide](https://google.github.io/styleguide/tsguide.html)：**没有文件行数上限**（它只提「限制 `../../../` 这类父级层数，深路径让模块结构难懂」），因此 Google 不能作为 1000 行的依据。
- 结论：**500 落在社区建议区间的上沿**，既不当最严（100–300 会迫使本仓把 20 个文件都拆了），也远离「几千行」的公认坏味；1000 在本仓语境下没有可引用的一手依据，故不采用。
- 阈值与度量口径解耦：`max-lines` 配 `skipBlankLines + skipComments` 时，500 是「逻辑行」，避免注释密度左右判定（见 §2）。

## 1. 规范落点（单一真源）

| 内容 | 真源 |
| --- | --- |
| ≤500 逻辑行是硬门禁、高于单一职责；原地变目录、入口留文件 | `src/AGENTS.md`「文件限大与内部拆分」 |
| 注释判据（关键函数一行目的、复杂关键函数精简编号步骤、禁 what 注释、中文） | `src/AGENTS.md`「TypeScript 口径 · 注释」 |
| 测试镜像与拆分（源拆则测试必拆、源不拆则不拆）、关键用例两行头 | `tests/AGENTS.md`「落点 · 镜像与拆分」「注释」 |
| 机器门禁 | `eslint.config.mjs` 的 `max-lines`（`src/**` error、`tests/**` warn） |
| 镜像机检 | `tests/guard/test-mirror.test.ts` |

## 2. 度量口径（不要用字节或物理行代替）

- **逻辑行 = ESLint `max-lines` 的 `{ skipBlankLines: true, skipComments: true }`**：空行与纯注释行不计。
  这条口径和「读一次要多少行」一致，也顺手避免「靠删注释过关」。
- 为什么不用字节：UTF-8 中文注释每字 3 字节，字节阈值会让注释语言决定成败。
- 为什么不用物理行：注释多的文件会因注释被判超限，逼人删知识而不是拆职责。
- 复现：`npx eslint src tests` 看 `max-lines` 报告；`tests/**` 只 warn，不 fail。

## 3. 实测基线（本轮开工点）

对 61 个 `src/**` 与 53 个 `tests/**` 的 ts/tsx 统计（脚本口径：字符串字面量感知的注释扫描 + 逻辑行）：

| 范围 | 字节 | 注释字节 | 注释占比 |
| --- | --- | --- | --- |
| `src/**` | 约 0.72 MB | 约 0.32 MB | **44.2%** |
| `tests/**` | 约 0.39 MB | 约 51 KB | 13.1% |

注释占比较高的源文件（字节/占比/逻辑行）：`src/dag/dag-worktree.ts` 16.1 KB/52.5%、`src/dag/dag-lifecycle.ts` 13.6 KB/59.2%、`src/host/routes.ts` 13.3 KB/40.3%、`src/host/context.ts` 11.6 KB/46.3%、`src/dag/dag-tool.ts` 10.2 KB/47.7%、`src/host/reminders.ts` 9.5 KB/51.3%。

`max-lines` 口径下超 500 逻辑行的源文件只有两个：`src/dag/dag.ts`（596）、`src/client/DagBody.tsx`（536）；第三名 `src/host/routes.ts`（488）不拆。

## 3.1 同一口径的收口复测

| 范围 | 注释字节 | 注释占比 | 说明 |
| --- | --- | --- | --- |
| `src/**` | 241.4 KB → 201.3 KB（**−16.6%**） | 44.2% → **39.6%** | 删 what 注释、压缩长段散文；why 类全保留 |
| `tests/**` | 74.4 KB → 107.3 KB（+44.3%） | 13.1% → 17.8% | 关键用例两行头是**有意增加**：169 处、约占用例 15% |

降幅最大者：`src/mint/cross-project.ts` 33.2% → 8.3%、`src/client/dag-model.ts` 53.1% → 42.0%、`src/client/model.ts` 51.6% → 41.4%、`src/dag/dag-metrics.ts` 56.5% → 49.3%。

一个可复用的教训：**测试文件的注释会因这条规范「变多」**，别把总注释字节当单一 KPI；正确的读法是「源码的 why 密度不降、what 噪音下降；测试只给关键用例加目的说明」。

## 3.2 存量 prettier 偏离必须先建基线

本轮改动前后跑 `prettier --check` 的**违规集合逐文件一致**（57 个文件），证明新写的注释没有制造新的格式偏离——
这套「改前跑一次、改后跑一次、比对集合而不是计数」的手法，应在任何批量注释/文档改动里复用。


## 4. 本轮拆掉的文件与拆法

- `src/dag/dag.ts` → 入口文件保留（只再导出）+ `src/dag/dag/internal/{model,validate,parse-action,parse-doc,write,graph}.ts`。
- `src/client/DagBody.tsx` → `DagBody.tsx` + `src/client/{dag-sampler.ts,NodeCard.tsx,dag-labels.ts}`；
  其中 `dag-sampler.ts` 是纯逻辑，**首次进入覆盖口径**（此前只有 `.tsx` 被 exclude）。
- 测试同构：`tests/unit/dag/dag.test.ts` 退化为模块边界守卫，子模块测试进
  `tests/unit/dag/dag/internal/*.test.ts`，共用 fixture 落 `tests/unit/dag/dag/internal/helpers.ts`。

### 4.1 关键坑位：NodeNext 不做目录 index 查找

原计划是「`x.ts` → `x/index.ts`」的经典原地变目录，实测**行不通**：
`moduleResolution: NodeNext` 下，形如 `'./dag.js'` 的说明符不会被解析成 `./dag/index.ts`
（`tsc --traceResolution` 只试 `dag.ts` / `dag.tsx` / `dag.d.ts`，然后直接判失败；
在目录里放 `package.json` 的 `main`/`exports` 也不被采纳，因为 `exports` 对相对路径不生效）。
所以本仓的形式是：**入口必须是文件**（`x.ts`），实现进 `x/internal/`。好处是外部 import
说明符、TS 解析、`tsup` 产物出口三者全都不变（本轮 53 处 `'./dag.js'` 引用一处未改）。

## 5. 注释判据的可操作版本

- **删**：复述函数名/参数类型/字段类型/下一行代码的 what 注释（`/** 节点的标签 */` 紧跟 `label: string`）。
- **留**：讲为什么、讲不变量、讲跨模块契约、讲非显然边界、讲历史坑的注释——可以压缩措辞，但知识必须原样存活。
- **补**：关键函数一行设计目的；复杂关键函数用 1./2./3. 精简编号替代长段散文。
- **语言**：新增/改写用中文；存量英文只在「已经动到这一处」时顺手改，不做全量翻译（避免纯 diff 与语义漂移）。

## 6. 客户端面的额外约束（copy 守卫）

`tests/unit/client/copy.test.ts` 守卫「面板文案只能来自 `copy.ts`」。它原来按**整份文本**扫 CJK，
于是注释也不能写中文——与注释规范直接冲突。现改为**只扫字符串字面量**（用 TS 词法器遍历
`StringLiteral` / `NoSubstitutionTemplateLiteral`）：硬编码中文文案依旧被挡，注释可以写中文。

## 7. 验收命令

```bash
npx eslint src tests      # src 零 error；tests 只 warn（max-lines 提示体量）
npx tsc --noEmit
pnpm vitest run           # 含 tests/guard/test-mirror.test.ts 的镜像机检
pnpm vitest run --coverage
pnpm build                # dist 产物名不变（entry key 未动）
```
