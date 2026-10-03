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
 */
export function sessionIdOf(agent: unknown): string | undefined {
  const sessionId = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof sessionId === 'string' ? sessionId : undefined;
}
