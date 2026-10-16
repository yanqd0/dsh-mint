import { describe, expect, it } from 'vitest';

import { collectAgentTree } from '../../../../src/dag/agent-tree/agent-tree.js';
import type { CollectAgentTreeInput } from '../../../../src/dag/agent-tree/agent-tree.js';
import { parseAgentTreeDoc } from '../../../../src/dag/agent-tree/internal/parse-doc.js';
import type {
  AgentCwdLike,
  AgentsLike,
  SessionProjectionsLike,
} from '../../../../src/shared/types.js';

const ROOT = 'session-root';
const SAMPLED_MS = 1_000_000;

/** 一个会话对象：只有 id 与 durable header 对被测代码有意义。 */
function session(id: string, parentSession?: string): AgentCwdLike {
  return {
    id,
    session: {
      id,
      header: {
        ...(parentSession === undefined ? {} : { parentSession }),
        createdAt: 5,
      },
    },
  };
}

/**
 * 一棵固定的测试树：**每个 id 只给一个会话对象**，与真宿主一样。
 *
 * 宿主的会话注册表答的是会话本身（`AgentCwdLike` 的 `session`），而 agent 注册表答的是
 * 带着那个会话的 Agent——测试与实际读法保持一致。
 *
 * `status` 决定该 id 的 agent 是否在跑；`catalogs` 是该会话的子级列表。
 */
interface Fixture {
  root: string;
  sessions: Map<string, AgentCwdLike>;
  agents: AgentsLike;
  projections: SessionProjectionsLike;
}

function tree(input: {
  /** 每个 id 的 parent；ROOT 必须出现且没有 parent。 */
  parents: Record<string, string | undefined>;
  /** 每个 id 的 agent 状态；缺席即「没有活 agent」（已结束的子代理）。 */
  status?: Record<string, string | undefined>;
  /** 每个 id 的子级 catalog；缺席即空表。 */
  catalogs?: Record<string, readonly unknown[]>;
}): Fixture {
  const sessions = new Map<string, AgentCwdLike>();
  for (const [id, parent] of Object.entries(input.parents)) {
    sessions.set(id, session(id, parent));
  }
  const catalogs = new Map<unknown, readonly unknown[]>();
  for (const [id, children] of Object.entries(input.catalogs ?? {})) {
    const owner = sessions.get(id)?.session;
    if (owner !== undefined) catalogs.set(owner, children);
  }
  return {
    root: ROOT,
    sessions,
    agents: {
      get: (id) => {
        const own = sessions.get(id);
        if (own === undefined) return undefined;
        const status = input.status?.[id];
        return { ...own, ...(status === undefined ? {} : { status }) };
      },
    },
    // 按真实宿主的两半给料：`stateOf` 只答投影 **state**（`{inheritedEventCount, head}`，head 是
    // 最近一条的 `childId`/`childCreatedAt`），树的形状在 `snapshot` 的 wire view 里。两半都给，
    // 于是「实现有没有回头读 stateOf」在每条形状用例上都能被证伪。
    projections: {
      stateOf: (s, key) => {
        if (key !== 'subagentCatalog') return undefined;
        const children = catalogs.get(s) ?? [];
        return {
          inheritedEventCount: children.length,
          ...(children.length === 0
            ? {}
            : { head: { childId: 'state-head', childCreatedAt: 7, mode: 'one-shot' } }),
        };
      },
      snapshot: (s, keys) => ({
        asOfSeq: 1,
        values: (keys ?? []).includes('subagentCatalog')
          ? { subagentCatalog: catalogs.get(s) }
          : {},
      }),
    },
  };
}

/** 一份只填断言需要字段的输入。 */
function input(fixture: Fixture, over: Partial<CollectAgentTreeInput> = {}): CollectAgentTreeInput {
  return {
    rootId: fixture.root,
    agents: fixture.agents,
    sessions: { get: (id) => fixture.sessions.get(id) },
    projections: fixture.projections,
    sampledMs: SAMPLED_MS,
    ...over,
  };
}

describe('collectAgentTree', () => {
  it('answers the root alone when the session has no children', () => {
    const read = collectAgentTree(
      input(tree({ parents: { [ROOT]: undefined }, status: { [ROOT]: 'running' } }))
    );
    // 根的 `seenAt` 来自会话自己的 header（子级的来自 catalog 条目）。
    expect(read.nodes).toEqual([
      { id: ROOT, kind: 'main', depth: 0, label: 'main', running: true, seenAt: 5 },
    ]);
    expect(read.counts).toEqual({ total: 1, running: 1, unsupported: 0 });
    expect(read.warnings).toBeUndefined();
  });

  // 树的形状来自父会话的 catalog（持久事实），存活度来自 agent 注册表：两者不是一件事，
  // 所以已结束的子代理仍然在树上，只是 `running: false`。
  it('keeps a settled child in the tree while reporting it as not running', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, 'child-1': ROOT },
          status: { [ROOT]: 'idle' },
          catalogs: {
            [ROOT]: [{ id: 'child-1', createdAt: 7, mode: 'one-shot', label: '审 tests' }],
          },
        })
      )
    );
    expect(read.nodes).toEqual([
      { id: ROOT, kind: 'main', depth: 0, label: 'main', running: false, seenAt: 5 },
      {
        id: 'child-1',
        kind: 'subagent',
        parent: ROOT,
        depth: 1,
        label: '审 tests',
        mode: 'one-shot',
        running: false,
        seenAt: 7,
      },
    ]);
    expect(read.counts).toEqual({ total: 2, running: 0, unsupported: 0 });
  });

  // 两级委派（dev → test）：孙节点的 `parent` 是**子会话**而不是根，这正是「不靠猜」的证明。
  it('links a grandchild to its own parent, not to the root', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, dev: ROOT, test: 'dev' },
          status: { [ROOT]: 'idle', dev: 'idle', test: 'running' },
          catalogs: {
            [ROOT]: [{ id: 'dev', mode: 'one-shot', label: '写实现' }],
            dev: [{ id: 'test', mode: 'one-shot', label: '跑测试' }],
          },
        })
      )
    );
    expect(read.nodes.map((node) => [node.id, node.depth, node.parent ?? '-'])).toEqual([
      [ROOT, 0, '-'],
      ['dev', 1, ROOT],
      ['test', 2, 'dev'],
    ]);
    expect(read.counts).toEqual({ total: 3, running: 1, unsupported: 0 });
  });

  // 兄弟顺序 = catalog 事件顺序，且先序（父先于子）：面板直接按数组顺序排版。
  it('keeps catalog order for siblings and stays pre-order', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, a: ROOT, b: ROOT, 'a-child': 'a' },
          catalogs: {
            [ROOT]: [
              { id: 'b', mode: 'one-shot', label: '第二' },
              { id: 'a', mode: 'one-shot', label: '第一' },
            ],
            a: [{ id: 'a-child', mode: 'one-shot', label: 'a 的子级' }],
          },
        })
      )
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'b', 'a', 'a-child']);
  });

  it('falls back to the short id when the catalog carries no label', () => {
    const long = '1234567890abcdef';
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, [long]: ROOT },
          catalogs: { [ROOT]: [{ id: long, mode: 'one-shot' }] },
        })
      )
    );
    expect(read.nodes[1]?.label).toBe('12345678');
    expect(read.nodes[1]?.mode).toBe('one-shot');
  });

  // 一条 id 出现两次（同一子代理被两处登记）只画一次：重复会在面板上变成两行假节点。
  it('visits each session once even when two catalogs name it', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, a: ROOT },
          catalogs: {
            [ROOT]: [
              { id: 'a', mode: 'one-shot', label: 'a' },
              { id: 'a', mode: 'one-shot', label: 'a 再来一次' },
            ],
            // 人为的环：a 的 catalog 又说自己是根的子级。
            a: [{ id: ROOT, mode: 'one-shot', label: 'root' }],
          },
        })
      )
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'a']);
  });

  // `mode: 'unknown'` 的条目按宿主自己的语义不画（连形态都还没确定），但要有计数，
  // 否则面板会把「有东西没显示」读成「什么都没有」。
  it('drops unsupported catalog entries and counts them', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, 'ok-1': ROOT },
          catalogs: {
            [ROOT]: [
              { id: 'unknown-1', mode: 'unknown' },
              { id: 'ok-1', mode: 'one-shot', label: '能画的' },
              'not an object',
              { mode: 'one-shot' },
            ],
          },
        })
      )
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'ok-1']);
    expect(read.counts.unsupported).toBe(1);
  });

  // 会话读不出来的子级仍然画（catalog 是持久事实），只是没有读数、也没有下一层。
  it('keeps a child whose session is gone, without metrics or children', () => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined },
          catalogs: { [ROOT]: [{ id: 'gone', mode: 'continuable', label: '已经收尾的' }] },
        })
      )
    );
    expect(read.nodes[1]).toEqual({
      id: 'gone',
      kind: 'subagent',
      parent: ROOT,
      depth: 1,
      label: '已经收尾的',
      mode: 'continuable',
      running: false,
    });
  });

  // 反面用例：wire view 读不到就没有子级——四种坏输入各自定位（缺 `snapshot` 端口 / `values` 里
  // 没这个键 / 值不是数组 / `stateOf` 那边放着像 catalog 的数组），**绝不回落 `stateOf`**。
  const noWireView: Array<[string, SessionProjectionsLike]> = [
    ['a missing snapshot port', { stateOf: () => undefined }],
    [
      'a snapshot without the catalog value',
      { stateOf: () => undefined, snapshot: () => ({ asOfSeq: 1, values: {} }) },
    ],
    [
      'a catalog value that is not an array',
      {
        stateOf: () => undefined,
        snapshot: () => ({ asOfSeq: 1, values: { subagentCatalog: { inheritedEventCount: 1 } } }),
      },
    ],
    [
      'a stateOf that looks like a catalog',
      { stateOf: () => [{ id: 'child-1', mode: 'one-shot', label: 'stateOf 里的' }] },
    ],
  ];

  it.each(noWireView)('answers the root alone with %s', (_case, projections) => {
    const read = collectAgentTree(
      input(
        tree({
          parents: { [ROOT]: undefined, 'child-1': ROOT },
          catalogs: { [ROOT]: [{ id: 'child-1', mode: 'one-shot', label: '读不到的' }] },
        }),
        { projections }
      )
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT]);
    expect(read.counts.unsupported).toBe(0);
  });

  // 反面用例：`stateOf` 答的是投影 state（`{inheritedEventCount, head}`），把它当 catalog 读正是
  // 这次误读的来源——即使 fixture 里有真 catalog，没有 wire view 就必须答「没有子级」。
  it('never takes the projection state for the catalog', () => {
    const fixture = tree({
      parents: { [ROOT]: undefined, 'child-1': ROOT },
      catalogs: { [ROOT]: [{ id: 'child-1', mode: 'one-shot', label: '真子级' }] },
    });
    const read = collectAgentTree(
      input(fixture, {
        projections: {
          stateOf: () => ({
            inheritedEventCount: 1,
            head: { childId: 'child-1', childCreatedAt: 7, mode: 'one-shot' },
          }),
        },
      })
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT]);
    expect(read.counts).toEqual({ total: 1, running: 0, unsupported: 0 });
  });

  // 一个坏分支（`snapshot` 抛错）只丢它自己：根照旧、兄弟照旧，绝不带走整棵树。
  it('loses only the branch whose catalog read throws', () => {
    const fixture = tree({
      parents: { [ROOT]: undefined, bad: ROOT, good: ROOT },
      catalogs: {
        [ROOT]: [
          { id: 'bad', mode: 'one-shot', label: '坏' },
          { id: 'good', mode: 'one-shot', label: '好' },
        ],
      },
    });
    const bad = fixture.sessions.get('bad')?.session;
    const read = collectAgentTree(
      input(fixture, {
        projections: {
          stateOf: (s, key) => fixture.projections.stateOf(s, key),
          snapshot: (s, keys) => {
            if (s === bad) throw new Error('unknown session');
            return fixture.projections.snapshot?.(s, keys);
          },
        },
      })
    );
    expect(read.nodes.map((node) => node.id)).toEqual([ROOT, 'bad', 'good']);
  });

  // 根不在册（面板活得比会话久）不是错误：空树 + 一条说明，由面板显示空态。
  it('answers an empty tree when the root session is not live', () => {
    const read = collectAgentTree(
      input(tree({ parents: {} }), {
        agents: { get: () => undefined },
        sessions: { get: () => undefined },
      })
    );
    expect(read.nodes).toEqual([]);
    expect(read.counts).toEqual({ total: 0, running: 0, unsupported: 0 });
    expect(read.warnings).toEqual(['root session is not live']);
  });

  it('answers an empty tree when neither registry service is present', () => {
    const read = collectAgentTree(
      input(tree({ parents: { [ROOT]: undefined } }), {
        agents: undefined,
        sessions: undefined,
        projections: undefined,
      })
    );
    expect(read.nodes).toEqual([]);
    expect(read.warnings).toEqual(['host agents/sessions services are absent']);
  });

  // 存活度只认 agent 注册表：会话还在册（`sessions.get` 有值）但 agent 已经放掉，
  // 就该读成「不在跑」——catalog 是历史事实，存活度是此刻的事实。
  it('reads a session with no live agent as not running', () => {
    const fixture = tree({ parents: { [ROOT]: undefined } });
    const read = collectAgentTree(input(fixture, { agents: { get: () => undefined } }));
    expect(read.nodes[0]?.running).toBe(false);
  });

  // 上下文/时长等读数来自 `nodeMetrics`：这里只钉「main 不发 token 计数、子级发」，
  // 四桶与降级的细节由 dag-metrics 自己的用例守。树的形状仍从 fixture 的 wire view 取，
  // 投影服务只在读数那几把键上补料——树的形状与读数是两条独立的读。
  it('withholds token counts for main but publishes them for a subagent', () => {
    const usage = {
      totals: {
        uncachedInputTokens: 10,
        outputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    };
    const fixture = tree({
      parents: { [ROOT]: undefined, child: ROOT },
      status: { [ROOT]: 'running', child: 'running' },
      catalogs: { [ROOT]: [{ id: 'child', mode: 'one-shot', label: '子' }] },
    });
    const read = collectAgentTree(
      input(fixture, {
        projections: {
          stateOf: (s, key) => {
            if (key === 'tokenUsage') return usage;
            if (key === 'contextPressure') return { pressureTokens: 900 };
            if (key === 'subagentTiming') return { settledMs: 42 };
            return fixture.projections.stateOf(s, key);
          },
          snapshot: (s, keys) => fixture.projections.snapshot?.(s, keys),
        },
      })
    );
    expect(read.nodes[0]?.metrics).toEqual({ context: 900, elapsed_ms: 42 });
    expect(read.nodes[1]?.metrics).toEqual({
      tokens: 11,
      uncached_input: 10,
      cache_read: 0,
      cache_write: 0,
      output: 1,
      context: 900,
      elapsed_ms: 42,
    });
  });

  // 上限护栏：坏 catalog 造出的超深链被截断，而不是把一次应答变成没完没了的遍历。
  it('stops walking past the depth cap', () => {
    const parents: Record<string, string | undefined> = { [ROOT]: undefined };
    const catalogs: Record<string, readonly unknown[]> = {};
    let previous = ROOT;
    for (let index = 0; index < 12; index += 1) {
      const id = `n-${String(index)}`;
      parents[id] = previous;
      catalogs[previous] = [{ id, mode: 'one-shot', label: id }];
      previous = id;
    }
    const read = collectAgentTree(input(tree({ parents, catalogs })));
    expect(read.nodes).toHaveLength(9);
    expect(read.nodes.at(-1)?.depth).toBe(8);
  });
});

describe('parseAgentTreeDoc', () => {
  /** 一份形状完整的文档；只有断言关心的字段会被改写。 */
  function raw(over: Record<string, unknown> = {}): Record<string, unknown> {
    return {
      version: 1,
      session: ROOT,
      revision: 2,
      sampled_at: SAMPLED_MS,
      nodes: [
        {
          id: ROOT,
          kind: 'main',
          depth: 0,
          label: 'main',
          running: true,
          metrics: { tokens: 3, context: 900, elapsed_ms: 42 },
        },
      ],
      ...over,
    };
  }

  /** 只跑解析并按 `error` 断言：合法时必须失败，让用例本身红掉。 */
  function errorOf(document: unknown): string {
    const parsed = parseAgentTreeDoc(document);
    if (!('error' in parsed)) throw new Error('expected an error');
    return parsed.error;
  }

  it('round-trips a valid document', () => {
    const parsed = parseAgentTreeDoc(raw());
    expect(parsed).toEqual({
      doc: {
        version: 1,
        session: ROOT,
        revision: 2,
        sampled_at: SAMPLED_MS,
        nodes: [
          {
            id: ROOT,
            kind: 'main',
            depth: 0,
            label: 'main',
            running: true,
            metrics: { tokens: 3, context: 900, elapsed_ms: 42 },
          },
        ],
      },
    });
  });

  // 整体字段严：版本、会话 id、revision 与 sampled_at 任一不成立就是具名错误，不做默认值猜测。
  it.each([
    ['an unsupported version', raw({ version: 2 }), 'unsupported version'],
    [
      'a session id that may become a path',
      raw({ session: '../etc/passwd' }),
      'session is not a valid session id',
    ],
    ['a negative revision', raw({ revision: -1 }), 'revision must be a non-negative integer'],
    [
      'a fractional sampled_at',
      raw({ sampled_at: 1.5 }),
      'sampled_at must be a non-negative integer',
    ],
    ['nodes that are not an array', raw({ nodes: 'x' }), 'nodes must be an array'],
    ['an over-long node list', raw({ nodes: new Array(201).fill(0) }), 'at most 200'],
  ])('refuses %s', (_case, document, message) => {
    expect(errorOf(document)).toContain(message);
  });

  it('refuses a document that is not an object', () => {
    expect(errorOf([])).toBe('document must be an object');
  });

  // 节点层从宽：形状坏的那条、重复 id 的那条各自丢掉，余下的照原顺序留下。
  it.each([
    [
      'a duplicate id',
      [
        { id: ROOT, kind: 'main', depth: 0, label: 'main', running: true },
        { id: ROOT, kind: 'subagent', depth: 1, label: 'dup', running: true },
      ],
      1,
    ],
    ['an unknown kind', [{ id: 'c1', kind: 'agent', depth: 1, label: 'c1', running: true }], 0],
  ])('drops the node with %s instead of failing the document', (_case, nodes, kept) => {
    const parsed = parseAgentTreeDoc(raw({ nodes }));
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.doc.nodes).toHaveLength(kept);
    if (kept > 0) expect(parsed.doc.nodes[0]?.id).toBe(ROOT);
  });

  // 读数逐字段收：坏的那一个只丢它自己，一个都没剩才整项不发。
  it('keeps the metrics fields that survived and drops the broken one', () => {
    const parsed = parseAgentTreeDoc(
      raw({
        nodes: [
          {
            id: 'c1',
            kind: 'subagent',
            depth: 1,
            label: 'c1',
            running: false,
            metrics: { tokens: 3, elapsed_ms: -1, context: 900 },
          },
        ],
      })
    );
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.doc.nodes[0]?.metrics).toEqual({ tokens: 3, context: 900 });
  });

  it('drops metrics entirely when no field survived', () => {
    const parsed = parseAgentTreeDoc(
      raw({
        nodes: [
          {
            id: 'c1',
            kind: 'subagent',
            depth: 1,
            label: 'c1',
            running: false,
            metrics: { tokens: 'x' },
          },
        ],
      })
    );
    if ('error' in parsed) throw new Error(parsed.error);
    expect(parsed.doc.nodes[0]).not.toHaveProperty('metrics');
  });
});
