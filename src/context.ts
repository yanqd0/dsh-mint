import {
  MINT_ENTRY_WARNING,
  describeMintEntry,
  parseMintVersion,
  resolveMintEntry,
  runMint,
} from './mint.js';
import type { MintRunResult } from './mint.js';
import { isRecord, parseDetail, parseItems } from './mint-json.js';
import { noteOwnProject } from './own-project.js';
import { sessionIdOf } from './session-id.js';
import type { AgentLike, DshContext } from './types.js';

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
  /**
   * Project the item belongs to. Optional because an older/subset `list --json`
   * may omit it, but it is the **only** way this plugin learns its own project
   * name without reading mint's database (#114).
   */
  project?: string;
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
    value.labels.every((label) => typeof label === 'string') &&
    (value.project === undefined || typeof value.project === 'string')
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
  /**
   * Project the session's cwd resolves to, read off the issue rows (#114).
   *
   * Absent when the project has no issues (nothing to read it from) — a real
   * "unknown", not "no project": the consumers (the injection line and the
   * own-project memo) are both optional.
   */
  project?: string;
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
  /**
   * `mint doctor`'s verdict, only when the resolved CLI can answer it (#126).
   *
   * Absent is the normal case for an old CLI and for a probe failure; the
   * injected line is only worth its bytes when there is a warning to report.
   */
  doctor?: DoctorReport;
}

/** The slice of `doctor --json` the overview renders. */
export interface DoctorReport {
  /** Number of findings; `0` means a healthy ledger and no injected line. */
  warnings: number;
  /**
   * Per-check counts, keyed by mint's stable check name.
   *
   * mint serializes these through a sorted map, so the JSON key order is
   * alphabetical rather than the check order its own summary line uses; the
   * rendered detail therefore orders by {@link DOCTOR_CHECKS} itself.
   */
  counts: Record<string, number>;
}

/** mint's own check order (`doctor` summary line); unknown checks trail it. */
const DOCTOR_CHECKS: readonly string[] = [
  'multiple-running',
  'stale-plan',
  'overlap-plan',
  'idle-milestone',
  'stalled-dev',
];

/** `stale-plan:1, stalled-dev:2` for the checks that actually fired. */
function doctorDetail(counts: Record<string, number>): string {
  const fired = (check: string): number => counts[check] ?? 0;
  const known = DOCTOR_CHECKS.filter((check) => fired(check) > 0);
  // A check this plugin has never heard of still reaches the model: the line is
  // a pointer, and dropping a new check would hide the reason doctor fired.
  const extra = Object.keys(counts)
    .filter((check) => !DOCTOR_CHECKS.includes(check) && fired(check) > 0)
    .sort();
  return [...known, ...extra].map((check) => `${check}:${fired(check)}`).join(', ');
}

/** Validate a `doctor --json` payload against the fields the overview reads. */
function isDoctorReport(value: unknown): value is DoctorReport {
  if (!isRecord(value)) return false;
  if (typeof value.warnings !== 'number') return false;
  return isRecord(value.counts) && Object.values(value.counts).every((count) => typeof count === 'number');
}

/**
 * True when a CLI version is new enough to answer `doctor` (#126).
 *
 * The gate exists to avoid one guaranteed-failure spawn per session on older
 * mint: `doctor` arrived in the 0.9 line, and the prerelease suffix is
 * irrelevant (`0.9.0-alpha.1` already has it). An unparsable version answers
 * `false`, so the injection degrades to its pre-#126 shape.
 */
export function supportsDoctor(version: string): boolean {
  const [core = ''] = version.split('-', 1);
  const [major = 0, minor = 0] = core
    .split('.')
    .map((part) => Number.parseInt(part, 10) || 0);
  return major > 0 || minor >= 9;
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

/**
 * Ask mint for its own health check (#126).
 *
 * Runs only behind {@link supportsDoctor}: an older CLI would answer
 * `unrecognized subcommand`, and paying one guaranteed-failure spawn per
 * session is exactly what the version gate avoids. Every other failure (timeout,
 * killed process, unreadable JSON) is advisory and degrades to "no doctor
 * line"; only a well-formed JSON payload with the wrong shape is worth a visible
 * note, matching the other reads' skew contract (#65).
 */
async function probeDoctor(
  run: (args: string[]) => Promise<MintRunResult>,
  version: string
): Promise<{ report?: DoctorReport; warning?: string }> {
  if (!supportsDoctor(version)) return {};
  try {
    const result = await run(['doctor', '--json']);
    if (result?.ok !== true) return {};
    const parsed = parseDetail('doctor --json', result.text, isDoctorReport);
    if (parsed.value === undefined) {
      return parsed.warning === undefined ? {} : { warning: parsed.warning };
    }
    // Keep only the two fields the line renders: the payload also carries the
    // per-finding detail, which the per-request overview has no use for.
    return { report: { warnings: parsed.value.warnings, counts: parsed.value.counts } };
  } catch {
    return {};
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
  // The project name rides on the rows themselves (`"project":"dsh-mint"`); the
  // first row that names one is authoritative — all rows come from one ledger.
  const project = issues.items.find((item) => item.project !== undefined)?.project;
  if (project !== undefined) overview.project = project;
  const warnings = [issues.warning, milestones.warning].filter(
    (warning): warning is string => warning !== undefined
  );
  if (cli !== undefined) {
    overview.cliVersion = cli.version;
    if (cli.entry !== undefined) overview.cliEntry = cli.entry;
    // The doctor read is sequential on purpose: it is gated on the version that
    // the `-V` probe just answered, so it cannot join the parallel batch above.
    const doctor = await probeDoctor(run, cli.version);
    if (doctor.report !== undefined) overview.doctor = doctor.report;
    if (doctor.warning !== undefined) warnings.push(doctor.warning);
  }
  if (warnings.length > 0) overview.warnings = warnings;
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
  // Identity line: the resolved project, then the CLI version. Both are optional
  // and independent — a failed `-V` probe still leaves the project name worth
  // stating, and a project with no issues still has its CLI version (#114, #58).
  // The project name is what lets a session check "am I already in my project?"
  // instead of defensively prefixing `-p <self>`.
  const identity: string[] = [];
  if (overview.project !== undefined) identity.push(overview.project);
  if (overview.cliVersion !== undefined) {
    // One short line, first: a command that the running build does not know
    // ("unrecognized subcommand") is otherwise indistinguishable from a typo,
    // and `-V` alone cannot tell a debug build from a release one (#58).
    const via = overview.cliEntry !== undefined ? ` via ${overview.cliEntry}` : '';
    identity.push(`mint ${overview.cliVersion}${via}`);
  }
  if (identity.length > 0) lines.push(`[Mint] ${identity.join(' · ')}`);
  // Surface a CLI shape mismatch instead of letting it read as "no issues" (#65).
  for (const warning of overview.warnings ?? []) {
    lines.push(`[Mint] WARNING: ${warning}`);
  }
  // One line for the ledger's own health check, and only when there is
  // something to report (#126): an always-on line is per-request cost with no
  // signal, and a zero-warning answer is the common case. The counts keep
  // mint's own check order (see {@link DoctorReport}).
  const doctor = overview.doctor;
  if (doctor !== undefined && doctor.warnings > 0) {
    const detail = doctorDetail(doctor.counts);
    const suffix = detail === '' ? '' : ` (${detail})`;
    lines.push(
      `[Mint] doctor: ${doctor.warnings} health warning${doctor.warnings === 1 ? '' : 's'}${suffix} — ` +
        'mint({args:["doctor","--json"]})'
    );
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
    // Two running milestones are no longer "fix this by hand": since mint 0.9.0
    // the CLI refuses any write that would add one, and `--force` is the only
    // escape hatch (#104). The injected line must not tell the model to reopen a
    // milestone when the CLI's own answer is "ask the user about parallel
    // versions"; the migration route stays as the non-parallel option.
    const names = running.map((m) => m.version || m.title).join(', ');
    lines.push(
      `[Mint] WARNING: ${running.length} running milestones (${names}) — the CLI now refuses ` +
        'to start another without --force; ask the user whether parallel versions are intended ' +
        '(mint({args:["milestone","set","<id>","--status","running","--force"]})) or migrate the ' +
        'extra work and set it open'
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
      // Remember which project this directory *is*, so `-p <self>` can be
      // recognised as own-project work rather than a cross-project write (#114).
      // Keyed by the mount-line `entry`, the same key the gate probes with.
      if (overview.project !== undefined) {
        noteOwnProject(cwd, entry, overview.project);
      }
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

/**
 * How many session ids the channel remembers; matches the other bounded
 * session maps (approval grants, cross-project grants).
 */
const MAX_REGISTERED_SESSIONS = 100;

/**
 * Register the overview/guidance channel (#113).
 *
 * The host's lifecycle event is **`agent/created`** (payload
 * `{ agent, source, signal? }`, `dsh-agent` `Registry.announce`). The name this
 * plugin used through 0.2.0 — `agent/session-start` — is published by no harness
 * package of 0.2.0-rc.2, so the listener never ran and neither the overview nor
 * the tool-first guidance ever reached a session. The old name stays wired for
 * hosts that do publish it; both events are handled by the same function.
 *
 * Three guards, each with a reason:
 *
 * - **Dedup by session id.** Both events can fire for one session; registering
 *   twice would inject the overview and the guidance twice. The id is only
 *   consumed once the agent has a `systemPrompt` to register on, so an event
 *   that arrives too early does not burn the session.
 * - **Skip subagents.** The overview costs three mint spawns per session plus a
 *   per-request section, and a subagent already inherits the `mint` tool: its
 *   session header carries `delegationDepth > 0` (`origin: 'subagent'`).
 * - **Never throw.** `agent/created` is a *serial* event — a throwing listener
 *   rejects agent creation itself. A missing overview is the acceptable failure.
 */
export function installOverviewChannel(ctx: DshContext, entry?: string): () => void {
  const registered = new Set<string>();

  const onAgent = (payload: { agent?: AgentLike }): void => {
    try {
      const agent = payload?.agent;
      const cwd = agent?.session?.header?.cwd;
      if (agent === undefined || !agent.ctx || cwd === undefined) return;
      if ((agent.session.header.delegationDepth ?? 0) > 0) return;
      // Registering without the service would silently do nothing and (worse)
      // mark the session as done, so wait for the host to hand it over.
      if (agent.ctx.systemPrompt === undefined) return;
      const sessionId = sessionIdOf(agent);
      if (sessionId !== undefined) {
        if (registered.has(sessionId)) return;
        if (registered.size >= MAX_REGISTERED_SESSIONS) {
          const oldest = registered.values().next().value;
          if (oldest !== undefined) registered.delete(oldest);
        }
        registered.add(sessionId);
      }
      registerMintContext(agent.ctx, cwd, entry);
    } catch {
      // Contained on purpose: see the `agent/created` note above.
    }
  };

  const offCreated = ctx.on('agent/created', onAgent);
  const offLegacy = ctx.on('agent/session-start', onAgent);
  return () => {
    offCreated();
    offLegacy();
  };
}
