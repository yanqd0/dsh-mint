/**
 * 一个会话的子代理树（规格见 `notes/agent-tree.md`）。
 *
 * 三件事分别有各自的真源，本模块只负责把它们对齐到同一个 id 上：
 *
 * - **谁是谁** —— 父会话自己的 `subagentCatalog` 会话投影（`[{id, createdAt, mode, label?}]`，
 *   只列**直接**子级）。它是**持久事实**（写在父会话日志里），所以子代理结束、会话离开注册表
 *   之后，树形与标签仍然读得到；这也正是「不靠遍历活会话猜父子」的原因。
 * - **活不活** —— `ctx.agents.get(id)?.status === 'running'`（宿主自己的答案），退
 *   `ctx.sessions.get(id)` 的存在性。catalog 是历史事实，存活度是此刻的事实，两者刻意分开。
 * - **花了多少** —— 复用 `dag-metrics.ts` 的 `nodeMetrics`：四桶、上下文占用、步数、时长。
 *
 * 全模块**同步、无 I/O**：数据都在宿主内存里，按请求现读；一个坏分支（`stateOf` 抛错、
 * catalog 形状漂移）只丢它自己的子树，绝不带走整棵树——与 `nodeMetrics` 的既有纪律相同。
 */
import { nodeMetrics } from '../dag-metrics.js';
import type { AgentNodeView, DagNodeMetrics } from '../../shared/records.js';
import type { AgentsLike, SessionProjectionsLike, SessionsLike } from '../../shared/types.js';

/** 宿主 `agents.get` 的返回值结构面：Agent（带 `session`）或会话本身都可能。 */
export interface AgentEntryLike {
  status?: string;
  header?: { id?: string; parentSession?: string; createdAt?: number };
  session?: {
    header?: { id?: string; parentSession?: string; createdAt?: number };
  };
}

export interface CollectAgentTreeInput {
  /** 树的根：面板所在的那个会话 id。 */
  rootId: string;
  agents: AgentsLike | undefined;
  sessions: SessionsLike | undefined;
  projections: SessionProjectionsLike | undefined;
  /** 本次读数共用的宿主时钟（epoch ms）。 */
  sampledMs: number;
}

export interface AgentTreeRead {
  nodes: AgentNodeView[];
  counts: { total: number; running: number; unsupported: number };
  warnings?: string[];
}

/**
 * 节点总量上限。
 *
 * 宿主的最大委派深度是 2，正常会话离这个数很远；它守的是坏 catalog（复制粘贴出来的环、
 * 单调增长的重复条目）把一次 HTTP 应答变成一个没完没了的遍历。
 */
const MAX_AGENT_TREE_NODES = 200;

/** 层号上限，理由同上：坏 catalog 的环在这里被切断。 */
const MAX_AGENT_TREE_DEPTH = 8;

/** 子代理没带 label 时给它的可读身份：短 id 比空白强。 */
const ID_LABEL_LENGTH = 8;

/** 一个 catalog 条目：宿主 `subagentCatalog` wire view 逐字段校验后的形状。 */
interface CatalogEntry {
  id: string;
  createdAt?: number;
  mode?: 'one-shot' | 'continuable';
  /** 派发时的 description；宿主可能没给，那时面板退回短 id。 */
  label?: string;
}

/** 一个会话对象：`agents.get` 的 Agent 与会话本身都归一到这里。 */
interface SessionEntry {
  session: unknown;
  header: { id?: string; parentSession?: string; createdAt?: number };
}

/** 待展开/已展开的一个节点：父与标签都随队列走，避免回头再查一次会话。 */
interface WalkItem {
  id: string;
  session: unknown;
  depth: number;
  parent: string | undefined;
  label: string | undefined;
  mode: CatalogEntry['mode'];
  seenAt: number | undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * 把两种宿主形状归一成一种。
 *
 * 判据是**自己有没有 `header`**，不是「有没有 `session` 字段」：`agents.get` 给的是 Agent
 * （带 `session`），而 `sessions.get`（以及 Agent 身上的 `session`）给的是会话本身。按
 * 「有 `session` 就当 Agent」判会在两层都能给出 `session` 时读错一层，进而把读数的键取错。
 */
function normalizeSession(value: unknown): SessionEntry | undefined {
  if (!isRecord(value)) return undefined;
  const direct = value['header'];
  if (isRecord(direct)) return { session: value, header: readHeader(direct) };
  const carried = value['session'];
  if (!isRecord(carried)) return undefined;
  const nested = carried['header'];
  if (!isRecord(nested)) return undefined;
  return { session: carried, header: readHeader(nested) };
}

function readHeader(header: Record<string, unknown>): SessionEntry['header'] {
  const id = header['id'];
  const parentSession = header['parentSession'];
  const createdAt = header['createdAt'];
  return {
    ...(typeof id === 'string' ? { id } : {}),
    ...(typeof parentSession === 'string' ? { parentSession } : {}),
    ...(isCount(createdAt) ? { createdAt } : {}),
  };
}

function lookUp(id: string, input: CollectAgentTreeInput): unknown {
  // `agents` 优先：注册表里的那个对象才是**活着**的会话（`sessions.get` 只保证「有一个会话」，
  // 已结束的子代理可能仍留在会话注册表里，但那已经不是能读实时投影的那个会话了）。
  const fromAgents = input.agents?.get(id);
  if (normalizeSession(fromAgents) !== undefined) return fromAgents;
  const fromSessions = input.sessions?.get(id);
  if (normalizeSession(fromSessions) !== undefined) return fromSessions;
  // 两个注册表都答不出可用的会话对象：退回 agents 的原始答案，让调用方按「读不出读数」处理。
  return fromAgents ?? fromSessions;
}

/** 该 id 是否有一个正在干活的 agent（宿主自己的状态，不是猜出来的）。 */
function isRunning(id: string, input: CollectAgentTreeInput): boolean {
  const entry = input.agents?.get(id);
  if (!isRecord(entry)) return false;
  return entry['status'] === 'running';
}

/**
 * 读一个会话的直接子级。
 *
 * `subagentCatalog` 未注册、形状不对或 `stateOf` 抛错都答「没有子级」：树少一层远好过整条
 * 路由 500。`mode === 'unknown'` 的条目**按宿主自己的语义**不画（`listDescendants` 把它报成
 * `unsupported`）：那样的条目连 one-shot / continuable 都还没确定，没有可展示的身份。
 */
function childrenOf(
  session: unknown,
  input: CollectAgentTreeInput
): { children: CatalogEntry[]; unsupported: number } {
  if (input.projections === undefined) return { children: [], unsupported: 0 };
  let raw: unknown;
  try {
    raw = input.projections.stateOf(session, 'subagentCatalog');
  } catch {
    return { children: [], unsupported: 0 };
  }
  if (!Array.isArray(raw)) return { children: [], unsupported: 0 };
  const children: CatalogEntry[] = [];
  let unsupported = 0;
  for (const entry of raw) {
    if (!isRecord(entry)) continue;
    const id = entry['id'];
    if (typeof id !== 'string' || id.length === 0) continue;
    const mode = entry['mode'];
    if (mode === 'unknown') {
      unsupported += 1;
      continue;
    }
    const createdAt = entry['createdAt'];
    const label = entry['label'];
    children.push({
      id,
      ...(isCount(createdAt) ? { createdAt } : {}),
      ...(mode === 'one-shot' || mode === 'continuable' ? { mode } : {}),
      ...(typeof label === 'string' && label.trim().length > 0 ? { label } : {}),
    });
  }
  return { children, unsupported };
}

/** 一个节点的读数：`main` 不发 token 计数，理由见 `nodeMetrics` 的注释。 */
function metricsOf(
  session: unknown,
  running: boolean,
  kind: 'main' | 'subagent',
  input: CollectAgentTreeInput
): DagNodeMetrics | undefined {
  if (input.projections === undefined) return undefined;
  const metrics = nodeMetrics({
    session,
    projections: input.projections,
    status: running ? 'running' : 'done',
    sampledMs: input.sampledMs,
    kind,
  });
  return Object.keys(metrics).length === 0 ? undefined : metrics;
}

/**
 * 广度优先读出一棵子代理树，输出**先序扁平数组**（根在前，子级紧随其父）。
 *
 * 先序是面板的排版契约：列表形态直接按数组顺序画，缩进由 `depth` 决定，客户端不必再排一次。
 * 子级即使连会话都读不出来也照旧入树（catalog 是持久事实），只是它没有读数、也没有下一层。
 *
 * @param input - 根会话 id、三个宿主服务与本次采样时钟。
 * @returns 节点、计数与读不到服务时的说明性 `warnings`（空树不是错误）。
 */
export function collectAgentTree(input: CollectAgentTreeInput): AgentTreeRead {
  const nodes: AgentNodeView[] = [];
  const warnings: string[] = [];
  if (input.agents === undefined && input.sessions === undefined) {
    return {
      nodes,
      counts: { total: 0, running: 0, unsupported: 0 },
      warnings: ['host agents/sessions services are absent'],
    };
  }
  if (input.projections === undefined) {
    warnings.push('host sessionProjections service is absent: the tree has no children');
  }
  const root = normalizeSession(lookUp(input.rootId, input));
  if (root === undefined) {
    return {
      nodes,
      counts: { total: 0, running: 0, unsupported: 0 },
      warnings: [...warnings, 'root session is not live'],
    };
  }

  const queue: WalkItem[] = [
    {
      id: input.rootId,
      session: root.session,
      depth: 0,
      parent: undefined,
      label: undefined,
      mode: undefined,
      seenAt: root.header.createdAt,
    },
  ];
  const visited = new Set<string>([input.rootId]);
  let unsupported = 0;
  let running = 0;

  for (let head = 0; head < queue.length && nodes.length < MAX_AGENT_TREE_NODES; head += 1) {
    const current = queue[head] as WalkItem;
    const isRoot = current.depth === 0;
    const active = isRunning(current.id, input);
    if (active) running += 1;

    const read = childrenOf(current.session, input);
    unsupported += read.unsupported;
    const metrics = metricsOf(current.session, active, isRoot ? 'main' : 'subagent', input);

    nodes.push({
      id: current.id,
      kind: isRoot ? 'main' : 'subagent',
      ...(current.parent === undefined ? {} : { parent: current.parent }),
      depth: current.depth,
      label: current.label ?? (isRoot ? 'main' : current.id.slice(0, ID_LABEL_LENGTH)),
      ...(current.mode === undefined ? {} : { mode: current.mode }),
      running: active,
      ...(current.seenAt === undefined ? {} : { seenAt: current.seenAt }),
      ...(metrics === undefined ? {} : { metrics }),
    });

    if (current.depth >= MAX_AGENT_TREE_DEPTH) continue;
    for (const child of read.children) {
      if (visited.has(child.id)) continue;
      if (nodes.length + (queue.length - head) >= MAX_AGENT_TREE_NODES) break;
      visited.add(child.id);
      const childSession = normalizeSession(lookUp(child.id, input));
      queue.push({
        id: child.id,
        // 会话读不出来时给占位：它没有读数，也没有可读的 catalog（也就没有下一层）。
        session: childSession?.session ?? { header: { id: child.id } },
        depth: current.depth + 1,
        parent: current.id,
        label: child.label,
        mode: child.mode,
        seenAt: child.createdAt,
      });
    }
  }

  const answer: AgentTreeRead = {
    nodes,
    counts: { total: nodes.length, running, unsupported },
  };
  if (warnings.length > 0) answer.warnings = warnings;
  return answer;
}
