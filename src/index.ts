import { z } from 'zod';

import { registerMintContext } from './context.js';
import { installPlanBinding } from './planbind.js';
import { installMintQuery } from './query.js';
import { installCommitReminder, installFailureSignal } from './reminders.js';
import type { DshContext } from './types.js';

/** dsh-mint — DSH plugin integrating the mint issue tracker into DSH sessions. */
export const name = 'dsh-mint';

/**
 * Services this plugin consumes on its own context. `tools`/`shell` must be
 * declared here or cordis refuses the access (`cannot get property ... without
 * inject`). `systemPrompt` is consumed on `agent.ctx` (host-provided), not here.
 */
export const inject = ['tools', 'shell'];

export const Config = z.object({
  /** Reserved for mount-line config — features land in #3–#6. */
  debug: z.boolean().default(false),
});

export type Config = z.infer<typeof Config>;

/**
 * Host-face entry.
 *
 * - #3: mint overview context on every agent session start
 * - #4: commit reminder (`tools/post-execute`) + failure signal (`tools/result`)
 * - #5 (plan binding) and #6 (mint_query tool) land here as they ship.
 */
export function apply(ctx: DshContext, _config: Config): void {
  ctx.on('agent/session-start', (payload: { ctx?: DshContext }) => {
    if (payload.ctx) {
      registerMintContext(payload.ctx);
    }
  });
  installCommitReminder(ctx);
  installFailureSignal(ctx);
  installPlanBinding(ctx);
  installMintQuery(ctx);
}
