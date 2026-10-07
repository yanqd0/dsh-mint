/**
 * The plan DAG's host lifecycle pairing (plan #31).
 *
 * A node's `status` is the model's own claim; the host knows something the model
 * does not — that a subagent it delegated to has actually started or ended. This
 * module is that second opinion, and it is deliberately the *only* thing it
 * does:
 *
 * - `subagent/start` backfills the node's `agent` id, so the panel can show
 *   which child is executing a step.
 * - `subagent/end` settles a node the child never reported on: `fail` plus the
 *   stop reason, which is the "subagent crashed without a verdict" backstop.
 *
 * Two rules keep it safe. It **never creates a node** — a node is a modelling
 * decision only `init`/`add` may make — and it **never throws or awaits**: these
 * are fire-and-forget listeners on the host's event bus, and one failing write
 * must not take down an unrelated event dispatch.
 */
import { DAG_NOTE_MAX } from './dag.js';
import { updateDag } from './dag-store.js';
import type { DagDoc, DagNode } from './dag.js';
import type { AgentsLike, DshContext, SubagentRunEndInfoLike, SubagentRunInfoLike } from './types.js';

/**
 * How long a note assembled from a child's final message may get.
 *
 * The same ceiling `dag.ts` enforces for a `set` note, applied here because this
 * path builds the text itself instead of validating a caller's.
 */
const NOTE_MAX_BYTES = DAG_NOTE_MAX;

/** A silent end is still an outcome; say so instead of writing an empty note. */
const NO_REASON = 'subagent ended without a verdict';

/** Grow a string from a fixed suffix until it fits the byte budget. */
function prefixWithinBytes(text: string, suffix: string): string {
  const budget = NOTE_MAX_BYTES - Buffer.byteLength(suffix, 'utf8');
  const points = Array.from(text);
  let kept = points.length;
  while (kept > 0 && Buffer.byteLength(points.slice(0, kept).join(''), 'utf8') > budget) {
    kept -= 1;
  }
  return points.slice(0, kept).join('');
}

/**
 * The node's conclusion text: why the child stopped, then its last words.
 *
 * A child's final assistant message is the only place its conclusion exists —
 * it never gets to call `set` if it died — so the text blocks are quoted into
 * `note` (the panel's scrollable tooltip). Truncation is explicit rather than
 * silent: a note that was cut says so.
 */
function completedNote(info: SubagentRunEndInfoLike): string {
  const parts: string[] = [];
  const reason = info.stopReason?.trim();
  parts.push(reason === undefined || reason.length === 0 ? NO_REASON : reason);
  for (const block of info.lastAssistantMessage ?? []) {
    if (typeof block !== 'object' || block === null) continue;
    const candidate = block as { type?: unknown; text?: unknown };
    if (candidate.type !== 'text' || typeof candidate.text !== 'string') continue;
    const text = candidate.text.trim();
    if (text.length > 0) parts.push(text);
  }
  const note = parts.join('\n');
  if (Buffer.byteLength(note, 'utf8') <= NOTE_MAX_BYTES) return note;
  return `${prefixWithinBytes(note, '\n…[note 已截断]')}\n…[note 已截断]`;
}

/** The last node waiting for an agent — the one a starting child belongs to. */
function claimNextNode(doc: DagDoc, agentId: string, now: string): DagDoc | undefined {
  for (let index = doc.nodes.length - 1; index >= 0; index -= 1) {
    const node = doc.nodes[index] as DagNode;
    if (node.status !== 'running' || node.agent !== undefined) continue;
    const nodes = [...doc.nodes];
    nodes[index] = { ...node, agent: agentId, updated_at: now };
    return { ...doc, nodes, revision: doc.revision + 1, updated_at: now };
  }
  return undefined;
}

/**
 * Settle the node `agentId` was paired with, when the child never did.
 *
 * A settled node is left alone: the child's own `set` is the better record, and
 * double-writing would also bump the revision the panel re-renders on.
 */
function settleNode(doc: DagDoc, agentId: string, note: string, now: string): DagDoc | undefined {
  const index = doc.nodes.findIndex((node) => node.agent === agentId && node.status === 'running');
  if (index < 0) return undefined;
  const node = doc.nodes[index] as DagNode;
  const nodes = [...doc.nodes];
  nodes[index] = {
    ...node,
    status: 'done',
    verdict: 'fail',
    note,
    updated_at: now,
  };
  return { ...doc, nodes, revision: doc.revision + 1, updated_at: now };
}

/**
 * Install the subagent ↔ DAG node pairing.
 *
 * @param ctx - the plugin's root context; the listeners are registered there so
 *   every subagent's lifecycle is seen.
 * @param dagDir - DAG directory override; absent means `DAG_DIR`.
 */
export function installDagLifecycle(ctx: DshContext, dagDir?: string): void {
  /** runId → the parent session, remembered so `end` needs no agent lookup. */
  const pending = new Map<string, string>();

  const agents = (): AgentsLike | undefined => ctx.get?.('agents') as AgentsLike | undefined;

  /**
   * Fire one locked read-modify-write without awaiting it.
   *
   * The listener contract is synchronous and the mutation is best-effort: a DAG
   * write racing a tool call loses nothing (both go through `updateDag`'s
   * per-session lock), and a failure here must not surface as an event error.
   */
  const write = (
    sessionId: string,
    mutate: (doc: DagDoc, now: string) => DagDoc | undefined
  ): void => {
    const now = new Date().toISOString();
    void updateDag(
      sessionId,
      (state) => {
        // No DAG, or one we cannot trust: skip rather than create or clobber.
        if (state.state !== 'ok') return { skip: true };
        const next = mutate(state.doc, now);
        return next === undefined ? { skip: true } : { doc: next };
      },
      dagDir
    ).catch(() => undefined);
  };

  ctx.on('subagent/start', (info: SubagentRunInfoLike) => {
    const child = agents()?.get(info.id);
    const parent = child?.session.header.parentSession;
    if (parent === undefined) return;
    pending.set(String(info.runId), parent);
    // `parent` is the session that owns the DAG: a subagent's parent is the
    // root (or the DAG of a nested chain is written by that same root rule).
    write(parent, (doc, now) => claimNextNode(doc, String(info.id), now));
  });

  ctx.on('subagent/end', (info: SubagentRunEndInfoLike) => {
    const runId = String(info.runId);
    const remembered = pending.get(runId);
    pending.delete(runId);
    // A session started before this plugin loaded (or one the `start` event
    // missed) still has a live agent to ask.
    const parent = remembered ?? agents()?.get(info.id)?.session.header.parentSession;
    if (parent === undefined) return;
    const note = completedNote(info);
    write(parent, (doc, now) => settleNode(doc, String(info.id), note, now));
  });
}
