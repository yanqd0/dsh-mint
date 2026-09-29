import { describe, expect, it } from 'vitest';

import { MINT_TOOL_GUIDANCE, renderOverview } from './context.js';
import { MINT_ENTRY_WARNING } from './mint.js';
import { MINT_TOOL_DESCRIPTION } from './mint-tool.js';

/**
 * Every-request budget (#61).
 *
 * The `[Mint]` overview, the tool-first guidance and the tool description are
 * re-sent on every request. They are the plugin's whole fixed cost, so they are
 * held to explicit byte ceilings: a real-shaped sample (a full page of issues +
 * a running milestone + the #58 identity line) must stay within budget.
 *
 * These ceilings are not estimates — they are the #61 acceptance criteria. When
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
    issues: SAMPLE_ISSUES,
    milestones: SAMPLE_MILESTONES,
    cliVersion: '0.8.0-alpha.1',
    cliEntry: 'mint-faa@0.8.0',
  });
}

describe('per-request injection budget (#61)', () => {
  it('renders at most TOP_ISSUES issue lines and states the real total', () => {
    const text = sampleOverview();
    const issueLines = text.split('\n').filter((line) => line.startsWith('- #'));
    expect(issueLines).toHaveLength(5);
    expect(text).toContain('top 5 of 8');
    // the top five by (priority, id), not mint's own order
    expect(issueLines[0]).toContain('#9');
    expect(issueLines.join('\n')).not.toContain('#45');
  });

  it('keeps the overview under 700 bytes', () => {
    expect(bytes(sampleOverview())).toBeLessThanOrEqual(700);
  });

  it('keeps the tool-first guidance to one sentence', () => {
    expect(bytes(MINT_TOOL_GUIDANCE)).toBeLessThanOrEqual(200);
  });

  it('keeps the tool description under 550 bytes', () => {
    expect(bytes(MINT_TOOL_DESCRIPTION)).toBeLessThanOrEqual(550);
  });

  it('states the paging footer contract mint 0.8 writes (#78)', () => {
    expect(MINT_TOOL_DESCRIPTION).toContain('# Page');
    expect(MINT_TOOL_DESCRIPTION).not.toContain('--- Page');
  });

  it('keeps the entry-failure warning small — it only shows when mint is broken (#66)', () => {
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
});
