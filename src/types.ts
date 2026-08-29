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

/**
 * Agent-scoped context received by `agent/session-start` listeners
 * (host `Agent.ctx`). Registration here is agent-local and unwinds on disposal.
 */
export interface DshContext {
  on(event: string, listener: (payload: unknown) => void): () => void;
  systemPrompt?: SystemPromptLike;
  shell?: ShellLike;
}
