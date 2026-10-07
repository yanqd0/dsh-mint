import { describe, expect, it } from 'vitest';

import { MINT_TOOL_GUIDANCE, RECORD_GAP_LINE, renderOverview } from '../../src/host/context.js';
import { DAG_TOOL_DESCRIPTION } from '../../src/dag/dag-tool.js';
import { WORKTREE_TOOL_DESCRIPTION } from '../../src/dag/worktree-tool.js';
import { MINT_ENTRY_WARNING } from '../../src/mint/mint.js';
import { MINT_TOOL_DESCRIPTION } from '../../src/mint/mint-tool.js';

/**
 * Every-request budget.
 *
 * The `[Mint]` overview, the tool-first guidance and the tool description are
 * re-sent on every request. They are the plugin's whole fixed cost, so they are
 * held to explicit byte ceilings: a real-shaped sample (a full page of issues +
 * a running milestone + the entry identity line) must stay within budget.
 *
 * These ceilings are not estimates — they are this guard's acceptance criteria. When
 * a legitimate change needs more room, raise the ceiling deliberately and say
 * why in the commit message.
 */
const bytes = (text: string): number => Buffer.byteLength(text, 'utf8');

const SAMPLE_ISSUES = [
  {
    id: 9,
    title: '实现 client 打包面：dsh.client 与构建通道',
    kind: 'requirement',
    status: 'open',
    priority: 0,
    labels: ['agent', 'client', 'dev-clean'],
  },
  {
    id: 55,
    title: 'mint 工具支持跨项目登记与查询（--project）',
    kind: 'requirement',
    status: 'open',
    priority: 1,
    labels: ['agent', 'dsh-dev-dsh', 'host', 'plugin'],
  },
  {
    id: 12,
    title: '实现面板内容：issue/plan/milestone 展示与交互',
    kind: 'requirement',
    status: 'open',
    priority: 1,
    labels: ['agent', 'client', 'dev-clean'],
  },
  {
    id: 11,
    title: '实现 mint tab：conversation.view 注册与骨架',
    kind: 'requirement',
    status: 'open',
    priority: 1,
    labels: ['agent', 'client', 'dev-clean'],
  },
  {
    id: 10,
    title: '实现 Host RPC：mint 查询接口',
    kind: 'requirement',
    status: 'open',
    priority: 1,
    labels: ['agent', 'dev-clean', 'host'],
  },
  {
    id: 61,
    title: '上下文注入瘦身：[Mint] 概览与工具指引的每请求开销',
    kind: 'requirement',
    status: 'dev',
    priority: 2,
    labels: ['agent', 'dev-clean', 'dsh-dev-dsh', 'host'],
  },
  {
    id: 59,
    title: 'plan 绑定门禁过软：0 issue 的 open plan 也可放行 exit_plan_mode',
    kind: 'problem',
    status: 'open',
    priority: 2,
    labels: ['agent', 'bug', 'dsh-dev-dsh', 'host'],
  },
  {
    id: 45,
    title: '冷安装首次调用：mint 二进制按需下载可能超 30s 工具超时',
    kind: 'problem',
    status: 'open',
    priority: 2,
    labels: ['agent'],
  },
];

const SAMPLE_MILESTONES = [
  { id: 1, title: '宿主面：上下文与提醒', version: '0.1.0', status: 'done' },
  { id: 2, title: '待定：工具面增强与会话 tab', version: '0.2.0', status: 'running' },
];

function sampleOverview(): string {
  return renderOverview({
    project: 'dsh-mint',
    issues: SAMPLE_ISSUES,
    milestones: SAMPLE_MILESTONES,
    cliVersion: '0.8.0-alpha.1',
    cliEntry: 'mint-faa@0.8.0',
  });
}

describe('per-request injection budget', () => {
  it('renders at most TOP_ISSUES issue lines and states the real total', () => {
    const text = sampleOverview();
    const issueLines = text.split('\n').filter((line) => line.startsWith('- #'));
    expect(issueLines).toHaveLength(5);
    expect(text).toContain('top 5 of 8');
    // the top five by (priority, id), not mint's own order. The ids are fixture
    // data, so the leak check names the cut item by its title instead of a
    // `#<id>` token: what matters is that the line past the cap never arrives.
    expect(issueLines[0]).toContain('#9');
    expect(issueLines.join('\n')).not.toContain('冷安装');
  });

  it('keeps the overview under 700 bytes', () => {
    expect(bytes(sampleOverview())).toBeLessThanOrEqual(700);
  });

  it('names the resolved project, so own-project calls need no -p', () => {
    expect(sampleOverview().split('\n')[0]).toBe(
      '[Mint] dsh-mint · mint 0.8.0-alpha.1 via mint-faa@0.8.0'
    );
  });

  it('keeps the tool-first guidance to one sentence', () => {
    expect(bytes(MINT_TOOL_GUIDANCE)).toBeLessThanOrEqual(200);
  });

  it('keeps the tool description under 550 bytes', () => {
    expect(bytes(MINT_TOOL_DESCRIPTION)).toBeLessThanOrEqual(550);
  });

  // the DAG tool's description is the second per-request tool budget.
  // It is larger than `mint`'s because it carries a whole small DSL (the document
  // actions, the node fields, the edge direction). The worktree line moved out to
  // the standalone `worktree` tool, so this ceiling came back down to the measured
  // value +20 B — and it must stay a description, not a manual: the full spec is
  // `notes/plan-dag.md` §2 and the exact parameters live in the tool's own schema.
  it('keeps the plan DAG tool description under 700 bytes', () => {
    expect(bytes(DAG_TOOL_DESCRIPTION)).toBeLessThanOrEqual(700);
    expect(DAG_TOOL_DESCRIPTION).toContain('init');
    expect(DAG_TOOL_DESCRIPTION).toContain('to 依赖 from');
    expect(DAG_TOOL_DESCRIPTION).toContain('label ≤6 字');
    expect(DAG_TOOL_DESCRIPTION).toContain('mint_plan_dag({action:"add"');
  });

  // The worktree tool is the third per-request budget, and the only one whose
  // actions touch the filesystem: the description has to name all five (a model
  // that cannot see `remove`/`prune` leaves trees behind, or never clears the old
  // ones) and the batch rule that makes the merges independent.
  it('keeps the worktree tool description under 700 bytes', () => {
    expect(bytes(WORKTREE_TOOL_DESCRIPTION)).toBeLessThanOrEqual(700);
    for (const marker of ['create', 'list', 'merge', 'remove', 'prune']) {
      expect(WORKTREE_TOOL_DESCRIPTION, marker).toContain(marker);
    }
  });

  it('states the paging footer contract mint 0.8 writes', () => {
    expect(MINT_TOOL_DESCRIPTION).toContain('# Page');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('--- Page');
  });

  it('keeps the entry-failure warning small — it only shows when mint is broken', () => {
    expect(bytes(`[Mint] WARNING: ${MINT_ENTRY_WARNING}`)).toBeLessThanOrEqual(200);
  });

  it('keeps the whole fixed injection under 1500 bytes', () => {
    const total =
      bytes(sampleOverview()) + bytes(MINT_TOOL_GUIDANCE) + bytes(MINT_TOOL_DESCRIPTION);
    expect(total).toBeLessThanOrEqual(1500);
  });

  it('still carries the attachment workflow the skill relies on', () => {
    const text = sampleOverview();
    expect(text).toContain('"milestone","attach","2"');
    expect(text).toContain('plan create --milestone 2');
  });

  it('warns when no milestone is running, without setting it itself', () => {
    const text = renderOverview({
      issues: [],
      milestones: [{ id: 2, title: 'b', version: '0.2.0', status: 'open' }],
    });
    expect(text).toContain('no running milestone (latest 0.2.0)');
    expect(text).toContain('ASK the user');
    expect(text).toContain('do not set it yourself');
  });

  // the 2+ running branch is abnormal, so it may be longer than the
  // one-running line — but it is still re-sent every request and must carry the
  // CLI's own answer (`--force`, ask the user) instead of manual repair advice.
  it('keeps the 2+ running warning within budget and aligned with the guard', () => {
    const text = renderOverview({
      issues: [],
      milestones: [
        { id: 1, title: 'a', version: '0.1.0', status: 'running' },
        { id: 2, title: 'b', version: '0.2.0', status: 'running' },
      ],
    });
    const warning = text.split('\n').find((line) => line.startsWith('[Mint] WARNING:')) ?? '';
    expect(warning).toContain('--force');
    expect(bytes(warning)).toBeLessThanOrEqual(320);
  });

  // the doctor line is only paid for when the ledger has warnings, so it
  // is held to its own small ceiling rather than the clean-ledger sample's.
  it('keeps the doctor line within budget', () => {
    const text = renderOverview({
      issues: [],
      milestones: [{ id: 1, title: 'a', version: '0.1.0', status: 'running' }],
      doctor: { warnings: 1, counts: { 'stale-plan': 1, 'stalled-dev': 0 } },
    });
    const line = text.split('\n').find((l) => l.startsWith('[Mint] doctor:')) ?? '';
    expect(line).toContain('stale-plan:1');
    expect(bytes(line)).toBeLessThanOrEqual(160);
  });

  // the record-gap line is a condition line too — rendered at most once per
  // session, and only while that session has nothing recorded — so it is held to
  // its own ceiling instead of the clean sample's.
  it('keeps the record-gap line within budget', () => {
    expect(RECORD_GAP_LINE.startsWith('[Mint] ')).toBe(true);
    expect(bytes(RECORD_GAP_LINE)).toBeLessThanOrEqual(300);
  });
});
