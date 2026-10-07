import { spawn } from 'node:child_process';

/**
 * The git runner behind the DAG worktree actions.
 *
 * The plugin process spawns git the same way it spawns mint (`mint.ts`): no
 * shell, an argv array, and a hard wall-clock limit. Nothing here reads a config
 * or a credential — only `status` / `rev-parse` / `worktree` / `merge`, run for
 * the repository the DAG's worktrees belong to.
 *
 * A non-zero exit is **not** an exception: it is the answer every caller has to
 * handle (`git merge` conflict, a missing ref, a worktree already registered),
 * so the runner resolves with the captured stderr instead of throwing.
 */

/** Wall-clock limit for one git command; git is local and must not hang a tool call. */
export const GIT_TIMEOUT_MS = 30_000;

/** What one git invocation produced. */
export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run one git command in `cwd`.
 *
 * @param cwd - the repository (or worktree) to run in.
 * @param args - the git arguments, after the program name.
 * @param timeoutMs - wall-clock limit; defaults to {@link GIT_TIMEOUT_MS}.
 */
export function runGit(
  cwd: string,
  args: readonly string[],
  timeoutMs: number = GIT_TIMEOUT_MS
): Promise<GitRunResult> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (result: GitRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    let child;
    try {
      child = spawn('git', [...args], { cwd, shell: false });
    } catch (error) {
      done({ ok: false, stdout: '', stderr: messageOf(error), code: null });
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      done({ ok: false, stdout: '', stderr: `git ${args.join(' ')} timed out`, code: null });
    }, timeoutMs);
    const out: string[] = [];
    const err: string[] = [];
    child.stdout?.on('data', (chunk: Buffer) => out.push(chunk.toString('utf8')));
    child.stderr?.on('data', (chunk: Buffer) => err.push(chunk.toString('utf8')));
    child.on('error', (error: Error) => {
      clearTimeout(timer);
      done({ ok: false, stdout: out.join(''), stderr: messageOf(error), code: null });
    });
    child.on('close', (code: number | null) => {
      clearTimeout(timer);
      done({ ok: code === 0, stdout: out.join(''), stderr: err.join(''), code });
    });
  });
}

/** Readable text for an unknown throwable. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
