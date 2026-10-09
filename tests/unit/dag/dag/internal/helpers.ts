/**
 * `dag.ts` 拆分后各镜像测试共用的 fixture。
 *
 * 放在被拆目录下与源同构（`internal/` 是源，本文件是测试侧），文件名 `helpers.ts`
 * 不是 `.test.ts`，vitest 不会收集它；镜像守卫按「测试侧 fixtures 豁免」放行。
 */
import type { DagAddNode, DagDoc, DagNode } from '../../../../../src/dag/dag.js';
import type { DagWorktree } from '../../../../../src/shared/records.js';

export const NOW = '2026-10-07T00:00:00.000Z';
export const SESSION = 'session-1';

/** One stored node; every field a case does not care about is filled here. */
export function node(over: Partial<DagNode> = {}): DagNode {
  return {
    id: 'a',
    label: '总①',
    title: '第一轮',
    phase: 'exec',
    status: 'pending',
    depends_on: [],
    updated_at: NOW,
    ...over,
  };
}

/** One stored document. */
export function doc(over: Partial<DagDoc> = {}): DagDoc {
  return {
    version: 1,
    session: SESSION,
    title: '',
    revision: 1,
    created_at: NOW,
    updated_at: NOW,
    nodes: [],
    edges: [],
    ...over,
  };
}

/** One `add` entry. */
export function addNode(over: Partial<DagAddNode> = {}): Partial<DagAddNode> {
  return { id: 'a', label: '总①', title: '第一轮', phase: 'exec', ...over };
}

/** One node's worktree record; `target` is optional and only set when a case needs it. */
export function tree(over: Partial<DagWorktree> = {}): DagWorktree {
  return {
    path: '/proj/.git/dsh-mint/worktrees/s/a',
    branch: 'dsh-mint/wt/s/a',
    base: 'a'.repeat(40),
    state: 'active',
    ...over,
  };
}

/** The error text of any refused parse/write outcome, failing loudly on a surprise success. */
export function errorOf(result: { error: string } | object): string {
  if (!('error' in result)) throw new Error(`expected a refusal, got ${JSON.stringify(result)}`);
  return result.error;
}
