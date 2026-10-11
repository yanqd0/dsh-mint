/**
 * 子代理树文档的读取校验：整体严格、单个节点宽松。
 *
 * 读的是**不可信方向**（文件在 `/tmp`，任何进程都写得进去），所以版本不符、形状不符都变成具名
 * 错误，由路由转成一次空树加告警而不是崩溃。节点层则相反：一条坏节点是一段读不到的子树，把它
 * 扔掉仍然画出其余的树，比为一条坏数据宣布整份文档不可读更有用——与 `dag/internal/parse-doc.ts`
 * 对 `samples` 的宽松同一条纪律。
 */
import { isValidDagSession } from '../../dag.js';
import { isRecord } from '../../../mint/mint-json.js';
import type { AgentNodeView, DagNodeMetrics } from '../../../shared/records.js';

export const AGENT_TREE_VERSION = 1;

export interface AgentTreeDoc {
  version: number;
  session: string;
  revision: number;
  sampled_at: number;
  nodes: AgentNodeView[];
}

/** 节点数上限，与收集器的 `MAX_AGENT_TREE_NODES` 同值：它守的是坏 catalog 撑爆一次应答。 */
const AGENT_TREE_NODE_MAX = 200;

/** 非负安全整数：计数字段的唯一判据（与 `dag/internal/validate.ts` 的 `isCount` 同式）。 */
function isCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** 收下 `value` 当且仅当它是个非负安全整数，否则留空——绝不做强制转换。 */
function countField(value: unknown): number | undefined {
  return isCount(value) ? value : undefined;
}

/** 收下 `value` 当且仅当它是个串；空串是合法标签（宿主也可能真给不出东西）。 */
function stringField(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

/** 派发形态是封闭集：别的写法一律当作缺席。 */
function modeField(value: unknown): AgentNodeView['mode'] | undefined {
  return value === 'one-shot' || value === 'continuable' ? value : undefined;
}

/**
 * 节点读数：**逐字段**收，坏的只丢它自己。
 *
 * 逐字段是刻意的：一个数坏掉（例如宿主换了单位）不该连累同一行里真测到的另几个数；而一个都
 * 没剩时整项不发——面板据此区分「没测到」与「测到零」。
 */
function parseMetrics(raw: unknown): DagNodeMetrics | undefined {
  if (!isRecord(raw)) return undefined;
  const metrics: DagNodeMetrics = {};
  const tokens = countField(raw.tokens);
  if (tokens !== undefined) metrics.tokens = tokens;
  const uncached = countField(raw.uncached_input);
  if (uncached !== undefined) metrics.uncached_input = uncached;
  const cacheRead = countField(raw.cache_read);
  if (cacheRead !== undefined) metrics.cache_read = cacheRead;
  const cacheWrite = countField(raw.cache_write);
  if (cacheWrite !== undefined) metrics.cache_write = cacheWrite;
  const output = countField(raw.output);
  if (output !== undefined) metrics.output = output;
  const context = countField(raw.context);
  if (context !== undefined) metrics.context = context;
  const steps = countField(raw.steps);
  if (steps !== undefined) metrics.steps = steps;
  const elapsed = countField(raw.elapsed_ms);
  if (elapsed !== undefined) metrics.elapsed_ms = elapsed;
  return Object.keys(metrics).length === 0 ? undefined : metrics;
}

/** 一条节点：形状不成立就是 `undefined`（坏节点整条丢，不整份报错）。 */
function parseNode(raw: unknown): AgentNodeView | undefined {
  if (!isRecord(raw)) return undefined;
  const id = stringField(raw.id);
  if (id === undefined || id === '') return undefined;
  const kind = raw.kind;
  if (kind !== 'main' && kind !== 'subagent') return undefined;
  const depth = countField(raw.depth);
  if (depth === undefined) return undefined;
  const label = stringField(raw.label);
  if (label === undefined) return undefined;
  if (typeof raw.running !== 'boolean') return undefined;
  const parent = raw.parent === undefined ? undefined : stringField(raw.parent);
  if (raw.parent !== undefined && parent === undefined) return undefined;
  const mode = raw.mode === undefined ? undefined : modeField(raw.mode);
  if (raw.mode !== undefined && mode === undefined) return undefined;
  const seenAt = raw.seenAt === undefined ? undefined : countField(raw.seenAt);
  if (raw.seenAt !== undefined && seenAt === undefined) return undefined;
  const metrics = parseMetrics(raw.metrics);
  return {
    id,
    kind,
    ...(parent === undefined ? {} : { parent }),
    depth,
    label,
    ...(mode === undefined ? {} : { mode }),
    running: raw.running,
    ...(seenAt === undefined ? {} : { seenAt }),
    ...(metrics === undefined ? {} : { metrics }),
  };
}

/**
 * 校验一份文档。
 *
 * 三条整体规则（对象、版本、会话 id、revision/`sampled_at` 是非负安全整数、`nodes` 是数组且
 * 不超限）任一不成立就返回具名错误；节点层从宽——重复 id 的那条与形状坏的那条各自丢掉，活下来
 * 的按原顺序回到 `doc.nodes`。
 */
export function parseAgentTreeDoc(raw: unknown): { doc: AgentTreeDoc } | { error: string } {
  if (!isRecord(raw)) return { error: 'document must be an object' };
  if (raw.version !== AGENT_TREE_VERSION) {
    return { error: `unsupported version: ${JSON.stringify(raw.version)}` };
  }
  if (typeof raw.session !== 'string' || !isValidDagSession(raw.session)) {
    return { error: 'session is not a valid session id' };
  }
  const revision = countField(raw.revision);
  if (revision === undefined) return { error: 'revision must be a non-negative integer' };
  const sampledAt = countField(raw.sampled_at);
  if (sampledAt === undefined) return { error: 'sampled_at must be a non-negative integer' };
  if (!Array.isArray(raw.nodes)) return { error: 'nodes must be an array' };
  if (raw.nodes.length > AGENT_TREE_NODE_MAX) {
    return { error: `nodes must hold at most ${String(AGENT_TREE_NODE_MAX)} entries` };
  }
  const nodes: AgentNodeView[] = [];
  const ids = new Set<string>();
  for (const entry of raw.nodes) {
    const node = parseNode(entry);
    if (node === undefined) continue;
    if (ids.has(node.id)) continue;
    ids.add(node.id);
    nodes.push(node);
  }
  return {
    doc: {
      version: AGENT_TREE_VERSION,
      session: raw.session,
      revision,
      sampled_at: sampledAt,
      nodes,
    },
  };
}
