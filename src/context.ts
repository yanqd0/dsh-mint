import { runMint } from './mint.js';
import type { DshContext } from './types.js';

const CONTEXT_ORDER = 60;
const TOP_ISSUES = 8;

/**
 * Static guidance for the B-v2 approval gate (#25): how the model asks for the
 * one mint approval and then rides the gate without re-prompting. Doctrine-
 * grounded: the preemptive escalation pattern is only sanctioned after the
 * session already observed the same denied access, so the text teaches the
 * normal first retry, then the preemptive pattern.
 */
export const MINT_APPROVAL_GUIDANCE =
  'mint CLI 与沙箱（dsh-mint B-v2 放行 gate）：本会话首条 mint 命令可能被文件沙箱拒绝；' +
  '此时按常规提权重试一次（sandbox_permissions: danger-full-access + justification "mint"），' +
  '用户批准一次后，本会话后续所有 mint bash 命令可直接预置 ' +
  'sandbox_permissions: danger-full-access 与 justification "mint"——放行 gate 会自动批准，不再弹窗。' +
  '非 mint 命令不得预置提权，必须保持常规沙箱与审批流程。';

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
export async function fetchOverview(cwd: string): Promise<MintOverview> {
  const [issuesRes, msRes] = await Promise.all([
    runMint(cwd, ['list', '--json', '--no-page']),
    runMint(cwd, ['milestone', 'list', '--json']),
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
 * Register mint systemPrompt contexts on an agent-scoped context: the active
 * overview plus the static B-v2 approval-gate guidance.
 *
 * The overview text provider loads the mint overview once per session (cached,
 * so the CLI is not hit on every assembly) and degrades silently to an empty
 * string on failure — it never blocks the prompt assembly. `cwd` is the
 * session's workspace (project) directory, which mint uses for project lookup.
 */
export function registerMintContext(agentCtx: DshContext, cwd: string): (() => void) | undefined {
  const sp = agentCtx.systemPrompt;
  if (!sp) return undefined;

  let cached = '';
  let started = false;

  const load = async (): Promise<void> => {
    try {
      const overview = await fetchOverview(cwd);
      cached = renderOverview(overview);
    } catch {
      cached = '';
    }
  };

  const offOverview = sp.context({
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
  const offGuidance = sp.context({
    name: 'mint:approval-guidance',
    order: CONTEXT_ORDER + 1,
    text: MINT_APPROVAL_GUIDANCE,
  });
  return () => {
    offOverview();
    offGuidance();
  };
}
