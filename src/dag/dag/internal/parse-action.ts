/**
 * 工具参数的形状校验：把 `mint_plan_dag` 的原始参数转成带类型的动作，或给出具名错误。
 *
 * 只判「与当前文档无关」的部分（形状、枚举、上下限）；图规则（未知依赖、成环、
 * 节点上限）由 `write.ts` 的 `applyDagWrite` 执行——只有它同时看得见新节点与存盘节点。
 */
import { isRecord } from '../../../mint/mint-json.js';
import type { DagWorktree } from '../../../shared/records.js';
import { AGENT_ID_MAX, DOC_TITLE_MAX, DAG_PHASES, DAG_STATUSES, DAG_VERDICTS } from './model.js';
import type { DagAction, DagAddNode, DagVerdict } from './model.js';
import {
  checkCount,
  checkEdge,
  checkLabel,
  checkNodeId,
  checkNote,
  checkTitle,
  checkWorktree,
  codePoints,
  isDagPhase,
  isDagStatus,
  isDagVerdict,
} from './validate.js';

function checkAddNode(raw: unknown): DagAddNode | { error: string } {
  if (!isRecord(raw)) return { error: 'nodes 的每一项必须是对象' };
  const id = checkNodeId(raw.id);
  if (typeof id !== 'string') return id;
  const label = checkLabel(raw.label);
  if (typeof label !== 'string') return label;
  const title = checkTitle(raw.title);
  if (typeof title !== 'string') return title;
  if (!isDagPhase(raw.phase)) {
    return { error: `phase 必须是 ${DAG_PHASES.join(' | ')}：${JSON.stringify(raw.phase)}` };
  }
  const dependsOn: string[] = [];
  if (raw.depends_on !== undefined) {
    if (!Array.isArray(raw.depends_on)) return { error: `${id}.depends_on 必须是字符串数组` };
    for (const dependency of raw.depends_on) {
      if (typeof dependency !== 'string' || dependency.length === 0) {
        return { error: `${id}.depends_on 必须是非空字符串数组` };
      }
      if (!dependsOn.includes(dependency)) dependsOn.push(dependency);
    }
  }
  let issue: number | undefined;
  if (raw.issue !== undefined) {
    const checked = checkCount(raw.issue, `${id}.issue`);
    if (typeof checked !== 'number') return checked;
    issue = checked;
  }
  return {
    id,
    label,
    title,
    phase: raw.phase,
    depends_on: dependsOn,
    ...(issue === undefined ? {} : { issue }),
  };
}

export function parseDagAction(raw: unknown): DagAction | { error: string } {
  if (!isRecord(raw)) return { error: '参数必须是对象' };
  const { action } = raw;
  if (action === 'get') return { action: 'get' };
  if (action === 'init') {
    if (raw.title === undefined) return { action: 'init', title: '' };
    if (typeof raw.title !== 'string') return { error: 'title 必须是字符串' };
    if (codePoints(raw.title) > DOC_TITLE_MAX) {
      return { error: `title 超过 ${String(DOC_TITLE_MAX)} 字` };
    }
    return { action: 'init', title: raw.title };
  }
  if (action === 'add') {
    if (!Array.isArray(raw.nodes) || raw.nodes.length === 0) {
      return { error: 'add 需要非空的 nodes 数组' };
    }
    const nodes: DagAddNode[] = [];
    const seen = new Set<string>();
    for (const entry of raw.nodes) {
      const node = checkAddNode(entry);
      if ('error' in node) return node;
      if (seen.has(node.id)) return { error: `nodes 里有重复 id：${node.id}` };
      seen.add(node.id);
      nodes.push(node);
    }
    const edges: [string, string][] = [];
    if (raw.edges !== undefined) {
      if (!Array.isArray(raw.edges)) return { error: 'edges 必须是数组' };
      for (const entry of raw.edges) {
        const edge = checkEdge(entry);
        if ('error' in edge) return edge;
        edges.push(edge);
      }
    }
    return { action: 'add', nodes, edges };
  }
  if (action === 'set') {
    const id = checkNodeId(raw.id);
    if (typeof id !== 'string') return id;
    const status = raw.status;
    if (!isDagStatus(status)) {
      return { error: `status 必须是 ${DAG_STATUSES.join(' | ')}：${JSON.stringify(raw.status)}` };
    }
    let verdict: DagVerdict | undefined;
    if (raw.verdict !== undefined) {
      const checked = raw.verdict;
      if (!isDagVerdict(checked)) {
        return { error: `verdict 必须是 ${DAG_VERDICTS.join(' | ')}：${JSON.stringify(raw.verdict)}` };
      }
      if (status !== 'done') {
        return { error: 'verdict 只在 status="done"（终态）时合法；请先完成该节点' };
      }
      verdict = checked;
    }
    let note: string | undefined;
    if (raw.note !== undefined) {
      const checked = checkNote(raw.note);
      if (typeof checked !== 'string') return checked;
      note = checked;
    }
    let tokens: number | undefined;
    if (raw.tokens !== undefined) {
      const checked = checkCount(raw.tokens, 'tokens');
      if (typeof checked !== 'number') return checked;
      tokens = checked;
    }
    let agent: string | undefined;
    if (raw.agent !== undefined) {
      if (typeof raw.agent !== 'string' || raw.agent.length === 0) {
        return { error: 'agent 必须是非空字符串' };
      }
      if (raw.agent.length > AGENT_ID_MAX) return { error: `agent 过长（>${String(AGENT_ID_MAX)} 字）` };
      agent = raw.agent;
    }
    let worktree: DagWorktree | undefined;
    if (raw.worktree !== undefined) {
      const checked = checkWorktree(raw.worktree, `node ${id}`);
      if ('error' in checked) return checked;
      worktree = checked;
    }
    return {
      action: 'set',
      id,
      status,
      ...(verdict === undefined ? {} : { verdict }),
      ...(note === undefined ? {} : { note }),
      ...(tokens === undefined ? {} : { tokens }),
      ...(agent === undefined ? {} : { agent }),
      ...(worktree === undefined ? {} : { worktree }),
    };
  }
  return { error: `action 必须是 init | add | set | get：${JSON.stringify(action)}` };
}
