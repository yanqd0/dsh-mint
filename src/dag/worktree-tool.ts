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
  removeWorktree,
} from './dag-worktree.js';
import type { WorktreeDeps, WorktreeNode } from './dag-worktree.js';
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

/** The four operations this tool accepts; `prune` is a later issue, not an alias. */
export const WORKTREE_ACTIONS = ['create', 'list', 'merge', 'remove'] as const;

/** One operation, as {@link parseWorktreeAction} validated it. */
export type WorktreeAction = (typeof WORKTREE_ACTIONS)[number];

/**
 * How many trees `list` prints before it starts counting.
 *
 * The output goes into the model's context: twenty lines is already a long
 * answer, and everything past it is one number until `prune` (the next issue)
 * gives the leftovers a home.
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
  'action：create(node?,base?) 建树并记录 target=当前分支；list 列出本仓已装的树（无需 DAG）；',
  'merge(node) 合回该节点记录的目标分支（不一致即拒绝，冲突不裁决）；remove(node?,force?) 清理（未合并默认拒绝）。',
  '只有 main agent 调 create/merge/remove；一步一节点派发、同批同 base（见 skill worktree-exec.md）。',
  '例：worktree({action:"create",node:"a1",base:"<sha>"})。',
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
      description: '要执行的操作：create 建树，list 列出，merge 合回目标分支，remove 清理',
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

/**
 * Validate raw tool arguments into a typed call.
 *
 * The combinations are the point: `base` only ever means something to `create`
 * (it is the commit a parallel batch shares), `force` only to `remove` (the
 * override of the unmerged guard), and every action except `list` names exactly
 * one node. Accepting a stray field would silently ignore an intent the caller
 * clearly had, so each one is refused by name.
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
  if (call.action !== 'list' && call.node === undefined) return { error: '该动作需要 node' };
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
  // 定位节点，并把它存储的 worktree 记录一并带出（#189）：merge/remove 的目标分支
  // 不在 `WorktreeNode` 里，只能从文档节点的 `worktree.target` 取；这里一次读出。
  const node = read.doc.nodes.find((candidate) => candidate.id === parsed.node);
  if (node === undefined) return refusal(`节点不存在：${String(parsed.node)}`);
  const target: WorktreeNode = {
    id: node.id,
    ...(node.issue === undefined ? {} : { issue: node.issue }),
  };
  // 把记录里的目标分支交给 worktree 层（#189）：契约「merge 目标 = 建树时所在分支」
  // 靠这个字段落地；缺记录（#189 之前的旧节点）就不传，让 git 层退回按当前分支判定。
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
      // outcome carries a complete record (path/branch/base, #177) — persisting
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
