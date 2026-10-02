/**
 * One home for the text predicates more than one layer needs (#103).
 *
 * The cross-project classifier validates a project name with them, the route
 * layer validates a filter value with them, and the approval prompt strips them
 * out of the action it renders; keeping one implementation is what stops the
 * three answers from drifting apart.
 */

/** True for a single C0 (0x00–0x1f) or DEL (0x7f) control character. */
export function isControlChar(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code < 0x20 || code === 0x7f;
}

/** True when the value carries any C0/DEL control character. */
export function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    if (isControlChar(char)) return true;
  }
  return false;
}
