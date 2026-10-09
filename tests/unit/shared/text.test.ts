import { describe, expect, it } from 'vitest';

import { hasControlCharacter, isControlChar } from '../../../src/shared/text.js';

// 控制字符是路由参数、项目名与 DAG 标签/引用校验的公共门禁：C0 与 DEL 必须全判 true。
// 逐字符遍历边界字符集，再用 hasControlCharacter 覆盖空串、整串扫描与制表符/DEL 收尾。
describe('control characters', () => {
  it('flags C0 and DEL, and nothing else', () => {
    for (const char of ['\u0000', '\u0007', '\n', '\u001f', '\u007f']) {
      expect(isControlChar(char)).toBe(true);
    }
    for (const char of ['a', 'Z', '0', ' ', '中', 'é', '\u0080']) {
      expect(isControlChar(char)).toBe(false);
    }
  });

  it('answers "carries any" for a whole value', () => {
    expect(hasControlCharacter('')).toBe(false);
    expect(hasControlCharacter('docs')).toBe(false);
    expect(hasControlCharacter('中文 label')).toBe(false);
    expect(hasControlCharacter('do\u0007cs')).toBe(true);
    expect(hasControlCharacter('with\tseparator')).toBe(true);
    expect(hasControlCharacter('trailing\u007f')).toBe(true);
  });
});
