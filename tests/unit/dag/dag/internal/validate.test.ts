import { describe, expect, it } from 'vitest';

import { checkNodeId } from '../../../../../src/dag/dag.js';

describe('checkNodeId', () => {
  it('accepts the ids that stay one path segment and one git ref', () => {
    for (const id of ['a', 'a1', 'w1d-2', 'a.b', 'a_b', 'A-9', 'x'.repeat(64)]) {
      expect(checkNodeId(id), id).toBe(id);
    }
  });

  // 上库与路径双禁区：`#数字` 进不了 merge subject 与分支名，`/`、`.` 开头的 id 逃不出会话目录。
  // 把可能越界或进上库的样本逐个喂给 `checkNodeId`，断言全部拒绝且文案含「只允许」。
  it('refuses anything that could reach committed content or escape the directory', () => {
    // `#<数字>` 会被拼进 merge subject 与分支名（上库内容不得出现 mint ID）；空白、
    // `/`、`\` 是 git ref 的禁区；`.`/`..`/`.hidden` 会让 worktree 的路径段逃出会话
    // 目录。控制字符由这一条字符集一并挡住，不再单独判。
    for (const id of ['a1#1', '#1', '总1', 'a b', 'a/b', 'a\\b', '.', '..', '.hidden', '-x', 'a\u0000']) {
      const checked = checkNodeId(id);
      if (typeof checked === 'string') throw new Error(`expected a refusal for ${JSON.stringify(id)}`);
      expect(checked.error, JSON.stringify(id)).toContain('只允许');
    }
  });

  // 判据顺序契约：空串/非字符串与超长必须排在字符集之前，各自给出专属文案。
  // 分别传 `''`、数字 7 与 65 个字符，断言前两条文案与长度分支的「过长」。
  it('keeps the empty and length rules ahead of the charset', () => {
    expect(checkNodeId('')).toEqual({ error: '节点 id 必须是非空字符串' });
    expect(checkNodeId(7)).toEqual({ error: '节点 id 必须是非空字符串' });
    const tooLong = checkNodeId('x'.repeat(65));
    if (typeof tooLong === 'string') throw new Error('expected a refusal');
    expect(tooLong.error).toContain('过长');
  });
});
