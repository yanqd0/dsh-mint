import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  AGENT_TREE_DIR,
  AgentTreePathError,
  agentTreeFilePath,
  readAgentTreeDoc,
  updateAgentTree,
} from '../../../../src/dag/agent-tree/agent-tree-store.js';
import type { AgentTreeDoc } from '../../../../src/dag/agent-tree/internal/parse-doc.js';

const SESSION = 'sess-1';

let root = '';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'dsh-mint-agent-tree-'));
});

afterAll(() => {
  if (root !== '') rmSync(root, { recursive: true, force: true });
});

/** 每个用例一个目录，免得上一个用例的文件漏进下一个。 */
function dir(): string {
  return mkdtempSync(join(root, 'case-'));
}

/** 一份形状完整的最小文档：只有断言关心的字段会被改写。 */
function doc(over: Partial<AgentTreeDoc> = {}): AgentTreeDoc {
  return {
    version: 1,
    session: SESSION,
    revision: 1,
    sampled_at: 1_700_000_000_000,
    nodes: [{ id: SESSION, kind: 'main', depth: 0, label: 'main', running: true }],
    ...over,
  };
}

/** 把一份原始文本写进该会话的文档路径，用于伪造坏文件。 */
function writeRaw(where: string, text: string): void {
  mkdirSync(where, { recursive: true });
  writeFileSync(join(where, `${SESSION}.json`), text);
}

describe('agentTreeFilePath', () => {
  it('builds one path per session under the configured directory', () => {
    expect(agentTreeFilePath(SESSION, '/tmp/x')).toBe('/tmp/x/sess-1.json');
    expect(agentTreeFilePath(SESSION)).toBe(`${AGENT_TREE_DIR}/sess-1.json`);
    expect(agentTreeFilePath('a_b-C9', '/tmp/x')).toBe('/tmp/x/a_b-C9.json');
  });

  // 路径门禁：会话 id 若会拼出目录之外的文件名，必须在拼路径这一步就抛 `AgentTreePathError`。
  // 逐个喂空串、`..`、带 `/` 与超长 id，断言每次抛出的都是这个类型。
  it.each(['', '..', '../etc/passwd', 'a/b', 'x'.repeat(65)])(
    'refuses the id %j that would escape the directory',
    (id) => {
      expect(() => agentTreeFilePath(id, '/tmp/x')).toThrow(AgentTreePathError);
    }
  );
});

describe('readAgentTreeDoc', () => {
  // 缺文件是正常态：多数会话从来没有过子代理，路由要把它答成空树而不是错误。
  it('answers missing for a session without a document', async () => {
    const where = dir();
    const read = await readAgentTreeDoc(SESSION, where);
    expect(read.state).toBe('missing');
    expect(read).not.toHaveProperty('error');
    expect(read.file).toBe(join(where, `${SESSION}.json`));
  });

  it('answers the parsed document for a document it wrote itself', async () => {
    const where = dir();
    await updateAgentTree(SESSION, () => ({ doc: doc({ revision: 3 }) }), where);
    const read = await readAgentTreeDoc(SESSION, where);
    expect(read).toEqual({
      state: 'ok',
      file: join(where, `${SESSION}.json`),
      doc: doc({ revision: 3 }),
    });
  });

  it('answers unreadable for a file that is not JSON', async () => {
    const where = dir();
    writeRaw(where, '{ not json');
    const read = await readAgentTreeDoc(SESSION, where);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('expected unreadable');
    expect(read.error).toContain('invalid JSON');
  });

  // 文件里的会话 id 不是被请求的那个，说明文档被别的东西写坏了：绝不能拿它冒充本会话的树。
  it('answers unreadable for a document belonging to another session', async () => {
    const where = dir();
    writeRaw(where, JSON.stringify(doc({ session: 'other' })));
    const read = await readAgentTreeDoc(SESSION, where);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('expected unreadable');
    expect(read.error).toBe('document belongs to session other');
  });

  it('answers unreadable for a document the parser refuses', async () => {
    const where = dir();
    writeRaw(where, JSON.stringify(doc({ version: 99 })));
    const read = await readAgentTreeDoc(SESSION, where);
    expect(read.state).toBe('unreadable');
    if (read.state !== 'unreadable') throw new Error('expected unreadable');
    expect(read.error).toContain('unsupported version');
  });
});

describe('updateAgentTree', () => {
  it('writes the document a mutation returns, and reads it back', async () => {
    const where = dir();
    const update = await updateAgentTree(SESSION, () => ({ doc: doc({ revision: 7 }) }), where);
    expect(update).toEqual({ ok: true, doc: doc({ revision: 7 }) });
    const stored = JSON.parse(readFileSync(join(where, `${SESSION}.json`), 'utf8')) as AgentTreeDoc;
    expect(stored.revision).toBe(7);
  });

  it('reports a skip without touching the file', async () => {
    const where = dir();
    await updateAgentTree(SESSION, () => ({ doc: doc() }), where);
    const before = readFileSync(join(where, `${SESSION}.json`), 'utf8');
    const update = await updateAgentTree(SESSION, () => ({ skip: true }), where);
    expect(update).toEqual({ ok: true, skipped: true });
    expect(readFileSync(join(where, `${SESSION}.json`), 'utf8')).toBe(before);
  });

  it('reports the error a mutation refuses with', async () => {
    const where = dir();
    const update = await updateAgentTree(SESSION, () => ({ error: '不行' }), where);
    expect(update).toEqual({ ok: false, error: '不行' });
  });

  // 每会话一把锁：两次并发写都要基于前一次的结果，否则第二次会把第一次的 revision 覆盖回去。
  it('serialises concurrent writes so neither clobbers the other', async () => {
    const where = dir();
    const bump = (): Promise<unknown> =>
      updateAgentTree(
        SESSION,
        (state) => ({ doc: doc({ revision: state.state === 'ok' ? state.doc.revision + 1 : 1 }) }),
        where
      );
    await Promise.all([bump(), bump(), bump()]);
    const read = await readAgentTreeDoc(SESSION, where);
    if (read.state !== 'ok') throw new Error('expected ok');
    expect(read.doc.revision).toBe(3);
  });
});
