# 会话成本复盘：mint 注入、工具开销与 dsh-dev-dsh 使用效果

> 样本：`session-81beab16-…`（2026-10-01，dsh-mint 仓，一次评估→重构→实现→修复→验证全流程）。
> 数据来源：`~/.dsh/sessions/--home-user-yanqd0-dsh-mint--/<id>/session.v4.jsonl.zstd`（319 次 LLM 调用）。
> 结论用于回答两个问题：**mint 的 token 占用是否值得**、**dsh-dev-dsh 是否省了时间与 token**。

## 1. 会话总量（实测）

| 指标 | 数值 |
| --- | --- |
| LLM 调用次数 | 319 |
| 累计「未缓存输入」 | 235,200 token |
| 累计「缓存读」 | 88,120,576 token |
| 累计输出 | 225,532 token |
| 末次请求上下文 | 424,326 token |
| 平均请求上下文 | 276,977 token |
| 工具调用 / 工具结果字符数 | 384 次 / 730,621 字符 |

读法：上下文一路涨到 42 万 token，但 99.7% 的提示量是**缓存读**；「未缓存输入」只有 23.5 万，
说明前缀稳定、KV cache 打得很满。**真正的成本不是插件注入，而是长会话本身**。

## 2. mint 的固定注入（每请求）

三条由插件注入、每次请求都要重发的内容（验收预算，由 `tests/guard/injection-size.test.ts` 守）：

| 项 | 现状 | 预算上限 |
| --- | --- | --- |
| `[Mint]` 概览（`systemPrompt.context()`） | ≤700 B（top 5 issue + running milestone + 版本行） | 700 B |
| 工具优先指引（`systemPrompt.section()`，order 110） | 168 B | 200 B |
| `mint` 工具描述（工具 schema 内） | 522 B | 550 B |
| `mint` skill 目录行（每轮 skill 目录里的一行） | 276 B | — |
| **合计固定开销** | **≈1.67 KB/请求** | 1,500 B（不含 skill 目录行） |

对本次会话的量级：1.67 KB × 319 ≈ 0.53 MB 字符量级的**前缀**内容，占 88.36 M 提示 token 的
**0.3% 量级**；且因为是稳定前缀，除首次外都是缓存读。**结论：占用小、结构合理（静态部分走 section、
动态部分走 context、有字节上限与回归测试），值得保留。**

## 3. mint 的"行为"开销（工具调用）

工具结果字符数按工具归因（按 callId 配对，100% 归因）：

| 工具 | 调用次数 | 结果字符 | 占比 |
| --- | --- | --- | --- |
| bash | 138 | 297,194 | 40.7% |
| read | 38 | 186,203 | 25.5% |
| cordis_inspect_query | 10 | 125,350 | 17.2% |
| **mint** | **62** | **55,797** | **7.6%** |
| edit | 90 | 30,244 | 4.1% |
| write | 34 | 12,449 | 1.7% |
| skill | 2 | 11,388 | 1.6% |
| cordis_inspect_list | 1 | 8,748 | 1.2% |
| 其它 | 9 | ~3,200 | 0.4% |

- mint 工具 62 次调用（本轮在**用 mint 管理本次开发**，属于偏高样本）合计 5.6 万字符，
  单次均值约 900 字符 —— 与「TSV/JSON 列表 + 分页页脚」的形态相称。
- **最值得优化的不是 mint，而是 `cordis_inspect_query`：10 次调用吃掉 12.5 万字符（17.2%），
  单次均值 12.5 KB。** 全量 `listService`/`listSubTree` 会把整棵目录/整棵 slot 树倒出来。
  可执行做法：先 `cordis_inspect_query` 取精确 key（`{"service":"webServer"}`），
  需要 slot 时才按 `root` 精确查；避免为了"看一眼"拉全量。

## 4. dsh-dev-dsh 的使用效果

| 项 | 实测 |
| --- | --- |
| 载入次数 | 1 次（只载入顶层 `SKILL.md`） |
| 顶层页成本 | 4,270 B |
| 目录行成本 | 112 B/轮（skill 目录里的一行） |
| reference 载入 | **0 个**（45 个文件、331 KB 一个没读） |

**结论：本轮它几乎没有直接产出价值。** 但这不是"内容没用"，而是**路由没被触发**：
我拿到任务后直接奔着运行时的硬事实去了（Inspect + 已安装包产物），没有先读
`references/develop/index.md` → `web-ui-plugins.md`。

### 它本来能省掉的部分

事后核对 `references/develop/web-ui-plugins.md`（7.6 KB），它覆盖了：

- `dsh.client` 四个字段的语义（含 `inject` **只是信息性包名依赖**，不是服务注入）；
- 完整加载链（声明本身不产生 loader entry → 必须有 `dsh.bundle.patch`）；
- **失败面速查表**（`MissingClientBundleError`、`cannot resolve "<spec>"`、`slot "<name>" is not declared` …）；
- 验收路径：`__DSH_BOOT__`、`/plugins/??…` 的 rev 语义。

这些我在本轮主要靠 `dsh-client-modules` 的 README + 报错反推补齐，**属于重复劳动**。

### 它明确不覆盖、只能读产物/源码的部分（本轮真正的硬骨头）

1. **bundle 的加载器包装形态** `window.__ModuleLoader__.load({id, factory})` —— 骨架页明说
   「客户端 bundle 的构建配方…本手册当前不承诺」。实际来自 `dshmarket/client/client.js` 与
   `dsh-client-ui-sidebar-files/lib/client.js` 的产物结构。
2. **PLATFORM_MODULES 基线清单** —— 从 Web 前端产物里那段 `rM()` 表读出（9 个模块）。
3. **右侧边栏 seat 语义**（`ctx.sidebarRightTabs`、`sidebar.right.pane.tab`、guide entry、
   `useTabInfo` 的标准 props）—— 来自 `dsh-client-ui-sidebar-right/README.md` 与 `tab-registry.d.ts`。
4. **静态插件的 host↔client 通道**：为什么 Typert `remote` 不可用、`harness.handle` 只属动态包、
   `ctx.webServer` 路由才是正解 —— 由 `api-remotes` / cordis runner README + `dshmarket/src/host/routes.ts` 推出。
5. **webServer 匹配规则**（前缀不能带尾斜杠）—— 纯源码（`dsh-host-webserver` 的 `match`），
   也是本轮唯一一个**上线后才暴露**的缺陷来源。

### 建议

把这 5 条补进 dsh-dev-dsh 的 `references/develop/web-ui-plugins.md`（尤其 1/2/4/5：
它们都是"不读产物就会踩"的硬事实，而且**稳定**、不随版本腐烂）。同时把
「先读 `develop/index.md` 再动手」写进顶层路由的显式提示，避免像本轮一样跳过。

## 5. 可直接执行的两条改进

1. **Inspect 少拉全量**：`cordis_inspect_query` 按 key/root 精确查询（本条既省 token 也省时间）。
2. **dsh-dev-dsh 补"客户端 bundle 五件事"**：包装形态、基线模块表、右侧边栏 seat、静态插件 RPC 通道、
   webServer 前缀规则（另一仓，待办）。
