/**
 * 宿主 mint 查询路由（`src/routes.ts`）与浏览器半边（`src/client/*`）共用的线格式。
 *
 * 只有类型、无产物：宿主 bundle 与 client bundle 靠一份声明对齐，二者之间不留运行时边；
 * 字段名镜像 mint CLI 的 `--json` 输出，由 `src/mint-json.ts` 的守卫校验。
 */

export interface IssueItem {
  id: number;
  title: string;
  kind: string;
  status: string;
  priority: number;
  labels: string[];
  /** Owning plan, or `null` for a standalone issue. */
  plan_id: number | null;
  /**
   * 该 issue 的「有效 milestone」：自己直挂的优先，否则取所属 plan 的。
   *
   * **可选是刻意的**：这个字段比多数安装实际解析到的 CLI 新——它随 mint
   * 0.9.0-alpha.1 才有，已发布的 `mint-faa`（0.8.1）根本不返回该键。所以字段缺失
   * 代表「老 CLI」而非形状漂移：读取方退化回经 plan 表解析，绝不因整页 issue 丢了
   * 一个可选字段就全丢。`null` 表示确实没有有效 milestone。
   */
  milestone_id?: number | null;
  /**
   * {@link milestone_id} 是 issue 自己直挂的（`true`）还是经其 plan 得到的
   * （`false`）。可选原因同 {@link milestone_id}：老 CLI 两个键都不返回。
   */
  milestone_direct?: boolean;
  /** Typed links; each element reaches the panel unvalidated (see `describeLink`). */
  links: unknown[];
  created_at: string;
  updated_at: string;
}

export interface IssueDetail extends IssueItem {
  /**
   * The issue's markdown body, or `null` when it was created without one (mint
   * serializes the column's `Option`). The route truncates a string at its byte
   * budget; the panel renders both `null` and `''` as "no body".
   */
  body: string | null;
  /**
   * 这里**始终**有值：`show --json` 早在 list 读也带上它之前就返回了该字段，
   * 这行声明只是把它重新收紧成必到。
   */
  milestone_id: number | null;
  uid?: string;
  test_cmd?: string | null;
}

export interface PlanItem {
  id: number;
  title: string;
  status: string;
  /**
   * The plan's version, which follows its milestone: a plan attached to no
   * milestone answers `null`.
   */
  version: string | null;
  milestone_id: number | null;
  issue_count: number;
  created_at: string;
  updated_at: string;
}

export interface MilestoneItem {
  id: number;
  title: string;
  status: string;
  /** `null` for a milestone created without a version. */
  version: string | null;
  issue_count: number;
  created_at: string;
  updated_at: string;
}

/** label 的颜色只在这里出现，issue 上从不带。 */
export interface LabelItem {
  id: number;
  name: string;
  /**
   * The recorded `#rrggbb` value the panel tints the label's badge with, or
   * `null` for a label mint has no color for — the panel falls back to a neutral
   * chip instead of losing the label.
   */
  color: string | null;
  description: string | null;
  issue_count: number;
  created_at: string;
  updated_at: string;
}

/**
 * 面板的字典表：一次读齐，而不是每行读一遍。
 *
 * `list --json` 既不带 label 颜色、也不带 plan 版本，故宿主在这里补齐这两本字典；
 * issue 归属自 mint 0.9.0-alpha.1 起直接写在每个 issue 的 `milestone_id` /
 * `milestone_direct` 上，本 payload 只剩字典。
 */
export interface MintMetaPayload {
  ok: true;
  plans: PlanItem[];
  milestones: MilestoneItem[];
  labels: LabelItem[];
  /** Shape-drift and partial-read notices the panel shows instead of guessing. */
  warnings?: string[];
}

export interface ContainerChild {
  id: number;
  title: string;
  kind: string;
  status: string;
}

export interface ContainerDetail {
  id: number;
  title: string;
  status: string;
  /** `null` for a plan whose milestone is absent (the version comes from it). */
  version: string | null;
  milestone_id: number | null;
  /** `null` when the container was created without a body. */
  body: string | null;
  issues: ContainerChild[];
  created_at: string;
  updated_at: string;
}

/** The envelope every `list` route answers with. */
export interface MintListPayload<T> {
  ok: true;
  items: T[];
  page: number;
  page_size: number;
  pages: number;
  total: number;
  /** Shape-drift notices; the panel shows them instead of pretending emptiness is real. */
  warnings?: string[];
}

/** `issue show <id> --json`：整条 issue，含 list 不返回的 body。 */
export interface MintIssuePayload {
  ok: true;
  item: IssueDetail;
  /** True when the body hit the route's byte budget. */
  truncated: boolean;
}

/** `plan show` / `milestone show`, discriminated by which key the kind fills. */
export type MintDetailPayload<T> = ({ ok: true } & { plan: T }) | ({ ok: true } & { milestone: T });

/** Any route's refusal: a dead session, a bad parameter, or a mint CLI failure. */
export interface MintFailurePayload {
  ok: false;
  error: string;
  stderr?: string;
}

/** What the panel must handle from any route: a success payload or a refusal. */
export type MintResponse<T extends { ok: true }> = T | MintFailurePayload;

/**
 * plan DAG 的线格式：宿主 `/dsh-mint/dag` 路由与渲染它的浏览器半边共用一份声明。
 *
 * 文档在 `/tmp/mint/dag/<sessionId>.json`，面板是这条路由答案的纯函数；宿主侧文档
 * （`src/dag.ts`）在 {@link DagView} 之上另加自己的归属字段。
 */

export type DagPhase = 'research' | 'exec' | 'post';

export type DagStatus = 'pending' | 'running' | 'done';

/**
 * A settled node's outcome — success or a refuted direction.
 *
 * Only meaningful with `status: 'done'`: the host refuses a verdict on a
 * non-terminal node, so the panel can read the two fields without guessing.
 */
export type DagVerdict = 'pass' | 'fail';

/**
 * 节点工作树的去处：`active` 存在且分支尚未合入；`merged` 分支已在**目标分支**里
 * （建树时签出的那条，工作树可能仍在）；`conflict` 合并停在冲突上待裁决；`removed`
 * 工作树已不在（先合后删，或手工删除）。
 */
export type DagWorktreeState = 'active' | 'merged' | 'conflict' | 'removed';

/**
 * plan 的并行 issue 开发所用的节点级 git worktree：一个节点至多一个，基于一个 commit。
 *
 * 它是**协作**边界而非安全边界：子代理的文件沙箱仍是会话工作区，隔离来自工作路径
 * （工作区内的 `.worktrees/`）与文件白名单，不来自围栏。
 */
export interface DagWorktree {
  /** 绝对路径：`<common git dir>/dsh-mint/worktrees/<session-slug>/<node>`。 */
  path: string;
  branch: string;
  /** The commit the worktree (and its branch) started from. */
  base: string;
  state: DagWorktreeState;
  /** Short commit the merge produced **on the target branch**, once `merged`. */
  merged_sha?: string;
  /** 建树时所在的分支名（开工点的工作分支）；detached 时为 'HEAD'。 */
  target?: string;
}

export interface DagNodeView {
  id: string;
  /** Short label drawn inside the node (≤6 code points, enforced by the host). */
  label: string;
  /** Full title, shown in the hover tooltip. */
  title: string;
  phase: DagPhase;
  status: DagStatus;
  /** Present only for a settled node. */
  verdict?: DagVerdict;
  /** Predecessors: the nodes this one waits for. */
  depends_on: string[];
  /** mint issue this node tracks, when it tracks one. */
  issue?: number;
  /** Subagent session id, backfilled by the host's `subagent/start` pairing. */
  agent?: string;
  /** 该节点的 token 数：模型自报，或宿主测到该节点时由实测值覆盖（见 {@link DagNodeMetrics}）。 */
  tokens?: number;
  /** The conclusion text a node's own agent reported (tooltip, scrollable). */
  note?: string;
  /** The node's isolated working tree, when one was created. */
  worktree?: DagWorktree;
  updated_at: string;
}

/** One node's host-measured usage, absent when the host cannot read it (never a zero guess). */
export interface DagNodeMetrics {
  /**
   * 该子会话四桶的**和**（下面四个桶字段相加）。
   *
   * 只为向后兼容保留：**它不是成本代理**——命中（`cache_read`）与未命中（`uncached_input`）
   * 的单价相差约 50 倍，同一个和可以对应差很多的账单，要读成本得分开看四桶。
   */
  tokens?: number;
  /** 未命中缓存的输入 token（宿主投影 `uncachedInputTokens`），四桶之一。 */
  uncached_input?: number;
  /** 命中缓存的输入 token（宿主投影 `cacheReadTokens`），四桶之一；单价远低于未命中。 */
  cache_read?: number;
  /** 写入缓存的输入 token（宿主投影 `cacheWriteTokens`），四桶之一。 */
  cache_write?: number;
  /** 输出 token（宿主投影 `outputTokens`；推理 token 含在其中）。 */
  output?: number;
  /**
   * 当前上下文占用（宿主 `contextPressure.pressureTokens`：最近一次请求的提示词大小，
   * 即未命中 + 命中 + 缓存写，**不含输出**）。
   *
   * 与 {@link tokens} **不是同一把尺子**，故两个字段并存：`tokens` 是整条日志累计用掉的量
   * （账单口径），`context` 是此刻留在上下文里的量（窗口口径）。provider 没报过 usage 时
   * 它缺席——那是「读不到」，不是 0。该键没注册时退回 `tokenUsage.last.buckets` 的三桶之和
   * （同一语义、同一次请求的四桶），两者都读不到就整项不发。
   */
  context?: number;
  /**
   * 该会话已结算的步数（`sessionStats.steps`，即 `step/end` 计数）。
   *
   * 步数×留存上下文才是成本的主项，故它与四桶一起落：`tokens` 只说明「多大」，
   * 步数说明「为什么这么大」。
   */
  steps?: number;
  /** Active-turn duration in milliseconds, from the host's own timing projection. */
  elapsed_ms?: number;
  /**
   * Epoch ms the host sampled this entry at — present only on a stored sample
   * (a live one carries the answer's `sampled_at`).
   */
  at?: number;
  /**
   * **只在客户端内部用**：子代理树那一行标签的指纹。
   *
   * 它存在的唯一理由是轮询守卫要比「这一行变了没有」——label 是那行最显眼的文本，改它必须
   * 触发重渲。宿主从不发布它，落盘样本也从不携带它（`sampleOf` 逐字段白名单会丢掉）。
   */
  agentTag?: number;
}

/**
 * One plan DAG as the route publishes it.
 *
 * `edges` are `[from, to]` pairs meaning **`to` depends on `from`** — the same
 * direction as {@link DagNodeView.depends_on}.
 */
export interface DagView {
  title: string;
  /** Increments on every write; the panel re-renders only when it changes. */
  revision: number;
  created_at: string;
  updated_at: string;
  nodes: DagNodeView[];
  edges: [string, string][];
}

/**
 * `GET /dsh-mint/dag` — the panel's whole view.
 *
 * A missing file is the normal "no DAG in this session" state (`dag: null`,
 * no warnings); an unreadable one is the same empty `dag` plus a `warnings`
 * entry, so the panel can name the file it could not read instead of going
 * blank.
 */
export interface MintDagPayload {
  ok: true;
  dag: DagView | null;
  /** The answered revision (`0` when there is no readable DAG). */
  revision: number;
  /** Absolute path the answer came from; shown in the empty/unreadable states. */
  file: string;
  /** Mount-line `openDagTab`: whether the client should auto-open the panel. */
  autoOpen: boolean;
  /** Per-node live metrics, keyed by node id; absent when the host read nothing. */
  metrics?: Record<string, DagNodeMetrics>;
  /** The host clock (epoch ms) every metric in this answer was sampled at. */
  sampled_at?: number;
  warnings?: string[];
}

/**
 * 子代理树的一个节点：根会话（`main`）或它下面的某一级子代理。
 *
 * 形状是**扁平数组 + `parent`**，不是嵌套树：面板要按类型（行/图）自己排版，而嵌套结构会
 * 把「父节点缺一条读数」「某个 id 重复出现」这类坏数据的处理塞进序列化里。根节点的
 * `parent` 缺席——它没有上一层。
 */
export interface AgentNodeView {
  /** 会话 id：根会话的 id，或某个子代理的子会话 id（`DagNodeView.agent` 是同一个键）。 */
  id: string;
  kind: 'main' | 'subagent';
  /** 上一层会话 id；缺席即根。 */
  parent?: string;
  /** 0 起算的层号：根是 0，一级子代理是 1。 */
  depth: number;
  /** 派发时的 description；子代理可能没带 label，此时宿主退回短 id。 */
  label: string;
  /** 宿主的派发形态；读不出来时缺席（`unknown` 的条目根本不进这个数组）。 */
  mode?: 'one-shot' | 'continuable';
  /**
   * 该子会话此刻是否真的有活 agent（`agents.get(id)?.status === 'running'`）。
   *
   * 已结束的子代理仍在 catalog 里（catalog 是父会话的持久事实），故 `running: false`
   * 与「没量到读数」是两件事，面板要分开画。
   */
  running: boolean;
  /** 宿主记下的会话创建时刻（epoch ms）；读不到就缺席。 */
  seenAt?: number;
  /** 宿主实测读数；只含真读到的字段（`main` 不含 `tokens`，见 `notes/agent-tree.md`）。 */
  metrics?: DagNodeMetrics;
}

/**
 * `GET /dsh-mint/agents` — 子代理树这一视图的整个答案。
 *
 * 数据**live 优先、快照兜底**：宿主内存里的注册表与投影读得到东西时，就是此刻的真树；读不到
 * （会话已结束、注册表塌了、宿主重启过）时退回上一次落盘的按会话文档，此时答案带上 `file`（文档
 * 路径）、`revision`（文档版本）与 `stale`（这套节点是旧值），`sampled_at` 也换成那份文档的采样钟。
 * 两条路都读不到才是空树。
 */
export interface MintAgentsPayload {
  ok: true;
  /** 先序：根在前，子级紧随其父；已按宿主 catalog 的事件顺序排列。 */
  nodes: AgentNodeView[];
  counts: { total: number; running: number; unsupported: number };
  /** The host clock (epoch ms) every metric in this answer was sampled at. */
  sampled_at: number;
  /**
   * 兜底快照的文档版本；live 答案恒为 `0`（这份数据不落盘，没有版本可言）。
   *
   * 快照的 `revision` 只在树真的变了时才前进，所以面板能靠它跳过白重渲。
   */
  revision?: number;
  /** 这次答案来自哪份文档（兜底时才有）；面板据此指明「读的是哪个文件」。 */
  file?: string;
  /**
   * 这套节点取自快照而非此刻的宿主：`running` 已按「已结束」下发。
   *
   * 缺席即 live 答案。面板据此给出一行「会话已结束」的说明，而不是把旧值冒充现状。
   */
  stale?: boolean;
  warnings?: string[];
}
