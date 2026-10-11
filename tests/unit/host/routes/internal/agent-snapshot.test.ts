import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { readAgentTreeDoc } from '../../../../../src/dag/agent-tree/agent-tree-store.js';
import {
  agentSnapshotChanged,
  flushAgentSnapshot,
} from '../../../../../src/host/routes/internal/agent-snapshot.js';
import type { AgentNodeView } from '../../../../../src/shared/records.js';

const SESSION = 'sess-1';
const SAMPLED_MS = 1_700_000_000_000;

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mint-agent-snapshot-'));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** 每个用例一个目录，免得上一个用例的文件漏进下一个。 */
function dir(): string {
  return mkdtempSync(join(root, 'case-'));
}

/** 一条只填断言需要字段的节点。 */
function node(over: Partial<AgentNodeView> = {}): AgentNodeView {
  return {
    id: 'c1',
    kind: 'subagent',
    parent: SESSION,
    depth: 1,
    label: '审 tests',
    running: true,
    ...over,
  };
}

describe('agentSnapshotChanged', () => {
  it('treats a missing file as changed', () => {
    expect(agentSnapshotChanged(undefined, [])).toBe(true);
  });

  it('treats an identical tree as unchanged', () => {
    expect(agentSnapshotChanged([node()], [node()])).toBe(false);
  });

  it.each([
    ['label', node({ label: '跑测试' })],
    ['running', node({ running: false })],
    ['seenAt', node({ seenAt: 7 })],
    ['metrics', node({ metrics: { tokens: 12 } })],
  ])('treats a changed %s as changed', (_field, fresh) => {
    expect(agentSnapshotChanged([node()], [fresh])).toBe(true);
  });

  // `elapsed_ms` 只增不减：纳入即每次轮询都写盘，所以它刻意不进比较清单。
  it('ignores a change in elapsed_ms alone', () => {
    const stored = [node({ metrics: { tokens: 12, elapsed_ms: 1_000 } })];
    const fresh = [node({ metrics: { tokens: 12, elapsed_ms: 9_000 } })];
    expect(agentSnapshotChanged(stored, fresh)).toBe(false);
  });

  it('treats a node appearing or disappearing as changed', () => {
    expect(agentSnapshotChanged([node()], [node(), node({ id: 'c2', depth: 2 })])).toBe(true);
    expect(agentSnapshotChanged([node(), node({ id: 'c2', depth: 2 })], [node()])).toBe(true);
  });

  it('treats a reordered tree as changed', () => {
    const first = node();
    const second = node({ id: 'c2', depth: 2 });
    expect(agentSnapshotChanged([first, second], [second, first])).toBe(true);
  });
});

describe('flushAgentSnapshot', () => {
  // 非空实时读数落盘：文件第一次写就是版本 1，节点与采样钟都照读数抄。
  it('writes the live tree as revision 1', async () => {
    const where = dir();
    await flushAgentSnapshot({
      sessionId: SESSION,
      read: { nodes: [node()], counts: { total: 1, running: 1, unsupported: 0 } },
      dir: where,
      sampledMs: SAMPLED_MS,
    });
    const read = await readAgentTreeDoc(SESSION, where);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') throw new Error('expected ok');
    expect(read.doc).toEqual({
      version: 1,
      session: SESSION,
      revision: 1,
      sampled_at: SAMPLED_MS,
      nodes: [node()],
    });
  });

  it('skips the write when the live tree did not really change', async () => {
    const where = dir();
    const write = (): Promise<void> =>
      flushAgentSnapshot({
        sessionId: SESSION,
        read: { nodes: [node()], counts: { total: 1, running: 1, unsupported: 0 } },
        dir: where,
        sampledMs: SAMPLED_MS,
      });
    await write();
    await write();
    const read = await readAgentTreeDoc(SESSION, where);
    if (read.state !== 'ok') throw new Error('expected ok');
    expect(read.doc.revision).toBe(1);
  });

  it('bumps the revision when the live tree changed', async () => {
    const where = dir();
    const write = (nodes: AgentNodeView[]): Promise<void> =>
      flushAgentSnapshot({
        sessionId: SESSION,
        read: { nodes, counts: { total: nodes.length, running: 1, unsupported: 0 } },
        dir: where,
        sampledMs: SAMPLED_MS,
      });
    await write([node()]);
    await write([node({ running: false })]);
    const read = await readAgentTreeDoc(SESSION, where);
    if (read.state !== 'ok') throw new Error('expected ok');
    expect(read.doc.revision).toBe(2);
  });

  // 空树不是快照：它什么都没答（宿主没挂、读抛错），写成文件只会把上一次好快照抹掉。
  it('writes nothing for an empty live tree', async () => {
    const where = dir();
    await flushAgentSnapshot({
      sessionId: SESSION,
      read: { nodes: [], counts: { total: 0, running: 0, unsupported: 0 } },
      dir: where,
      sampledMs: SAMPLED_MS,
    });
    expect(readdirSync(where)).toEqual([]);
  });
});
