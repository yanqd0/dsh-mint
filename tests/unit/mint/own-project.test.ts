import { describe, expect, it, beforeEach } from 'vitest';

import {
  MAX_OWN_PROJECTS,
  isOwnProject,
  noteOwnProject,
  ownProjectOf,
  resetOwnProjectCache,
} from '../../../src/mint/own-project.js';

/**
 * The own-project memo: which project a session's directory resolves to.
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

  // 门禁要的是「记得的正是这个项目」：认不出的目录必须答 false（fail closed），继续拦。
  // 三个方向：同名 true、不同名 false、未记录的 cwd false。
  it('matches only the remembered name, and never an unknown directory', () => {
    noteOwnProject('/proj', undefined, 'dsh-mint');

    expect(isOwnProject('/proj', undefined, 'dsh-mint')).toBe(true);
    expect(isOwnProject('/proj', undefined, 'chromosome')).toBe(false);
    // unknown cwd: fail closed, so the gate keeps asking
    expect(isOwnProject('/other', undefined, 'dsh-mint')).toBe(false);
  });

  // 备忘录有上限：越界时必须先淘汰最旧的目录，不能无界增长。
  // 灌入 MAX+1 条后断言第 0 条已不在、最后一条仍在。
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
