import type { AgentsLike } from './types.js';

/**
 * Session identity of a host `Agent` (or of anything carrying one).
 *
 * The runtime may hand out a fresh `Agent` object per dispatch, so only the
 * session id is stable — every session-scoped decision (approval grants #80,
 * the mint-write ledger #111, the injection channel's dedup #113) has to key on
 * it. Absent or non-string ids yield `undefined`, which means "do not
 * attribute": callers then fail open (no grant remembered, no injection dedup
 * applied).
 *
 * Its own module only so the three callers can share one rule instead of
 * restating the shape three times (the duplication #103 was about).
 *
 * {@link rootSessionId} lives here too: it is the same question asked one level
 * up the chain, and **two** tools need the answer (`mint_plan_dag` and the
 * worktree tool), so keeping the walk next to `sessionIdOf` is what stops a
 * second copy of it from appearing in the next tool.
 */

export function sessionIdOf(agent: unknown): string | undefined {
  const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof sessionId === 'string' ? sessionId : undefined;
}

/**
 * How far {@link rootSessionId} walks up a delegation chain.
 *
 * A chain deeper than this is a host bug or a cycle, not a plan: the walk stops
 * and gives up instead of looping.
 */
const MAX_SESSION_HOPS = 16;

/**
 * The session id a session-scoped write belongs to.
 *
 * A subagent's own session is the wrong owner: the plan DAG describes the plan
 * the *main* agent is running, and the panel that draws it is attached to that
 * session. So the walk follows `session.header.parentSession` up to the top,
 * with a visited set and a hop ceiling because a corrupted or cyclic chain must
 * fail closed rather than loop.
 *
 * @param agent - the tool execution's agent, however malformed.
 * @param agents - the host's live-agent registry, when the composition has one.
 * @returns the root session id, or `undefined` when it cannot be resolved.
 */
export function rootSessionId(agent: unknown, agents: AgentsLike | undefined): string | undefined {
  const start = sessionIdOf(agent);
  if (start === undefined) return undefined;
  const visited = new Set<string>();
  let current = start;
  for (let hop = 0; hop < MAX_SESSION_HOPS; hop += 1) {
    if (visited.has(current)) return undefined;
    visited.add(current);
    const parent = agents?.get(current)?.session.header.parentSession;
    if (typeof parent !== 'string' || parent.length === 0) return current;
    current = parent;
  }
  return undefined;
}
