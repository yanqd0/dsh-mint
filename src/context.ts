import {
  MINT_ENTRY_WARNING,
  describeMintEntry,
  parseMintVersion,
  resolveMintEntry,
  runMint,
} from './mint.js';
import type { MintRunResult } from './mint.js';
import { isRecord, parseItems } from './mint-json.js';
import type { DshContext } from './types.js';

const CONTEXT_ORDER = 60;
/** Tool guidance band is 100–199 (`notes/dsh/0.1.0/17-system-prompt-assembly.md`). */
const TOOL_GUIDANCE_ORDER = 110;
/** Fallback order when `systemPrompt.section` is unavailable and we use context(). */
const TOOL_GUIDANCE_CONTEXT_ORDER = 61;
/**
 * How many active issues the overview carries. Five matches mint's default
 * page size, and the header states the real total — the overview must never
 * look like the whole backlog (#61).
 */
const TOP_ISSUES = 5;

/**
 * Static guidance pointing the model at the `mint` host tool (#39).
 *
 * This replaces the B-v2 escalation script that used to be injected here: that
 * text taught the model to preside over `sandbox_permissions: danger-full-access`
 * for bash-run mint commands, which was the single strongest push toward the
 * bash path. The tool executes mint inside the plugin process instead — no bash,
 * no sandbox, no approval — so the guidance says exactly that.
 *
 * This is the **single source** of the tool-first policy (#62): the tool
 * description documents the mechanism, `skill/SKILL.md` documents the workflow,
 * and neither restates this. Kept to one sentence on purpose — it is repeated on
 * every request.
 */
export const MINT_TOOL_GUIDANCE =
  'mint 操作一律走宿主 mint 工具（插件进程内执行：不经 bash、无需授权）；' +
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
  /** `null` for a milestone mint has no version for (#107). */
  version: string | null;
  status: string;
}

/** Validate one `list --json` item against the fields the overview reads. */
function isOverviewIssue(value: unknown): value is OverviewIssue {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'number' &&
    typeof value.title === 'string' &&
    typeof value.kind === 'string' &&
    typeof value.status === 'string' &&
    typeof value.priority === 'number' &&
    Array.isArray(value.labels) &&
    value.labels.every((label) => typeof label === 'string')
  );
}

/**
 * Validate one `milestone list --json` item against the fields the overview reads.
 *
 * `version` is optional in mint (the column is nullable), so `null` is a real
 * answer and must not drop the milestone from the overview: a version-less
 * running milestone is exactly the one the attachment advice has to name (#107).
 */
function isOverviewMilestone(value: unknown): value is OverviewMilestone {
  if (!isRecord(value)) return false;
  return (
    typeof value.id === 'number' &&
    typeof value.title === 'string' &&
    (value.version === null || typeof value.version === 'string') &&
    typeof value.status === 'string'
  );
}

export interface MintOverview {
  issues: OverviewIssue[];
  milestones: OverviewMilestone[];
  /** Version the resolved entry reported through `-V`; absent when the probe failed. */
  cliVersion?: string;
  /** Short label for the entry that answered `-V` (build skew: debug vs release). */
  cliEntry?: string;
  /**
   * Notes about CLI answers that did not match the expected JSON shape (#65).
   *
   * The dependency is a subprocess CLI, so a `mint-faa` bump can rename a field
   * without any import failing. Without these, the shrunken item list would
   * render as a plausible-but-empty overview; the warning makes the skew
   * visible instead of silent.
   */
  warnings?: string[];
}

/**
 * Ask the entry for its version. Advisory only (#58): the overview is worth
 * rendering even when `-V` is unavailable, so every failure degrades to
 * `undefined` instead of failing {@link fetchOverview}.
 */
async function probeCliVersion(
  run: (args: string[]) => Promise<MintRunResult>,
  entry: string | undefined
): Promise<{ version: string; entry?: string } | undefined> {
  try {
    const result = await run(['-V']);
    if (result?.ok !== true) return undefined;
    const version = parseMintVersion(result.text);
    if (version === undefined) return undefined;
    try {
      return { version, entry: describeMintEntry(entry ?? resolveMintEntry()) };
    } catch {
      return { version };
    }
  } catch {
    return undefined;
  }
}

/** Fetch the active-issue overview + milestone state via the mint CLI. */
export async function fetchOverview(cwd: string, entry?: string): Promise<MintOverview> {
  // Keep the no-override call shape at two arguments: the default path stays
  // exactly what it was before `mintEntry` existed.
  const run = (args: string[]): Promise<MintRunResult> =>
    entry === undefined ? runMint(cwd, args) : runMint(cwd, args, { entry });
  const [issuesRes, msRes, cli] = await Promise.all([
    run(['list', '--json', '--no-page']),
    run(['milestone', 'list', '--json']),
    probeCliVersion(run, entry),
  ]);
  if (!issuesRes.ok) throw new Error(issuesRes.error ?? 'mint list failed');
  if (!msRes.ok) throw new Error(msRes.error ?? 'mint milestone list failed');
  const issues = parseItems('list --json', issuesRes.text, isOverviewIssue);
  const milestones = parseItems('milestone list --json', msRes.text, isOverviewMilestone);
  const overview: MintOverview = { issues: issues.items, milestones: milestones.items };
  const warnings = [issues.warning, milestones.warning].filter(
    (warning): warning is string => warning !== undefined
  );
  if (warnings.length > 0) overview.warnings = warnings;
  if (cli !== undefined) {
    overview.cliVersion = cli.version;
    if (cli.entry !== undefined) overview.cliEntry = cli.entry;
  }
  return overview;
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
    // A milestone without a version has nothing to compare; it also does not
    // drag `best` down — the semver hint keeps working off the rest (#107).
    if (milestone.version === null) continue;
    if (isNewer(milestone.version, best)) best = milestone.version;
  }
  return best;
}

/** Render the overview into compact model-facing text. */
export function renderOverview(overview: MintOverview): string {
  const lines: string[] = [];
  if (overview.cliVersion !== undefined) {
    // One short line, first: a command that the running build does not know
    // ("unrecognized subcommand") is otherwise indistinguishable from a typo,
    // and `-V` alone cannot tell a debug build from a release one (#58).
    const via = overview.cliEntry !== undefined ? ` via ${overview.cliEntry}` : '';
    lines.push(`[Mint] mint ${overview.cliVersion}${via}`);
  }
  // Surface a CLI shape mismatch instead of letting it read as "no issues" (#65).
  for (const warning of overview.warnings ?? []) {
    lines.push(`[Mint] WARNING: ${warning}`);
  }
  // Top-N by (priority, id) — explicit so the "top" claim does not depend on
  // mint's default ordering. Labels are deliberately left out: they are a tool
  // call away, and they cost the most bytes per line (#61).
  const issues = [...overview.issues]
    .sort((a, b) => a.priority - b.priority || a.id - b.id)
    .slice(0, TOP_ISSUES);
  if (issues.length > 0) {
    const total = overview.issues.length;
    const shown = total > TOP_ISSUES ? `top ${TOP_ISSUES} of ${total}` : `${total}`;
    lines.push(`[Mint] issues (${shown}):`);
    for (const issue of issues) {
      lines.push(
        `- #${issue.id} [${issue.kind}] ${issue.title} (P${issue.priority}, ${issue.status})`
      );
    }
  }
  const running = overview.milestones.filter((m) => m.status === 'running');
  const [current] = running;
  if (running.length === 1 && current) {
    // Exactly one current milestone: state the default attachment target explicitly
    // (the skill carries the reasoning; this line is what every request can see).
    const label = current.version || current.title;
    lines.push(
      `[Mint] milestone ${label} (id ${current.id}) running — new plans/standalone issues ` +
        `attach to it: mint({args:["milestone","attach","${current.id}","<id>"]}); ` +
        `plan create --milestone ${current.id}`
    );
  } else if (running.length >= 2) {
    const names = running.map((m) => m.version || m.title).join(', ');
    lines.push(
      `[Mint] WARNING: ${running.length} running milestones (${names}) — keep exactly one; ` +
        'ask the user, then reopen the later one: mint({args:["milestone","set","<id>","--status","open"]})'
    );
  } else if (overview.milestones.length > 0) {
    const latest = latestVersion(overview.milestones);
    // No version anywhere: drop the parenthetical instead of printing "(latest )".
    const latestNote = latest === '' ? '' : ` (latest ${latest})`;
    lines.push(
      `[Mint] no running milestone${latestNote} — infer the next version by semver ` +
        '(patch for fixes/docs, minor for a new capability, major for a breaking change) and ' +
        'ASK the user to set it running or create it; do not set it yourself'
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
export function registerMintContext(
  agentCtx: DshContext,
  cwd: string,
  entry?: string
): (() => void) | undefined {
  const sp = agentCtx.systemPrompt;
  if (!sp) return undefined;

  let cached = '';
  let started = false;

  const load = async (): Promise<void> => {
    // Resolve first, separately: an unresolvable entry is a plugin-side outage
    // the session can act on (#66), not an empty project — staying silent here
    // made `Cannot find module` look like "no issues".
    let resolved: string;
    try {
      resolved = entry === undefined ? resolveMintEntry() : resolveMintEntry({ entry });
    } catch {
      cached = `[Mint] WARNING: ${MINT_ENTRY_WARNING}`;
      return;
    }
    try {
      const overview = await fetchOverview(cwd, resolved);
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
      ? sp.section({
          name: 'mint:tool-guidance',
          order: TOOL_GUIDANCE_ORDER,
          text: MINT_TOOL_GUIDANCE,
        })
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
