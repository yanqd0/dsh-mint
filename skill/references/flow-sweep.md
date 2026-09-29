# 孤立 issue 收口流程（flow-sweep）

> 标题/body 模板：`title-templates/issue.md` + `body-templates/3.md、4.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`；挂载口径见 `flow-conditions.md`。

触发：用户要求「收口散落的 issue / 把小的排一起 / 统一清理 open 项」，
或接管扫描（`flow-session.md`）发现一批 `plan_id=null` 的 open 项长期漂移。

## 步骤

1. **收集孤立集**：`mint({ args: ["list","--status","open","--json","--no-page"] })` →
   只保留 `plan_id == null` 的项（已在 plan 里的不动）。
2. **粒度评估**（按**改动面**，不看标题长短）：
   - **S**：单模块小改（文档 / 一条逻辑 / 一条 SQL）。
   - **M**：跨模块但自成一体（如「去重算法 + CLI 开关」）。
   - **L**：需要 schema/迁移、新命令或新表。
3. **S/M 收进一个 plan**：`plan create`（挂当前 running milestone）→ 逐条
   `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })`（一次一个）→
   `mint({ args: ["plan","plan","<PLAN>"] })` 锁定排期 → 统一测试后一次收口。
4. **L 与外部阻塞项不入 sweep**：逐条写明去向（独立 plan / 等待版本 / 阻塞依赖 + 阻塞者 id），
   在结论里给每项一句理由。
5. **同域优先并入既有 plan**：孤立项与既有 plan 同主题 → `plan attach` 到那里，
   不新开重叠/闲置 plan。
6. **登记新缺口**：收口过程中发现的 CLI/文档缺口按 `flow-todo.md` 查重后登记，不混进本次改动。

## 收口

- 统一测试与批量 close 见 `state-machine.md`（`plan close --test-cmd`）。
- 确认不再需要的项用 `state drop --reason`；空 plan 用 `plan drop`（见 `constraints.md`）。
