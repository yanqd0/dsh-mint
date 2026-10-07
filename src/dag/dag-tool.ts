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
 *   was delegated from (`rootSessionId`), so the panel of the main session
 *   shows the whole run instead of one fragment per child.
 * - **A bounded answer.** Every action returns at most a few lines
 *   ({@link dagSummary}); the full graph goes to the panel through the read-only
 *   route, never back into the model's context (#61).
 *
 * Settling a node also persists the host's last measurement of its child
 * ({@link persistNodeSample}, #168): the `subagent/end` listener covers a child
 * that died, and `set status="done"` covers the one that reported back before
 * its session went away. That step is a second, best-effort write *after* the
 * action's own document, so a measurement can never delay or fail the answer.
 * 测量键已改为「调用者自己的会话」（子代理收尾自己节点时它必然活着，且不受宿主
 * 配对错位影响），只在 main 收尾时才退回节点的 `agent`——见 {@link measuredNode}。
 *
 * The worktree actions left this tool: they are the standalone `worktree` tool
 * (`worktree-tool.ts`), which owns the git side and writes back through the same
 * `set`-shaped persistence — this file only knows the graph.
 */
import { applyDagWrite, dagSummary, isValidDagSession, parseDagAction, sampleOf } from './dag.js';
import type { DagDoc, DagWrite } from './dag.js';
import { readAgentMetrics, withSample } from './dag-lifecycle.js';
import { rememberMeasurement } from './dag-metrics.js';
import { rootSessionId, sessionIdOf } from '../shared/session-id.js';
import { DAG_DIR, readDag, updateDag } from './dag-store.js';
import type {
  AgentsLike,
  ContentBlockLike,
  DshContext,
  SessionProjectionsLike,
  ToolDefinitionLike,
  ToolExecutionLike,
} from '../shared/types.js';

/** The tool's registered name; the model calls it as `mint_plan_dag`. */
export const TOOL_NAME = 'mint_plan_dag';

/**
 * Every refusal and answer carries this prefix, so a plan DAG line is
 * distinguishable from a `mint` tool line at a glance.
 */
const PREFIX = '[plan-dag] ';

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
  // worktree 建/合/列的用法已拆到独立的 `worktree` 工具（injection-size 守卫按
  // 实测值 +20 B 收紧），故这里只留四个图动作，不再复述那条工作流。
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
    tokens: {
      type: 'integer',
      description: '节点 token 数；由子代理收尾时宿主实测并覆盖（实测优先，main 自有节点不填）',
    },
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

/** Everything one `set`-to-`done` measurement needs. */
export interface DagSampleInput {
  sessionId: string;
  /** The node that just settled. */
  nodeId: string;
  /**
   * 这次读数按哪个会话读：`own` 为 true 时是**调用者自己的会话**（子代理收尾
   * 自己的节点，它必然活着），否则是节点自己记的 `agent`（旧路径）。
   */
  agentId: string;
  /**
   * 这次读的是**调用者自己的会话**。
   *
   * true 时宿主实测优先：读数落 `samples`，并把同一个 token 数覆盖写进节点的
   * `tokens`（模型自报的值让位）。`status` 也随之为 `running`（调用者的 turn 还在
   * 进行，计时按运行口径对采样钟算）；省略/false 表示旧路径，只落 `samples`。
   */
  own?: boolean;
  dagDir: string;
  agents: AgentsLike | undefined;
  projections: SessionProjectionsLike | undefined;
}

/**
 * Persist the node's last host measurement as the `set` settles it (#168).
 *
 * `set status="done"` is the moment the model reports a node finished, and it is
 * often the *last* moment the child session is still alive to be read — the
 * `subagent/end` listener covers the crash path, this covers the polite one. The
 * two writes are deliberately separate: the `set` above is the tool's answer and
 * may not be delayed or failed by a measurement, so this runs after it, as a
 * best-effort second write that only touches `samples`（以及 `own` 路径下节点的
 * `tokens`，同一次更新里覆盖自报值）。
 *
 * The reading is remembered as well as stored, so the route can still flush it
 * for a node that was re-opened (and is therefore `running` again) later.
 *
 * @param input - the owning session, the session this reading is keyed by (the
 *   caller's own, or the node's `agent`), and the host services.
 * @returns nothing; every failure is a measurement that was not taken.
 */
export async function persistNodeSample(input: DagSampleInput): Promise<void> {
  try {
    const sampledMs = Date.now();
    const metrics = readAgentMetrics({
      agentId: input.agentId,
      // 两种口径分开：调用者自己的会话还在跑，计时按 running 对采样钟算；旧路径读的
      // 是已经结算的节点，用它投影里的 `through`。token 与口径无关，两边同一读法。
      status: input.own === true ? 'running' : 'done',
      agents: input.agents,
      projections: input.projections,
      sampledMs,
    });
    if (metrics === undefined) return;
    const sample = sampleOf(metrics, sampledMs);
    if (sample === undefined) return;
    rememberMeasurement(input.sessionId, input.nodeId, metrics);
    await updateDag(
      input.sessionId,
      (state) => {
        if (state.state !== 'ok') return { skip: true };
        const next = withSample(
          state.doc,
          input.nodeId,
          sample,
          new Date(sampledMs).toISOString(),
          // 只有「调用者自己的会话」这个测量键才把实测值写进节点字段：main 给自己
          // 的节点收尾时读的是整条主会话的累计，对「该节点开销」没有意义，不能填。
          input.own === true ? metrics.tokens : undefined
        );
        return next === undefined ? { skip: true } : { doc: next };
      },
      input.dagDir
    );
  } catch {
    // A measurement is a bonus; the tool's answer is already written.
  }
}

/**
 * `set` 刚改完的那个节点，以及这次读数该按哪个会话读。
 *
 * 测量键按可信度排序：① **调用者自己的会话**——子代理给自己节点收尾时它必然活着，
 * 不受宿主注册表释放、也不受「一批多节点整体错位」影响，且**不要求节点有 `agent`**
 * （这正是修掉「没有 agent 的节点结构上永远没有读数」的地方）；② 否则退回节点自己
 * 的 `agent`（旧路径：main 收尾一个曾经派过子代理的节点，仍只写 `samples`）；
 * ③ main 给自己的节点（没有 `agent`）→ 不测——读到的会是整条主会话的累计，语义不对。
 *
 * @param doc - {@link applyDagWrite} 产出的文档。
 * @param action - 产出它的那次写入。
 * @param callerId - 调用者自己的会话 id；`undefined` 表示身份不可知，退回旧路径。
 * @param rootId - 文档归属的根会话 id；与 `callerId` 相同即 main 自己在收尾。
 * @returns 节点 id、测量键、以及这次读的是否是调用者自己的会话。
 */
function measuredNode(
  doc: DagDoc,
  action: Extract<DagWrite, { action: 'set' }>,
  callerId: string | undefined,
  rootId: string | undefined
): { id: string; agentId: string; own: boolean } | undefined {
  const node = doc.nodes.find((candidate) => candidate.id === action.id);
  if (node === undefined) return undefined;
  if (callerId !== undefined && callerId !== rootId) {
    return { id: node.id, agentId: callerId, own: true };
  }
  if (node.agent === undefined) return undefined;
  return { id: node.id, agentId: node.agent, own: false };
}

/**
 * Run one `mint_plan_dag` call.
 *
 * Kept free of host types so the whole action surface is unit-testable: the
 * installer resolves the session and the directory, this decides what happens.
 *
 * @param input - the owning session id (already resolved to the root), the
 *   caller's own session id (the measurement key when a subagent settles its
 *   node), the optional DAG directory (tests point it at a temp directory), and
 *   the host services a settling measurement reads (`agents`/`projections`;
 *   absent means the sample step is skipped, never that the action fails).
 * @param rawArgs - the tool call's arguments, however malformed.
 */
export async function executeDagTool(
  input: {
    sessionId: string | undefined;
    callerId?: string | undefined;
    dagDir?: string;
    agents?: AgentsLike;
    projections?: SessionProjectionsLike;
  },
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
  // A node the model just settled is the host's last chance to measure its
  // child: the sample is written after the answer's own document, so it can
  // never delay or fail the `set` itself (#168). 测量键取调用者自己的会话（子代理
  // 收尾自己的节点），退回节点 `agent` 只是旧路径，见 `measuredNode`。
  if (parsed.status === 'done') {
    const settled = measuredNode(doc, parsed, input.callerId, sessionId);
    if (settled !== undefined) {
      await persistNodeSample({
        sessionId,
        nodeId: settled.id,
        agentId: settled.agentId,
        // 只有 own 这条路才把实测 token 覆盖进节点字段；旧路径保持自报值。
        ...(settled.own ? { own: true } : {}),
        dagDir: dir,
        agents: input.agents,
        projections: input.projections,
      });
    }
  }
  return answer(`${setHeadline(parsed)}；${dagSummary(doc)}`);
}

/**
 * Register the `mint_plan_dag` tool on `ctx.tools`.
 *
 * The plugin's root context is the global layer, so **every** agent inherits the
 * tool — including in-process subagents, which is exactly who needs to report a
 * node's status back (`rootSessionId` maps their call onto the main session's
 * graph).
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
      // 测量键 = 调用者**自己**的会话：子代理收尾自己节点时它必然活着，比节点上可能
      // 错位的 `agent` 可靠；`rootSessionId` 只回答图归谁，两者不是一回事。
      const callerId = sessionIdOf(exec?.agent);
      // The sample step reads the same two host services the DAG route does,
      // resolved per call because a composition may mount them after this tool.
      const projections = ctx.get?.('sessionProjections') as SessionProjectionsLike | undefined;
      return executeDagTool(
        {
          sessionId,
          callerId,
          ...(dagDir === undefined ? {} : { dagDir }),
          ...(agents === undefined ? {} : { agents }),
          ...(projections === undefined ? {} : { projections }),
        },
        rawArgs
      );
    },
  };
  return tools.register(definition);
}
