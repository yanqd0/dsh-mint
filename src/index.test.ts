import { describe, expect, it } from 'vitest';

import { apply, inject, name } from './index.js';
import type { DshContext } from './types.js';

describe('dsh-mint plugin', () => {
  it('exposes the plugin name', () => {
    expect(name).toBe('dsh-mint');
  });

  it('declares the services it consumes via inject', () => {
    expect(inject).toEqual(['tools', 'shell']);
  });

  it('registers an agent/session-start listener', () => {
    const events: string[] = [];
    const ctx: DshContext = {
      on: (event) => {
        events.push(event);
        return () => {};
      },
    };
    apply(ctx, { debug: false });
    expect(events).toContain('agent/session-start');
  });
});
