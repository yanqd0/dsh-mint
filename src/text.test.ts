import { describe, expect, it } from 'vitest';

import { hasControlCharacter, isControlChar } from './text.js';

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
