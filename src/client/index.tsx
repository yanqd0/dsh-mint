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
 * What this plugin contributes to the page: two parallel tab types in the right
 * sidebar — the `mint` panel and the plan DAG — each reachable from the tab
 * strip's add control exactly like the shipped file tree and terminal, plus the
 * bodies that render them and the DAG tab's auto-open prober.
 */
import { IconChecklistOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives';

import { DagBody } from './DagBody.js';
import { MintBody } from './MintBody.js';
import { createApi } from './api.js';
import { EN, NS, ZH, createTranslator } from './copy.js';
import type { CopyTranslate } from './copy.js';
import { DAG_TAB_KIND, startDagAutoOpen } from './dag-open.js';
import type { ClientContextLike, MintApiLike, TabDefinitionLike } from './types.js';

/**
 * Client services this plugin waits for before `apply` runs.
 *
 * Declaring them is what keeps the bundle safe in every composition: where one
 * never appears (a host without the right sidebar), the plugin stays pending
 * instead of throwing.
 */
export const inject = ['slots', 'locale', 'sidebarRightTabs', 'sidebarRight'];

/** This implementation's identity in the tab system, and the body seat's key. */
export const TAB_ID = '@yanqd0/dsh-mint';

/** The tab type's discriminator: what `openTab('mint')` names. */
export const TAB_KIND = 'mint';

/** The guide entry's position: after the file tree (10) and the terminal (20). */
export const GUIDE_ORDER = 30;

/** The DAG tab type's identity, distinct from the tab kind it opens by. */
export const DAG_TAB_ID = '@yanqd0/dsh-mint:plan-dag';

/**
 * The DAG tab's discriminator, re-exported from the prober.
 *
 * One definition, two consumers: `apply` registers the type, `dag-open.ts`
 * opens it. Two literals would be a silent no-op rather than an error.
 */
export { DAG_TAB_KIND };

/** The DAG guide entry's position: after the mint entry (30). */
export const DAG_GUIDE_ORDER = 40;

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

/**
 * The DAG tab type's static declaration.
 *
 * A second *page* type, not a mode of the first: it has no `patterns` either, so
 * it is opened by kind (which is what makes it unique per session, and therefore
 * what lets the auto-open prober call `openTab` without stacking tabs), and its
 * guide entry asks for an order after the mint panel's.
 *
 * @param t - the copy seat, read again on every projection.
 */
export function dagTabDefinition(t: CopyTranslate): TabDefinitionLike {
  return {
    id: DAG_TAB_ID,
    kind: DAG_TAB_KIND,
    priority: 'builtin',
    title: () => t('dag.type.label'),
    guide: [
      {
        id: DAG_TAB_KIND,
        order: DAG_GUIDE_ORDER,
        title: () => t('dag.guide.title'),
        description: () => t('dag.guide.description'),
      },
    ],
  };
}

/**
 * The DAG body's injected props.
 *
 * Split out so `apply` reads as the list of registrations it makes, and so the
 * two bodies' identical shape is visible in one place.
 */
function dagInject(t: CopyTranslate): (sessionId: string) => Record<string, unknown> {
  return (sessionId): { api: MintApiLike; copy: CopyTranslate } => ({
    api: createApi({ sessionId }),
    copy: t,
  });
}

/** Client plugin body. */
export function apply(ctx: ClientContextLike): void {
  const t = createTranslator(ctx.locale.bind(NS));

  // Both built-in locales carry a real dictionary: the single-locale form is the
  // only one open to an out-of-tree namespace (`LocaleServiceLike.register`), and
  // `EN` is exhaustive over `ZH`'s keys at compile time, so neither locale can
  // register an incomplete dictionary.
  own(ctx, () => ctx.locale.register(NS, 'zh', { ...ZH }), 'dsh-mint: zh copy');
  own(ctx, () => ctx.locale.register(NS, 'en', { ...EN }), 'dsh-mint: en copy');

  own(ctx, () => ctx.sidebarRightTabs.register(mintTabDefinition(t)), 'dsh-mint: tab type');
  own(ctx, () => ctx.sidebarRightTabs.register(dagTabDefinition(t)), 'dsh-mint: dag tab type');

  own(
    ctx,
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          {
            name: 'sidebar.right.pane.tab',
            key: TAB_ID,
            locale: NS,
            // `locale: NS` gives the framework's `t` seat to the body; the panel
            // uses this injected seat instead, whose keys are the checked
            // `CopyKey` union rather than the framework's open string domain.
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

  own(
    ctx,
    () =>
      ctx.slots.inject('sidebar.right.pane.tab', () =>
        ctx.slots.register(
          { name: 'sidebar.right.pane.tab', key: DAG_TAB_ID, locale: NS, inject: dagInject(t) },
          DagBody
        )
      ),
    'dsh-mint: dag tab body'
  );

  // Auto-open needs a real page to watch: the prober owns a `setInterval`, and a
  // Node test run (or any host without the sidebar service) must not leak one.
  const sidebarRight = ctx.sidebarRight;
  if (sidebarRight !== undefined && typeof document !== 'undefined') {
    own(
      ctx,
      () =>
        startDagAutoOpen(
          { sidebarRight, apiFor: (sessionId) => createApi({ sessionId }) },
          { visible: () => document.visibilityState !== 'hidden' }
        ),
      'dsh-mint: dag auto-open'
    );
  }
}
