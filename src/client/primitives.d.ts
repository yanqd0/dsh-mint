/**
 * The shell provides this module from its frozen platform table.
 *
 * It is deliberately **not** a dependency: installing it would ship a second copy
 * of components the page already has (and a second React identity). What the
 * bundle requires is declared here, next to the only import that needs it; the
 * build marks the specifier `external`, so nothing resolves it at build time.
 *
 * Keep this list to what `src/client` actually imports — anything outside the
 * platform table would need a `dsh.client.external` declaration instead.
 */
declare module '@deepseek-ai/dsh-client-ui-primitives' {
  import type { ComponentType } from 'react';

  /** Props every icon component accepts. */
  export interface IconProps {
    className?: string;
    size?: number;
  }

  /** Checklist glyph, used as the guide entry's artwork. */
  export const IconChecklistOutlineRegular: ComponentType<IconProps>;

  /** What the panel passes to the highlighted body block it renders. */
  export interface CodeBlockProps {
    /** The source text, rendered verbatim. */
    code: string;
    /** Grammar hint; `markdown` is what mint bodies are written in. */
    lang?: string | undefined;
    /** Show the language and copy header. Defaults to true. */
    showHeader?: boolean | undefined;
    /** Extra class merged onto the wrapper. */
    className?: string | undefined;
    /** Copy-button idle label; this package is cordis-free, so copy is a prop. */
    copyLabel: string;
    /** Copy-button label during the post-copy confirmation window. */
    copiedLabel: string;
  }

  /** One fenced block of source, syntax-highlighted and copyable. */
  export const CodeBlock: ComponentType<CodeBlockProps>;
}
