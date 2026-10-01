import { describe, expect, it } from 'vitest';

import { NS, ZH, createTranslator } from './copy.js';
import { GUIDE_ORDER, TAB_ID, TAB_KIND, apply, inject, mintTabDefinition } from './index.js';
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
} {
  const locales: Array<{ ns: string; locale: string; dict: Record<string, string> }> = [];
  const types: TabDefinitionLike[] = [];
  const injected: string[] = [];
  const registrations: Registration[] = [];
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
    effect: (callback) => {
      callback();
      return () => {};
    },
  };
  return { ctx, locales, types, injected, registrations };
}

/** A translate seat that marks what it rendered, so thunks are observable. */
const marking = createTranslator((key) => `t:${key}`);

describe('mint client plugin', () => {
  it('waits for exactly the services it consumes', () => {
    expect(inject).toEqual(['slots', 'locale', 'sidebarRightTabs']);
  });

  it('registers the dictionary for both built-in locales', () => {
    const { ctx, locales } = clientDouble();
    apply(ctx);
    expect(locales.map((entry) => `${entry.ns}/${entry.locale}`)).toEqual(['mint/zh', 'mint/en']);
    for (const entry of locales) {
      expect(entry.dict).toEqual({ ...ZH });
    }
  });

  it('declares one builtin page type whose guide entry sits after terminal', () => {
    const { ctx, types } = clientDouble();
    apply(ctx);
    expect(types).toHaveLength(1);
    const definition = types[0];
    expect(definition?.id).toBe(TAB_ID);
    expect(definition?.kind).toBe(TAB_KIND);
    expect(definition?.priority).toBe('builtin');
    // A page type claims no resource address; the guide is how it is opened.
    expect(definition?.patterns).toBeUndefined();
    expect(definition?.guide?.map((entry) => [entry.id, entry.order])).toEqual([['mint', GUIDE_ORDER]]);
  });

  it('reads every guide string through the copy seat, on each projection', () => {
    const definition = mintTabDefinition(marking);
    expect(definition.title()).toBe('t:type.label');
    expect(definition.guide?.[0]?.title()).toBe('t:guide.title');
    expect(definition.guide?.[0]?.description?.()).toBe('t:guide.description');
  });

  it('registers its body under the type id in the right sidebar seat', () => {
    const { ctx, injected, registrations } = clientDouble();
    apply(ctx);
    expect(injected).toEqual(['sidebar.right.pane.tab']);
    const registration = registrations[0];
    expect(registration?.options.name).toBe('sidebar.right.pane.tab');
    expect(registration?.options.key).toBe(TAB_ID);
    expect(registration?.options.locale).toBe(NS);
    expect(registration?.component).toBeTypeOf('function');
  });

  it('injects a session-scoped transport and the copy seat into the body', () => {
    const { ctx, registrations } = clientDouble();
    apply(ctx);
    const injectedProps = registrations[0]?.options.inject?.('session-1');
    expect(Object.keys(injectedProps ?? {}).sort()).toEqual(['api', 'copy']);
    const api = (injectedProps as { api: Record<string, unknown> }).api;
    expect(Object.keys(api).sort()).toEqual([
      'issueBody',
      'issues',
      'milestone',
      'milestones',
      'plan',
      'plans',
    ]);
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
    expect(types).toHaveLength(1);
  });
});
