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
  id: number;
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

/** Semver-ish rank: `[major, minor, patch, stable]`; a release outranks its prereleases. */
function versionRank(version: string): number[] {
  const [core = '', pre = ''] = version.split('-', 2);
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((p) => Number.parseInt(p, 10) || 0);
  return [major, minor, patch, pre ? 0 : 1];
}

/** True when `a` outranks `b` under {@link versionRank}. */
function isNewer(a: string, b: string): boolean {
  const [ra, rb] = [versionRank(a), versionRank(b)];
  for (let i = 0; i < ra.length; i += 1) {
    const diff = (ra[i] ?? 0) - (rb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** Highest version among the project's milestones (seeds the next-version suggestion). */
export function latestVersion(milestones: readonly OverviewMilestone[]): string {
  let best = '';
  for (const milestone of milestones) {
    if (isNewer(milestone.version, best)) best = milestone.version;
  }
  return best;
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
  const [current] = running;
  if (running.length === 1 && current) {
    // Exactly one current milestone: state the default attachment target explicitly
    // (the skill carries the reasoning; this line is what every request can see).
    const label = current.version || current.title;
    lines.push(`[Mint] running milestones: ${label}`);
    lines.push(
      `[Mint] current milestone = ${label} (id ${current.id}) — new plans and standalone issues ` +
        `default to it: mint({args:["milestone","attach","${current.id}","<id>"]}); ` +
        `plan create --milestone ${current.id}`,
    );
  } else if (running.length >= 2) {
    const names = running.map((m) => m.version || m.title).join(', ');
    lines.push(`[Mint] running milestones: ${names}`);
    lines.push('[Mint] WARNING: multiple running milestones — check milestone state');
    lines.push(
      '[Mint] exactly one milestone should be running: list them, ask the user, then ' +
        'mint({args:["milestone","set","<id>","--status","open"]}) for the later one',
    );
  } else if (overview.milestones.length > 0) {
    const latest = latestVersion(overview.milestones);
    lines.push(
      `[Mint] no running milestone (latest ${latest}) — infer the next version by semver ` +
        '(patch for fixes/docs, minor for a new capability, major for a breaking change) and ask the user: ' +
        'set it running with mint({args:["milestone","set","<id>","--status","running"]}) or create it; ' +
        'do not set it yourself',
    );
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
