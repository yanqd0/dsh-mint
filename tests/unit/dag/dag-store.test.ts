import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { emptyDag, parseDagAction, applyDagWrite } from '../../../src/dag/dag.js';
import type { DagDoc } from '../../../src/dag/dag.js';
import { DAG_DIR, DagPathError, dagFilePath, readDag, updateDag } from '../../../src/dag/dag-store.js';

/** The session every case writes under; the id shape is the only one allowed. */
const SESSION = 'sess-1';
const NOW = '2026-10-07T00:00:00.000Z';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mint-dag-'));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** A per-case directory, so one case's file never leaks into the next. */
function dir(): string {
  return mkdtempSync(join(root, 'case-'));
}

/** Turn a validated action into one update call, failing loudly on bad input. */
async function write(where: string, action: unknown, session = SESSION): Promise<DagDoc> {
  const parsed = parseDagAction(action);
  if ('error' in parsed) throw new Error(parsed.error);
  // `wt`/`merge` change the filesystem, not the document, so a stored-write
  // test may only drive the three document actions.
  if (parsed.action !== 'init' && parsed.action !== 'add' && parsed.action !== 'set') {
    throw new Error(`${parsed.action} is not a document write`);
  }
  const result = await updateDag(
    session,
    (state) => {
      const current = state.state === 'ok' ? state.doc : undefined;
      const outcome = applyDagWrite(parsed, current, session, NOW);
      return outcome;
    },
    where
  );
  if (!result.ok) throw new Error(result.error);
  if ('skipped' in result) throw new Error('unexpected skip');
  return result.doc;
}

describe('dagFilePath', () => {
  it('builds one path per session under the configured directory', () => {
    expect(dagFilePath(SESSION, '/tmp/x')).toBe('/tmp/x/sess-1.json');
    expect(dagFilePath(SESSION)).toBe(`${DAG_DIR}/sess-1.json`);
    expect(dagFilePath('a_b-C9', '/tmp/x')).toBe('/tmp/x/a_b-C9.json');
  });

  // 路径门禁：会话 id 若会拼出目录之外的文件名，必须在拼路径这一步就抛 `DagPathError`。
  // 逐个喂空串、`..`、带 `/` 与超长 id，断言每次抛出的都是 `DagPathError`。
  it('refuses an id that would escape the directory', () => {
    for (const id of ['', '..', '../x', 'a/b', 'x'.repeat(65)]) {
      expect(() => dagFilePath(id, '/tmp/x'), id).toThrow(DagPathError);
    }
  });
});

describe('readDag', () => {
  it('answers missing for a session that never wrote one', async () => {
    const where = dir();
    await expect(readDag(SESSION, where)).resolves.toEqual({
      state: 'missing',
      file: dagFilePath(SESSION, where),
    });
  });

  it('round-trips a written document', async () => {
    const where = dir();
    const written = await write(where, { action: 'init', title: '演示计划' });
    const read = await readDag(SESSION, where);
    expect(read.state).toBe('ok');
    if (read.state !== 'ok') throw new Error('expected a document');
    expect(read.doc).toEqual(written);
    const text = readFileSync(read.file, 'utf8');
    expect(text.endsWith('\n')).toBe(true);
    expect(JSON.parse(text)).toEqual(written);
    expect(readdirSync(where)).toEqual([`${SESSION}.json`]);
  });

  // 读侧的降级口径：坏 JSON、未来版本、别的会话的文档都归为 unreadable，且要点名原因。
  // 三个临时目录各写一种坏文件，分别断言错误文案含 `JSON`、`version`、`other-session`。
  it('reports broken JSON, an unknown version, and a foreign session as unreadable', async () => {
    const broken = dir();
    writeFileSync(dagFilePath(SESSION, broken), '{ not json');
    const brokenRead = await readDag(SESSION, broken);
    expect(brokenRead.state).toBe('unreadable');
    if (brokenRead.state !== 'unreadable') throw new Error('expected unreadable');
    expect(brokenRead.error).toContain('JSON');

    const future = dir();
    writeFileSync(
      dagFilePath(SESSION, future),
      JSON.stringify({ ...emptyDag(SESSION, '', NOW), version: 99 })
    );
    const futureRead = await readDag(SESSION, future);
    if (futureRead.state !== 'unreadable') throw new Error('expected unreadable');
    expect(futureRead.error).toContain('version');

    const foreign = dir();
    writeFileSync(dagFilePath(SESSION, foreign), JSON.stringify(emptyDag('other-session', '', NOW)));
    const foreignRead = await readDag(SESSION, foreign);
    if (foreignRead.state !== 'unreadable') throw new Error('expected unreadable');
    expect(foreignRead.error).toContain('other-session');
  });

  // 边界区分：文件位上是目录属于「读不了」而不是「没有」，绝不静默当成缺文档。
  // 在目标路径上 `mkdirSync` 出目录占位，断言 `readDag` 回 unreadable。
  it('treats a directory in the file slot as unreadable rather than missing', async () => {
    const where = dir();
    const squatting = join(where, `${SESSION}.json`);
    // `writeFileSync` on an existing directory throws, so create the colliding
    // entry by making the target itself a directory.
    mkdirSync(squatting);
    await expect(readDag(SESSION, where)).resolves.toMatchObject({ state: 'unreadable' });
  });
});

describe('updateDag', () => {
  it('refuses an invalid session before touching the filesystem', async () => {
    await expect(updateDag('../escape', () => ({ skip: true }), '/tmp')).rejects.toThrow(DagPathError);
  });

  it('honours skip without writing anything', async () => {
    const where = dir();
    await expect(updateDag(SESSION, () => ({ skip: true }), where)).resolves.toEqual({
      ok: true,
      skipped: true,
    });
    expect(readdirSync(where)).toEqual([]);
  });

  it('reports a refusal from the mutation without writing anything', async () => {
    const where = dir();
    await expect(updateDag(SESSION, () => ({ error: 'nope' }), where)).resolves.toEqual({
      ok: false,
      error: 'nope',
    });
    expect(readdirSync(where)).toEqual([]);
  });

  it('hands the mutation what is on disk and advances the revision', async () => {
    const where = dir();
    const seen: string[] = [];
    const first = await updateDag(
      SESSION,
      (state) => {
        seen.push(state.state);
        return { doc: emptyDag(SESSION, 'first', NOW) };
      },
      where
    );
    expect(first).toMatchObject({ ok: true });
    await updateDag(
      SESSION,
      (state) => {
        expect(state.state).toBe('ok');
        if (state.state !== 'ok') return { error: 'expected a document' };
        seen.push(`revision=${String(state.doc.revision)}`);
        return { doc: { ...state.doc, title: 'second', revision: state.doc.revision + 1, updated_at: NOW } };
      },
      where
    );
    expect(seen).toEqual(['missing', 'revision=1']);
    const read = await readDag(SESSION, where);
    if (read.state !== 'ok') throw new Error('expected a document');
    expect(read.doc).toMatchObject({ title: 'second', revision: 2 });
  });

  // 并发回归钉：12 个 add 并发跑完不能丢更新，revision 必须等于 1 + 12。
  // 用 `Promise.all` 同时发 12 次真实 `updateDag`，最后读回节点数与 revision 并确认没留临时文件。
  it('serializes concurrent read-modify-writes instead of losing updates', async () => {
    const where = dir();
    await write(where, { action: 'init', title: 'fan-out' });
    const adds = Array.from({ length: 12 }, (_, index) => index);
    await Promise.all(
      adds.map(async (index) =>
        write(
          where,
          {
            action: 'add',
            nodes: [{ id: `n${String(index)}`, label: '分', title: `node ${String(index)}`, phase: 'exec' }],
            edges: [],
          }
        )
      )
    );
    const read = await readDag(SESSION, where);
    if (read.state !== 'ok') throw new Error('expected a document');
    expect(read.doc.nodes).toHaveLength(adds.length);
    expect(read.doc.revision).toBe(1 + adds.length);
    expect(readdirSync(where)).toEqual([`${SESSION}.json`]);
  });

  // 写失败契约：落盘出错时返回错误对象而不是抛出，让工具层能原样回显。
  // 在目录位放一个普通文件让 `mkdir` 失败，断言 `ok:false` 且文案含「写入 DAG 失败」。
  it('reports a write failure instead of throwing', async () => {
    // A regular file where the directory should be: `mkdir` cannot create it.
    const blocked = join(root, 'blocked');
    writeFileSync(blocked, 'not a directory');
    const blockedWrite = await updateDag(SESSION, () => ({ doc: emptyDag(SESSION, '', NOW) }), blocked);
    if (blockedWrite.ok) throw new Error('expected a write failure');
    expect(blockedWrite.error).toContain('写入 DAG 失败');
  });

  // 串行链排空后锁要重新可用：第二次独立写入必须还能看到上一次的文件。
  // 先 init 再 add，断言第二次拿到的文档含 1 个节点且 revision 为 2。
  it('reopens the lock once the chain drains', async () => {
    const where = dir();
    await write(where, { action: 'init', title: '' });
    const second = await write(where, {
      action: 'add',
      nodes: [{ id: 'b', label: '分', title: 'b', phase: 'exec' }],
      edges: [],
    });
    expect(second.nodes).toHaveLength(1);
    expect(second.revision).toBe(2);
  });
});
