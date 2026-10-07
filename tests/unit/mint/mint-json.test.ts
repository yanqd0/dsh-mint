import { describe, expect, it } from 'vitest';

import { isIssueDetail, isIssueItem } from '../../../src/mint/mint-json.js';

/** One `list --json` row shaped like the published CLI's answer (no new fields). */
const ITEM = {
  id: 9,
  title: '实现 client 打包面',
  kind: 'requirement',
  status: 'dev',
  priority: 0,
  labels: ['agent', 'client'],
  plan_id: 3,
  links: [],
  created_at: '2026-08-29 12:55:45',
  updated_at: '2026-09-01 00:00:00',
};

// mint 0.9.0-alpha.1 起 `list --json` 的每行带 `milestone_id` /
// `milestone_direct`，但已发布的 `mint-faa`（0.8.1）不返回——所以字段缺失必须放行
// （老 CLI 不是形状漂移），字段存在但类型漂移才判 false。
describe('issue milestone fields in list --json', () => {
  it('keeps a row from a CLI that predates the fields', () => {
    expect(isIssueItem(ITEM)).toBe(true);
  });

  it('accepts the effective milestone and the direct flag when they are there', () => {
    expect(isIssueItem({ ...ITEM, milestone_id: 4, milestone_direct: true })).toBe(true);
    // `milestone_id: null` is mint's declared "no effective milestone".
    expect(isIssueItem({ ...ITEM, milestone_id: null, milestone_direct: false })).toBe(true);
  });

  it('rejects a milestone_id of the wrong shape instead of hiding it', () => {
    expect(isIssueItem({ ...ITEM, milestone_id: '4' })).toBe(false);
    expect(isIssueItem({ ...ITEM, milestone_id: {} })).toBe(false);
  });

  it('rejects a milestone_direct that is not a boolean', () => {
    expect(isIssueItem({ ...ITEM, milestone_direct: 'true' })).toBe(false);
    expect(isIssueItem({ ...ITEM, milestone_direct: 1 })).toBe(false);
  });
});

describe('issue detail still requires the milestone', () => {
  // `show --json` has always answered `milestone_id`; only the list read's copy of
  // it is the optional new field, so the detail guard stays strict.
  it('refuses a detail read without milestone_id', () => {
    expect(isIssueItem({ ...ITEM, body: null })).toBe(true);
    expect(isIssueDetail({ ...ITEM, body: null })).toBe(false);
  });

  it('accepts a detail read with the body and a nullable milestone', () => {
    expect(isIssueDetail({ ...ITEM, body: '## 范围', milestone_id: 2 })).toBe(true);
    expect(isIssueDetail({ ...ITEM, body: null, milestone_id: null })).toBe(true);
  });
});
