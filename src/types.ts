/**
 * Minimal structural types for the DSH host surface.
 *
 * The host provides these services at runtime; we deliberately avoid importing
 * the closed-source `@deepseek-ai/*` type packages, so these are structural
 * approximations (supersets are accepted by the host, subsets are what we
 * consume). Verify against the live host with `cordis_inspect_*` at load time.
 */

/** Subset of the host's `CollectedOutput`. */
interface CollectedOutputLike {
  text: string;
}

/** Subset of the host's `ShellRunResult`. */
export interface ShellRunResultLike {
  exitCode: number | null;
  stdout: CollectedOutputLike;
  stderr: CollectedOutputLike;
}

/** Subset of the host's resolved `ShellExecSpec`. */
export interface ShellSpecLike {
  command: string;
  workdir: string;
  timeoutMs: number;
}

/** Subset of the host's `ctx.shell` (ShellExecutor). */
export interface ShellLike {
  resolve(request: { command: string; timeoutMs?: number }): ShellSpecLike;
  run(spec: ShellSpecLike): Promise<ShellRunResultLike>;
}

/** Subset of the host's `systemPrompt` service. */
export interface SystemPromptLike {
  context(spec: { name: string; order: number; text: string | (() => string) }): () => void;
}

/** Subset of a host text content block. */
export interface ContentBlockLike {
  type: 'text';
  text: string;
}

/** Subset of the host's `ToolExecution` (bash tool: name 'bash', args.command). */
export interface ToolExecutionLike {
  name: string;
  arguments: { command?: string } & Record<string, unknown>;
  agent?: { ctx?: Pick<DshContext, 'shell'> };
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

/** Subset of the host's `PreToolDecision`. */
export interface PreToolDecisionLike {
  kind: 'allow' | 'deny' | 'ask';
  reason?: string;
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
  execute: (args: unknown) => Promise<unknown>;
}

export interface ToolsLike {
  register(definition: ToolDefinitionLike): () => void;
}

/** Structural listener union for the events dsh-mint consumes. */
export type EventListener =
  | ((payload: { ctx?: DshContext }) => void)
  | ((
      exec: ToolExecutionLike,
      next: () => Promise<PreToolDecisionLike>,
    ) => Promise<PreToolDecisionLike>)
  | ((
      exec: ToolExecutionLike,
      result: ToolResultLike,
      next: () => Promise<PostToolDecisionLike>,
    ) => Promise<PostToolDecisionLike>)
  | ((exec: ToolExecutionLike, result: ToolResultLike) => void);

/**
 * Agent-scoped context received by event listeners (host `Agent.ctx`).
 * Registration here is agent-local and unwinds on disposal.
 */
export interface DshContext {
  on(event: string, listener: EventListener): () => void;
  systemPrompt?: SystemPromptLike;
  shell?: ShellLike;
  tools?: ToolsLike;
}
