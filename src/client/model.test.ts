import { describe, expect, it } from 'vitest';

import type { ContainerChild, ContainerDetail, IssueItem, MintListPayload } from '../records.js';
import {
  clampPage,
  containerChildLine,
  containerMeta,
  containerRow,
  describeLink,
  detailContainer,
  issueHeadline,
  issueMeta,
  labelSummary,
  linkLabelKey,
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
    expect(issueMeta(ISSUE)).toBe('P1 · dev · #3');
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
