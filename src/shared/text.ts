/**
 * 多处共用的文本谓词：跨项目分类器用它校验项目名、路由层用它校验过滤值、审批文案用它
 * 清洗待渲染的动作。
 *
 * 合到一份实现，是防止这三处判断各自漂移。
 */

/** C0（0x00–0x1f）与 DEL（0x7f）都算控制字符。 */
export function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isControlChar(char)) return true;
  }
  return false;
}
