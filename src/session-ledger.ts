import { isWriteInvocation } from './cross-project.js';
import { invocationsOf, sessionIdOf } from './cross-project-gate.js';
import { isOwnProject } from './own-project.js';
import type {
  DshContext,
  SessionEventLike,
  SessionLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

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
 * this session's work in this project, so it does not count — but `-p <本项目>`
 * is, because it writes to the very ledger the default path writes (#114).
 */

/** How many sessions are remembered; matches the other bounded session maps. */
export const MAX_SESSIONS = 100;

/** Sessions that performed at least one own-project mint write, oldest first. */
const writes = new Set<string>();

/** Sessions whose log recorded leaving plan mode, oldest first (#116). */
const planModeExits = new Set<string>();

/**
 * Sessions that were already told about the missing record — by the tool-result
 * notice (#111) or by the one-shot overview line (#116). Oldest first.
 */
const recordGapNotified = new Set<string>();

/**
 * Remember one session id in a bounded set, evicting the oldest entry.
 *
 * All session facts in this module share the bound and the eviction order, so
 * they share the insertion helper too.
 */
function remember(set: Set<string>, sessionId: string): void {
  if (set.has(sessionId)) return;
  if (set.size >= MAX_SESSIONS) {
    const oldest = set.values().next().value;
    if (oldest !== undefined) set.delete(oldest);
  }
  set.add(sessionId);
}

/** Record one own-project mint write for a session. */
export function recordMintWrite(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  remember(writes, sessionId);
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

/**
 * Record that a session's log left plan mode (#116).
 *
 * The `/plan off` command and the GUI toggle both end as a `plan/mode`
 * `{active:false}` session event — there is no tool result to enrich, which is
 * the coverage hole #116 describes.
 */
export function notePlanModeExit(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  remember(planModeExits, sessionId);
}

/**
 * Mark the record-gap notice as delivered for this session.
 *
 * The `exit_plan_mode` tool path appends its notice to the tool result (#111),
 * and that delivery must satisfy the overview channel too — otherwise one exit
 * would be announced twice. Marking on the *call* rather than on the appended
 * text makes the two channels mutually exclusive regardless of when the host
 * appends the `plan/mode` event (it does so at the next request assembly, after
 * the tool result was already enriched).
 */
export function noteRecordGapNotified(sessionId: string | undefined): void {
  if (sessionId === undefined) return;
  remember(recordGapNotified, sessionId);
}

/**
 * Consume the one-shot "left plan mode with nothing recorded" notice (#116).
 *
 * Answers `true` at most once per session, and only while all three facts hold:
 * the session left plan mode, it never wrote to its own project, and no notice
 * has been delivered yet. A non-tool exit therefore surfaces exactly one overview
 * line, and a session that records its work never sees one at all.
 */
export function takeRecordGapNotice(sessionId: string | undefined): boolean {
  if (sessionId === undefined || !planModeExits.has(sessionId)) return false;
  if (writes.has(sessionId) || recordGapNotified.has(sessionId)) return false;
  remember(recordGapNotified, sessionId);
  return true;
}

/** Forget every recorded session (tests: state must not leak between cases). */
export function resetSessionLedger(): void {
  writes.clear();
  planModeExits.clear();
  recordGapNotified.clear();
}

/** True when a tool result carries an own-project mint write. */
export function isOwnProjectMintWrite(
  exec: ToolExecutionLike,
  result?: ToolResultLike,
  entry?: string
): boolean {
  if (result?.isError === true) return false;
  try {
    const cwd = exec?.agent?.session?.header?.cwd;
    return invocationsOf(exec).some((invocation) => {
      if (!isWriteInvocation(invocation)) return false;
      if (invocation.project === undefined) return true;
      // `-p <本项目>` writes to this session's own ledger, so it *is* a record of
      // this session's work — unlike a real cross-project write (#114). An
      // unknown own name keeps the old answer: no evidence.
      return cwd !== undefined && isOwnProject(cwd, entry, invocation.project);
    });
  } catch {
    // An unreadable call is not evidence of a record.
    return false;
  }
}

/**
 * Register the ledger's observers.
 *
 * `tools/result` and `session/event` are both emit-only (the host contains
 * listener failures), and the event type / tool name are checked before any
 * work, so unrelated activity costs nothing.
 *
 * The `session/event` listener is the #116 coverage point: a user leaving plan
 * mode with `/plan off` or the GUI toggle produces no tool result at all, so the
 * signal has to come from the session log itself.
 */
export function installSessionLedger(ctx: DshContext, entry?: string): () => void {
  const offResult = ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    if (isOwnProjectMintWrite(exec, result, entry)) {
      recordMintWrite(sessionIdOf(exec?.agent));
    }
  });
  const offEvent = ctx.on('session/event', (session: SessionLike, event: SessionEventLike) => {
    try {
      if (event?.type !== 'plan/mode' || event.data?.active !== false) return;
      notePlanModeExit(session?.id);
    } catch {
      // An unreadable event is not evidence of anything; stay silent.
    }
  });
  return () => {
    offResult();
    offEvent();
  };
}
