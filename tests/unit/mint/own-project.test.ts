import { describe, expect, it, beforeEach } from 'vitest';

import {
  MAX_OWN_PROJECTS,
  isOwnProject,
  noteOwnProject,
  ownProjectOf,
  resetOwnProjectCache,
} from '../../../src/mint/own-project.js';

/**
 * The own-project memo (#114): which project a session's directory resolves to.
 *
 * The memo is what turns "`-p` was passed" into "`-p` names *this* project" for
 * the cross-project gate and the `mint` tool, so the two failure directions are
 * what these cases pin: a remembered name must match exactly, and an unknown
 * directory must stay unknown (callers fail closed on it).
 */
beforeEach(() => {
  resetOwnProjectCache();
});

describe('own-project memo', () => {
  it('remembers the name under the cwd it was learned for', () => {
    noteOwnProject('/proj', undefined, 'dsh-mint');

    expect(ownProjectOf('/proj', undefined)).toBe('dsh-mint');
    expect(ownProjectOf('/other', undefined)).toBeUndefined();
  });

  it('keeps entries for different mintEntry values apart', () => {
    noteOwnProject('/proj', undefined, 'dependency-project');
    noteOwnProject('/proj', '/local/mint', 'local-project');

    expect(ownProjectOf('/proj', undefined)).toBe('dependency-project');
    expect(ownProjectOf('/proj', '/local/mint')).toBe('local-project');
  });

  it('replaces the name when the same directory is learned again', () => {
    noteOwnProject('/proj', undefined, 'old');
    noteOwnProject('/proj', undefined, 'new');

    expect(ownProjectOf('/proj', undefined)).toBe('new');
  });

  it('matches only the remembered name, and never an unknown directory', () => {
    noteOwnProject('/proj', undefined, 'dsh-mint');

    expect(isOwnProject('/proj', undefined, 'dsh-mint')).toBe(true);
    expect(isOwnProject('/proj', undefined, 'chromosome')).toBe(false);
    // unknown cwd: fail closed, so the gate keeps asking
    expect(isOwnProject('/other', undefined, 'dsh-mint')).toBe(false);
  });

  it('stays bounded, dropping the oldest directory first', () => {
    for (let index = 0; index <= MAX_OWN_PROJECTS; index += 1) {
      noteOwnProject(`/proj-${index}`, undefined, `project-${index}`);
    }

    expect(ownProjectOf('/proj-0', undefined)).toBeUndefined();
    expect(ownProjectOf(`/proj-${MAX_OWN_PROJECTS}`, undefined)).toBe(
      `project-${MAX_OWN_PROJECTS}`
    );
  });

  it('forgets everything on reset', () => {
    noteOwnProject('/proj', undefined, 'dsh-mint');

    resetOwnProjectCache();

    expect(ownProjectOf('/proj', undefined)).toBeUndefined();
  });
});
