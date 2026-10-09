/**
 * 文档写入：`applyDagWrite` 把一次校验过的动作落到当前文档上。
 *
 * 图规则（未知依赖、成环、节点上限）只在这里执行——只有这里同时看得见新节点
 * 与存盘节点。出错时不写盘：调用方要么存下返回的文档，要么原样转述拒绝理由。
 */
import { DAG_NODE_MAX, DAG_VERSION } from './model.js';
import type { DagDoc, DagNode, DagResult, DagWrite } from './model.js';
import { findCycle, unknownDependencies } from './graph.js';

/** A fresh document for one session; `init` rewrites the file with this. */
export function emptyDag(session: string, title: string, now: string): DagDoc {
  return {
    version: DAG_VERSION,
    session,
    title,
    revision: 1,
    created_at: now,
    updated_at: now,
    nodes: [],
    edges: [],
  };
}

/**
 * Apply one write action to the current document.
 *
 * @param action - a validated write action.
 * @param current - the stored document, or `undefined` when there is none.
 * @param session - the owning (root) session id.
 * @param now - ISO timestamp; a parameter so tests need no fake timers.
 */
export function applyDagWrite(
  action: DagWrite,
  current: DagDoc | undefined,
  session: string,
  now: string
): DagResult {
  if (action.action === 'init') {
    return { doc: emptyDag(session, action.title, now) };
  }
  if (current === undefined) {
    return { error: '本会话暂无 DAG；先用 action="init" 建立，再 add/set' };
  }
  if (action.action === 'add') {
    const existing = new Set(current.nodes.map((node) => node.id));
    const collision = action.nodes.find((node) => existing.has(node.id));
    if (collision !== undefined) return { error: `节点 id 已存在：${collision.id}` };
    if (current.nodes.length + action.nodes.length > DAG_NODE_MAX) {
      return { error: `节点数超过上限 ${String(DAG_NODE_MAX)}（当前 ${String(current.nodes.length)}）` };
    }
    const added: DagNode[] = action.nodes.map((node) => ({
      ...node,
      status: 'pending',
      updated_at: now,
    }));
    const nodes = [...current.nodes, ...added];
    const edges = [...current.edges, ...action.edges];
    const unknown = unknownDependencies(nodes, edges);
    if (unknown.length > 0) {
      return { error: `未知依赖（没有对应节点）：${unknown.join(', ')}` };
    }
    const cycle = findCycle(nodes, edges);
    if (cycle !== undefined) return { error: `成环，拒绝写入：${cycle.join(' → ')}` };
    return { doc: { ...current, nodes, edges, revision: current.revision + 1, updated_at: now } };
  }
  const index = current.nodes.findIndex((node) => node.id === action.id);
  if (index < 0) return { error: `节点不存在：${action.id}` };
  const previous = current.nodes[index] as DagNode;
  // A settled node keeps no stale verdict: re-opening it drops the outcome, and
  // `set` to `done` is the only way a verdict is ever written.
  const rewritten: DagNode = {
    ...previous,
    status: action.status,
    updated_at: now,
  };
  delete rewritten.verdict;
  if (action.verdict !== undefined) rewritten.verdict = action.verdict;
  if (action.note !== undefined) rewritten.note = action.note;
  if (action.tokens !== undefined) rewritten.tokens = action.tokens;
  if (action.agent !== undefined) rewritten.agent = action.agent;
  // 与 agent/tokens 相反：worktree 是持久事实（git 里真有这棵树），普通 `set`
  // 不传就保持原样，不能被清空——只有独立的 `worktree` 工具会带新值进来覆盖。
  if (action.worktree !== undefined) rewritten.worktree = action.worktree;
  const nodes = [...current.nodes];
  nodes[index] = rewritten;
  return { doc: { ...current, nodes, revision: current.revision + 1, updated_at: now } };
}
