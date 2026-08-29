import { z } from 'zod';

import { registerMintContext } from './context.js';
import type { DshContext } from './types.js';

/** dsh-mint — DSH plugin integrating the mint issue tracker into DSH sessions. */
export const name = 'dsh-mint';

/** Services this plugin consumes (filled in by #3–#6). */
export const inject = {};

export const Config = z.object({
  /** Reserved for mount-line config — features land in #3–#6. */
  debug: z.boolean().default(false),
});

export type Config = z.infer<typeof Config>;

interface SessionStartPayload {
  /** Agent-scoped context (host `Agent.ctx`) — agent-local registration. */
  ctx?: DshContext;
}

/**
 * Host-face entry.
 *
 * Registers the mint overview context on every agent session start (#3).
 * Event reminders (#4), plan binding (#5) and the mint_query tool (#6) land
 * here as they ship.
 */
export function apply(ctx: DshContext, _config: Config): void {
  ctx.on('agent/session-start', (payload) => {
    const agent = payload as SessionStartPayload;
    if (agent.ctx) {
      registerMintContext(agent.ctx);
    }
  });
}
