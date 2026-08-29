import { runMint } from './mint.js';
import type { DshContext, ShellLike } from './types.js';

const CONTEXT_ORDER = 60;
const TOP_ISSUES = 8;

interface OverviewIssue {
  id: number;
  title: string;
  kind: string;
  status: string;
  priority: number;
  labels: string[];
}

interface OverviewMilestone {
  title: string;
  version: string;
  status: string;
}

export interface MintOverview {
  issues: OverviewIssue[];
  milestones: OverviewMilestone[];
}

/** Fetch the active-issue overview + milestone state via the mint CLI. */
export async function fetchOverview(shell: ShellLike): Promise<MintOverview> {
  const [issuesRes, msRes] = await Promise.all([
    runMint(shell, ['list', '--json', '--no-page']),
    runMint(shell, ['milestone', 'list', '--json']),
  ]);
  if (!issuesRes.ok) throw new Error(issuesRes.error ?? 'mint list failed');
  if (!msRes.ok) throw new Error(msRes.error ?? 'mint milestone list failed');
  const issues = JSON.parse(issuesRes.text ?? '{}') as { items?: OverviewIssue[] };
  const milestones = JSON.parse(msRes.text ?? '{}') as { items?: OverviewMilestone[] };
  return {
    issues: Array.isArray(issues.items) ? issues.items : [],
    milestones: Array.isArray(milestones.items) ? milestones.items : [],
  };
}

/** Render the overview into compact model-facing text. */
export function renderOverview(overview: MintOverview): string {
  const lines: string[] = [];
  const issues = overview.issues.slice(0, TOP_ISSUES);
  if (issues.length > 0) {
    lines.push(`[Mint] active issues (top ${TOP_ISSUES}):`);
    for (const issue of issues) {
      const labels = issue.labels.length > 0 ? ` [${issue.labels.join(',')}]` : '';
      lines.push(
        `- #${issue.id} [${issue.kind}] ${issue.title} (P${issue.priority}, ${issue.status})${labels}`,
      );
    }
  }
  const running = overview.milestones.filter((m) => m.status === 'running');
  if (running.length > 0) {
    const names = running.map((m) => m.version || m.title).join(', ');
    lines.push(`[Mint] running milestones: ${names}`);
    if (running.length >= 2) {
      lines.push('[Mint] WARNING: multiple running milestones — check milestone state');
    }
  }
  return lines.join('\n');
}

/**
 * Register a systemPrompt context on an agent-scoped context.
 *
 * The text provider loads the mint overview once per session (cached, so the
 * shell is not hit on every assembly) and degrades silently to an empty
 * string on failure — it never blocks the prompt assembly.
 */
export function registerMintContext(agentCtx: DshContext): (() => void) | undefined {
  const sp = agentCtx.systemPrompt;
  if (!sp) return undefined;

  let cached = '';
  let started = false;

  const load = async (): Promise<void> => {
    if (!agentCtx.shell) return;
    try {
      const overview = await fetchOverview(agentCtx.shell);
      cached = renderOverview(overview);
    } catch {
      cached = '';
    }
  };

  return sp.context({
    name: 'mint:overview',
    order: CONTEXT_ORDER,
    text: () => {
      if (!started) {
        started = true;
        void load();
      }
      return cached;
    },
  });
}
