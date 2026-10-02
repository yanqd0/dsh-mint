import { describe, expect, it } from 'vitest';

import type {
  ContainerChild,
  ContainerDetail,
  IssueDetail,
  IssueItem,
  MintListPayload,
  MintMetaPayload,
} from '../records.js';
import {
  activeContainer,
  clampPage,
  containerChildLine,
  containerMeta,
  containerRow,
  describeLink,
  detailContainer,
  detailPlacement,
  issueHeadline,
  issueMeta,
  issuePlacement,
  labelSummary,
  linkLabelKey,
  milestoneVersionOf,
  priorityLabel,
  statusTone,
  toLoadState,
} from './model.js';

const ISSUE: IssueItem = {
  id: 12,
  title: '实现 issue 视图',
  kind: 'requirement',
  status: 'dev',
  priority: 1,
  labels: ['agent', 'client', 'dev-clean', 'extra'],
  plan_id: 3,
  links: [],
  created_at: '2026-08-29 12:55:45',
  updated_at: '2026-10-01 15:10:00',
};

describe('load state', () => {
  it('turns a successful payload into ready state', () => {
    const payload: MintListPayload<IssueItem> = {
      ok: true,
      items: [ISSUE],
      page: 1,
      page_size: 20,
      pages: 1,
      total: 1,
    };
    expect(toLoadState(payload)).toEqual({ status: 'ready', value: payload });
  });

  it('turns a refusal into a failure state, keeping stderr when mint wrote one', () => {
    expect(toLoadState({ ok: false, error: 'session-not-live' })).toEqual({
      status: 'failed',
      message: 'session-not-live',
    });
    expect(toLoadState({ ok: false, error: 'boom', stderr: 'mint: hint: boom' })).toEqual({
      status: 'failed',
      message: 'boom',
      stderr: 'mint: hint: boom',
    });
  });
});

describe('status and priority', () => {
  it('maps mint states onto theme tones', () => {
    expect(statusTone('done')).toBe('success');
    expect(statusTone('dropped')).toBe('error');
    expect(statusTone('dev')).toBe('warn');
    expect(statusTone('test')).toBe('warn');
    expect(statusTone('open')).toBe('idle');
    expect(statusTone('planned')).toBe('idle');
    expect(statusTone('something-new')).toBe('idle');
  });

  it('writes priority the way mint does', () => {
    expect(priorityLabel(0)).toBe('P0');
    expect(priorityLabel(3)).toBe('P3');
  });
});

describe('labels', () => {
  it('elides a long label list and says how many are hidden', () => {
    expect(labelSummary([])).toBeUndefined();
    expect(labelSummary(['agent'])).toBe('agent');
    expect(labelSummary(['a', 'b', 'c'])).toBe('a · b · c');
    expect(labelSummary(['a', 'b', 'c', 'd'], 2)).toBe('a · b +2');
  });
});

describe('issue lines', () => {
  it('headlines an issue without decoration', () => {
    expect(issueHeadline(ISSUE)).toBe('#12 实现 issue 视图');
  });

  it('summarizes position as priority, status and plan', () => {
    expect(issueMeta(ISSUE)).toBe('P1 · dev');
    expect(issueMeta({ ...ISSUE, plan_id: null })).toBe('P1 · dev');
  });
});

describe('links', () => {
  it('knows every relation mint documents', () => {
    for (const rel of [
      'related',
      'solves',
      'solved-by',
      'duplicates',
      'duplicated-by',
      'blocked_by',
      'blocks',
    ]) {
      expect(linkLabelKey(rel)).toBeDefined();
    }
    expect(linkLabelKey('invented')).toBeUndefined();
  });

  it('describes a recognized link and keeps an unknown relation verbatim', () => {
    expect(describeLink({ rel: 'blocks', id: 42 })).toEqual({
      rel: 'blocks',
      labelKey: 'link.blocks',
      target: '#42',
    });
    expect(describeLink({ rel: 'invented', uid: 'abc' })).toEqual({ rel: 'invented', target: 'abc' });
    expect(describeLink({ rel: 'blocks' })).toEqual({
      rel: 'blocks',
      labelKey: 'link.blocks',
      target: '',
    });
  });

  it('drops anything it cannot read', () => {
    expect(describeLink(null)).toBeUndefined();
    expect(describeLink('blocks')).toBeUndefined();
    expect(describeLink({ id: 3 })).toBeUndefined();
  });
});

describe('containers and pagination', () => {
  it('lines a container child', () => {
    const child: ContainerChild = { id: 9, title: '实现 client 打包面', kind: 'requirement', status: 'test' };
    expect(containerChildLine(child)).toBe('#9 [requirement] 实现 client 打包面');
  });

  it('joins container meta, dropping empty parts', () => {
    expect(containerMeta(['open', '0.2.0', 6, null, undefined, ''])).toBe('open · 0.2.0 · 6');
  });

  it('projects a plan or milestone record onto a row', () => {
    const record = { id: 3, title: '客户端面', status: 'open', version: '0.2.0', issue_count: 6 };
    expect(containerRow(record)).toEqual({
      id: 3,
      title: '客户端面',
      meta: 'open · 0.2.0 · 6 issues',
    });
  });

  it('reads the container out of whichever key the route filled', () => {
    const detail: ContainerDetail = {
      id: 3,
      title: '客户端面',
      status: 'open',
      version: '0.2.0',
      milestone_id: 2,
      body: '## 范围',
      issues: [],
      created_at: '2026-08-29 12:55:45',
      updated_at: '2026-10-01 15:00:00',
    };
    expect(detailContainer({ ok: true, plan: detail })).toEqual(detail);
    expect(detailContainer({ ok: true, milestone: detail })).toEqual(detail);
  });

  it('clamps a page into the loaded range', () => {
    expect(clampPage(0, 5)).toBe(1);
    expect(clampPage(3, 5)).toBe(3);
    expect(clampPage(9, 5)).toBe(5);
    expect(clampPage(Number.NaN, 5)).toBe(1);
    expect(clampPage(2, Number.NaN)).toBe(1);
    expect(clampPage(2.7, 5)).toBe(2);
  });
});

const META: MintMetaPayload = {
  ok: true,
  plans: [
    {
      id: 3,
      title: '客户端面：右侧边栏 mint 面板',
      status: 'done',
      version: '0.2.0',
      milestone_id: 2,
      issue_count: 6,
      created_at: '2026-08-29 12:55:45',
      updated_at: '2026-10-01 15:00:00',
    },
    {
      id: 11,
      title: 'mint 入口双模式与解析加固',
      status: 'done',
      version: '0.2.0',
      milestone_id: null,
      issue_count: 3,
      created_at: '2026-09-29 13:21:39',
      updated_at: '2026-09-29 22:09:40',
    },
  ],
  milestones: [
    {
      id: 2,
      title: '待定：工具面增强与会话 tab',
      status: 'running',
      version: '0.2.0',
      issue_count: 15,
      created_at: '2026-08-29 12:55:45',
      updated_at: '2026-10-01 14:55:32',
    },
    {
      id: 4,
      title: '0.3.0 客户端面优化',
      status: 'open',
      version: '0.3.0',
      issue_count: 0,
      created_at: '2026-10-01 14:55:24',
      updated_at: '2026-10-01 14:55:24',
    },
  ],
  labels: [],
  placement: {
    '12': { milestone: 2, direct: false },
    '69': { milestone: 4, direct: true },
  },
};

describe('issue placement', () => {
  it('prefers the placement table and keeps direct apart from via-plan', () => {
    expect(issuePlacement(ISSUE, META)).toEqual({
      planId: 3,
      milestoneId: 2,
      milestoneVersion: '0.2.0',
      direct: false,
    });
    const standalone = { ...ISSUE, id: 69, plan_id: null };
    expect(issuePlacement(standalone, META)).toEqual({
      planId: null,
      milestoneId: 4,
      milestoneVersion: '0.3.0',
      direct: true,
    });
  });

  it('falls back to the plan table when the scan missed the issue', () => {
    const unseen = { ...ISSUE, id: 99 };
    expect(issuePlacement(unseen, META)).toEqual({
      planId: 3,
      milestoneId: 2,
      milestoneVersion: '0.2.0',
      direct: false,
    });
  });

  it('shows only the plan link when the lookup tables are unusable', () => {
    expect(issuePlacement(ISSUE, undefined)).toEqual({
      planId: 3,
      milestoneId: null,
      milestoneVersion: undefined,
      direct: false,
    });
    expect(issuePlacement({ ...ISSUE, plan_id: null }, undefined)).toBeUndefined();
  });

  it('does not invent a milestone for a plan that has none', () => {
    const item = { ...ISSUE, id: 99, plan_id: 11 };
    expect(issuePlacement(item, META)).toEqual({
      planId: 11,
      milestoneId: null,
      milestoneVersion: undefined,
      direct: false,
    });
  });

  it('reads a milestone version only when the table carries it', () => {
    expect(milestoneVersionOf(META, 2)).toBe('0.2.0');
    expect(milestoneVersionOf(META, 7)).toBeUndefined();
    expect(milestoneVersionOf(undefined, 2)).toBeUndefined();
    expect(milestoneVersionOf(META, null)).toBeUndefined();
  });

  it('trusts the detail read for a standalone milestone', () => {
    const detail = { ...ISSUE, body: '## 范围' };
    const direct = { ...detail, id: 69, plan_id: null, milestone_id: 4 } satisfies IssueDetail;
    expect(detailPlacement(direct, META)).toEqual({
      planId: null,
      milestoneId: 4,
      milestoneVersion: '0.3.0',
      direct: true,
    });
    const viaPlan = { ...detail, milestone_id: 2 } satisfies IssueDetail;
    expect(detailPlacement(viaPlan, META)).toEqual({
      planId: 3,
      milestoneId: 2,
      milestoneVersion: '0.2.0',
      direct: false,
    });
    const nowhere = { ...detail, plan_id: null, milestone_id: null } satisfies IssueDetail;
    expect(detailPlacement(nowhere, META)).toBeUndefined();
  });
});

describe('open container targets', () => {
  // Regression for #82: plan and milestone ids are different namespaces, so a
  // plan opened in one tab must not be read as the milestone with that id.
  it('answers only for the tab whose kind opened the target', () => {
    expect(activeContainer({ kind: 'plan', id: 13 }, 'plan')).toEqual({ kind: 'plan', id: 13 });
    expect(activeContainer({ kind: 'plan', id: 13 }, 'milestone')).toBeUndefined();
    expect(activeContainer({ kind: 'milestone', id: 4 }, 'milestone')).toEqual({
      kind: 'milestone',
      id: 4,
    });
    expect(activeContainer({ kind: 'milestone', id: 4 }, 'plan')).toBeUndefined();
  });

  it('has no target before anything is opened', () => {
    expect(activeContainer(undefined, 'plan')).toBeUndefined();
    expect(activeContainer(undefined, 'milestone')).toBeUndefined();
  });
});
