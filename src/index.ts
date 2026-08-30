import { z } from 'zod';

import { installApprovalGate } from './approval-gate.js';
import { registerMintContext } from './context.js';
import { installPlanBinding } from './planbind.js';
import { installMintQuery } from './query.js';
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
});

export type Config = z.infer<typeof Config>;

/**
 * Host-face entry.
 *
 * - #3: mint overview context on every agent session start
 * - #4: commit reminder (`tools/post-execute`) + failure signal (`tools/result`)
 * - #5: plan binding (exit_plan_mode ↔ mint plan)
 * - #6: mint_query tool
 * - #25: approval gate — once-per-session mint escalation approval, then
 *   auto-allowed mint escalations (B-v2)
 */
export function apply(ctx: DshContext, config: Config): void {
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
  installMintQuery(ctx);
  installApprovalGate(ctx, config);
}
