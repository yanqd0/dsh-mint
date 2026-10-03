import { isWriteInvocation } from './cross-project.js';
import { invocationsOf, sessionIdOf } from './cross-project-gate.js';
import type { DshContext, ToolExecutionLike, ToolResultLike } from './types.js';

/**
 * Session-scoped mint-write ledger (#111).
 *
 * The plan-binding gate (`planbind.ts`) can only see that *some* plan in the
 * project is `running` — a project-level fact. The question "has this session
 * recorded anything?" needs a session-level fact, and the only reliable evidence
 * of it is a mint write performed by this session. This module keeps exactly
 * that: a bounded set of session ids that wrote to **their own** project.
 *
 * Deliberately an observer over `tools/result`:
 *
 * - it never participates in the `tools/post-execute` waterfall, so it cannot
 *   change or veto a tool's content;
 * - it reads the invocation through the same classifier the cross-project gate
 *   uses (`invocationsOf` + `isWriteInvocation`), so "what counts as a write"
 *   has one definition;
 * - a mint *domain* failure (an invalid state transition, which the tool reports
 *   as `ok: false` without an error result) still counts. The ledger answers
 *   "did this session touch the ledger", not "did the write succeed" — and that
 *   is why the `mint` tool itself needs no change here.
 *
 * A cross-project write (`-p <project>` / `MINT_PROJECT`) is **not** a record of
 * this session's work in this project, so it does not count.
 */

/** How many sessions are remembered; matches the other bounded session maps. */
export const MAX_SESSIONS = 100;

/** Sessions that performed at least one own-project mint write, oldest first. */
const writes = new Set<string>();

/** Record one own-project mint write for a session. */
export function recordMintWrite(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  if (writes.has(sessionId)) return;
  if (writes.size >= MAX_SESSIONS) {
    const oldest = writes.values().next().value;
    if (oldest !== undefined) writes.delete(oldest);
  }
  writes.add(sessionId);
}

/**
 * True when this session has already written to its own project's ledger.
 *
 * An unknown session id answers `false`: the caller either stays silent (the
 * plan-mode reminder) or asks the user (a future hard gate) rather than
 * pretending a record exists.
 */
export function hasMintWrite(sessionId: string | undefined): boolean {
  return sessionId !== undefined && writes.has(sessionId);
}

/** Forget every recorded session (tests: state must not leak between cases). */
export function resetSessionLedger(): void {
  writes.clear();
}

/** True when a tool result carries an own-project mint write. */
export function isOwnProjectMintWrite(exec: ToolExecutionLike, result?: ToolResultLike): boolean {
  if (result?.isError === true) return false;
  try {
    return invocationsOf(exec).some(
      (invocation) => invocation.project === undefined && isWriteInvocation(invocation)
    );
  } catch {
    // An unreadable call is not evidence of a record.
    return false;
  }
}

/**
 * Register the ledger's observer.
 *
 * `tools/result` is emit-only (the host contains listener failures), and the
 * tool name is checked inside `invocationsOf` before any work, so unrelated
 * calls cost nothing.
 */
export function installSessionLedger(ctx: DshContext): () => void {
  return ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    if (isOwnProjectMintWrite(exec, result)) {
      recordMintWrite(sessionIdOf(exec?.agent));
    }
  });
}
