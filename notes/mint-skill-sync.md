# mint 升级后的 skill 复核方法（mint-skill-sync）

> 触发：mint（CLI/mint-faa/本地构建）升级后，或用户要求「重估 skill 是否要增补」。
> 目标：用可复核的事实把 `skill/` 对齐到当前 CLI 面，而不是凭印象补文档。

## 复核步骤

1. **拿当前 CLI 面**：`mint({ args: ["--help-llm"] })`（一页，clap 派生，无 DB 副作用）；
   记下版本：`mint({ args: ["-V"] })`（带 build SHA，可区分同版本不同构建）。
2. **对账本仓 `skill/`**：`references/commands.md` 的命令/参数取值、`state-machine.md` 的转换与约束、
   各 `flow-*.md` 的流程步骤。
3. **逐命令 `--help` 补漏**：`--help-llm` **只漏 clap id 为 `version` 的参数**
   （`src/cli/help_llm/syntax.rs` 显式跳过 `help`/`version`），当前即 `milestone create/set --version`；
   其余参数以 `--help` 为准。
4. **对照上游实现（权威语义）**：`~/yanqd0/mint/src/cli/**`（本仓与上游 git 层解耦，仅作核对）。
   派生状态、去重、body 编辑等语义都在源码/测试里，不在 help 文本里。
5. **对照上游 skill 找流程缺口**：`~/yanqd0/mint/claude-plugin/mint-faa/skills/mint/`
   （本仓是 DSH 单宿主版，不迁移其多宿主路由，只移植与 mint 版本相关的流程）。
6. **落地**：按 `AGENTS.md`「skill 拆分原则」——分支内容与独立主题进 `references/`，
   SKILL.md 只加一行指针；跑 `pnpm test`（`tests/guard/skill-doc.test.ts` 守预算与孤儿指针）+ `pnpm build`。

## 只读核对手段

- `mint({ args: ["issue","show","<id>","--json"] })` 看真实 JSON 字段（别沿用旧文档的字段清单）。
- 用**不存在的 id** 试参数取值（如 `link remove 999999 blocked_by 999999`）：取值非法时 clap 直接报错，
  不产生任何写入。

## 本轮（0.8/0.9.0-alpha.1）核实到的坑

| 事实 | 证据 |
|---|---|
| `issue link` 取值是 kebab `blocked-by`；`blocked_by` 只在 JSON `rel` 输出出现 | 实测 exit 2 `invalid value`；`ValueEnum` 派生 |
| 分页页脚 `# Page x/y (N per page, M total)` 在 **stdout**（0.8 起；旧说法 stderr + `--- Page … ---` 作废） | `src/cli/list_common.rs` `print_page_footer`；`help_llm/notes.rs` |
| `issue state commit --sha` 可省（默认 HEAD，非 git 目录必填），`--test-cmd` 仅记录 | `issue state commit --help` |
| 去重只合并 `plan_id=null` 的活跃候选，合并不可逆，`--force-new` 逃生 | `src/cli/issue/add.rs` |
| `issue set`/`plan set` 支持 `--body-append`/`--body-file`/`--body-section`（三选一；section 需配 body/file；标题不存在报 `section not found`） | `src/cli/body_edit.rs` |
| `milestone set --status` 只有 done/dropped 是手动终态（派生短路），open/running 会被重算 | `src/container/sync.rs` |
| 读命令可见 `mint: hint: found unmerged data from machine(s)` → 本地视图不完整，先 `sync pull` | `src/cli/run.rs` |
| 安装同步必须按**整树**比对（曾只比 SKILL.md，references-only 变更静默失效） | `src/skill/install-skill.ts`（#72 修复） |

## 相关 issue

#70–#78（plan #12）：拆分 SKILL.md、补 0.8 命令面、纠错与护栏、安装同步整树比对、复核方法沉淀。
