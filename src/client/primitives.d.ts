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

  /** Refresh glyph, used by the panel's toolbar. */
  export const IconRefreshOutlineRegular: ComponentType<IconProps>;
}
