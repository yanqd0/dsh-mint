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
  import type { ComponentType, ReactElement } from 'react';

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

  /** One segment of a {@link SegmentedControl}. */
  export interface SegmentedControlOption<Value extends string> {
    /** The value the owner receives when this segment is chosen. */
    value: Value;
    /** Localized segment text. */
    label: string;
    /** Whether the segment refuses selection. */
    disabled?: boolean;
    /** Localized hover text, typically why the segment is locked. */
    title?: string;
  }

  /** What the panel passes to the mode switch it renders. */
  export interface SegmentedControlProps<Value extends string> {
    /**
     * The owner's base DOM id: each tab is `<id>-<value>` and names
     * `<id>-<value>-panel` as the panel it controls, so one page may not reuse it.
     */
    id: string;
    /** The selected option's value; the control is fully controlled. */
    value: Value;
    /** The segments in display order; at least two. */
    options: readonly SegmentedControlOption<Value>[];
    /** Called with the value a click or a walk key asks for. */
    onChange: (next: Value) => void;
    /** Localized accessible name of the tablist. */
    label: string;
    /** Lock every segment. */
    disabled?: boolean;
    /** Extra class for layout placement. */
    className?: string | undefined;
  }

  /** Two-way mode switch over a base id the caller owns. */
  export function SegmentedControl<Value extends string>(
    props: SegmentedControlProps<Value>
  ): ReactElement;

  /** Localized chrome a rendered Markdown document carries. */
  export interface MarkdownLabels {
    /** Copy-button labels forwarded to every fence's code block. */
    code: { copyLabel: string; copiedLabel: string };
    /** The footnote section's heading. */
    footnotes: string;
  }

  /** What the panel passes to the document renderer it renders. */
  export interface MarkdownTextProps {
    /** The markdown source, rendered as a GFM document. */
    text: string;
    /** Localized fence and footnote chrome. */
    labels: MarkdownLabels;
    /** `compact` uses secondary sizing; the default `body` is document typography. */
    variant?: 'body' | 'compact' | undefined;
  }

  /** Untrusted-markdown document renderer (GFM and KaTeX; raw HTML off). */
  export const MarkdownText: ComponentType<MarkdownTextProps>;
}
