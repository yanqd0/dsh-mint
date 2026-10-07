/**
 * Minimal structural types for the DSH host surface.
 *
 * The host provides these services at runtime; we deliberately avoid importing
 * the closed-source `@deepseek-ai/*` type packages, so these are structural
 * approximations (supersets are accepted by the host, subsets are what we
 * consume). Verify against the live host with `cordis_inspect_*` at load time.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

/** Subset of a host text content block. */
export interface ContentBlockLike {
  type: 'text';
  text: string;
}

/** Subset of the host's `ToolExecution` (bash tool: name 'bash', args.command). */
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
         * `> 0` for a subagent session (#113). The todo dock (#119) belongs to
         * the root agent's session, so the reminder skips delegated ones.
         */
        delegationDepth?: number;
        /**
         * The session that delegated this one, absent at the top. The plan DAG
         * (plan #31) walks it upward so a subagent writes the graph its main
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

/** Subset of the host's `ToolExecutionResult`. */
export interface ToolResultLike {
  isError: boolean;
  error?: { message?: string };
  content: ContentBlockLike[];
}

/** Subset of the host's `PostToolDecision` (enrich = accept + content). */
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

/** Subset of the host's `systemPrompt` service. */
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
  ctx: DshContext;
  session: {
    id?: string;
    header: {
      cwd?: string;
      /**
       * `0` or absent for a top-level session, `> 0` for a subagent session —
       * the injection channel uses it to skip subagents (#113).
       */
      delegationDepth?: number;
      /**
       * The session that delegated this one, absent at the top — the edge the
       * plan DAG's root-session walk follows (plan #31).
       */
      parentSession?: string;
    };
  };
}

/**
 * The host's `subagent/start` payload (plan #31).
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
 * outcome available when a subagent died before reporting one (plan #31 §3).
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

/** Subset of the host's `ApprovalOutcome`. */
export type ApprovalOutcomeLike = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable';

/**
 * Subset of the host `Session` seen by `session/event` (#116).
 *
 * Unlike {@link AgentLike}, the host hands the session itself to the listener,
 * so `id` and the durable `header` are read off it directly.
 */
export interface SessionLike {
  id?: string;
  header?: { cwd?: string; delegationDepth?: number };
}

/**
 * Subset of the host `SessionEvent` (#116).
 *
 * Only the plan-mode exit is consumed, and the event map entry it reads is
 * `{'plan/mode': {active: boolean}}` (`@deepseek-ai/dsh-plan-mode`). Every other
 * event fails the `type` comparison and costs nothing.
 */
export interface SessionEventLike {
  type?: string;
  data?: { active?: boolean };
}

/** Structural listener union for the events dsh-mint consumes. */
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
 * are the delegation chain the DAG's root-session walk reads (plan #31).
 */
export interface AgentCwdLike {
  id?: string;
  session: { header: { cwd?: string; parentSession?: string } };
}

/** Subset of the host's `ctx.agents` service. */
export interface AgentsLike {
  get(id: string): AgentCwdLike | undefined;
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
