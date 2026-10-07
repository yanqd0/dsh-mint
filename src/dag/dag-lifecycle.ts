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
 *   stop reason, which is the "subagent crashed without a verdict" backstop —
 *   and, before doing so, it measures the child one last time and persists that
 *   reading into the document's `samples` (#168), because a child's live
 *   projection state disappears with its session and the number must outlive it.
 *
 * Two rules keep it safe. It **never creates a node** — a node is a modelling
 * decision only `init`/`add` may make — and it **never throws or awaits**: these
 * are fire-and-forget listeners on the host's event bus, and one failing write
 * must not take down an unrelated event dispatch. The persistence step is the
 * same shape: it runs beside `settle`, never in front of it, so a measurement
 * that cannot be read costs a sample rather than the settlement.
 *
 * 「哪次派发属于哪个节点」宿主不给（`SubagentRunInfo` 只有 runId/id/provider/local，
 * 见 `notes/plan-dag.md` §7.8.1），所以认领结果只能自己在 `start` 时记下来，`end` 时
 * 拿它兜底（{@link FALLBACK_MARK}）。批内多节点同时 `running` 时认领本身就会整体错位
 * ——这一步只做到「发生过兜底能被看见」，错位靠「一步一节点」的纪律避免。
 */
import { DAG_NOTE_MAX, sampleOf } from './dag.js';
import { nodeMetrics, rememberMeasurement } from './dag-metrics.js';
import { updateDag } from './dag-store.js';
import type { DagDoc, DagNode, DagSample } from './dag.js';
import type { DagNodeMetrics, DagStatus } from '../shared/records.js';
import type {
  AgentLike,
  AgentsLike,
  DshContext,
  SessionProjectionsLike,
  SubagentRunEndInfoLike,
  SubagentRunInfoLike,
} from '../shared/types.js';

/**
 * How long a note assembled from a child's final message may get.
 *
 * The same ceiling `dag.ts` enforces for a `set` note, applied here because this
 * path builds the text itself instead of validating a caller's.
 */
const NOTE_MAX_BYTES = DAG_NOTE_MAX;

/** A silent end is still an outcome; say so instead of writing an empty note. */
const NO_REASON = 'subagent ended without a verdict';

/**
 * What a settlement written through {@link settleNodeById} says about itself.
 *
 * 兜底认领没有任何日志面可用（宿主 `DshContext` 既没有 logger，`subagent/end`
 * 也没有工具回答），所以「这次是兜底结算的」唯一能存活下来的痕迹就是节点 `note` 的
 * 这个前缀——面板 tooltip 直接看得到它。
 */
const FALLBACK_MARK = '[fallback 认领] ';

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

/**
 * The last node waiting for an agent — the one a starting child belongs to.
 *
 * 返回**认领到的那个节点 id**：`subagent/end` 拿它兜底，所以认领必须能被调用方
 * 记住（宿主 payload 里没有「哪次派发」的关联信息，这是唯一的配对凭据）。
 */
function claimNextNode(
  doc: DagDoc,
  agentId: string,
  now: string
): { doc: DagDoc; nodeId: string } | undefined {
  for (let index = doc.nodes.length - 1; index >= 0; index -= 1) {
    const node = doc.nodes[index] as DagNode;
    if (node.status !== 'running' || node.agent !== undefined) continue;
    const nodes = [...doc.nodes];
    nodes[index] = { ...node, agent: agentId, updated_at: now };
    return { doc: { ...doc, nodes, revision: doc.revision + 1, updated_at: now }, nodeId: node.id };
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
 * 认领过这个节点的子代理没能按 `agent` 结算时的兜底：按 id 结算同一个节点。
 *
 * 守卫与 {@link settleNode} 一致（**只动 `running` 节点**）：子代理已经自己
 * `set` 过结论时，它的记录比兜底更好，也不该让 revision 再跳一次。
 * 三条边界：① 它只救「文档里**没有任何节点**带这个 agent」的情形（按 `agent` 找不到
 * 才走到这里）；② 认领本身错位时，它落到的仍是**认领过的**那个节点——所以它能自证
 * 「发生过兜底」，但**不修错位**（错位只能靠「一步一节点」的纪律避免）；③ 调用方
 * 必须给带 {@link FALLBACK_MARK} 前缀的 note，这是兜底唯一的可见面。
 */
function settleNodeById(doc: DagDoc, nodeId: string, note: string, now: string): DagDoc | undefined {
  const index = doc.nodes.findIndex((node) => node.id === nodeId && node.status === 'running');
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
 * 兜底结算的 note：前缀 `[fallback 认领] ` + 原来的结论原文。
 *
 * 复用 {@link prefixWithinBytes}——它的第二个参数是「要追加的 suffix」，语义是
 * 「按 suffix 占掉的字节把 text 截到剩余预算」，所以把前缀当 suffix 传进去，
 * 拼出来的整条 note 仍在 `DAG_NOTE_MAX` 字节内。
 */
function fallbackNote(note: string): string {
  return `${FALLBACK_MARK}${prefixWithinBytes(note, FALLBACK_MARK)}`;
}

/**
 * 一次派发的配对记录：runId → {父会话, 认领到的节点 id}。
 *
 * `nodeId` 故意**可变**：它由 `start` 里那次认领回调**回填**，而回调与
 * `subagent/end` 是两条互不等待的路径——`end` 可能先到，把 map 里的这一项删掉。
 * 所以 map 只负责把对象交给回调，认领结果写在对象自身上（闭包持有同一个引用），
 * 即使 map 项已经消失，`end` 仍能读到它。
 */
interface PendingRun {
  parent: string;
  nodeId?: string;
}

/**
 * The node a child agent is paired with, in the order the pairing wrote it.
 *
 * The scan is backwards because `claimNextNode` claims the *last* waiting node,
 * so the newest pairing wins when two nodes name the same agent.
 */
function nodeOf(doc: DagDoc, agentId: string): DagNode | undefined {
  for (let index = doc.nodes.length - 1; index >= 0; index -= 1) {
    const node = doc.nodes[index] as DagNode;
    if (node.agent === agentId) return node;
  }
  return undefined;
}

/**
 * One live measurement, once: the session behind an agent, and its two numbers.
 *
 * Shared by the two host paths that persist a sample — the `subagent/end`
 * listener below and the tool's `set`-to-`done` step (`dag-tool.ts`) — because
 * the reading and the "refuse rather than guess" rules are the same for both,
 * and a second copy is a second thing to keep in step.
 *
 * Every reason the measurement can be missing is a `return`: the host has no
 * projection registry, the registry knows no session for the agent, or the two
 * numbers came back empty. None of them is an error worth reporting, and the
 * node's own `tokens` stays the fallback the panel already knows.
 *
 * @param input.agentId - the child session an agent-registry lookup is keyed by.
 * @param input.status - the node's lifecycle, which is what the timing formula
 *   branches on (`running` measures against the sample clock, a settled node
 *   against the `through` its projection recorded).
 */
export function readAgentMetrics(input: {
  agentId: string;
  status: DagStatus;
  agents: AgentsLike | undefined;
  projections: SessionProjectionsLike | undefined;
  sampledMs: number;
}): DagNodeMetrics | undefined {
  const { projections, agents } = input;
  if (projections === undefined) return undefined;
  const agent = agents?.get(input.agentId) as AgentLike | undefined;
  if (agent === undefined || agent === null) return undefined;
  // The registry answers either an agent wrapper (`{ session }`) or the session
  // itself, depending on the host's shape; the fallback eats both (as
  // `dag-metrics.ts` does for the same read).
  const session = (agent as { session?: unknown }).session ?? agent;
  const metrics = nodeMetrics({
    session,
    projections,
    status: input.status,
    sampledMs: input.sampledMs,
  });
  if (metrics.tokens === undefined && metrics.elapsed_ms === undefined) return undefined;
  return metrics;
}

/**
 * The document with one node's measurement merged into `samples`.
 *
 * Only `samples` and the two timestamps move: the reading is *about* the node,
 * and the node's own `status` is the next step's business (`settleNode`), so a
 * sample must not be able to pre-empt or double-bump it. A reading that is
 * already stored with the same `at` is a skip rather than a second write, which
 * keeps the revision (and the panel's guard) still.
 *
 * 给了 `tokens` 时，**同一次**更新里也覆盖该节点的 `tokens`（实测优先于模型自报，
 * revision 仍只 +1）；skip 的那条路径什么都不写，`tokens` 也不写。
 *
 * @param tokens - 宿主实测的 token 数；**实测优先于模型自报**，给了就在同一次
 *   （revision 只 +1）更新里覆盖节点字段。省略表示这次只落 `samples`，节点自报值
 *   保持原样（例如 main 收尾一个曾经配过子代理的节点，见 `dag-tool.ts` 的测量键）。
 */
export function withSample(
  doc: DagDoc,
  nodeId: string,
  sample: DagSample,
  now: string,
  tokens?: number
): DagDoc | undefined {
  if (doc.samples?.[nodeId]?.at === sample.at) return undefined;
  return {
    ...doc,
    nodes:
      tokens === undefined
        ? doc.nodes
        : doc.nodes.map((node) => (node.id === nodeId ? { ...node, tokens } : node)),
    samples: { ...doc.samples, [nodeId]: sample },
    revision: doc.revision + 1,
    updated_at: now,
  };
}

/**
 * Install the subagent ↔ DAG node pairing.
 *
 * @param ctx - the plugin's root context; the listeners are registered there so
 *   every subagent's lifecycle is seen.
 * @param dagDir - DAG directory override; absent means `DAG_DIR`.
 */
export function installDagLifecycle(ctx: DshContext, dagDir?: string): void {
  /** runId → 配对记录（父会话 + 认领到的节点 id），见 {@link PendingRun}。 */
  const pending = new Map<string, PendingRun>();

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

  /**
   * Persist one child's last measurement, without blocking its settlement.
   *
   * The stamp is one local constant for the whole step: `sampledMs` is the host
   * clock the reading was taken at and becomes the stored `at`, so the sample
   * and the live reading agree about when they were measured. The cache write
   * (`rememberMeasurement`) happens *before* the file write, because the cache
   * is what lets the route and the `set` path persist the reading later even if
   * this document write loses the race or fails.
   *
   * @param parent - the DAG-owning session, resolved once by the caller.
   * @param info - the host's own `subagent/end` payload.
   * @param fallbackId - 这次派发**认领过的**节点 id；只在该 agent 在文档里找不到
   *   任何节点时用来定位样本落点，见 {@link settleNodeById} 的边界。
   */
  const saveSample = (parent: string, info: SubagentRunEndInfoLike, fallbackId?: string): void => {
    const agentId = info.id;
    if (typeof agentId !== 'string' || agentId.length === 0) return;
    // Nothing here may throw into the host's dispatch; one `try` covers the
    // whole step, including the service lookups.
    try {
      const sampledMs = Date.now();
      const lookup = {
        agentId,
        agents: agents(),
        projections: ctx.get?.('sessionProjections') as SessionProjectionsLike | undefined,
      };
      write(parent, (doc) => {
        const node =
          nodeOf(doc, agentId) ??
          (fallbackId === undefined
            ? undefined
            : doc.nodes.find((candidate) => candidate.id === fallbackId));
        if (node === undefined) return undefined;
        const metrics = readAgentMetrics({
          ...lookup,
          status: node.status,
          sampledMs,
        });
        if (metrics === undefined) return undefined;
        const sample = sampleOf(metrics, sampledMs);
        if (sample === undefined) return undefined;
        // The cache is written first: it is what lets the route or the `set`
        // path persist this reading later even if this write loses the race.
        rememberMeasurement(parent, node.id, metrics);
        return withSample(doc, node.id, sample, new Date(sampledMs).toISOString());
      });
    } catch {
      // A measurement is a bonus: a host whose services changed shape under us
      // must still get its settlement.
    }
  };

  ctx.on('subagent/start', (info: SubagentRunInfoLike) => {
    const child = agents()?.get(info.id);
    const parent = child?.session.header.parentSession;
    if (parent === undefined) return;
    // 先建对象再写 map，并让下面的 mutation 闭包**持有同一个对象**：认领是异步的
    // （排队等 `updateDag` 的锁），而 `subagent/end` 不排队等它——`end` 完全可以先到，
    // 把 map 里这一项 `pending.delete` 掉。map 只负责把对象交给回调；认领结果写在
    // 对象自身上，所以即使 map 项已经消失，那位仍握着引用的读者也能看到它。
    const entry: PendingRun = { parent };
    pending.set(String(info.runId), entry);
    // `parent` is the session that owns the DAG: a subagent's parent is the
    // root (or the DAG of a nested chain is written by that same root rule).
    write(parent, (doc, now) => {
      const claimed = claimNextNode(doc, String(info.id), now);
      if (claimed === undefined) return undefined;
      entry.nodeId = claimed.nodeId;
      return claimed.doc;
    });
  });

  ctx.on('subagent/end', (info: SubagentRunEndInfoLike) => {
    const runId = String(info.runId);
    const remembered = pending.get(runId);
    const fallbackId = remembered?.nodeId;
    pending.delete(runId);
    // A session started before this plugin loaded (or one the `start` event
    // missed) still has a live agent to ask.
    const parent =
      remembered?.parent ?? agents()?.get(info.id)?.session.header.parentSession;
    if (parent === undefined) return;
    // The measurement first, the settlement second: both are queued on the
    // session's own lock, so the order here is the order on disk — and a
    // measurement that cannot be taken never delays the backstop below.
    saveSample(parent, info, fallbackId);
    const note = completedNote(info);
    // 先按 agent 结算（子代理自己没 `set` 时 `start` 回填的那个 agent 就是它），
    // 找不到再按认领记录兜底 —— 两条路径都只动 `running` 节点。
    write(parent, (doc, now) => {
      const settled = settleNode(doc, String(info.id), note, now);
      if (settled !== undefined) return settled;
      if (fallbackId === undefined) return undefined;
      return settleNodeById(doc, fallbackId, fallbackNote(note), now);
    });
  });
}
