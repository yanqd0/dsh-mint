# 标题与 body 模板纪律（template-guide）

> 从 SKILL.md 迁出。目标：省 token、**只记 LLM 未知**。
> 改写/追加既有 body 的纪律见 `body-editing.md`。

## 总则

- **只记 LLM 未知**：公共知识/定义不描述；不明确就写 `? 待确认 <简述>`，**不瞎猜**。
- **标题 ≤60 字符**（约 30 汉字），语义见 `title-templates/`（issue / plan / milestone）；
  **好标题可省 body**。
- **body 套 `body-templates/N.md`**：≤4 字段、每字段 ≤1 句、要点用纯 `- ` 列表；
  **禁止 `- [ ]` checkbox**（永远显未完成）。

## 模板索引

| 类型 | 模板 | 场景 |
|---|---|---|
| T1 | `body-templates/1.md` | bug（现象/位置） |
| T2 | `body-templates/2.md` | 需求（目标/要点） |
| T3 | `body-templates/3.md` | 单点 task（一句话） |
| T4 | `body-templates/4.md` | 遗留/观察（来源） |
| T5 | `body-templates/5.md` | 审查发现 |
| T6 | `body-templates/6.md` | plan 执行方案（目标/拆解/并行批次/验收） |
| T7 | `body-templates/7.md` | plan 版本计划（范围） |
| T8 | `body-templates/8.md` | milestone（版本） |
| T9–T16 | `body-templates/9.md`…`16.md` | 决策 / 疑问 / 状态变更 / 跨文件方案 / 验证 / 依赖 / 发布 / 兜底 |

每个 flow reference 顶部标注了本流程该用的模板。
