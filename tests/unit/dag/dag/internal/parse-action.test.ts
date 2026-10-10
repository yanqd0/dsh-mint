import { describe, expect, it } from 'vitest';

import { DAG_LABEL_MAX, DAG_NOTE_MAX, parseDagAction } from '../../../../../src/dag/dag.js';
import { addNode, errorOf } from './helpers.js';

describe('parseDagAction', () => {
  // 入参门禁：工具参数来自模型，非对象或没有已知 action 时一律拒绝并点名 action。
  // 依次喂 `undefined`、字符串、空对象与未知 action，断言错误文案分别含「对象」与「action」。
  it('refuses arguments that are not an object or carry no known action', () => {
    expect(errorOf(parseDagAction(undefined))).toContain('对象');
    expect(errorOf(parseDagAction('init'))).toContain('对象');
    expect(errorOf(parseDagAction({}))).toContain('action');
    expect(errorOf(parseDagAction({ action: 'draw' }))).toContain('action');
  });

  it('reads get as a pure read', () => {
    expect(parseDagAction({ action: 'get' })).toEqual({ action: 'get' });
  });

  it('allows init without a title and bounds the one it takes', () => {
    expect(parseDagAction({ action: 'init' })).toEqual({ action: 'init', title: '' });
    expect(parseDagAction({ action: 'init', title: '演示计划' })).toEqual({
      action: 'init',
      title: '演示计划',
    });
    expect(errorOf(parseDagAction({ action: 'init', title: 7 }))).toContain('title');
    expect(errorOf(parseDagAction({ action: 'init', title: 'x'.repeat(201) }))).toContain('title');
  });

  it('requires a non-empty node list for add', () => {
    expect(errorOf(parseDagAction({ action: 'add' }))).toContain('nodes');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [] }))).toContain('nodes');
    expect(errorOf(parseDagAction({ action: 'add', nodes: 'a' }))).toContain('nodes');
  });

  // 字段契约总表（add）：每个节点字段的拒绝形状，以及去重 depends_on、缺省 phase 两条规范化。
  // 先给合法输入断言规范化结果，再逐字段喂空值/超长/控制字符/类型错/重复 id 断言报错字段。
  it('checks every node field add carries', () => {
    const good = parseDagAction({
      action: 'add',
      nodes: [
        addNode({ id: 'a' }),
        addNode({ id: 'b', depends_on: ['a', 'a'], issue: 31, phase: 'research' }),
      ],
      edges: [['a', 'b']],
    });
    expect(good).toEqual({
      action: 'add',
      nodes: [
        { id: 'a', label: '总①', title: '第一轮', phase: 'exec', depends_on: [] },
        { id: 'b', label: '总①', title: '第一轮', phase: 'research', depends_on: ['a'], issue: 31 },
      ],
      edges: [['a', 'b']],
    });

    expect(errorOf(parseDagAction({ action: 'add', nodes: ['x'] }))).toContain('对象');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ id: '' })] }))).toContain(
      'id'
    );
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ id: 'x'.repeat(65) })] }))
    ).toContain('id');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ id: 'a\u0000' })] }))
    ).toContain('只允许');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ label: '' })] }))).toContain(
      'label'
    );
    expect(
      errorOf(
        parseDagAction({
          action: 'add',
          nodes: [addNode({ label: 'x'.repeat(DAG_LABEL_MAX + 1) })],
        })
      )
    ).toContain('label');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ label: 'a\u0007' })] }))
    ).toContain('控制字符');
    expect(parseDagAction({ action: 'add', nodes: [addNode({ label: '123456' })] })).toMatchObject({
      action: 'add',
    });
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ title: '' })] }))).toContain(
      'title'
    );
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ title: 'x'.repeat(201) })] }))
    ).toContain('title');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ phase: 'plan' as never })] }))
    ).toContain('phase');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ depends_on: 'a' as never })] }))
    ).toContain('depends_on');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode({ depends_on: [''] })] }))
    ).toContain('depends_on');
    expect(errorOf(parseDagAction({ action: 'add', nodes: [addNode({ issue: 1.5 })] }))).toContain(
      'issue'
    );
    expect(
      errorOf(
        parseDagAction({ action: 'add', nodes: [addNode({ id: 'a' }), addNode({ id: 'a' })] })
      )
    ).toContain('重复');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode()], edges: 'x' as never }))
    ).toContain('edges');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode()], edges: [['a'] as never] }))
    ).toContain('edges');
    expect(
      errorOf(parseDagAction({ action: 'add', nodes: [addNode()], edges: [[1, 2] as never] }))
    ).toContain('edges');
  });

  // 字段契约总表（set）：status/verdict 的搭配、note 上限、tokens 非负整数、agent 长度都要挡住。
  // 先断言两条合法 set 的原样解析，再逐字段喂非法样本，断言错误文案点名对应字段。
  it('checks every field set carries', () => {
    expect(parseDagAction({ action: 'set', id: 'a', status: 'running' })).toEqual({
      action: 'set',
      id: 'a',
      status: 'running',
    });
    expect(
      parseDagAction({
        action: 'set',
        id: 'a',
        status: 'done',
        verdict: 'pass',
        note: 'ok',
        tokens: 12,
        agent: 's-2',
      })
    ).toEqual({
      action: 'set',
      id: 'a',
      status: 'done',
      verdict: 'pass',
      note: 'ok',
      tokens: 12,
      agent: 's-2',
    });

    expect(errorOf(parseDagAction({ action: 'set', status: 'running' }))).toContain('id');
    expect(errorOf(parseDagAction({ action: 'set', id: 'a', status: 'shipped' }))).toContain(
      'status'
    );
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'running', verdict: 'pass' }))
    ).toContain('verdict');
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', verdict: 'maybe' }))
    ).toContain('verdict');
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', note: 7 as never }))
    ).toContain('note');
    expect(
      errorOf(
        parseDagAction({
          action: 'set',
          id: 'a',
          status: 'done',
          note: 'x'.repeat(DAG_NOTE_MAX + 1),
        })
      )
    ).toContain('note');
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', tokens: -1 }))
    ).toContain('tokens');
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', tokens: 1.5 }))
    ).toContain('tokens');
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', agent: '' }))
    ).toContain('agent');
    expect(
      errorOf(parseDagAction({ action: 'set', id: 'a', status: 'done', agent: 'x'.repeat(129) }))
    ).toContain('agent');
  });
});
