import {
  MINT_ENTRY_WARNING,
  describeMintEntry,
  parseMintVersion,
  resolveMintEntry,
  runMint,
} from '../mint/mint.js';
import type { MintRunResult } from '../mint/mint.js';
import { isRecord, parseDetail, parseItems } from '../mint/mint-json.js';
import { noteOwnProject } from '../mint/own-project.js';
import { sessionIdOf } from '../shared/session-id.js';
import { delegationShape, readSubagentDepth, renderOverviewDepthLine } from './subagent-depth.js';
import type { SubagentDepth } from './subagent-depth.js';
import { takeRecordGapNotice } from './session-ledger.js';
import type { AgentLike, DshContext } from '../shared/types.js';

const CONTEXT_ORDER = 60;
/** 工具指引带是 100–199（`notes/dsh/0.1.0/17-system-prompt-assembly.md`）。 */
const TOOL_GUIDANCE_ORDER = 110;
/** 没有 `systemPrompt.section` 而退回 `context()` 时用的序号。 */
const TOOL_GUIDANCE_CONTEXT_ORDER = 61;
/**
 * 概览携带多少条活跃 issue。五条与 mint 默认页大小一致，而表头写出真实总数——概览
 * 绝不能看起来像整个待办池。
 */
const TOP_ISSUES = 5;

/**
 * 指向 `mint` 宿主工具的静态指引。
 *
 * 它取代了原先注入在此处的 B-v2 提权脚本：那段文字教模型为 bash 跑 mint 而主持
 * `sandbox_permissions: danger-full-access`，是把模型推向 bash 路径的最强推力。本工具
 * 改在插件进程内执行 mint——不经 bash、不进沙箱、无需授权——所以指引就这么说。
 *
 * 这里是工具优先口径的**单一真源**：工具描述只讲机制，`skill/SKILL.md` 只讲流程，
 * 两者都不复述本句。刻意压到一句话——它每个请求都要重复。
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
   * 条目所属项目。可选，因为较旧/子集的 `list --json` 可能省略它；但这是本插件不读
   * mint 数据库而得知自己项目名的**唯一**途径。
   */
  project?: string;
}

interface OverviewMilestone {
  id: number;
  title: string;
  /** mint 没有版本的 milestone 为 `null`。 */
  version: string | null;
  status: string;
}

/** 按概览读取的字段校验一条 `list --json` 项。 */
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
 * `version` 在 mint 里可选（该列为 nullable），所以 `null` 是真实答案，不能因此把
 * milestone 从概览里丢掉：无版本的 running milestone 正是挂载建议必须点名的那一个。
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
   * 会话 cwd 解析到的项目，从 issue 行上读出。
   *
   * 项目没有 issue 时缺失（没有行可读）——那是真实的「未知」，不是「没有项目」：两个
   * 消费方（注入行与 own-project 备忘）都是可选的。
   */
  project?: string;
  /** 解析出的入口经 `-V` 报告的版本；探测失败时缺失。 */
  cliVersion?: string;
  /** 应答 `-V` 的入口短标签（构建偏斜：debug 还是 release）。 */
  cliEntry?: string;
  /**
   * CLI 答案与预期 JSON 形状不符时的说明。
   *
   * 依赖是子进程 CLI，所以 `mint-faa` 升级可以悄悄改掉一个字段名而不触发任何 import
   * 失败。没有这些说明，缩水的条目列表会渲染成一份看似合理却为空的概览；有告警才能把
   * 这种偏斜显出来而不是静默过去。
   */
  warnings?: string[];
  /**
   * `mint doctor` 的判定，仅当解析出的 CLI 能回答它时存在。
   *
   * 缺失是旧 CLI 与探测失败的常态；只有确有告警可报时，注入行才值它那几个字节。
   */
  doctor?: DoctorReport;
}

/** 概览渲染的 `doctor --json` 切片。 */
export interface DoctorReport {
  /** 发现数；`0` 表示台账健康、不注入任何行。 */
  warnings: number;
  /**
   * 各检查项的计数，键是 mint 的稳定检查名。
   *
   * mint 经有序 map 序列化这些，所以 JSON 键序是字母序而非它自己摘要行的检查顺序；
   * 因此渲染出的明细按 {@link DOCTOR_CHECKS} 自身的顺序排列。
   */
  counts: Record<string, number>;
}

/** mint 自己的检查顺序（`doctor` 摘要行）；未知检查排在它之后。 */
const DOCTOR_CHECKS: readonly string[] = [
  'multiple-running',
  'stale-plan',
  'overlap-plan',
  'idle-milestone',
  'stalled-dev',
];

/** 真正触发的检查渲染成 `stale-plan:1, stalled-dev:2`。 */
function doctorDetail(counts: Record<string, number>): string {
  const fired = (check: string): number => counts[check] ?? 0;
  const known = DOCTOR_CHECKS.filter((check) => fired(check) > 0);
  // 本插件没听说过的检查也要到达模型：这行是个指针，丢掉一个新检查就等于藏起 doctor
  // 报警的原因。
  const extra = Object.keys(counts)
    .filter((check) => !DOCTOR_CHECKS.includes(check) && fired(check) > 0)
    .sort();
  return [...known, ...extra].map((check) => `${check}:${fired(check)}`).join(', ');
}

/** 按概览读取的字段校验 `doctor --json` 载荷。 */
function isDoctorReport(value: unknown): value is DoctorReport {
  if (!isRecord(value)) return false;
  if (typeof value.warnings !== 'number') return false;
  return (
    isRecord(value.counts) &&
    Object.values(value.counts).every((count) => typeof count === 'number')
  );
}

/**
 * CLI 版本是否新到能回答 `doctor`。
 *
 * 这道闸是为了别在旧 mint 上每个会话白付一次注定失败的 spawn：`doctor` 是 0.9 线引入
 * 的，预发布后缀无关紧要（`0.9.0-alpha.1` 已经有它）。版本解析不出来时答 `false`，
 * 注入于是退化成 `doctor` 之前的样子。
 */
export function supportsDoctor(version: string): boolean {
  const [core = ''] = version.split('-', 1);
  const [major = 0, minor = 0] = core.split('.').map((part) => Number.parseInt(part, 10) || 0);
  return major > 0 || minor >= 9;
}

/**
 * 向入口询问版本。只是附加信息：`-V` 不可用时概览仍值得渲染，所以一切失败都降级成
 * `undefined`，而不是让 {@link fetchOverview} 失败。
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
 * 向 mint 询问它自己的健康检查。
 *
 * 只在 {@link supportsDoctor} 之后运行：旧 CLI 会答 `unrecognized subcommand`，而每个
 * 会话白付一次注定失败的 spawn 正是版本闸要避免的。其余失败（超时、被杀、JSON 读不出来）
 * 都是附加信息，降级为「没有 doctor 行」；只有形状不对的**格式良好** JSON 才值得一条可见
 * 说明，与其他读取的偏斜契约一致。
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
    // 只留这一行渲染的两个字段：载荷还带着逐条发现的明细，每请求的概览用不上。
    return { report: { warnings: parsed.value.warnings, counts: parsed.value.counts } };
  } catch {
    return {};
  }
}

/** 经 mint CLI 拉取活跃 issue 概览 + milestone 状态。 */
export async function fetchOverview(cwd: string, entry?: string): Promise<MintOverview> {
  // 无覆写时保持两参数调用形状：默认路径与 `mintEntry` 出现之前逐字节一致。
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
  // 项目名就挂在行本身（`"project":"dsh-mint"`）；第一个点出它的行即权威——所有行都
  // 来自同一个台账。
  const project = issues.items.find((item) => item.project !== undefined)?.project;
  if (project !== undefined) overview.project = project;
  const warnings = [issues.warning, milestones.warning].filter(
    (warning): warning is string => warning !== undefined
  );
  if (cli !== undefined) {
    overview.cliVersion = cli.version;
    if (cli.entry !== undefined) overview.cliEntry = cli.entry;
    // doctor 读取刻意串行：它以 `-V` 探测刚给出的版本为前提，所以进不了上面的并行批。
    const doctor = await probeDoctor(run, cli.version);
    if (doctor.report !== undefined) overview.doctor = doctor.report;
    if (doctor.warning !== undefined) warnings.push(doctor.warning);
  }
  if (warnings.length > 0) overview.warnings = warnings;
  return overview;
}

/** 类 semver 排序键：`[major, minor, patch, stable]`；正式版排在它的预发布之前。 */
function versionRank(version: string): number[] {
  const [core = '', pre = ''] = version.split('-', 2);
  const [major = 0, minor = 0, patch = 0] = core.split('.').map((p) => Number.parseInt(p, 10) || 0);
  return [major, minor, patch, pre ? 0 : 1];
}

/** `a` 在 {@link versionRank} 下是否高于 `b`。 */
function isNewer(a: string, b: string): boolean {
  const [ra, rb] = [versionRank(a), versionRank(b)];
  for (let i = 0; i < ra.length; i += 1) {
    const diff = (ra[i] ?? 0) - (rb[i] ?? 0);
    if (diff !== 0) return diff > 0;
  }
  return false;
}

/** 项目 milestone 里的最高版本（给「下一个版本」建议播种）。 */
export function latestVersion(milestones: readonly OverviewMilestone[]): string {
  let best = '';
  for (const milestone of milestones) {
    // 没有版本的 milestone 无从比较；它也不会把 `best` 拉低——semver 提示靠其余版本
    // 继续工作。
    if (milestone.version === null) continue;
    if (isNewer(milestone.version, best)) best = milestone.version;
  }
  return best;
}

/** 把概览渲染成紧凑的面向模型文本。 */
export function renderOverview(overview: MintOverview): string {
  const lines: string[] = [];
  // 身份行：先是解析出的项目，再是 CLI 版本。两者都可选且互相独立——`-V` 探测失败仍
  // 值得说出项目名，没有 issue 的项目也仍有 CLI 版本。
  // 项目名是会话用来判断「我是不是已经在本项目里」的依据，免得防御性地加 `-p <自己>`。
  const identity: string[] = [];
  if (overview.project !== undefined) identity.push(overview.project);
  if (overview.cliVersion !== undefined) {
    // 先给一行短信息：运行中的构建不认识的命令（“unrecognized subcommand”）否则与错别字
    // 无从区分，而光看 `-V` 也分不出 debug 构建和 release 构建。
    const via = overview.cliEntry !== undefined ? ` via ${overview.cliEntry}` : '';
    identity.push(`mint ${overview.cliVersion}${via}`);
  }
  if (identity.length > 0) lines.push(`[Mint] ${identity.join(' · ')}`);
  // 把 CLI 形状不符显出来，而不是让它读成「没有 issue」。
  for (const warning of overview.warnings ?? []) {
    lines.push(`[Mint] WARNING: ${warning}`);
  }
  // 台账自身健康检查只占一行，且只在有可报内容时出现：常驻行是每请求的成本而无信号，
  // 而零告警是常态。计数保持 mint 自己的检查顺序（见 {@link DoctorReport}）。
  const doctor = overview.doctor;
  if (doctor !== undefined && doctor.warnings > 0) {
    const detail = doctorDetail(doctor.counts);
    const suffix = detail === '' ? '' : ` (${detail})`;
    lines.push(
      `[Mint] doctor: ${doctor.warnings} health warning${doctor.warnings === 1 ? '' : 's'}${suffix} — ` +
        'mint({args:["doctor","--json"]})'
    );
  }
  // 按 (priority, id) 取前 N——显式排序，让「前 N」这个说法不依赖 mint 的默认顺序。
  // 刻意不写 labels：一次工具调用就能拿到，而它们每行最费字节。
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
    // 恰好一个当前 milestone：显式点明默认挂载目标（推理归 skill，这一行是每个请求都能
    // 看到的东西）。
    const label = current.version || current.title;
    lines.push(
      `[Mint] milestone ${label} (id ${current.id}) running — new plans/standalone issues ` +
        `attach to it: mint({args:["milestone","attach","${current.id}","<id>"]}); ` +
        `plan create --milestone ${current.id}`
    );
  } else if (running.length >= 2) {
    // 两个 running milestone 已不再是「手工修一下」：自 mint 0.9.0 起 CLI 会拒绝任何会
    // 再加一个的写操作，`--force` 是唯一的逃生口。注入行不得叫模型重开 milestone，因为
    // CLI 自己的回答是「去问用户是否要并行版本」；迁移路线留作非并行选项。
    const names = running.map((m) => m.version || m.title).join(', ');
    lines.push(
      `[Mint] WARNING: ${running.length} running milestones (${names}) — the CLI now refuses ` +
        'to start another without --force; ask the user whether parallel versions are intended ' +
        '(mint({args:["milestone","set","<id>","--status","running","--force"]})) or migrate the ' +
        'extra work and set it open'
    );
  } else if (overview.milestones.length > 0) {
    const latest = latestVersion(overview.milestones);
    // 任何地方都没有版本时就丢掉这个括号，别打印出 "(latest )"。
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
 * 会话离开计划模式却什么都没登记时的一次性概览行。
 *
 * mint 写台账提醒挂在 `exit_plan_mode` 的工具结果上，所以以别的方式离开计划模式的会话
 * （`/plan off`、GUI 开关）原本一点信号都没有——而那是主机提供的退出方式，不是跳过记录的
 * 理由。这行正是那条路径在注入侧的载体；它必须短（是条件行，不是流程），并且指向 skill
 * 而不是复述它。
 */
export const RECORD_GAP_LINE =
  '[Mint] 本会话已离开计划模式且尚无 mint 写操作——离开计划模式不等于已登记；' +
  '要改码先按 mint skill 补登记（plan create/attach + 拆 issue），首个 issue 先 state start。';

/**
 * 在 agent 作用域的 ctx 上注册 mint 的提示词贡献：活跃概览 + 静态的工具优先指引。
 *
 * 概览是动态的（反映实时 mint 数据库），所以留作每次装配都跑的 `context()` provider，
 * 每会话只加载一次，失败时静默降级为空串。指引是静态的且属于工具指引带，所以注册成
 * `section()`——稳定前缀对 KV 缓存复用远比每请求重复的 runtime-context 快照友好。没有
 * `section` 的主机退回 `context()`，文本相同。
 *
 * `cwd` 是会话语境（项目）目录，mint 用它做项目查找。`sessionId`（主机给了的话）是
 * record-gap 行的键；没有它那行永不渲染。
 *
 * `depthProbe` 是宿主委派深度的探针（缺省用 `agentCtx` 自己读）。它被抽成参数是因为
 * 概览装在 **agent 的 ctx** 上，而 `subagents` 服务装在**根 ctx** 上：装配处
 * （{@link installOverviewChannel}）显式传根 ctx 的探针，旧调用点则零改动。
 * 探针是同步的（`text()` 同步渲染），且**每次装配现读**：用户在 GUI 改完设置，
 * 下一次请求就准。
 */
export function registerMintContext(
  agentCtx: DshContext,
  cwd: string,
  entry?: string,
  sessionId?: string,
  depthProbe?: () => SubagentDepth
): (() => void) | undefined {
  const sp = agentCtx.systemPrompt;
  if (!sp) return undefined;

  const probeDepth = depthProbe ?? (() => readSubagentDepth(agentCtx));

  let cached = '';
  let started = false;

  const load = async (): Promise<void> => {
    // 先单独解析入口：入口解析不了是会话能应对的插件侧故障，不是空项目——在这里保持
    // 沉默曾让 `Cannot find module` 看起来像「没有 issue」。
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
      // 记住这个目录*是*哪个项目，好让 `-p <自己>` 被认成本项目工作而不是跨项目写。
      // 键用挂载行的 `entry`，与门禁探测用的是同一个键。
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
      // 空 body 意味着 mint 读不出来：此时空串（或入口 WARNING 行）才是可行动信号，
      // 不要再叠一条降级说明。降级行每次都现读——宿主设置改完下一次请求就准。
      if (cached === '') return cached;
      const depthLine = renderOverviewDepthLine(delegationShape(probeDepth()));
      // 缓存的 body 只加载一次；record-gap 行是叠在它之上的每次装配条件（并在此消费它
      // 的一次性额度，与退出提醒「只说一次」的语义一致）。降级行在 body 之后、record-gap
      // 行之前：它是宿主事实，比「本会话尚未登记」更基础，也不吃 record-gap 的一次性额度。
      const gap = takeRecordGapNotice(sessionId);
      const parts = [cached];
      if (depthLine !== '') parts.push(depthLine);
      if (gap) parts.push(RECORD_GAP_LINE);
      return parts.join('\n');
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
 * 通道记住多少个会话 id；与其它有界会话表（审批授权、跨项目授权）一致。
 */
const MAX_REGISTERED_SESSIONS = 100;

/**
 * 注册概览/指引通道。
 *
 * 宿主的生命周期事件是 **`agent/created`**（载荷 `{ agent, source, signal? }`，
 * `dsh-agent` 的 `Registry.announce`）。本插件在 0.2.0 期间用的名字
 * `agent/session-start` 在 0.2.0-rc.2 的任何 harness 包里都没被发布，于是监听器从未运行，
 * 概览与工具优先指引也从未到达任何会话。旧名字仍为确实发布它的主机保留；两个事件由同一个
 * 函数处理。
 *
 * 三道守卫，各带理由：
 *
 * - **按会话 id 去重。** 两个事件可能为同一个会话各触发一次；注册两次就会重复注入概览与
 *   指引。id 只在 agent 已有可注册的 `systemPrompt` 时才被消费，所以来得太早的事件不会
 *   烧掉这个会话。
 * - **跳过子代理。** 概览每会话要三次 mint spawn 外加一个每请求 section，而子代理已经继承
 *   `mint` 工具：它的会话头带 `delegationDepth > 0`（`origin: 'subagent'`）。
 * - **绝不抛错。** `agent/created` 是*串行*事件——抛错的监听器会否决 agent 创建本身。
 *   缺少概览是可接受的失败。
 */
export function installOverviewChannel(ctx: DshContext, entry?: string): () => void {
  const registered = new Set<string>();

  const onAgent = (payload: { agent?: AgentLike }): void => {
    try {
      const agent = payload?.agent;
      const cwd = agent?.session?.header?.cwd;
      if (agent === undefined || !agent.ctx || cwd === undefined) return;
      if ((agent.session.header.delegationDepth ?? 0) > 0) return;
      // 没有服务就注册会静默什么都不做，更糟的是把会话标成已处理，所以等宿主交出来。
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
      registerMintContext(agent.ctx, cwd, entry, sessionId, () => readSubagentDepth(ctx));
    } catch {
      // 刻意兜住：理由见上面 `agent/created` 那段。
    }
  };

  const offCreated = ctx.on('agent/created', onAgent);
  const offLegacy = ctx.on('agent/session-start', onAgent);
  return () => {
    offCreated();
    offLegacy();
  };
}
