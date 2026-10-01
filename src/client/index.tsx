/**
 * Browser half of dsh-mint — the entry of the prebuilt client bundle.
 *
 * `scripts/build-client.mjs` wraps this module into the factory the DSH client
 * module system loads:
 *
 *     window.__ModuleLoader__.load({ id: '@yanqd0/dsh-mint', factory: (require) => { … } })
 *
 * Everything outside the shell's frozen module table must stay `external`, so
 * this file may import React and `@deepseek-ai/dsh-client-ui-primitives` but
 * nothing else: `dsh.client.inject` only orders *other plugin bundles*, while an
 * undeclared module request fails at materialization.
 *
 * What this plugin contributes to the page: a `mint` tab type in the right
 * sidebar, reachable from the tab strip's add control exactly like the shipped
 * file tree and terminal, plus the body that renders it.
 */
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

import { MintBody } from './MintBody.js';
import { createApi } from './api.js';
import { NS, ZH, createTranslator } from './copy.js';
import type { CopyTranslate } from './copy.js';
import type { ClientContextLike, MintApiLike, TabDefinitionLike } from './types.js';

/**
 * Client services this plugin waits for before `apply` runs.
 *
 * Declaring them is what keeps the bundle safe in every composition: where one
 * never appears (a host without the right sidebar), the plugin stays pending
 * instead of throwing.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs'];

/** This implementation's identity in the tab system, and the body seat's key. */
export const TAB_ID = '@yanqd0/dsh-mint';

/** The tab type's discriminator: what `openTab('mint')` names. */
export const TAB_KIND = 'mint';

/** The guide entry's position: after the file tree (10) and the terminal (20). */
export const GUIDE_ORDER = 30;

/**
 * Own a registration for the plugin's lifetime.
 *
 * `effect` is always present on a real client context; the fallback keeps a lean
 * context (and the unit-test double) working, at the cost of no disposal.
 */
function own(ctx: ClientContextLike, callback: () => unknown, label: string): void {
  if (ctx.effect !== undefined) {
    ctx.effect(callback, label);
    return;
  }
  callback();
}

/**
 * The tab type's static declaration.
 *
 * @param t - the copy seat, read again on every projection so a language change
 *   needs no re-registration.
 */
export function mintTabDefinition(t: CopyTranslate): TabDefinitionLike {
  return {
    id: TAB_ID,
    kind: TAB_KIND,
    priority: 'builtin',
    title: () => t('type.label'),
    guide: [
      {
        id: 'mint',
        order: GUIDE_ORDER,
        title: () => t('guide.title'),
        description: () => t('guide.description'),
        icon: IconChecklistOutlineRegular,
      },
    ],
  };
}

/** Client plugin body. */
export function apply(ctx: ClientContextLike): void {
  const t = createTranslator(ctx.locale.bind(NS));

  // `en` carries the Chinese text until 0.3.0: an English-locale page must show
  // words, and a missing dictionary shows raw keys instead.
  own(ctx, () => ctx.locale.register(NS, 'zh', { ...ZH }), 'dsh-mint: zh copy');
  own(ctx, () => ctx.locale.register(NS, 'en', { ...ZH }), 'dsh-mint: en copy (placeholder)');

  own(ctx, () => ctx.sidebarRightTabs.register(mintTabDefinition(t)), 'dsh-mint: tab type');

  own(
    ctx,
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            // `locale: NS` gives the framework's `t`; the panel uses this injected
            // seat instead, because only its keys are checked against the copy and
            // it still answers Chinese on a locale that carries no dictionary.
            inject: (sessionId): { api: MintApiLike; copy: CopyTranslate } => ({
              api: createApi({ sessionId }),
              copy: t,
            }),
          },
          MintBody
        )
      ),
    'dsh-mint: tab body'
  );
}
