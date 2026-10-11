import { describe, expect, it } from 'vitest';

import {
  AGENT_COPY_KEYS,
  AGENT_ROW_H,
  AGENT_ROW_INDENT,
  AGENT_PAD,
  agentCanvasHeight,
  agentCanvasWidth,
  agentElapsedMs,
  agentMetrics,
  agentRowCells,
  agentRows,
  agentStatusTone,
  agentSummary,
  agentTone,
  isAgentRunning,
  rawCount,
} from '../../../src/client/agent-tree-model.js';
import { EN, ZH } from '../../../src/client/copy.js';
import type { CopyTranslate } from '../../../src/client/copy.js';
import type { AgentNodeView, MintAgentsPayload } from '../../../src/shared/records.js';

const SAMPLED_MS = 1_000_000;

/** 一个只填断言需要字段的节点视图。 */
function node(over: Partial<AgentNodeView> = {}): AgentNodeView {
  return { id: 'n1', kind: 'subagent', depth: 1, label: '审 tests', running: false, ...over };
}

/** 一份只填断言需要字段的信封。 */
function payload(over: Partial<MintAgentsPayload> = {}): MintAgentsPayload {
  return {
    ok: true,
    nodes: [],
    counts: { total: 0, running: 0, unsupported: 0 },
    sampled_at: SAMPLED_MS,
    ...over,
  };
}

/** 中文词典既用于断言原样文本，也用于给插值型 copy 提供模板。 */
const t: CopyTranslate = (key, params) => {
  const template: string = ZH[key];
  if (params === undefined) return template;
  return Object.entries(params).reduce<string>(
    (text, [name, value]) => text.replace(`{${name}}`, String(value)),
    template
  );
};

describe('agentTone / status', () => {
  it('draws a running row green and everything else neutral', () => {
    expect(agentTone(node({ running: true }))).toBe('success');
    expect(agentTone(node({ running: false }))).toBe('idle');
    // 根会话也是同一轴：main 不因为它是 main 而换色。
    expect(agentTone(node({ kind: 'main', depth: 0, running: false }))).toBe('idle');
  });

  it('maps the badge tone onto the same axis as the row', () => {
    expect(agentStatusTone(node({ running: true }))).toBe('success');
    expect(agentStatusTone(node({ running: false }))).toBe('idle');
  });

  it('pulses exactly the running rows', () => {
    expect(isAgentRunning(node({ running: true }))).toBe(true);
    expect(isAgentRunning(node({ running: false }))).toBe(false);
  });
});

describe('agentMetrics', () => {
  it('keeps the fields the row draws', () => {
    expect(
      agentMetrics(node({ metrics: { tokens: 12, context: 900, elapsed_ms: 3, steps: 7 } }))
    ).toEqual({ tokens: 12, context: 900, elapsed_ms: 3, steps: 7 });
  });

  // 缺失不猜：一个节点没有任何可画字段时整条读数不成立（而不是四个 0）。
  it('drops the whole reading when nothing is usable', () => {
    expect(agentMetrics(node())).toBeUndefined();
    expect(agentMetrics(node({ metrics: {} }))).toBeUndefined();
  });

  it('drops only the malformed fields', () => {
    expect(
      agentMetrics(
        node({
          metrics: {
            tokens: 1,
            context: -1,
            elapsed_ms: 1.5,
            steps: Number.NaN,
          },
        })
      )
    ).toEqual({ tokens: 1 });
  });
});

describe('agentElapsedMs', () => {
  it('ages a running row on the browser clock', () => {
    expect(
      agentElapsedMs(node({ running: true }), { elapsed_ms: 3000 }, SAMPLED_MS, SAMPLED_MS + 500)
    ).toBe(3500);
  });

  it('freezes a settled row at the measured value', () => {
    expect(agentElapsedMs(node(), { elapsed_ms: 3000 }, SAMPLED_MS, SAMPLED_MS + 500)).toBe(3000);
  });

  it('treats a clock that ran backwards as no elapsed time', () => {
    expect(
      agentElapsedMs(node({ running: true }), { elapsed_ms: 3000 }, SAMPLED_MS, SAMPLED_MS - 500)
    ).toBe(3000);
  });

  it('answers nothing without a measured duration or a sample clock', () => {
    expect(agentElapsedMs(node({ running: true }), {}, SAMPLED_MS, SAMPLED_MS)).toBeUndefined();
    expect(
      agentElapsedMs(node({ running: true }), { elapsed_ms: 3000 }, undefined, SAMPLED_MS)
    ).toBe(3000);
  });
});

describe('agentRowCells', () => {
  // main 的累计 token 不是「这个节点花了多少」：宿主不发，这里也不画。
  it('withholds the token cell for the main session', () => {
    const cells = agentRowCells(
      node({ kind: 'main', depth: 0, label: 'main', running: true, metrics: { tokens: 12 } }),
      { tokens: 12, context: 900, elapsed_ms: 3000 },
      undefined,
      SAMPLED_MS,
      t
    );
    expect(cells).toEqual({ label: 'main', context: '900t', tokens: undefined, elapsed: '3秒' });
  });

  it('draws context, the token total and the duration for a subagent', () => {
    const cells = agentRowCells(
      node({ running: true }),
      { tokens: 1200, context: 900, elapsed_ms: 3000 },
      SAMPLED_MS,
      SAMPLED_MS,
      t
    );
    expect(cells).toEqual({ label: '审 tests', context: '900t', tokens: '1.2kt', elapsed: '3秒' });
  });

  // 缺读数与「读数恰好是 0」必须能分开：running 写 `?`（会有数），其余写 `-`（不会有了）。
  it('marks a running row without a reading as pending and a settled one as none', () => {
    const pending = agentRowCells(node({ running: true }), {}, undefined, SAMPLED_MS, t);
    expect(pending.elapsed).toBe('?');
    expect(pending.context).toBeUndefined();
    expect(agentRowCells(node({ running: false }), {}, undefined, SAMPLED_MS, t).elapsed).toBe('-');
  });
});

describe('agentRows', () => {
  it('keeps host order and draws the elbow from the parent row', () => {
    const rows = agentRows([
      node({ id: 'main', kind: 'main', depth: 0, label: 'main' }),
      node({ id: 'dev', parent: 'main', depth: 1 }),
      node({ id: 'test', parent: 'dev', depth: 2 }),
    ]);
    expect(rows.map((row) => [row.node.id, row.depth, row.left])).toEqual([
      ['main', 0, AGENT_PAD],
      ['dev', 1, AGENT_PAD + AGENT_ROW_INDENT],
      ['test', 2, AGENT_PAD + 2 * AGENT_ROW_INDENT],
    ]);
    expect(rows[1]?.parentLeft).toBe(AGENT_PAD);
    expect(rows[2]?.parentLeft).toBe(AGENT_PAD + AGENT_ROW_INDENT);
  });

  // 断链的 parent（坏数据或被丢掉的中间层）退回根：整支绝不消失。
  it('falls back to the root when the parent is not in the list', () => {
    const rows = agentRows([
      node({ id: 'main', kind: 'main', depth: 0 }),
      node({ id: 'orphan', parent: 'gone', depth: 2 }),
    ]);
    expect(rows[1]?.parentLeft).toBeUndefined();
  });

  // 同一个 id 出现两次只画一行，第二次也不再连父：重复会在面板上变成两行假节点。
  it('draws each id once', () => {
    const rows = agentRows([
      node({ id: 'a', depth: 1 }),
      node({ id: 'a', depth: 1, label: '再来一次' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.node.label).toBe('审 tests');
  });
});

describe('canvas geometry', () => {
  it('sizes the canvas from the row count', () => {
    expect(agentCanvasHeight(0)).toBe(AGENT_PAD * 2);
    expect(agentCanvasHeight(1)).toBe(AGENT_PAD * 2 + AGENT_ROW_H);
    expect(agentCanvasHeight(3)).toBe(AGENT_PAD * 2 + 3 * AGENT_ROW_H + 2 * 8);
  });

  it('keeps a minimum width and widens for long labels', () => {
    expect(agentCanvasWidth(1)).toBe(260);
    expect(agentCanvasWidth(400)).toBe(400 + AGENT_PAD * 2);
  });
});

describe('agentSummary', () => {
  it('names the counts and only the non-zero extras', () => {
    expect(agentSummary(payload({ counts: { total: 3, running: 0, unsupported: 0 } }), t)).toBe(
      '3 个节点'
    );
    expect(agentSummary(payload({ counts: { total: 3, running: 2, unsupported: 1 } }), t)).toBe(
      '3 个节点 · 2 个在跑 · 1 个未支持'
    );
  });

  // `unsupported` 的计数必须出现：它解释「为什么树上有东西没画出来」。
  it('always reports the unsupported count when there is one', () => {
    expect(
      agentSummary(payload({ counts: { total: 1, running: 0, unsupported: 2 } }), t)
    ).toContain('2 个未支持');
  });
});

describe('rawCount', () => {
  it('prints the exact number with thousands separators', () => {
    expect(rawCount(12)).toBe('12');
    expect(rawCount(28067)).toBe('28,067');
  });
});

describe('AGENT_COPY_KEYS', () => {
  // 这一份是组件与守卫之间的契约：每个键都要在源里以字面量出现（copy.test.ts 的反向守卫），
  // 且都真的在词典里。
  it('names keys the dictionary carries in both locales', () => {
    for (const key of Object.values(AGENT_COPY_KEYS)) {
      expect(ZH[key as keyof typeof ZH], `${key} in ZH`).toBeTruthy();
      expect(EN[key as keyof typeof EN], `${key} in EN`).toBeTruthy();
    }
  });
});
