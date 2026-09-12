import { runMint } from './mint.js';
import type { DshContext } from './types.js';

const CONTEXT_ORDER = 60;
/** Tool guidance band is 100–199 (`notes/dsh/0.1.0/17-system-prompt-assembly.md`). */
const TOOL_GUIDANCE_ORDER = 110;
/** Fallback order when `systemPrompt.section` is unavailable and we use context(). */
const TOOL_GUIDANCE_CONTEXT_ORDER = 61;
const TOP_ISSUES = 8;

/**
 * Static guidance pointing the model at the `mint` host tool (#39).
 *
 * This replaces the B-v2 escalation script that used to be injected here: that
 * text taught the model to preside over `sandbox_permissions: danger-full-access`
 * for bash-run mint commands, which was the single strongest push toward the
 * bash path. The tool executes mint inside the plugin process instead — no bash,
 * no sandbox, no approval — so the guidance now says exactly that.
 *
 * Kept short on purpose: every section is repeated on each request.
 */
export const MINT_TOOL_GUIDANCE =
  'mint 操作统一走宿主 `mint` 工具（args 数组即 mint CLI 参数，如 ' +
  'mint({args:["issue","state","start","42"]})）：它在插件进程内执行，不经 bash、不受文件沙箱约束、无需授权。' +
  '不要用 bash 跑 mint。命令细节用 mint({args:["<子命令>","--help"]}) 查。' +
  '仅当该工具不可用时才回退 bash，并按常规提权审批。';

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
 * Register mint prompt contributions on an agent-scoped context: the active
 * overview plus the static tool-first guidance.
 *
 * The overview is dynamic (it reflects the live mint database), so it stays a
 * per-assembly `context()` provider that loads once per session and degrades
 * silently to an empty string on failure. The guidance is static and belongs to
 * the tool-guidance band, so it is registered as a `section()` — a stable
 * prefix, which is far friendlier to KV-cache reuse than a runtime-context
 * snapshot repeated on every request. Hosts without `section` fall back to
 * `context()` with the same text.
 *
 * `cwd` is the session's workspace (project) directory, which mint uses for
 * project lookup.
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

  const offGuidance =
    typeof sp.section === 'function'
      ? sp.section({ name: 'mint:tool-guidance', order: TOOL_GUIDANCE_ORDER, text: MINT_TOOL_GUIDANCE })
      : sp.context({
          name: 'mint:tool-guidance',
          order: TOOL_GUIDANCE_CONTEXT_ORDER,
          text: MINT_TOOL_GUIDANCE,
        });

  return () => {
    offOverview();
    offGuidance();
  };
}
