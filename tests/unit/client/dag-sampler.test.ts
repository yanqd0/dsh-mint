import { describe, expect, it } from 'vitest';

import type {
  DagNodeMetrics,
  DagNodeView,
  MintAgentsPayload,
  MintDagPayload,
} from '../../../src/shared/records.js';
import {
  agentSampleOf,
  measuredAtLabel,
  measuredTimeMs,
  sampleMetrics,
  sampleOf,
  sameSample,
} from '../../../src/client/dag-sampler.js';

/** 一个只填了断言需要字段的节点视图。 */
function node(id: string, status: DagNodeView['status']): DagNodeView {
  return { id, label: id, title: id, phase: 'exec', status, depends_on: [], updated_at: '' };
}

/** 一份可作答的信封；每个用例只覆盖它关心的字段。 */
function payload(over: Partial<MintDagPayload> = {}): MintDagPayload {
  return {
    ok: true,
    dag: { title: '', revision: 1, created_at: '', updated_at: '', nodes: [], edges: [] },
    revision: 1,
    file: '/tmp/dag.json',
    autoOpen: false,
    ...over,
  };
}

describe('agentSampleOf', () => {
  /** 一份只填断言需要字段的子代理树信封。 */
  function agents(nodes: MintAgentsPayload['nodes']): MintAgentsPayload {
    return {
      ok: true,
      nodes,
      counts: { total: nodes.length, running: 0, unsupported: 0 },
      sampled_at: 5,
    };
  }

  // 同一次读数的判据：`sampled_at` 每轮都不同，若把它算进身份，面板每 2s 都会白重渲一次。
  it('ignores the sample clock so two identical reads compare equal', () => {
    const one = agents([{ id: 'a', kind: 'main', depth: 0, label: 'main', running: true }]);
    expect(sameSample(agentSampleOf(one), agentSampleOf({ ...one, sampled_at: 99 }))).toBe(true);
  });

  // 兜底快照的 `revision` 只在树真变了时才前进，所以它是它与 live 之间、以及兜底内部的判据。
  it('treats a changed revision as a new reading', () => {
    const one = agents([{ id: 'a', kind: 'main', depth: 0, label: 'main', running: false }]);
    const first = agentSampleOf({ ...one, revision: 1, stale: true });
    const second = agentSampleOf({ ...one, revision: 2, stale: true });
    expect(sameSample(first, second)).toBe(false);
    expect(sameSample(first, agentSampleOf({ ...one, revision: 1, stale: true }))).toBe(true);
  });

  it('treats a flipped running flag, a new reading or a renamed label as a new reading', () => {
    const base = agentSampleOf(
      agents([
        {
          id: 'a',
          kind: 'subagent',
          depth: 1,
          label: '审 tests',
          running: true,
          metrics: { tokens: 1, context: 2 },
        },
      ])
    );
    const flipped = agentSampleOf(
      agents([{ id: 'a', kind: 'subagent', depth: 1, label: '审 tests', running: false }])
    );
    const measured = agentSampleOf(
      agents([
        {
          id: 'a',
          kind: 'subagent',
          depth: 1,
          label: '审 tests',
          running: true,
          metrics: { tokens: 1, context: 3 },
        },
      ])
    );
    const renamed = agentSampleOf(
      agents([{ id: 'a', kind: 'subagent', depth: 1, label: '跑测试', running: true }])
    );
    expect(sameSample(base, flipped)).toBe(false);
    expect(sameSample(base, measured)).toBe(false);
    expect(sameSample(base, renamed)).toBe(false);
  });

  it('treats a node appearing or disappearing as a new reading', () => {
    const one = agentSampleOf(
      agents([{ id: 'a', kind: 'main', depth: 0, label: 'main', running: false }])
    );
    const two = agentSampleOf(
      agents([
        { id: 'a', kind: 'main', depth: 0, label: 'main', running: false },
        { id: 'b', kind: 'subagent', parent: 'a', depth: 1, label: 'b', running: false },
      ])
    );
    expect(sameSample(one, two)).toBe(false);
  });
});

describe('sampleOf / sameSample', () => {
  it('reads the identity of an answer: revision, sample clock, and metrics', () => {
    const metrics: Record<string, DagNodeMetrics> = { a: { tokens: 1, elapsed_ms: 2 } };
    expect(sampleOf(payload({ revision: 3, sampled_at: 7, metrics }))).toEqual({
      revision: 3,
      sampledAt: 7,
      metrics,
    });
  });

  // 轮询守卫的判据：只有 revision 与 sample 都没动，才是「同一个读数」，可以跳过写状态。
  it('calls two answers the same reading only when revision and sample agree', () => {
    const metrics: Record<string, DagNodeMetrics> = { a: { tokens: 1 } };
    const base = sampleOf(payload({ revision: 2, sampled_at: 5, metrics }));
    expect(sameSample(base, sampleOf(payload({ revision: 2, sampled_at: 5, metrics })))).toBe(true);
    expect(sameSample(base, sampleOf(payload({ revision: 3, sampled_at: 5, metrics })))).toBe(
      false
    );
    expect(sameSample(base, sampleOf(payload({ revision: 2, sampled_at: 6, metrics })))).toBe(
      false
    );
    expect(
      sameSample(
        base,
        sampleOf(payload({ revision: 2, sampled_at: 5, metrics: { a: { tokens: 9 } } }))
      )
    ).toBe(false);
    expect(sameSample(undefined, base)).toBe(false);
  });

  it('compares metrics field by field, treating a missing map as its own reading', () => {
    const one = sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 2 } } }));
    expect(
      sameSample(one, sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 2 } } })))
    ).toBe(true);
    // 一个字段动了就是新读数；条目数不同亦然。
    expect(
      sameSample(one, sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 3 } } })))
    ).toBe(false);
    expect(
      sameSample(
        one,
        sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 2 }, b: { tokens: 1 } } }))
      )
    ).toBe(false);
    // 两侧都是「没有样本」才算同一次读数；一侧缺失一侧有值是不同读数。
    expect(sameSample(sampleOf(payload()), sampleOf(payload()))).toBe(true);
    expect(sameSample(sampleOf(payload()), one)).toBe(false);
  });

  // 重绘判据覆盖新字段：四桶、步数与落库戳任一变了都要重画，漏一个就是「数字变了面板不动」。
  it('treats a bucket, a step count or a stamp change as a new reading', () => {
    const base = sampleOf(payload({ metrics: { a: { tokens: 10, cache_read: 3, steps: 1 } } }));
    const same = sampleOf(payload({ metrics: { a: { tokens: 10, cache_read: 3, steps: 1 } } }));
    expect(sameSample(base, same)).toBe(true);
    expect(
      sameSample(
        base,
        sampleOf(payload({ metrics: { a: { tokens: 10, cache_read: 4, steps: 1 } } }))
      )
    ).toBe(false);
    expect(
      sameSample(
        base,
        sampleOf(payload({ metrics: { a: { tokens: 10, cache_read: 3, steps: 2 } } }))
      )
    ).toBe(false);
    expect(
      sameSample(
        base,
        sampleOf(payload({ metrics: { a: { tokens: 10, cache_read: 3, steps: 1, at: 5 } } }))
      )
    ).toBe(false);
  });
});

describe('sampleMetrics', () => {
  // 文档里已不存在的节点不得再带指标进面板：否则会留一份画不出来的幽灵读数。
  // 夹具给一个 running 节点与一份多出 dropped 的表，断言只留节点那份。
  it('keeps only the metrics of nodes the document still carries', () => {
    const dag = {
      title: '',
      revision: 1,
      created_at: '',
      updated_at: '',
      nodes: [node('a', 'running')],
      edges: [],
    };
    const metrics = { a: { tokens: 1 }, dropped: { tokens: 9 } };
    expect(sampleMetrics(payload({ dag, metrics }))).toEqual({ a: { tokens: 1 } });
  });

  it('answers an empty map for a payload that cannot be drawn from', () => {
    expect(sampleMetrics(undefined)).toEqual({});
    expect(sampleMetrics(payload())).toEqual({});
    expect(sampleMetrics(payload({ metrics: { a: { tokens: 1 } } }))).toEqual({});
  });

  // 白名单同步：四桶与步数必须与 `tokens` 一起被收下，坏的那一个只丢自己。
  it('keeps the four buckets and the step count, dropping only a bad one', () => {
    const dag = {
      title: '',
      revision: 1,
      created_at: '',
      updated_at: '',
      nodes: [node('a', 'running')],
      edges: [],
    };
    expect(
      sampleMetrics(
        payload({
          dag,
          metrics: {
            a: {
              tokens: 10,
              uncached_input: 1,
              cache_read: 3,
              cache_write: 4,
              output: 2,
              steps: 7,
            },
          },
        })
      )
    ).toEqual({
      a: { tokens: 10, uncached_input: 1, cache_read: 3, cache_write: 4, output: 2, steps: 7 },
    });
    expect(
      sampleMetrics(payload({ dag, metrics: { a: { cache_read: 1.5, steps: -1, output: 2 } } }))
    ).toEqual({ a: { output: 2 } });
  });
});

describe('measuredTimeMs', () => {
  it('ages a running node on the browser clock and freezes a settled one', () => {
    const running = node('a', 'running');
    expect(measuredTimeMs(running, { elapsed_ms: 1000 }, 10_000, 12_500)).toBe(3500);
    expect(measuredTimeMs(node('b', 'done'), { elapsed_ms: 1000 }, 10_000, 12_500)).toBe(1000);
    expect(measuredTimeMs(running, undefined, undefined, 12_500)).toBeUndefined();
  });

  // 存盘样本（带 at）是宿主早先量到的读数：子会话已不在，不能拿浏览器时钟继续累加。
  it('shows a stored sample verbatim instead of aging it', () => {
    expect(
      measuredTimeMs(node('a', 'running'), { elapsed_ms: 1000, at: 9_000 }, 10_000, 12_500)
    ).toBe(1000);
  });
});

describe('measuredAtLabel', () => {
  it('renders a stored stamp in the local clock', () => {
    const at = Date.UTC(2026, 9, 7, 12, 34, 56);
    expect(measuredAtLabel(at)).toBe(new Date(at).toLocaleTimeString());
  });
});
