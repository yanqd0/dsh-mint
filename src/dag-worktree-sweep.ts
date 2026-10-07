/**
 * Plan-close sweep for leftover worktrees (#175).
 *
 * The worktree actions (#172) leave a real directory and a real branch behind on
 * purpose: a merged node's tree is kept so its result can still be inspected, and
 * a conflicted one is kept because the decision is the model's. That makes the
 * **end** of a plan the moment the leftovers become litter — the graph is done,
 * the panel stops being looked at, and nobody merges or removes anything.
 *
 * This listener is the soft nudge for that moment. It observes
 * `tools/post-execute` (enrich, never veto), skips subagent sessions the way every
 * other session-scoped notice does (#113), and only speaks when a `plan close`
 * succeeded and the session's DAG still holds worktrees that are not `removed`.
 */
import { invocationsOf } from './cross-project-gate.js';
import { readDag } from './dag-store.js';
import { isFailedResult } from './reminders.js';
import { sessionIdOf } from './session-id.js';
import type { DagNodeView } from './records.js';
import type {
  ContentBlockLike,
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

/** The nodes whose worktrees are still on disk, in declaration order. */
export function outstandingWorktrees(nodes: readonly DagNodeView[]): DagNodeView[] {
  return nodes.filter((node) => node.worktree !== undefined && node.worktree.state !== 'removed');
}

/**
 * The nudge text, listing node → state → branch so the next step is obvious.
 *
 * It names the tool calls rather than explaining them: the skill owns the flow
 * (`references/worktree-exec.md`), and this line only has to make the leftovers
 * visible at the moment the plan ends.
 */
export function worktreeSweepReminder(nodes: readonly DagNodeView[]): string {
  const lines = nodes.map((node) => {
    const tree = node.worktree;
    const state = tree?.state ?? 'active';
    const branch = tree?.branch ?? '';
    return `  ${node.id} ${state} · ${branch}`;
  });
  return (
    '[mint] plan 已关闭，但本会话还有 worktree 未收尾：\n' +
    `${lines.join('\n')}\n` +
    '已合并的用 mint_plan_dag({action:"wt",op:"remove",node:"<id>"}) 清理；' +
    '未合并的先 merge；冲突态的在对应 worktree 内解决后重跑 merge（或 git merge --abort）。'
  );
}

/**
 * `tools/post-execute` listener: after a successful `plan close`, append the
 * leftover-worktree list once, when there is one.
 */
export async function worktreeSweepListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
  dagDir?: string
): Promise<PostToolDecisionLike> {
  try {
    if (isFailedResult(result)) return next();
    if ((exec.agent?.session?.header?.delegationDepth ?? 0) > 0) return next();
    const closes = invocationsOf(exec).some((invocation) => {
      const [root, leaf] = invocation.rest;
      return root === 'plan' && leaf === 'close';
    });
    if (!closes) return next();
    const sessionId = sessionIdOf(exec.agent);
    if (sessionId === undefined) return next();
    const read = dagDir === undefined ? await readDag(sessionId) : await readDag(sessionId, dagDir);
    if (read.state !== 'ok') return next();
    const leftover = outstandingWorktrees(read.doc.nodes);
    if (leftover.length === 0) return next();
    const reminder: ContentBlockLike = { type: 'text', text: worktreeSweepReminder(leftover) };
    return { kind: 'accept', content: [...result.content, reminder] };
  } catch {
    return next();
  }
}

/**
 * Register the plan-close worktree sweep on `tools/post-execute`.
 *
 * @param ctx - the plugin's root context, so every session's tool calls are seen.
 * @param dagDir - DAG directory override; absent means {@link DAG_DIR} (tests
 *   point it at a temporary directory).
 */
export function installWorktreeSweep(ctx: DshContext, dagDir?: string): () => void {
  return ctx.on(
    'tools/post-execute',
    (exec: ToolExecutionLike, result: ToolResultLike, next: () => Promise<PostToolDecisionLike>) =>
      worktreeSweepListener(exec, result, next, dagDir)
  );
}
