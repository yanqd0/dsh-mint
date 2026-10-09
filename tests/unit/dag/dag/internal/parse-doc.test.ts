import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { applyDagWrite, emptyDag, parseDagDoc, sampleOf } from '../../../../../src/dag/dag.js';
import type { DagSample } from '../../../../../src/dag/dag.js';
import { srcPath } from '../../../../helpers/repo.js';
import { NOW, SESSION, doc, node, tree } from './helpers.js';

describe('parseDagDoc', () => {
  it('round-trips a well-formed document', () => {
    const subject = doc({
      nodes: [
        node({ id: 'a', status: 'done', verdict: 'fail', note: 'n', tokens: 3, agent: 'child-1', issue: 150 }),
      ],
      edges: [['a', 'a']],
    });
    const parsed = parseDagDoc(JSON.parse(JSON.stringify(subject)) as unknown);
    expect(parsed).toEqual({ doc: subject });
  });

  // 读取门禁：坏文档必须点名是哪个字段坏了，绝不猜默认值把损坏数据读成合法状态。
  // 一张 21 条的坏文档表逐条交给 `parseDagDoc`，断言错误文案含对应字段名或判据关键词。
  it('names what is wrong instead of guessing defaults', () => {
    const cases: [unknown, string][] = [
      [null, 'object'],
      [{ ...doc(), version: 2 }, 'version'],
      [{ ...doc(), session: '../etc' }, 'session'],
      [{ ...doc(), title: 7 }, 'title'],
      [{ ...doc(), revision: -1 }, 'revision'],
      [{ ...doc(), revision: 1.5 }, 'revision'],
      [{ ...doc(), created_at: 7 }, 'created_at'],
      [{ ...doc(), nodes: {} }, 'arrays'],
      [{ ...doc(), nodes: [{ ...node(), phase: 'plan' }] }, 'phase'],
      [{ ...doc(), nodes: [{ ...node(), status: 'shipped' }] }, 'status'],
      [{ ...doc(), nodes: [{ ...node(), verdict: 'maybe' }] }, 'verdict'],
      [{ ...doc(), nodes: [{ ...node(), depends_on: [1] }] }, 'depends_on'],
      [{ ...doc(), nodes: [{ ...node(), updated_at: 7 }] }, 'updated_at'],
      [{ ...doc(), nodes: [{ ...node(), issue: 1.5 }] }, 'issue'],
      [{ ...doc(), nodes: [{ ...node(), tokens: 1.5 }] }, 'tokens'],
      [{ ...doc(), nodes: [{ ...node(), agent: 7 }] }, 'agent'],
      [{ ...doc(), nodes: [{ ...node(), note: 7 }] }, 'note'],
      [{ ...doc(), nodes: [{ ...node(), id: 'a1#1' }] }, '只允许'],
      [{ ...doc(), nodes: [{ ...node(), id: 'a' }, { ...node(), id: 'a' }] }, 'duplicate'],
      [{ ...doc(), nodes: ['x'] }, 'object'],
      [{ ...doc(), edges: [['a']] }, 'edges'],
    ];
    for (const [raw, needle] of cases) {
      const parsed = parseDagDoc(raw);
      if (!('error' in parsed)) throw new Error(`expected a refusal for ${JSON.stringify(raw)}`);
      expect(parsed.error, JSON.stringify(raw)).toContain(needle);
    }
  });

  // --- worktree.target ---

  it('refuses an empty worktree.target instead of keeping a blank branch name', () => {
    // 空串会在面板上渲染成空白分支名；「缺字段」才代表旧记录（可读）。
    const withTree = doc({ nodes: [node({ worktree: tree({ target: '' }) })] });
    const parsed = parseDagDoc(JSON.parse(JSON.stringify(withTree)) as unknown);
    if (!('error' in parsed)) throw new Error('expected a refusal for an empty target');
    expect(parsed.error).toContain('worktree.target 必须是非空字符串');
  });

  it('round-trips a legal worktree.target', () => {
    const subject = doc({ nodes: [node({ worktree: tree({ target: 'feature/branch' }) })] });
    const parsed = parseDagDoc(JSON.parse(JSON.stringify(subject)) as unknown);
    expect(parsed).toEqual({ doc: subject });
  });
});

describe('sampleOf', () => {
  it('stamps the numbers it was given with the sample clock', () => {
    expect(sampleOf({ tokens: 1, elapsed_ms: 2 }, 3)).toEqual({ tokens: 1, elapsed_ms: 2, at: 3 });
    expect(sampleOf({ tokens: 1 }, 3)).toEqual({ tokens: 1, at: 3 });
    expect(sampleOf({ elapsed_ms: 2 }, 0)).toEqual({ elapsed_ms: 2, at: 0 });
    // A legitimate zero is a measurement, not a missing one.
    expect(sampleOf({ tokens: 0, elapsed_ms: 0 }, 0)).toEqual({ tokens: 0, elapsed_ms: 0, at: 0 });
  });

  it('keeps the one field it can trust and drops the other', () => {
    expect(sampleOf({ tokens: -1, elapsed_ms: 2 }, 3)).toEqual({ elapsed_ms: 2, at: 3 });
    expect(sampleOf({ tokens: 1.5, elapsed_ms: 2 }, 3)).toEqual({ elapsed_ms: 2, at: 3 });
  });

  it('refuses a reading with no trustworthy number left', () => {
    expect(sampleOf({}, 3)).toBeUndefined();
    expect(sampleOf({ tokens: -1 }, 3)).toBeUndefined();
    expect(
      sampleOf({ tokens: Number.NaN, elapsed_ms: Number.MAX_SAFE_INTEGER + 1 }, 3)
    ).toBeUndefined();
  });

  // 采样钟边界：`at` 必须是非负安全整数，负数、小数、NaN 与超界一律拒绝。
  // 固定一份合法读数，逐种非法 `at` 断言返回 undefined，失败信息带上该值。
  it('refuses a clock that is not a non-negative safe integer', () => {
    for (const at of [-1, 1.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1, Number.POSITIVE_INFINITY]) {
      expect(sampleOf({ tokens: 1 }, at), String(at)).toBeUndefined();
    }
  });
});

describe('parseDagDoc samples', () => {
  /** One raw document carrying `samples`, however malformed the case is about. */
  function withSamples(samples: unknown): unknown {
    return { ...doc(), samples };
  }

  it('round-trips a well-formed map, with one or both numbers per entry', () => {
    const samples: Record<string, DagSample> = {
      a: { tokens: 3, elapsed_ms: 4, at: 1 },
      b: { tokens: 5, at: 2 },
      c: { elapsed_ms: 6, at: 3 },
    };
    const subject = doc({ samples });
    expect(parseDagDoc(JSON.parse(JSON.stringify(subject)) as unknown)).toEqual({ doc: subject });
  });

  it('omits the key for a document that never carried samples', () => {
    const parsed = parseDagDoc(JSON.parse(JSON.stringify(doc())) as unknown);
    expect(parsed).toEqual({ doc: doc() });
    if ('error' in parsed) throw new Error(`expected a document, got: ${parsed.error}`);
    expect('samples' in parsed.doc).toBe(false);
  });

  // 整体拒绝的门禁：`samples` 不是对象时不能只丢它，必须让整份文档不可读。
  // 依次喂数字、字符串、数组、布尔与 null，断言每种都返回含 `samples` 的错误。
  it('refuses the whole document when samples is not an object', () => {
    for (const samples of [7, 'x', [], true, null]) {
      const parsed = parseDagDoc(withSamples(samples));
      if (!('error' in parsed))
        throw new Error(`expected a refusal for ${JSON.stringify(samples)}`);
      expect(parsed.error, JSON.stringify(samples)).toContain('samples');
    }
  });

  // 逐条信任的降级口径：一个坏字段只连坐自己那条，好的兄弟条目必须原样留下。
  // 一份含 9 个条目的夹具（各种坏 at/tokens 与非对象），断言只剩 `good` 一条。
  it('drops only the entries it cannot trust, keeping every good sibling', () => {
    const parsed = parseDagDoc(
      withSamples({
        good: { tokens: 1, elapsed_ms: 2, at: 3 },
        'no-at': { tokens: 1 },
        // A stored entry is trusted whole: one unusable field costs the entry.
        'at-negative': { tokens: 1, at: -1 },
        'at-fraction': { tokens: 1, at: 1.5 },
        'at-string': { tokens: 1, at: '7' },
        'tokens-negative': { tokens: -1, at: 1 },
        'tokens-fraction': { elapsed_ms: 1, tokens: 1.5, at: 1 },
        'no-number': { at: 1 },
        'not-an-object': 7,
      })
    );
    expect(parsed).toEqual({
      doc: doc({ samples: { good: { tokens: 1, elapsed_ms: 2, at: 3 } } }),
    });
  });

  // 空映射的可读性契约：条目全被丢掉也要保留 `samples` 键，否则空图会被读成坏文档。
  // 分别解析「唯一条目非法」与「空对象」两份原始文档，断言结果都带空的 `samples`。
  it('keeps the key when every entry was dropped, so an empty map stays readable', () => {
    expect(parseDagDoc(withSamples({ a: { tokens: -1, at: 1 } }))).toEqual({
      doc: doc({ samples: {} }),
    });
    expect(parseDagDoc(withSamples({}))).toEqual({ doc: doc({ samples: {} }) });
  });

  it('leaves the write path alone: an applied write keeps the samples it read', () => {
    const stored = doc({ nodes: [node({ id: 'a' })], samples: { a: { tokens: 1, at: 2 } } });
    const written = applyDagWrite({ action: 'set', id: 'a', status: 'done' }, stored, SESSION, NOW);
    if ('error' in written) throw new Error(`expected a document, got: ${written.error}`);
    expect(written.doc.samples).toEqual({ a: { tokens: 1, at: 2 } });
    // Nothing here invents the key either: an empty document stays without one.
    expect(emptyDag(SESSION, '', NOW)).not.toHaveProperty('samples');
  });
});

describe('dag module boundaries', () => {
  it('imports no node builtin, because the browser bundle inlines it', () => {
    const source = readFileSync(srcPath('dag', 'dag.ts'), 'utf8');
    expect(source).not.toMatch(/from 'node:/);
    expect(source).not.toMatch(/require\('node:/);
    expect(source).not.toMatch(/\bBuffer\./);
  });
});
