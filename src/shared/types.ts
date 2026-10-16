/**
 * DSH 宿主面的最小结构类型：刻意不 import 闭源的 `@deepseek-ai/*` 类型包，只用结构近似
 * ——宿主给的是超集，这里只声明消费到的子集。
 *
 * 与真实宿主的核对以加载期的 `cordis_inspect_*` 为准。
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export interface ContentBlockLike {
  type: 'text';
  text: string;
}

/** 宿主 `ToolExecution` 的子集；bash 工具形如 name='bash' 加 args.command。 */
export interface ToolExecutionLike {
  name: string;
  /** Opaque call identity used to correlate executions with approval asks. */
  callId?: string;
  arguments: { command?: string } & Record<string, unknown>;
  agent?: {
    session?: {
      id?: string;
      header?: {
        cwd?: string;
        /**
         * `> 0` for a subagent session. The todo dock belongs to
         * the root agent's session, so the reminder skips delegated ones.
         */
        delegationDepth?: number;
        /**
         * The session that delegated this one, absent at the top. The plan DAG
         * walks it upward so a subagent writes the graph its main
         * session's panel draws.
         */
        parentSession?: string;
      };
    };
  };
  /**
   * Cooperative cancellation. Tool bodies are expected to observe and forward
   * it; the host only signals (`notes/dsh/0.1.0/06,20`).
   */
  signal?: AbortSignal;
}

export interface ToolResultLike {
  isError: boolean;
  error?: { message?: string };
  content: ContentBlockLike[];
}

/** 宿主 `PostToolDecision` 的子集；enrich 即 accept 加 content。 */
export interface PostToolDecisionLike {
  kind: 'accept' | 'block';
  content?: ContentBlockLike[];
  feedback?: ContentBlockLike[];
}

/**
 * Subset of the host's `PreToolDecision`.
 *
 * `displayReason` is presentation-only (localized prompt copy, never audited);
 * `en` is required by the host's locale resolution, extra keys are locales.
 */
export interface PreToolDecisionLike {
  kind: 'allow' | 'deny' | 'ask';
  reason?: string;
  displayReason?: { en: string; [locale: string]: string };
}

/** Subset of the host's tool registry (`ctx.tools`). */
export interface ToolDefinitionLike {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  output: {
    schema: Record<string, unknown>;
    render: (args: unknown, value: unknown) => ContentBlockLike[];
  };
  execute: (args: unknown, exec: ToolExecutionLike) => Promise<unknown>;
}

export interface ToolsLike {
  register(definition: ToolDefinitionLike): () => void;
}

/** A system-prompt section registration (`dsh-system-prompt`). */
export interface SystemPromptSectionSpec {
  name: string;
  /** Sections render in ascending order; tool guidance belongs in 100–199. */
  order: number;
  text: string;
}

export interface SystemPromptLike {
  context(spec: { name: string; order: number; text: string | (() => string) }): () => void;
  /**
   * Static prompt section. Optional: older/leaner hosts may not expose it, in
   * which case callers fall back to `context()`.
   */
  section?(spec: SystemPromptSectionSpec): () => void;
}

/** Subset of the host `Agent` published by `agent/created` (and `agent/session-start`). */
export interface AgentLike {
  /** Session id, shared by the agent and its session (the session-scoped key). */
  id?: string;
  /**
   * The live lifecycle state the host mirrors on every `agent/status` transition.
   * Optional so older/leaner hosts (and the unit-test doubles) keep working; a
   * reader that needs it then degrades to "not running".
   */
  status?: AgentStatusLike;
  ctx: DshContext;
  session: {
    id?: string;
    header: {
      cwd?: string;
      /**
       * `0` or absent for a top-level session, `> 0` for a subagent session —
       * the injection channel uses it to skip subagents.
       */
      delegationDepth?: number;
      /**
       * The session that delegated this one, absent at the top — the edge the
       * plan DAG's root-session walk follows.
       */
      parentSession?: string;
    };
  };
}

/**
 * The host's `subagent/start` payload.
 *
 * `id` is the child **session** id (what a DAG node's `agent` records); `runId`
 * identifies the run itself and is what pairs `start` with `end`.
 */
export interface SubagentRunInfoLike {
  runId: string;
  id: string;
  provider?: string;
  local?: boolean;
}

/**
 * The host's `subagent/end` payload: the start payload plus how the run ended.
 *
 * `stopReason` is the host's own wording (`error`, `cancelled`, …) and
 * `lastAssistantMessage` the child's final message — together they are the only
 * outcome available when a subagent died before reporting one (spec:
 * `notes/plan-dag.md`).
 */
export interface SubagentRunEndInfoLike extends SubagentRunInfoLike {
  stopReason?: string;
  lastAssistantMessage?: readonly unknown[];
}

/** Subset of the host's `ApprovalRequest` (approval/request waterfall). */
export interface ApprovalRequestLike {
  toolName: string;
  callId?: string | undefined;
  reason?: string | undefined;
  agent?: unknown;
  signal?: unknown;
}

export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * Subset of the host `Session` seen by `session/event`.
 *
 * Unlike {@link AgentLike}, the host hands the session itself to the listener,
 * so `id` and the durable `header` are read off it directly.
 */
export interface SessionLike {
  id?: string;
  header?: { cwd?: string; delegationDepth?: number };
}

/**
 * Subset of the host `SessionEvent`.
 *
 * Only the plan-mode exit is consumed, and the event map entry it reads is
 * `{'plan/mode': {active: boolean}}` (`@deepseek-ai/dsh-plan-mode`). Every other
 * event fails the `type` comparison and costs nothing.
 */
export interface SessionEventLike {
  type?: string;
  data?: { active?: boolean };
}

export type EventListener =
  | ((payload: { agent?: AgentLike }) => void)
  | ((session: SessionLike, event: SessionEventLike) => void)
  | ((
      exec: ToolExecutionLike,
      next: () => Promise<PreToolDecisionLike>
    ) => Promise<PreToolDecisionLike>)
  | ((
      exec: ToolExecutionLike,
      result: ToolResultLike,
      next: () => Promise<PostToolDecisionLike>
    ) => Promise<PostToolDecisionLike>)
  | ((exec: ToolExecutionLike, result: ToolResultLike) => void)
  | ((info: SubagentRunInfoLike) => void)
  | ((info: SubagentRunEndInfoLike) => void)
  | ((
      req: ApprovalRequestLike,
      next: () => Promise<ApprovalOutcomeLike>
    ) => Promise<ApprovalOutcomeLike>);

/**
 * Agent-scoped context received by event listeners (host `Agent.ctx`).
 * Registration here is agent-local and unwinds on disposal.
 */
export interface DshContext {
  on(event: string, listener: EventListener, options?: { prepend?: boolean }): () => void;
  systemPrompt?: SystemPromptLike;
  tools?: ToolsLike;
  /**
   * Optional service lookup. Absent on lean contexts and on the unit-test mocks,
   * so callers must null-check both the method and its result, narrowing the
   * `unknown` it returns to the structural slice they consume.
   */
  get?(name: string): unknown;
  /**
   * Run `callback` once the named services exist, without gating the rest of
   * `apply` — the pattern for a capability only some compositions provide.
   */
  inject?(services: readonly string[], callback: (ctx: DshContext) => void): void;
  /** Own an effect for this plugin's lifetime; the returned disposer unwinds it. */
  effect?(callback: () => (() => void) | void, label?: string): () => void;
  /** Live agents by session id, used to resolve a session's project directory. */
  agents?: AgentsLike;
  /** The browser HTTP carrier, present only in compositions that serve a page. */
  webServer?: WebServerLike;
}

/**
 * The slice of a live Agent the client-face routes and the plan DAG need.
 *
 * `session.header.cwd` is where the agent's project lives; `id`/`parentSession`
 * are the delegation chain the DAG's root-session walk reads.
 */
export interface AgentCwdLike {
  id?: string;
  session: {
    /**
     * 会话身份稳定键（`sessionIdOf` 读的就是它）：宿主每次派发都可能换一个 Agent
     * 对象，只有 session id 稳定，故一切会话级决策都以它为键。
     */
    id?: string;
    header: {
      cwd?: string;
      parentSession?: string;
      /** When the session was created, epoch ms. */
      createdAt?: number;
    };
  };
}

/** Subset of the host's `ctx.sessionProjections` registry (dsh-session-projection). */
export interface SessionProjectionsLike {
  /** One unit's live host state; `undefined` when the key is not registered. */
  stateOf(session: unknown, key: string): unknown;
  /**
   * wire view 取数口：答 `{asOfSeq, values}`，`values[key]` 是过 `viewSchema` 的 wire view；
   * unit 未定义 `wire` 段时不出现（那时 `stateOf` 的 state 就是 view）。缺失即该宿主读不到 wire 投影。
   */
  snapshot?(session: unknown, keys?: readonly string[]): unknown;
}

/** Subset of the host's `ctx.agents` service. */
export interface AgentsLike {
  get(id: string): AgentCwdLike | undefined;
  /**
   * Every live agent, in registration order. Optional: a lean composition (or a
   * test double) may publish `get` alone, and callers then fall back to it.
   */
  list?(): readonly unknown[];
}

/**
 * The host `Agent`'s live lifecycle state.
 *
 * `running` means a driver is active for that session; `idle` means it settled
 * and no work is scheduled. It is the host's own answer to "is this subagent
 * still doing something", which is exactly what the subagent tree draws.
 */
export type AgentStatusLike = 'idle' | 'running';

/**
 * One live session as the host's registry publishes it.
 *
 * The two registries answer different shapes for the same id — `agents.get`
 * gives an Agent carrying `{ session }` (and often *is* the session), while
 * `sessions.get` gives the session itself — so callers normalize both.
 */
export interface AgentSessionLike {
  header: {
    id?: string;
    parentSession?: string;
    createdAt?: number;
  };
}

/** Subset of the host's `ctx.sessions` service (`dsh-session`'s store). */
export interface SessionsLike {
  get(id: string): unknown;
}

/**
 * One route on the host's browser HTTP carrier (`ctx.webServer`).
 *
 * `kind: 'prefix'` claims every path under `path`; a duplicate `(kind, path)`
 * registration throws, because route patterns are a composition-level contract.
 */
export interface WebRouteLike {
  kind: 'exact' | 'prefix';
  path: string;
  handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>;
}

/** Subset of the host's `ctx.webServer` service (`dsh-host-webserver`). */
export interface WebServerLike {
  register(route: WebRouteLike): () => void;
}
