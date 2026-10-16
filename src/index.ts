import { z } from 'zod';

import { installApprovalGate } from './mint/approval-gate.js';
import { installOverviewChannel } from './host/context.js';
import { installCrossProjectGate } from './mint/cross-project-gate.js';
import { installAgentTreeCapture } from './dag/agent-tree/agent-tree-capture.js';
import { installDagLifecycle } from './dag/dag-lifecycle.js';
import { installDagPlanReminder } from './dag/dag-plan-reminder.js';
import { installDagTool } from './dag/dag-tool.js';
import { installWorktreeSweep } from './dag/dag-worktree-sweep.js';
import { installWorktreeTool } from './dag/worktree-tool.js';
import { installSkill } from './skill/install-skill.js';
import { installMintTool } from './mint/mint-tool.js';
import { installPlanBinding } from './host/planbind.js';
import {
  installCommitReminder,
  installFailureSignal,
  installPlanEntryHint,
  installReadonlyDbHint,
  installSessionRecordReminder,
  installSleepHint,
  installTodoSyncReminder,
} from './host/reminders.js';
import { installMintRoutes } from './host/routes.js';
import { installSessionLedger } from './host/session-ledger.js';
import type { DshContext } from './shared/types.js';

export const name = 'dsh-mint';

/**
 * 本插件在自身（root）ctx 上消费的服务。`tools` 不在此声明，cordis 会拒绝访问
 * （`cannot get property ... without inject`）；`systemPrompt` 在 `agent.ctx`（宿主提供）上消费，不在此处。
 */
export const inject = ['tools'];

/**
 * 宿主（cordis `resolveConfig`）把挂载行缺失的配置原样交给 `~standard.validate`、不做归一化，
 * 故少了这里的默认值整条挂载行会因 `invalid config: - Required (at )` 失效。`.default({})`
 * 让每个字段各回自己的默认值，推断类型仍是普通对象（`apply` 不会见到 `undefined`）。
 */
export const Config = z
  .object({
    /** 预留给挂载行配置：暂无消费方，等对应特性落地才起作用。 */
    debug: z.boolean().default(false),
    /**
     * 自动放行 mint 的沙箱提权、不再弹窗（B-v2）。默认 false：每会话首次提权仍走组合起来的
     * 审批应答者；打开它等于显式信任 mint。
     */
    autoApprove: z.boolean().default(false),
    /**
     * 插件加载时把随包 mint skill 同步进 DSH skill 目录。默认 true：`pnpm add -g` 下构建脚本
     * 可能被拦、postinstall 不跑，这条同步是保证装上的安装路径。
     */
    autoInstallSkill: z.boolean().default(true),
    /**
     * `mint` 工具执行的 mint 入口：`run-mint.js` 路径、原生 mint 二进制、`~` 前缀路径、`PATH` 里的
     * 裸命令，或 `dependency` 哨兵（即使设了 `MINT_ENTRY` 也强制走 `mint-faa` 链）。默认用 `mint-faa`
     * 依赖（范围 `>=0.8.0 <1.0.0`，任意 pre-1.0 版本免插件更新即可生效）；指向本地构建的 mint 可 dogfood。
     */
    mintEntry: z.string().optional(),
    /**
     * 自动打开 plan DAG tab：浏览器半边每 5s 探一次 `GET /dsh-mint/dag`，本会话有 DAG 且该 tab
     * 未开就打开（页类型每会话唯一，重复探测不会叠 tab）；false = 交给 add 控件。
     */
    openDagTab: z.boolean().default(true),
  })
  .default({});

export type Config = z.infer<typeof Config>;

/**
 * 宿主面入口：装配全部 `install*`——mint 概览注入、提交提醒与失败信号、todo 同步提醒、
 * 计划绑定（`exit_plan_mode` ↔ mint plan）、`mint` 工具（CLI 进程内、零授权）、审批门禁
 * （每会话一次，`autoApprove` 可自动放行）、跨项目写门禁、skill 自动安装、面板只读路由
 * （`src/host/routes.ts`）、plan DAG（`mint_plan_dag`、子代理生命周期配对、tab 轮询的只读路由）。
 */
export function apply(ctx: DshContext, config: Config): void {
  if (config.autoInstallSkill !== false) {
    installSkill();
  }
  const mintEntry = config.mintEntry;
  // `agent/created` is the host's lifecycle event (the older
  // `agent/session-start` name is kept as a fallback inside the installer).
  installOverviewChannel(ctx, mintEntry);
  installCommitReminder(ctx);
  // The host todo panel must not drift away from the mint ledger.
  installTodoSyncReminder(ctx);
  // A bash `sleep` while waiting for a subagent delays the settlement
  // notice it is waiting for, so the busy-poll gets named at the call site.
  installSleepHint(ctx);
  // A sandbox-blocked mint run (SQLite's readonly-db error) must read as
  // "use the tool / escalate", not as "mint is broken".
  installReadonlyDbHint(ctx);
  installFailureSignal(ctx);
  // The session-scoped mint-write ledger, read by the plan-mode exit notice.
  // The `mintEntry` makes `-p <本项目>` count as this session's own write.
  installSessionLedger(ctx, mintEntry);
  installSessionRecordReminder(ctx);
  installPlanBinding(ctx, mintEntry);
  // 进计划模式先点名「谁执行」（默认派子代理），再讲 DAG 纪律：执行形态是会话开工前的
  // 第一件事，两条提示同一条工具结果到达时，顺序也该是这个。
  installPlanEntryHint(ctx);
  // 没有 DAG 的计划模式在面板上不可见（空图不会开面板），研究纪律因此在两种缺口上各给一次软提醒：
  // 文档缺失，以及 `init` 之后仍无节点。它读的是与上面的退出门禁同一份计划模式答案（`src/host/plan-mode.ts`）。
  installDagPlanReminder(ctx);
  installMintTool(ctx, mintEntry);
  // The DAG tool and its subagent pairing are registered on the root
  // ctx, so subagents inherit the tool and the listeners see every child run.
  installDagTool(ctx);
  // worktree 动作已从 DAG 工具拆出，成为独立工具：git 侧（建/合/清理）与 DAG 文档
  // 是两套词汇，`list` 更是仓库级问题（不读 DAG），所以 schema、描述与执行器都独立。
  installWorktreeTool(ctx);
  installDagLifecycle(ctx);
  // 与 DAG 生命周期并列装在这里，**不经** `installMintRoutes`：那条在 `ctx.inject(['webServer'])`
  // 里，headless/ACP 这样的组合会整块跳过，而子代理树快照本就该与面板在不在无关。
  installAgentTreeCapture(ctx);
  // A closed plan is the last moment anyone looks at the DAG, so leftover
  // worktrees get named once instead of staying on disk unwatched.
  installWorktreeSweep(ctx);
  installApprovalGate(ctx, config);
  installCrossProjectGate(ctx, mintEntry);
  installMintRoutes(ctx, mintEntry, { openDagTab: config.openDagTab });
}
