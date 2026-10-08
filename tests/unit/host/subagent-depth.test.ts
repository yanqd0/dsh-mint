import { describe, expect, it } from 'vitest';

import {
  delegationShape,
  readSubagentDepth,
  renderDagDepthNotice,
  renderOverviewDepthLine,
} from '../../../src/host/subagent-depth.js';
import type { DshContext } from '../../../src/shared/types.js';

/**
 * 宿主 `subagent.maxDepth` 的探测与降级文案。
 *
 * 探针的判据只有一条：**读不到就说不知道**（`{ kind: 'unknown' }`），绝不猜、绝不抛。
 * 猜错深度比不说更糟——它会按一个不存在的宿主能力给出「去把设置改成 2」以外的东西。
 */
function ctxWith(service: unknown): DshContext {
  return { on: () => () => {}, get: () => service };
}

describe('readSubagentDepth', () => {
  it('reports the service-level value', () => {
    expect(readSubagentDepth(ctxWith({ resolveMaxDepth: () => 1 }))).toEqual({
      kind: 'reported',
      maxDepth: 1,
    });
    // 0（禁派）是合法读数：它不是「读不到」，而是「读到了 0」。
    expect(readSubagentDepth(ctxWith({ resolveMaxDepth: () => 0 }))).toEqual({
      kind: 'reported',
      maxDepth: 0,
    });
  });

  it.each([
    ['no get() on the context', { on: () => () => {} }],
    ['no subagents service', ctxWith(undefined)],
    ['a service without the method', ctxWith({})],
    ['a non-function method', ctxWith({ resolveMaxDepth: 2 })],
    [
      'a throwing method',
      ctxWith({
        resolveMaxDepth: () => {
          throw new Error('service gone');
        },
      }),
    ],
    ['an undefined answer', ctxWith({ resolveMaxDepth: () => undefined })],
    ['a fractional answer', ctxWith({ resolveMaxDepth: () => 1.5 })],
    ['a negative answer', ctxWith({ resolveMaxDepth: () => -1 })],
    ['a NaN answer', ctxWith({ resolveMaxDepth: () => Number.NaN })],
    ['a non-numeric answer', ctxWith({ resolveMaxDepth: () => '2' })],
  ])('answers unknown for %s', (_label, ctx) => {
    expect(readSubagentDepth(ctx)).toEqual({ kind: 'unknown' });
  });
});

describe('delegationShape', () => {
  it.each([
    [0, 'no-delegation'],
    [1, 'single-agent'],
    [2, 'two-level'],
    [9, 'two-level'],
  ])('maps maxDepth %i onto %s', (maxDepth, shape) => {
    expect(delegationShape({ kind: 'reported', maxDepth })).toBe(shape);
  });

  it('does not downgrade a depth it could not read', () => {
    expect(delegationShape({ kind: 'unknown' })).toBe('unknown');
  });
});

describe('renderDagDepthNotice', () => {
  it('says nothing at two levels or when the depth is unknown', () => {
    expect(renderDagDepthNotice('two-level')).toBe('');
    expect(renderDagDepthNotice('unknown')).toBe('');
  });

  it('names how to re-enable the second level and when the change lands', () => {
    const notice = renderDagDepthNotice('single-agent');
    expect(notice).toContain('宿主 subagent.maxDepth=1');
    expect(notice).toContain('设置 → 插件 → 子智能体 → 最大递归深度');
    expect(notice).toContain('改为 2');
    expect(notice).toContain('下一次委派');
  });

  it('names how to allow delegation at all when it is disabled', () => {
    const notice = renderDagDepthNotice('no-delegation');
    expect(notice).toContain('宿主 subagent.maxDepth=0');
    expect(notice).toContain('main 亲跑');
    expect(notice).toContain('设置 → 插件 → 子智能体 → 最大递归深度');
    expect(notice).toContain('下一次委派');
  });
});

describe('renderOverviewDepthLine', () => {
  it('says nothing at two levels or when the depth is unknown', () => {
    // 正常机器零新增字节：这两态都不渲染。
    expect(renderOverviewDepthLine('two-level')).toBe('');
    expect(renderOverviewDepthLine('unknown')).toBe('');
  });

  it('carries the GUI path and the effective timing as a `[Mint]` line', () => {
    for (const shape of ['single-agent', 'no-delegation'] as const) {
      const line = renderOverviewDepthLine(shape);
      expect(line.startsWith('[Mint] '), shape).toBe(true);
      expect(line, shape).toContain('设置 → 插件 → 子智能体 → 最大递归深度');
      expect(line, shape).toContain('下一次委派');
    }
  });
});
