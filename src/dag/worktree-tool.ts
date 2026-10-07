/**
 * The standalone `worktree` host tool: node-level git worktrees behind one
 * `action` parameter.
 *
 * Why it is not an action of `mint_plan_dag` any more: the two families answer
 * different questions. The DAG tool edits a small document in `/tmp` and every
 * action is a read-modify-write under a per-session lock; a worktree action
 * spawns git, touches the real filesystem, and only **then** records what
 * happened on a node. Keeping them together made one schema carry two vocabularies
 * (`op` vs `action`, node fields vs git refs) and one description pay for both —
 * and the split also lets `list` be what it really is, a **repository** question
 * that needs no DAG at all.
 *
 * The rules that did not move are the recording contract: the git outcome is
 * persisted as a follow-up node write (`create`/`merge`/`remove` need this
 * session's document and node), so a refused git command can never leave a
 * worktree claim in the stored graph. The git side itself lives in
 * `dag-worktree.ts`; this file only decides what the graph does with the answer.
 * `list` 与 `prune` 更彻底：它们连文档都不读，是纯粹的**仓库级**动作（`list` 看现状、
 * `prune` 在开工点按规则收旧的）。
 *
 * Git runs in the plugin process (`runGit`), not through a subagent's sandboxed
 * bash: the tree has to be created where the delegating agent can reach it, and
 * the model gets the path back in the same call.
 */
import { checkNodeId, isValidDagSession } from './dag.js';
import {
  createWorktree,
  installedWorktrees,
  mergeWorktree,
  pruneWorktrees,
  removeWorktree,
} from './dag-worktree.js';
import type { PruneResult, PruneVerdict, WorktreeDeps, WorktreeNode } from './dag-worktree.js';
import { isRecord } from '../mint/mint-json.js';
import { runGit } from '../shared/git.js';
import type { GitRunResult } from '../shared/git.js';
import type { DagNodeView, DagWorktree } from '../shared/records.js';
import { rootSessionId } from '../shared/session-id.js';
import { hasControlCharacter } from '../shared/text.js';
import { DAG_DIR, readDag, updateDag } from './dag-store.js';
import type {
  AgentsLike,
  ContentBlockLike,
  DshContext,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../shared/types.js';

/** The tool's registered name; the model calls it as `worktree`. */
export const TOOL_NAME = 'worktree';

/** Every refusal and answer carries this prefix, so a worktree line is not a DAG line. */
const PREFIX = '[worktree] ';

/**
 * Every operation this tool accepts. `list` 与 `prune` 是仓库级动作（不读 DAG），
 * 其余三个作用在某个节点上。
 */
export const WORKTREE_ACTIONS = ['create', 'list', 'merge', 'remove', 'prune'] as const;

/** One operation, as {@link parseWorktreeAction} validated it. */
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

/**
 * How many trees `list` prints before it starts counting.
 *
 * The output goes into the model's context: twenty lines is already a long
 * answer, and `prune` reports the same way at the start of a plan — the count on
 * the last line is what tells the model there are more.
 */
const LIST_MAX = 20;

/**
 * Model-facing tool description.
 *
 * Every byte ships on every request, so this is the whole cheat sheet: what the
 * tool is for, one line per action with the rule that makes it safe, the
 * discipline that keeps a batch mergeable, and one example. The long form is
 * `notes/worktree-tool.md`; the flow is `skill/references/worktree-exec.md`.
 */
export const WORKTREE_TOOL_DESCRIPTION = [
  '按节点管理 git worktree：每棵独立的树对应 DAG 的一个节点；只回摘要。',
  'action：create(node?,base?) 建树并记 target=当前分支；list 列出本仓已装的树（无需 DAG）；',
  'merge(node) 合回该节点记录的目标分支（不一致即拒绝，冲突不裁决）；remove(node?,force?) 清理（未合并默认拒绝）。',
  'prune 按「未合并 / 脏树 / 不到 1 小时」保护清理旧的（开工点用，仓库级）；',
  '只有 main agent 调 create/merge/remove；一步一节点派发、同批同 base（见 skill worktree-exec.md）。',
  '例：worktree({action:"prune"}) 或 worktree({action:"create",node:"a1",base:"<sha>"})。',
].join('\n');

/**
 * The tool's parameter schema.
 *
 * The field-name/action combinations are checked in {@link parseWorktreeAction}
 * rather than here: the host accepts only the plain JSON Schema subset, and a
 * refusal from the executor gives the model a sentence it can act on (which
 * field is wrong, not just that something is).
 */
const WORKTREE_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: [...WORKTREE_ACTIONS],
      description:
        '要执行的操作：create 建树，list 列出，merge 合回目标分支，remove 清理，prune 按规则清理旧的（仓库级）',
    },
    node: { type: 'string', description: '目标 DAG 节点 id（create/merge/remove 必需）' },
    base: {
      type: 'string',
      description: 'create 的起点 commit（缺省 HEAD；一批并行节点必须传同一个 base）',
    },
    force: { type: 'boolean', description: 'remove 时强制删除未合并的 worktree' },
  },
  required: ['action'],
};

/** The tool's output contract; like the DAG tool, a refusal is a normal answer. */
const WORKTREE_TOOL_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['ok', 'summary'],
  additionalProperties: false,
};

/** The one-answer summary rendered back into the conversation. */
export interface WorktreeToolOutcome {
  ok: boolean;
  summary: string;
}

/** A validated `worktree` call. */
export interface WorktreeCall {
  action: WorktreeAction;
  node?: string;
  base?: string;
  force?: boolean;
}

/**
 * Everything one call needs from its caller.
 *
 * `repo` is optional because the installer resolves it per call from the tool
 * execution (a lean context has no cwd): a missing repository is a refusal the
 * executor words, not a type the caller must satisfy.
 */
export interface WorktreeToolInput {
  /**
   * The owning (root) session id; absent when the walk could not resolve one.
   * Explicitly `| undefined` because callers pass "no session" through rather
   * than omitting the key (`exactOptionalPropertyTypes`).
   */
  sessionId?: string | undefined;
  /** Absolute repository root the worktrees belong to. */
  repo?: string;
  /** DAG directory override; absent means `DAG_DIR`. */
  dagDir?: string;
  /** Git runner override for tests; defaults to `runGit`. */
  git?: (cwd: string, args: readonly string[]) => Promise<GitRunResult>;
  agents?: AgentsLike;
}

/** A refusal, worded once so every failure path reads the same way. */
function refusal(reason: string): WorktreeToolOutcome {
  return { ok: false, summary: `${PREFIX}拒绝：${reason}` };
}

/** An answer; the caller supplies the already-formatted body. */
function answer(text: string): WorktreeToolOutcome {
  return { ok: true, summary: `${PREFIX}${text}` };
}

/** One list row: what the model needs to decide the next call, nothing more. */
function listLine(entry: {
  session: string;
  node: string;
  branch: string;
  merged: boolean;
  tipIso: string;
  path: string;
}): string {
  const branch = entry.branch === '' ? '(detached)' : entry.branch;
  const state = entry.merged ? 'merged' : 'unmerged';
  const tip = entry.tipIso === '' ? '?' : entry.tipIso;
  return `  ${entry.session}/${entry.node} · ${branch} · ${state} · ${tip} · ${entry.path}`;
}

/** 保留原因的中文说法：`prune` 的每一行都要说清「为什么没删」。 */
const PRUNE_REASONS: Record<Exclude<PruneVerdict, 'removed'>, string> = {
  unmerged: '未合并',
  dirty: '有未提交改动',
  recent: '不到 1 小时',
  unmeasured: '年龄不可测',
  failed: '删除失败',
};

/** One prune row: what happened to one tree, in one line. */
function pruneLine(entry: PruneResult): string {
  const where = `${entry.session}/${entry.node} · ${entry.branch}`;
  return entry.verdict === 'removed'
    ? `  removed ${where}`
    : `  kept ${where} · ${PRUNE_REASONS[entry.verdict]}`;
}

/**
 * Validate raw tool arguments into a typed call.
 *
 * The combinations are the point: `base` only ever means something to `create`
 * (it is the commit a parallel batch shares), `force` only to `remove` (the
 * override of the unmerged guard), and every action except the two repository-
 * level ones (`list`/`prune`) names exactly one node. Accepting a stray field
 * would silently ignore an intent the caller clearly had, so each one is refused
 * by name.
 *
 * @param raw - the tool call's arguments, however malformed.
 */
export function parseWorktreeAction(raw: unknown): WorktreeCall | { error: string } {
  if (!isRecord(raw)) return { error: '参数必须是对象' };
  const args = raw;
  const { action } = args;
  if (typeof action !== 'string' || !(WORKTREE_ACTIONS as readonly string[]).includes(action)) {
    return { error: `action 必须是 ${WORKTREE_ACTIONS.join(' | ')}：${JSON.stringify(action)}` };
  }
  const call: WorktreeCall = { action: action as WorktreeAction };

  if (args.node !== undefined) {
    const checked = checkNodeId(args.node);
    if (typeof checked !== 'string') return checked;
    call.node = checked;
  }
  // `prune` 与 `list` 一样不认节点：它按规则处理整仓，点名哪一棵是 `remove` 的事。
  if (call.action !== 'list' && call.action !== 'prune' && call.node === undefined) {
    return { error: '该动作需要 node' };
  }
  if (call.action === 'prune' && call.node !== undefined) {
    return { error: 'prune 不接受 node（整仓按规则清理，单棵用 remove）' };
  }
  if (args.base !== undefined) {
    if (call.action !== 'create') return { error: 'base 只用于 create' };
    if (typeof args.base !== 'string' || args.base.trim() === '') {
      return { error: 'base 必须是非空字符串（commit / ref）' };
    }
    if (hasControlCharacter(args.base)) return { error: 'base 含控制字符' };
    call.base = args.base;
  }
  if (args.force !== undefined) {
    if (call.action !== 'remove') return { error: 'force 只用于 remove' };
    if (typeof args.force !== 'boolean') return { error: 'force 必须是布尔值' };
    call.force = args.force;
  }
  return call;
}

/**
 * Run one `worktree` call.
 *
 * Kept free of host types so the whole surface is unit-testable: the installer
 * resolves the session and the repository, this decides what happens.
 *
 * @param input - the owning (root) session id, the repository the trees belong
 *   to (the root session's working directory), the optional DAG directory
 *   (tests point it at a temp directory), and a git runner override for tests.
 * @param rawArgs - the tool call's arguments, however malformed.
 */
export async function executeWorktreeTool(
  input: WorktreeToolInput,
  rawArgs: unknown
): Promise<WorktreeToolOutcome> {
  const parsed = parseWorktreeAction(rawArgs);
  if ('error' in parsed) return refusal(parsed.error);
  const repo = input.repo;
  if (repo === undefined || repo === '') {
    return refusal('无法确定仓库根目录（会话 cwd 未就绪）：worktree 需要 git 仓库');
  }
  const git = input.git ?? runGit;

  // `list` 是仓库级问题：它读 git 自己注册的树，不读本会话的 DAG，也不需要节点。
  if (parsed.action === 'list') {
    const found = await installedWorktrees({ git, repo, session: '' });
    if (found.length === 0) return answer('本仓还没有 dsh-mint worktree');
    const shown = found.slice(0, LIST_MAX).map((entry) => listLine(entry));
    if (found.length > shown.length) {
      shown.push(`  …还有 ${String(found.length - shown.length)} 条`);
    }
    return answer(shown.join('\n'));
  }

  // `prune` 同样是仓库级：开工点先收旧的，判据与「删哪一棵」都在 git 层，
  // 这里只负责排版。它不接受 node —— 点名一棵是 `remove` 的事（显式丢弃）。
  if (parsed.action === 'prune') {
    const results = await pruneWorktrees({ git, repo, session: '' });
    if (results.length === 0) return answer('本仓没有可清理的 dsh-mint worktree');
    const removed = results.filter((entry) => entry.verdict === 'removed').length;
    const lines = [
      `prune：删除 ${String(removed)} 棵，保留 ${String(results.length - removed)} 棵；`,
    ];
    lines.push(...results.slice(0, LIST_MAX - 1).map((entry) => pruneLine(entry)));
    const rest = results.length - (lines.length - 1);
    if (rest > 0) lines.push(`  …还有 ${String(rest)} 条`);
    return answer(lines.join('\n'));
  }

  const sessionId = input.sessionId;
  if (sessionId === undefined) {
    return refusal('无法确定会话：请在本会话内调用（需要 agent session id）');
  }
  if (!isValidDagSession(sessionId)) {
    return refusal(`会话 id 不可用于路径：${JSON.stringify(sessionId)}`);
  }
  const dir = input.dagDir ?? DAG_DIR;
  const read = await readDag(sessionId, dir);
  // The graph is where the record lands, so every node action needs one: a
  // worktree nobody recorded is precisely the leftover this tool exists to avoid.
  if (read.state !== 'ok') {
    return refusal('本会话暂无 DAG；先 mint_plan_dag({action:"init"}) 建立 DAG，再用 worktree');
  }

  const deps: WorktreeDeps = { git, repo, session: sessionId };
  // 定位节点，并把它存储的 worktree 记录一并带出：merge/remove 的目标分支
  // 不在 `WorktreeNode` 里，只能从文档节点的 `worktree.target` 取；这里一次读出。
  const node = read.doc.nodes.find((candidate) => candidate.id === parsed.node);
  if (node === undefined) return refusal(`节点不存在：${String(parsed.node)}`);
  const target: WorktreeNode = { id: node.id };
  // 把记录里的目标分支交给 worktree 层：契约「merge 目标 = 建树时所在分支」
  // 靠这个字段落地；缺记录（早期版本的旧节点）就不传，让 git 层退回按当前分支判定。
  const stored: DagWorktree | undefined = node.worktree;
  const scopedDeps: WorktreeDeps =
    stored?.target === undefined ? deps : { ...deps, target: stored.target };

  const persist = async (worktree: DagWorktree): Promise<void> => {
    await updateDag(
      sessionId,
      (state) => {
        if (state.state !== 'ok') return { skip: true };
        const index = state.doc.nodes.findIndex((candidate) => candidate.id === target.id);
        if (index < 0) return { skip: true };
        const previous = state.doc.nodes[index] as DagNodeView;
        const nodes = [...state.doc.nodes];
        nodes[index] = { ...previous, worktree };
        return { doc: { ...state.doc, nodes, revision: state.doc.revision + 1 } };
      },
      dir
    );
  };

  if (parsed.action === 'merge') {
    const outcome = await mergeWorktree(scopedDeps, target);
    if (!outcome.ok) {
      // A conflict is a real state, not a refusal to hide: record it so the panel
      // shows the node as conflicted, then answer with the actionable text. The
      // outcome carries a complete record (path/branch/base) — persisting
      // an empty `base` here once made the whole stored DAG unreadable.
      if (outcome.conflict !== undefined && outcome.worktree !== undefined) {
        await persist(outcome.worktree);
      }
      return refusal(outcome.error);
    }
    await persist(outcome.worktree);
    const sha = outcome.worktree.merged_sha ?? '';
    return answer(
      `merge ${target.id} → merged · ${outcome.worktree.branch} · ${outcome.worktree.path}` +
        (sha === '' ? '' : `；目标分支 ${sha}`)
    );
  }

  const outcome =
    parsed.action === 'create'
      ? await createWorktree(deps, target, parsed.base)
      : await removeWorktree(scopedDeps, target, parsed.force === true);
  if (!outcome.ok) return refusal(outcome.error);
  await persist(outcome.worktree);
  const note = outcome.note === undefined ? '' : ` · ${outcome.note}`;
  return answer(
    `${parsed.action} ${target.id} → ${outcome.worktree.state} · ${outcome.worktree.branch} · ` +
      `${outcome.worktree.path}${note}`
  );
}

/**
 * Register the `worktree` tool on `ctx.tools`.
 *
 * The plugin's root context is the global layer, so every agent inherits the
 * tool — including in-process subagents, which cannot use the bash path at all.
 * `create`/`merge`/`remove` are the main agent's calls by convention (they act on
 * the shared repository), which the description states.
 *
 * @param ctx - the plugin's root context.
 * @param dagDir - DAG directory override; absent means `DAG_DIR`.
 * @returns the disposer, or `undefined` on a context without a tool registry.
 */
export function installWorktreeTool(ctx: DshContext, dagDir?: string): (() => void) | undefined {
  const tools = ctx.tools;
  if (!tools) {
    return undefined;
  }
  const definition: ToolDefinitionLike = {
    name: TOOL_NAME,
    description: WORKTREE_TOOL_DESCRIPTION,
    parameters: WORKTREE_TOOL_PARAMETERS,
    output: {
      schema: WORKTREE_TOOL_OUTPUT,
      render: (_args, value) => {
        const outcome = value as WorktreeToolOutcome;
        return [{ type: 'text', text: outcome.summary } satisfies ContentBlockLike];
      },
    },
    execute: async (rawArgs, exec: ToolExecutionLike) => {
      const agents = ctx.get?.('agents') as AgentsLike | undefined;
      const sessionId = rootSessionId(exec?.agent, agents);
      // The tree lives inside the **root** session's repository (the same cwd the
      // panel's project reads), so the git runs where the agents that use the
      // path can reach it — not wherever a subagent happens to be.
      const repo = exec?.agent?.session?.header?.cwd;
      return executeWorktreeTool(
        {
          sessionId,
          // `exactOptionalPropertyTypes`: an unresolved cwd omits the key rather
          // than passing `undefined`, which the executor reads as "no repo".
          ...(repo === undefined ? {} : { repo }),
          ...(dagDir === undefined ? {} : { dagDir }),
          ...(agents === undefined ? {} : { agents }),
        },
        rawArgs
      );
    },
  };
  return tools.register(definition);
}
