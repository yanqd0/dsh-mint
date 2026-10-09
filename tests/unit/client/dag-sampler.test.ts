import { describe, expect, it } from 'vitest';

import type { DagNodeMetrics, DagNodeView, MintDagPayload } from '../../../src/shared/records.js';
import {
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
    expect(sameSample(base, sampleOf(payload({ revision: 3, sampled_at: 5, metrics })))).toBe(false);
    expect(sameSample(base, sampleOf(payload({ revision: 2, sampled_at: 6, metrics })))).toBe(false);
    expect(sameSample(base, sampleOf(payload({ revision: 2, sampled_at: 5, metrics: { a: { tokens: 9 } } })))).toBe(
      false
    );
    expect(sameSample(undefined, base)).toBe(false);
  });

  it('compares metrics field by field, treating a missing map as its own reading', () => {
    const one = sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 2 } } }));
    expect(sameSample(one, sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 2 } } })))).toBe(true);
    // 一个字段动了就是新读数；条目数不同亦然。
    expect(sameSample(one, sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 3 } } })))).toBe(false);
    expect(sameSample(one, sampleOf(payload({ metrics: { a: { tokens: 1, elapsed_ms: 2 }, b: { tokens: 1 } } })))).toBe(
      false
    );
    // 两侧都是「没有样本」才算同一次读数；一侧缺失一侧有值是不同读数。
    expect(sameSample(sampleOf(payload()), sampleOf(payload()))).toBe(true);
    expect(sameSample(sampleOf(payload()), one)).toBe(false);
  });
});

describe('sampleMetrics', () => {
  // 文档里已不存在的节点不得再带指标进面板：否则会留一份画不出来的幽灵读数。
  // 夹具给一个 running 节点与一份多出 dropped 的表，断言只留节点那份。
  it('keeps only the metrics of nodes the document still carries', () => {
    const dag = { title: '', revision: 1, created_at: '', updated_at: '', nodes: [node('a', 'running')], edges: [] };
    const metrics = { a: { tokens: 1 }, dropped: { tokens: 9 } };
    expect(sampleMetrics(payload({ dag, metrics }))).toEqual({ a: { tokens: 1 } });
  });

  it('answers an empty map for a payload that cannot be drawn from', () => {
    expect(sampleMetrics(undefined)).toEqual({});
    expect(sampleMetrics(payload())).toEqual({});
    expect(sampleMetrics(payload({ metrics: { a: { tokens: 1 } } }))).toEqual({});
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
    expect(measuredTimeMs(node('a', 'running'), { elapsed_ms: 1000, at: 9_000 }, 10_000, 12_500)).toBe(1000);
  });
});

describe('measuredAtLabel', () => {
  it('renders a stored stamp in the local clock', () => {
    const at = Date.UTC(2026, 9, 7, 12, 34, 56);
    expect(measuredAtLabel(at)).toBe(new Date(at).toLocaleTimeString());
  });
});
