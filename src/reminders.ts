import type {
  ContentBlockLike,
  DshContext,
  PostToolDecisionLike,
  ToolExecutionLike,
  ToolResultLike,
} from './types.js';

const COMMIT_REMINDER =
  'You committed changes — remember to register it with mint: `mint issue state commit <id> --sha <sha>` ' +
  'during dev, and `mint plan close <plan> --test-cmd ...` when a plan passes.';

const BASH_TOOL_NAMES = new Set(['bash', 'tool:bash']);

/** True when a bash tool call ran a git commit. */
export function isGitCommit(exec: ToolExecutionLike): boolean {
  if (!BASH_TOOL_NAMES.has(exec.name)) {
    return false;
  }
  const command = exec.arguments.command;
  return typeof command === 'string' && /\bgit\s+commit\b/.test(command);
}

/**
 * `tools/post-execute` listener: after a git commit, append a mint registration
 * reminder to the model-facing content. Accept + content keeps the original
 * tool value and content — only a text block is appended (enrich, not replace).
 */
export async function commitReminderListener(
  exec: ToolExecutionLike,
  result: ToolResultLike,
  next: () => Promise<PostToolDecisionLike>,
): Promise<PostToolDecisionLike> {
  if (!isGitCommit(exec)) {
    return next();
  }
  const reminder: ContentBlockLike = { type: 'text', text: COMMIT_REMINDER };
  return { kind: 'accept', content: [...result.content, reminder] };
}

/** Register the commit reminder on `tools/post-execute`. */
export function installCommitReminder(ctx: DshContext): () => void {
  return ctx.on('tools/post-execute', commitReminderListener);
}

/**
 * `tools/result` observer: on a failed tool call, emit an observable hint to
 * register the failure as a mint issue. The event is emit-only, so this never
 * alters the frozen result; listener failures are contained by the host.
 */
export function installFailureSignal(ctx: DshContext): () => void {
  return ctx.on('tools/result', (exec: ToolExecutionLike, result: ToolResultLike) => {
    if (result.isError) {
      process.stderr.write(
        `[mint] tool ${exec.name} failed — consider registering an issue: \`mint add <title> --kind problem\`\n`,
      );
    }
  });
}
