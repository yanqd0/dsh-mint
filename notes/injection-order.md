# 注入顺序与 KV cache：#63 前提核验（dsh 0.2.0-rc.2 实测）

> 触发：怀疑「动态概览排在静态指引之前 → 其后前缀缓存每轮失效」（#63）。
> 结论：**在 dsh 0.2.0-rc.2 上该前提不成立**，无需改码。本文是核验依据；结论已回写 #63 并 drop。

## 1. 结论

- 静态指引（`MINT_TOOL_GUIDANCE`）在 **system prompt** 里（surface 首节点）。
- 动态概览（`[Mint] …`）由 `systemPrompt.context()` 贡献，最终成为**请求尾部的一条 user 角色消息**
  （`Current runtime context. …`），排在 system prompt 与全部历史之后。
- 因此「动态块插到静态指引之前」在装配结果里不存在；两类内容**不共享排序空间**，
  `src/context.ts` 里的 `CONTEXT_ORDER = 60` 与 `TOOL_GUIDANCE_ORDER = 110` 只各自在自己的注册表内排序。
- 动态快照只在文本变化时才产出新消息，churn 落在尾部；前面的前缀（含更早的快照）逐字节稳定。

## 2. 证据（已安装代码，非推测）

`@deepseek-ai/dsh-system-prompt@0.2.0-rc.2`（`lib/index.js`）：

- `:113 renderPrompt(assembly)` —— 系统提示词**只**拼 `assembly.sections`（按 order 升序）。
- `:132 joinContextSections(sections)` / `:146 renderContextSections(assembly)` —— 动态上下文
  单独拼成 `Current runtime context. …` 文本，与 sections 不同容器。
- `:266 context(context)` + `:348 [...contextByName.values()].sort((a, b) => a.order - b.order)`
  —— **contexts 仅在 contexts 内部按 order 排序**；`sections` 另有自己的排序。
- `:10 SECTION_ORDERS` / `getContextOrder()` —— 两套放置表，各自独立。

`@deepseek-ai/dsh-agent-loop@0.2.0-rc.2`（`lib/index.js`）：

- `:909-910` `preStep()`：`const sections = renderContextSections(assembly);`
  `const context = this.runtimeContext.project(joinContextSections(sections), sections);`
- `:915` 进入步骤的判定回退分支：`messages: context === void 0 ? claimed : [...claimed, context]`
  —— 快照作为**追加**的消息进入本次请求，位置在 `claimed` 之后（即请求尾部）。
- `:334 RuntimeContextProjection.project(current, sections)`：`if (this.retained?.text === snapshot) return;`
  —— 内容未变则不产出新快照；变化只影响新追加的那条。

实证：本会话（0.2.0-rc.2）上下文里同时存在**两条** runtime-context 快照，且都排在 system prompt 之后，
与「追加而非原地替换」一致。

## 3. 唯一会「概览在前」的路径（也不构成问题）

宿主不提供 `systemPrompt.section()` 时，`src/context.ts` 回退把工具指引也注册为 `context()`
（order 61，见 `TOOL_GUIDANCE_CONTEXT_ORDER`），此时快照内部是「概览(60) → 指引(61)」。
但该路径下两块内容**都在同一条动态快照里**，整条快照本来就是每轮变化的尾部内容，
把 61 调到 60 之前不会带来任何缓存收益。

## 4. 复核手法（一分钟）

```bash
# 1) 定位已安装包（v11 下的 hash 目录是当前安装，另一个可能是软链）
D=$(ls -d ~/.nvm/versions/node/*/lib/v11/*/node_modules/.pnpm/@deepseek-ai+dsh-system-prompt@0.2.0-rc.2_*/node_modules/@deepseek-ai/dsh-system-prompt)
A=$(ls -d ~/.nvm/versions/node/*/lib/v11/*/node_modules/.pnpm/@deepseek-ai+dsh-agent-loop@0.2.0-rc.2_*/node_modules/@deepseek-ai/dsh-agent-loop)
grep -n "function renderPrompt\|function joinContextSections" "$D/lib/index.js"
grep -n "runtimeContext.project\|\[\.\.\.claimed, context\]" "$A/lib/index.js"
```

判定规则：只要 `renderPrompt` 仍只吃 `sections`、且 `preStep` 仍把快照追加在 `claimed` 之后，
#63 的前提就不成立；若未来宿主改成「快照原地替换/插到 system prompt 之前」，再重开该 issue。
