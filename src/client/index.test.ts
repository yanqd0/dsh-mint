import { describe, expect, it } from 'vitest';

import { EN, NS, ZH, createTranslator } from './copy.js';
import {
  DAG_GUIDE_ORDER,
  DAG_TAB_ID,
  DAG_TAB_KIND,
  GUIDE_ORDER,
  TAB_ID,
  TAB_KIND,
  apply,
  dagTabDefinition,
  inject,
  mintTabDefinition,
} from './index.js';
import type { ClientContextLike, SlotRegistrationLike, TabDefinitionLike } from './types.js';

/** One slot registration the double captured. */
interface Registration {
  options: SlotRegistrationLike;
  component: unknown;
}

/** A client context double recording every registration `apply` makes. */
function clientDouble(): {
  ctx: ClientContextLike;
  locales: Array<{ ns: string; locale: string; dict: Record<string, string> }>;
  types: TabDefinitionLike[];
  injected: string[];
  registrations: Registration[];
  opened: string[];
} {
  const locales: Array<{ ns: string; locale: string; dict: Record<string, string> }> = [];
  const types: TabDefinitionLike[] = [];
  const injected: string[] = [];
  const registrations: Registration[] = [];
  const opened: string[] = [];
  const ctx: ClientContextLike = {
    locale: {
      register: (ns, locale, dict) => {
        locales.push({ ns, locale, dict });
        return () => {};
      },
      bind: () => (key: string) => key,
    },
    slots: {
      inject: (name, register) => {
        injected.push(name);
        register();
      },
      register: (options, component) => {
        registrations.push({ options, component });
        return undefined;
      },
    },
    sidebarRightTabs: {
      register: (definition) => {
        types.push(definition);
        return () => {};
      },
    },
    // The runtime seat, as the page provides it. `apply` must not start probing
    // in a Node test run, so the assertion is that this stays untouched.
    sidebarRight: {
      openTab: (kind) => {
        opened.push(kind);
      },
      mounted: { getSnapshot: () => 'session-1' },
      openTabs: { getSnapshot: () => [] },
    },
    effect: (callback) => {
      callback();
      return () => {};
    },
  };
  return { ctx, locales, types, injected, registrations, opened };
}

/** A translate seat that marks what it rendered, so thunks are observable. */
const marking = createTranslator((key) => `t:${key}`);

describe('mint client plugin', () => {
  it('waits for exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs', 'sidebarRight']);
  });

  it('registers a complete dictionary for both built-in locales', () => {
    const { ctx, locales } = clientDouble();
    apply(ctx);
    expect(locales.map((entry) => `${entry.ns}/${entry.locale}`)).toEqual(['mint/zh', 'mint/en']);
    expect(locales.map((entry) => entry.dict)).toEqual([{ ...ZH }, { ...EN }]);
  });

  it('declares two builtin page types, the mint panel and the plan DAG', () => {
    const { ctx, types } = clientDouble();
    apply(ctx);
    expect(types).toHaveLength(2);
    const [mint, dag] = types;
    expect(mint?.id).toBe(TAB_ID);
    expect(mint?.kind).toBe(TAB_KIND);
    expect(dag?.id).toBe(DAG_TAB_ID);
    expect(dag?.kind).toBe(DAG_TAB_KIND);
    // A page type claims no resource address; the guide is how it is opened.
    expect(dag?.priority).toBe('builtin');
    expect(dag?.patterns).toBeUndefined();
    expect(dag?.guide?.map((entry) => [entry.id, entry.order])).toEqual([
      [DAG_TAB_KIND, DAG_GUIDE_ORDER],
    ]);
    // The primary tab is unchanged, and its guide entry sits before the DAG's.
    expect(mint?.priority).toBe('builtin');
    expect(mint?.guide?.map((entry) => [entry.id, entry.order])).toEqual([['mint', GUIDE_ORDER]]);
  });

  it('reads every guide string through the copy seat, on each projection', () => {
    const definition = mintTabDefinition(marking);
    expect(definition.title()).toBe('t:type.label');
    expect(definition.guide?.[0]?.title()).toBe('t:guide.title');
    expect(definition.guide?.[0]?.description?.()).toBe('t:guide.description');

    const dag = dagTabDefinition(marking);
    expect(dag.title()).toBe('t:dag.type.label');
    expect(dag.guide?.[0]?.title()).toBe('t:dag.guide.title');
    expect(dag.guide?.[0]?.description?.()).toBe('t:dag.guide.description');
  });

  it('registers one body per type in the right sidebar seat', () => {
    const { ctx, injected, registrations } = clientDouble();
    apply(ctx);
    expect(injected).toEqual(['sidebar.right.pane.tab', 'sidebar.right.pane.tab']);
    expect(registrations.map((entry) => entry.options.key)).toEqual([TAB_ID, DAG_TAB_ID]);
    for (const registration of registrations) {
      expect(registration.options.name).toBe('sidebar.right.pane.tab');
      expect(registration.options.locale).toBe(NS);
      expect(registration.component).toBeTypeOf('function');
    }
    // Two different bodies, not the same component registered twice.
    expect(registrations[0]?.component).not.toBe(registrations[1]?.component);
  });

  it('injects a session-scoped transport and the copy seat into both bodies', () => {
    const { ctx, registrations } = clientDouble();
    apply(ctx);
    for (const registration of registrations) {
      const injectedProps = registration.options.inject?.('session-1');
      expect(Object.keys(injectedProps ?? {}).sort()).toEqual(['api', 'copy']);
      const api = (injectedProps as { api: Record<string, unknown> }).api;
      expect(Object.keys(api).sort()).toEqual([
        'dag',
        'issue',
        'issues',
        'meta',
        'milestone',
        'milestones',
        'plan',
        'plans',
      ]);
    }
  });

  // The prober owns a real `setInterval`, and the unit tests run in Node: the
  // `document` guard in `apply` is the only thing keeping that timer out of it.
  it('cannot start the auto-open prober outside a browser', () => {
    expect(typeof document).toBe('undefined');
    const { ctx, opened } = clientDouble();
    apply(ctx);
    expect(opened).toEqual([]);
  });

  it('registers without an effect seam', () => {
    const { ctx, types } = clientDouble();
    const lean: ClientContextLike = {
      locale: ctx.locale,
      slots: ctx.slots,
      sidebarRightTabs: ctx.sidebarRightTabs,
    };
    expect(() => {
      apply(lean);
    }).not.toThrow();
    expect(types).toHaveLength(2);
  });

  it('registers without the sidebar runtime service', () => {
    const { ctx, types } = clientDouble();
    const withoutRight: ClientContextLike = {
      locale: ctx.locale,
      slots: ctx.slots,
      sidebarRightTabs: ctx.sidebarRightTabs,
      effect: (callback) => {
        callback();
        return () => {};
      },
    };
    expect(() => {
      apply(withoutRight);
    }).not.toThrow();
    expect(types).toHaveLength(2);
  });
});
