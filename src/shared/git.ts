import { spawn } from 'node:child_process';

/**
 * DAG worktree 动作背后的 git 跑壳：与跑 mint 同法（`src/mint/mint.ts`）——不用 shell、
 * argv 数组、硬墙钟上限；不读配置与凭据，只跑 `status` / `rev-parse` / `worktree` / `merge`。
 *
 * 非零退出**不是**异常，而是调用方必须处理的答案（合并冲突、ref 不存在、worktree 已登记），
 * 故一律 resolve 并带回 stderr，不抛。
 */

/** Wall-clock limit for one git command; git is local and must not hang a tool call. */
export const GIT_TIMEOUT_MS = 30_000;

export interface GitRunResult {
  ok: boolean;
  stdout: string;
  stderr: string;
  code: number | null;
}

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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
