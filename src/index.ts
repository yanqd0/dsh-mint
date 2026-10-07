import { z } from 'zod';

import { installApprovalGate } from './mint/approval-gate.js';
import { installOverviewChannel } from './host/context.js';
import { installCrossProjectGate } from './mint/cross-project-gate.js';
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
  installReadonlyDbHint,
  installSessionRecordReminder,
  installSleepHint,
  installTodoSyncReminder,
} from './host/reminders.js';
import { installMintRoutes } from './host/routes.js';
import { installSessionLedger } from './host/session-ledger.js';
import type { DshContext } from './shared/types.js';

/** dsh-mint — DSH plugin integrating the mint issue tracker into DSH sessions. */
export const name = 'dsh-mint';

/**
 * Services this plugin consumes on its own (root) context. `tools` must be
 * declared here or cordis refuses the access (`cannot get property ... without
 * inject`). `systemPrompt` is consumed on `agent.ctx` (host-provided), not here.
 */
export const inject = ['tools'];

/**
 * The host (`cordis` `resolveConfig`) hands a mount line's missing config
 * to `~standard.validate` as a plain `undefined` and does no normalization, so
 * without this default the whole mount line dies (`invalid config: - Required
 * (at )`). `.default({})` makes every field fall back to its own default; the
 * inferred type stays a plain object (`apply` never sees `undefined`).
 */
export const Config = z.object({
  /** 预留给挂载行配置：暂无消费方，等对应特性落地才起作用。 */
  debug: z.boolean().default(false),
  /**
   * Auto-allow mint sandbox escalations without any user prompt (B-v2).
   * Default false: the first mint escalation per session goes through the
   * composed approval answerers; enabling this is an explicit trust of mint.
   */
  autoApprove: z.boolean().default(false),
  /**
   * Sync the bundled mint skill into the DSH skill directory on plugin load.
   * Default true — this is the guaranteed install path under
   * `pnpm add -g`, whose build-script blocking may skip the postinstall.
   */
  autoInstallSkill: z.boolean().default(true),
  /**
   * Mint CLI entry the tool runs: a `run-mint.js` path, a native mint binary,
   * a `~`-prefixed path, a bare `PATH` command, or the `dependency` sentinel
   * (force the `mint-faa` chain even when `MINT_ENTRY` is set).
   * Default: the `mint-faa` dependency (range `>=0.8.0 <1.0.0`, so any pre-1.0
   * release is picked up without a plugin update). Point it at a locally built
   * mint to dogfood an unreleased version.
   */
  mintEntry: z.string().optional(),
  /**
   * Auto-open the plan DAG tab. The browser half probes
   * `GET /dsh-mint/dag` every 5s and opens the tab whenever this session has a
   * DAG and the tab is not already open (the page type is unique per session, so
   * a repeat never stacks one); false = leave the tab to the add control.
   */
  openDagTab: z.boolean().default(true),
}).default({});

export type Config = z.infer<typeof Config>;

/**
 * Host-face entry.
 *
 * - mint overview context on every agent session start
 * - commit reminder (`tools/post-execute`) + failure signal (`tools/result`)
 * - todo-sync reminder — after an `issue state` / `plan plan` / `plan close`
 *   call, the host todo panel is told to catch up with the mint ledger
 * - plan binding (exit_plan_mode ↔ mint plan)
 * - `mint` tool — the whole mint CLI in-process, zero approval
 * - approval gate — once-per-session mint escalation approval, then
 *   auto-allowed mint escalations (B-v2)
 * - cross-project gate — `-p/--project` is allowed, and a write to
 *   another project asks once per session and target project
 * - skill auto-install — content-syncs the bundled skill on load
 * - client-face routes — read-only `ctx.webServer` JSON endpoints the
 *   right-sidebar panel fetches (`src/routes.ts`)
 * - plan DAG — `mint_plan_dag` (`src/dag-tool.ts`), the
 *   subagent ↔ node lifecycle pairing (`src/dag-lifecycle.ts`) and the
 *   read-only `/dsh-mint/dag` route the `plan-dag` tab polls
 * - `mintEntry` — run a locally built mint instead of the published dependency
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
  // Plan mode without a DAG is invisible (an empty graph never opens
  // the panel), so the research discipline gets a soft nudge per gap — the
  // missing document, then an `init` that is still node-less. It reads the same
  // plan-mode answer as the exit gate above (`src/plan-mode.ts`).
  installDagPlanReminder(ctx);
  installMintTool(ctx, mintEntry);
  // The DAG tool and its subagent pairing are registered on the root
  // ctx, so subagents inherit the tool and the listeners see every child run.
  installDagTool(ctx);
  // worktree 动作已从 DAG 工具拆出，成为独立工具：git 侧（建/合/清理）与 DAG 文档
  // 是两套词汇，`list` 更是仓库级问题（不读 DAG），所以 schema、描述与执行器都独立。
  installWorktreeTool(ctx);
  installDagLifecycle(ctx);
  // A closed plan is the last moment anyone looks at the DAG, so leftover
  // worktrees get named once instead of staying on disk unwatched.
  installWorktreeSweep(ctx);
  installApprovalGate(ctx, config);
  installCrossProjectGate(ctx, mintEntry);
  installMintRoutes(ctx, mintEntry, { openDagTab: config.openDagTab });
}
