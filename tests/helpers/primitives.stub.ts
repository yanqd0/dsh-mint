/**
 * Test-only stand-in for the shell-provided primitives module.
 *
 * `@deepseek-ai/dsh-client-ui-primitives` is resolved by the *page*, not by this
 * package (installing it would ship a second copy of components the shell already
 * has), so `src/client/primitives.d.ts` declares it for type checking and
 * `vitest.config.ts` aliases the specifier here so the client modules can be
 * imported in Node. Nothing in this file ships: the client bundle marks the
 * specifier `external`.
 */
import type { ComponentType } from 'react';

/** Props every icon component accepts, mirroring the declaration file. */
export interface IconProps {
  className?: string;
  size?: number;
}

/** Checklist glyph, used as the guide entry's artwork. */
export const IconChecklistOutlineRegular: ComponentType<IconProps> = () => null;

/** What the panel passes to the highlighted body block it renders. */
export interface CodeBlockProps {
  code: string;
  lang?: string | undefined;
  showHeader?: boolean | undefined;
  className?: string | undefined;
  copyLabel: string;
  copiedLabel: string;
}

/** Highlighted source block; the stub only has to be importable in Node. */
export const CodeBlock: ComponentType<CodeBlockProps> = () => null;
