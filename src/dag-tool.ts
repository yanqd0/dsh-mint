/**
 * The `mint_plan_dag` host tool (plan #31): the model's write face for a plan's
 * execution DAG.
 *
 * Why a tool and not a shell command: the DAG document lives in
 * `/tmp/mint/dag/<sessionId>.json` and a write is a read-modify-write under a
 * per-session lock (`dag-store.ts`). Only an in-process caller can hold that
 * lock across the whole update, and only a host tool runs for subagents — whose
 * approval policy is pinned to `never` and which therefore cannot reach bash at
 * all (`notes/dsh/0.1.0/06,10,14`).
 *
 * Two properties shape the surface:
 *
 * - **One DAG per root session.** A subagent writes the graph of the session it
 *   was delegated from ({@link rootSessionId}), so the panel of the main session
 *   shows the whole run instead of one fragment per child.
 * - **A bounded answer.** Every action returns at most a few lines
 *   ({@link dagSummary}); the full graph goes to the panel through the read-only
 *   route, never back into the model's context (#61).
 */
import { applyDagWrite, dagSummary, isValidDagSession, parseDagAction } from './dag.js';
import type { DagDoc, DagWrite } from './dag.js';
import { DAG_DIR, readDag, updateDag } from './dag-store.js';
import type {
  AgentsLike,
  ContentBlockLike,
  DshContext,
  ToolDefinitionLike,
  ToolExecutionLike,
} from './types.js';

/** The tool's registered name; the model calls it as `mint_plan_dag`. */
export const TOOL_NAME = 'mint_plan_dag';

/**
 * Every refusal and answer carries this prefix, so a plan DAG line is
 * distinguishable from a `mint` tool line at a glance.
 */
const PREFIX = '[plan-dag] ';

/**
 * How far {@link rootSessionId} walks up a delegation chain.
 *
 * A chain deeper than this is a host bug or a cycle, not a plan: the walk stops
 * and gives up instead of looping.
 */
const MAX_SESSION_HOPS = 16;

/**
 * Model-facing tool description.
 *
 * Every byte ships on every request, so this is the whole cheat sheet: the four
 * actions, the exact field names `add` accepts, the edge direction, and the one
 * rule that keeps a plan coherent — **the main agent owns the graph, a subagent
 * only reports on its own node**. `notes/plan-dag.md` §2 is the long form.
 */
export const DAG_TOOL_DESCRIPTION = [
  '维护本会话的 plan 执行 DAG（节点=工作单元，边=依赖）；只回摘要，全图见面板。',
  '动作：init(title?) 新建/重置；add(nodes,edges?) 加节点连边；set(id,status,verdict?,note?,tokens?) 改节点；get 取摘要。',
  'nodes 每项 {id,label,title,phase:"research"|"exec",depends_on?,issue?}；edges 是 [from,to]，语义「to 依赖 from」；label ≤6 字。',
  '只有 main agent 建节点/连边，子代理只 set 自己的节点；DAG 归属根会话。',
  'set 的 status 取 pending|running|done，verdict(pass|fail) 仅 status="done" 合法。',
  '例：mint_plan_dag({action:"add",nodes:[{id:"a",label:"总①",title:"第一轮",phase:"exec"}]})。',
].join('\n');

/**
 * The tool's parameter schema.
 *
 * Constraints that need a *value* (`label ≤ 6`, `verdict` only with `done`,
 * cycles, unknown ids) are deliberately absent: the host accepts only the plain
 * JSON Schema subset, and a rejected call gets the same wording from
 * {@link executeDagTool} as a rejected tool call would — one place to read.
 */
const DAG_TOOL_PARAMETERS: Record<string, unknown> = {
  type: 'object',
  additionalProperties: false,
  properties: {
    action: {
      type: 'string',
      enum: ['init', 'add', 'set', 'get'],
      description: '要执行的动作：init 新建/重置，add 加节点连边，set 改节点状态，get 取摘要',
    },
    title: { type: 'string', description: 'init 的文档标题' },
    id: { type: 'string', description: 'set 的目标节点 id（须已由 add 建立）' },
    status: {
      type: 'string',
      enum: ['pending', 'running', 'done'],
      description: 'set 的新状态；done 为终态',
    },
    verdict: {
      type: 'string',
      enum: ['pass', 'fail'],
      description: 'set 的结论，仅 status="done" 时合法',
    },
    note: { type: 'string', description: 'set 的结论原文（写进节点 note，面板 tooltip 显示）' },
    tokens: { type: 'integer', description: 'set 自报的 token 消耗（宿主无自动采集）' },
    agent: { type: 'string', description: 'set 关联的子代理 sessionId' },
    nodes: {
      type: 'array',
      description: 'add 新增的节点',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: { type: 'string', description: '节点 id，文档内唯一' },
          label: { type: 'string', description: '节点上显示的短标签（≤6 字）' },
          title: { type: 'string', description: '完整标题，悬停显示' },
          phase: { type: 'string', enum: ['research', 'exec'], description: '所属阶段' },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: '前置节点 id（可指向本批或已存在的节点）',
          },
          issue: { type: 'integer', description: '关联的 mint issue id' },
        },
        required: ['id', 'label', 'title', 'phase'],
      },
    },
    edges: {
      type: 'array',
      description: 'add 新增的边，每项 [from,to] 表示 to 依赖 from',
      items: { type: 'array', items: { type: 'string' } },
    },
  },
  required: ['action'],
};

/**
 * The tool's output contract.
 *
 * `ok` is the domain outcome, not a transport error: a refused action is a
 * normal answer the model reads and corrects, so nothing here throws.
 */
const DAG_TOOL_OUTPUT = {
  type: 'object',
  properties: {
    ok: { type: 'boolean' },
    summary: { type: 'string' },
  },
  required: ['ok', 'summary'],
  additionalProperties: false,
};

/** The one-answer summary rendered back into the conversation. */
export interface DagToolOutcome {
  ok: boolean;
  summary: string;
}

/** A refusal, worded once so every failure path reads the same way. */
function refusal(reason: string): DagToolOutcome {
  return { ok: false, summary: `${PREFIX}拒绝：${reason}` };
}

/** An answer; the caller supplies the already-formatted body. */
function answer(text: string): DagToolOutcome {
  return { ok: true, summary: `${PREFIX}${text}` };
}

/** Narrow the host's structurally-typed agent to the field the walk reads. */
function sessionIdOf(agent: unknown): string | undefined {
  const id = (agent as { session?: { id?: unknown } } | undefined)?.session?.id;
  return typeof id === 'string' && id.length > 0 ? id : undefined;
}

/**
 * The session id a DAG write belongs to.
 *
 * A subagent's own session is the wrong owner: the graph describes the plan the
 * *main* agent is running, and the panel that draws it is attached to that
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

/** The document a write produced, or the reason there is none. */
type WriteOutcome = { doc: DagDoc } | { error: string };

/** `+2 节点 / +1 边` for an `add`: what the model needs to confirm the write. */
function addedCounts(action: Extract<DagWrite, { action: 'add' }>): string {
  return `+${String(action.nodes.length)} 节点 / +${String(action.edges.length)} 边`;
}

/** `a → done/pass` (or `a → running`), the node's line in a `set` answer. */
function setHeadline(action: Extract<DagWrite, { action: 'set' }>): string {
  const verdict = action.verdict === undefined ? '' : `/${action.verdict}`;
  return `${action.id} → ${action.status}${verdict}`;
}

/**
 * Run one `mint_plan_dag` call.
 *
 * Kept free of host types so the whole action surface is unit-testable: the
 * installer resolves the session and the directory, this decides what happens.
 *
 * @param input - the owning session id (already resolved to the root) and the
 *   optional DAG directory (tests point it at a temp directory).
 * @param rawArgs - the tool call's arguments, however malformed.
 */
export async function executeDagTool(
  input: { sessionId: string | undefined; dagDir?: string },
  rawArgs: unknown
): Promise<DagToolOutcome> {
  const parsed = parseDagAction(rawArgs);
  if ('error' in parsed) return refusal(parsed.error);
  const { sessionId } = input;
  if (sessionId === undefined) {
    return refusal('无法确定会话：请在本会话内调用（需要 agent session id）');
  }
  if (!isValidDagSession(sessionId)) {
    return refusal(`会话 id 不可用于路径：${JSON.stringify(sessionId)}`);
  }
  const dir = input.dagDir ?? DAG_DIR;
  if (parsed.action === 'get') {
    const read = await readDag(sessionId, dir);
    // A missing file is the normal "no plan yet" state, not a failure
    // (`notes/plan-dag.md` §1.5), so it answers ok with the empty-state line.
    if (read.state === 'missing') return answer('本会话暂无 DAG');
    if (read.state === 'unreadable') {
      return { ok: false, summary: `${PREFIX}DAG 不可读：${read.error}（${read.file}）` };
    }
    return answer(dagSummary(read.doc));
  }
  // The write actions are one read-modify-write each: `applyDagWrite` owns the
  // graph rules and refuses without touching the file.
  const now = new Date().toISOString();
  // The decision is captured out of the mutation callback, so the success
  // summary can name what `applyDagWrite` produced without a second parse. The
  // callback always runs before `updateDag` resolves, which is what makes the
  // definite assignment below safe.
  let applied: WriteOutcome | undefined;
  const update = await updateDag(
    sessionId,
    (state) => {
      const current = state.state === 'ok' ? state.doc : undefined;
      const decision = applyDagWrite(parsed, current, sessionId, now);
      applied = decision;
      return 'error' in decision ? { error: decision.error } : { doc: decision.doc };
    },
    dir
  );
  if (!update.ok) return refusal(update.error);
  if (applied === undefined) return refusal('内部错误：写入未执行');
  if ('error' in applied) return refusal(applied.error);
  const doc = applied.doc;
  if (parsed.action === 'init') {
    return answer(`已初始化 DAG「${doc.title}」（session ${sessionId}）`);
  }
  if (parsed.action === 'add') {
    return answer(`${addedCounts(parsed)}；${dagSummary(doc)}`);
  }
  return answer(`${setHeadline(parsed)}；${dagSummary(doc)}`);
}

/**
 * Register the `mint_plan_dag` tool on `ctx.tools`.
 *
 * The plugin's root context is the global layer, so **every** agent inherits the
 * tool — including in-process subagents, which is exactly who needs to report a
 * node's status back ({@link rootSessionId} maps their call onto the main
 * session's graph).
 *
 * @param ctx - the plugin's root context.
 * @param dagDir - DAG directory override; absent means `DAG_DIR`.
 * @returns the disposer, or `undefined` on a context without a tool registry.
 */
export function installDagTool(ctx: DshContext, dagDir?: string): (() => void) | undefined {
  const tools = ctx.tools;
  if (!tools) {
    return undefined;
  }
  const definition: ToolDefinitionLike = {
    name: TOOL_NAME,
    description: DAG_TOOL_DESCRIPTION,
    parameters: DAG_TOOL_PARAMETERS,
    output: {
      schema: DAG_TOOL_OUTPUT,
      render: (_args, value) => {
        const outcome = value as DagToolOutcome;
        return [{ type: 'text', text: outcome.summary } satisfies ContentBlockLike];
      },
    },
    execute: async (rawArgs, exec: ToolExecutionLike) => {
      const agents = ctx.get?.('agents') as AgentsLike | undefined;
      const sessionId = rootSessionId(exec?.agent, agents);
      return executeDagTool(dagDir === undefined ? { sessionId } : { sessionId, dagDir }, rawArgs);
    },
  };
  return tools.register(definition);
}
