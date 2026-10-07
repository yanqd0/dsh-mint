/**
 * Plan-close sweep for leftover worktrees (#175).
 *
 * The worktree actions (#172) leave a real directory and a real branch behind on
 * purpose: a merged node's tree is kept so its result can still be inspected, and
 * a conflicted one is kept because the decision is the model's. That makes the
 * **end** of a plan the moment someone is tempted to sweep it all away — the graph
 * is done, the panel stops being looked at, and the trees quietly pile up.
 *
 * 口径是**不在这一刻清理**（本模块只提醒，不动手）：现场留到下一个开工点，由
 * `worktree({action:"prune"})` 按三条保护（未合并 / 有未提交改动 / 不到 1 小时）收。
 * 详见 `skill/references/worktree-exec.md` §7。
 *
 * This listener is the soft nudge for that moment. It observes
 * `tools/post-execute` (enrich, never veto), skips subagent sessions the way every
 * other session-scoped notice does (#113), and only speaks when a `plan close`
 * succeeded and the session's DAG still holds worktrees that are not `removed`.
 */
import { invocationsOf } from '../mint/cross-project-gate.js';
import { readDag } from './dag-store.js';
import { isFailedResult } from '../host/reminders.js';
import { sessionIdOf } from '../shared/session-id.js';
import type { DagNodeView } from '../shared/records.js';
import type {
  ContentBlockLike,
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from '../shared/types.js';

/** The nodes whose worktrees are still on disk, in declaration order. */
export function outstandingWorktrees(nodes: readonly DagNodeView[]): DagNodeView[] {
  return nodes.filter((node) => node.worktree !== undefined && node.worktree.state !== 'removed');
}

/**
 * The nudge text, listing node → state → branch so the next step is obvious.
 *
 * 口径是**保留现场**：收尾不再逐棵清理。worktree 是「merge 之后仍要回看、可能回改」
 * 的地方，`plan close` 那一刻正是最后一次会看它的时候，过早删掉等于把现场销毁；
 * 旧树改由**下一个开工点**的 `prune` 按规则收（未合并 / 有未提交改动 / 不到 1 小时
 * → 保留）。所以这里第一句必须说清「不在收尾清理」，否则模型会照旧把树一棵棵删掉。
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
    '[mint] plan 已关闭：本会话的 worktree 按口径**保留现场**，不在收尾时清理；\n' +
    '下一次开工点会按规则清理旧的（未合并 / 有未提交改动 / 不到 1 小时 → 保留）：\n' +
    `${lines.join('\n')}\n` +
    '常规路径：下个 plan 开工点先 worktree({action:"prune"})；' +
    '要立刻丢掉某一棵才用 worktree({action:"remove",node:"<id>"})（未合并默认拒绝）。'
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
