import { z } from 'zod';

import { installApprovalGate } from './approval-gate.js';
import { registerMintContext } from './context.js';
import { installSkill } from './install-skill.js';
import { installMintTool } from './mint-tool.js';
import { installPlanBinding } from './planbind.js';
import { installCommitReminder, installFailureSignal } from './reminders.js';
import type { AgentLike, DshContext } from './types.js';

/** dsh-mint — DSH plugin integrating the mint issue tracker into DSH sessions. */
export const name = 'dsh-mint';

/**
 * Services this plugin consumes on its own (root) context. `tools` must be
 * declared here or cordis refuses the access (`cannot get property ... without
 * inject`). `systemPrompt` is consumed on `agent.ctx` (host-provided), not here.
 */
export const inject = ['tools'];

export const Config = z.object({
  /** Reserved for mount-line config — features land in #3–#6. */
  debug: z.boolean().default(false),
  /**
   * Auto-allow mint sandbox escalations without any user prompt (B-v2, #25).
   * Default false: the first mint escalation per session goes through the
   * composed approval answerers; enabling this is an explicit trust of mint.
   */
  autoApprove: z.boolean().default(false),
  /**
   * Sync the bundled mint skill into the DSH skill directory on plugin load
   * (#28). Default true — this is the guaranteed install path under
   * `pnpm add -g`, whose build-script blocking may skip the postinstall.
   */
  autoInstallSkill: z.boolean().default(true),
});

export type Config = z.infer<typeof Config>;

/**
 * Host-face entry.
 *
 * - #3: mint overview context on every agent session start
 * - #4: commit reminder (`tools/post-execute`) + failure signal (`tools/result`)
 * - #5: plan binding (exit_plan_mode ↔ mint plan)
 * - #6/#34: `mint` tool — the whole mint CLI in-process, zero approval
 * - #25: approval gate — once-per-session mint escalation approval, then
 *   auto-allowed mint escalations (B-v2)
 * - #28: skill auto-install — content-syncs the bundled skill on load
 */
export function apply(ctx: DshContext, config: Config): void {
  if (config.autoInstallSkill !== false) {
    installSkill();
  }
  ctx.on('agent/session-start', (payload: { agent?: AgentLike }) => {
    const agent = payload.agent;
    const cwd = agent?.session.header.cwd;
    if (agent?.ctx && cwd) {
      registerMintContext(agent.ctx, cwd);
    }
  });
  installCommitReminder(ctx);
  installFailureSignal(ctx);
  installPlanBinding(ctx);
  installMintTool(ctx);
  installApprovalGate(ctx, config);
}
