import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';
import { existsSync, realpathSync } from 'node:fs';
import { createRequire } from 'node:module';
import { homedir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);

export const MINT_TIMEOUT_MS = 30_000;

/**
 * 一个进程**首次** mint 运行的墙钟上限。
 *
 * 全新安装还没有 mint 二进制：`mint-faa` 首次使用时才懒下载 GitHub release，慢链路上可能
 * 超过 30 s。所以首次运行拿到大得多的预算；此后每次都是热的，留在 {@link MINT_TIMEOUT_MS}。
 */
export const MINT_COLD_TIMEOUT_MS = 180_000;

/** mint 入口的环境覆写，优先级先于 mint-faa 默认值。 */
export const MINT_ENTRY_ENV = 'MINT_ENTRY';

/**
 * `mintEntry`/`MINT_ENTRY` 的哨兵值，用于在另一个旋钮带了路径覆写时仍强制走依赖链——
 * 开发 profile 被钉在本地构建时，用户想查自己的环境就需要它。
 */
export const MINT_ENTRY_DEPENDENCY = 'dependency';

/** 匹配它的入口是 Node 脚本；其余都是原生二进制。 */
const NODE_ENTRY = /\.(cjs|mjs|js)$/i;

/** `mint-faa` 依赖提供的包装脚本的包内相对路径。 */
const MINT_FAA_ENTRY = join('node_modules', 'mint-faa', 'run-mint.js');

/**
 * 工具通道的可行动失败文案。一句光秃秃的 `Cannot find module 'mint-faa/run-mint.js'`
 * 读起来像插件 bug 且无路可走；这段文字点名两个覆写旋钮与 profile 侧的修法。
 */
export const MINT_ENTRY_HINT =
  'mint 入口解析失败：mint-faa 依赖不可见（DSH 下插件裸包名由 harness/profile 作用域解析，' +
  'link: 安装也不会把被 link 包的依赖装进 profile）。' +
  '请在挂载行 config.mintEntry 指定入口（如 ~/bin/mint 或本地构建 target/release/mint），' +
  '或设置 MINT_ENTRY 后重启 harness；依赖链需在 profile 内 ' +
  'dsh plugin --profile <p> approve-builds --all 后重装。';

/**
 * 每请求 `[Mint]` 概览用的一行版本。只在失败时渲染，所以从不进入每请求预算。
 */
export const MINT_ENTRY_WARNING =
  'mint 入口解析失败（mint-faa 不可见）→ 挂载行 mintEntry（如 ~/bin/mint）或 MINT_ENTRY，改后重启 harness';

/**
 * {@link resolveMintEntry} 的接缝；全部可选，生产路径一律留默认值。
 */
export interface MintEntryOptions {
  /**
   * 入口覆写（挂载行的 `mintEntry`；调用时的 `MintRunOptions.entry`）：可以是
   * `run-mint.js` 路径、原生 mint 二进制、`~` 前缀路径、裸 `PATH` 命令，或
   * {@link MINT_ENTRY_DEPENDENCY} 哨兵。优先于 `MINT_ENTRY` 环境变量。
   */
  entry?: string;
  /** 探测捆绑依赖用的包根（测试指向 fixture）。 */
  packageRoot?: string;
  /** 文件系统探测接缝（`fs.existsSync`）。 */
  exists?: (path: string) => boolean;
  /** 裸说明符解析接缝（`createRequire(...).resolve`）。 */
  resolveBare?: (specifier: string) => string;
}

/**
 * 本插件的包根：最近的带 `package.json` 的祖先目录。
 *
 * 不能写死 `..`：打包产物在 `dist/`（深度 1），源码在 `src/<module>/`（深度 2），而
 * `pnpm dev`/vitest 下跑的是源码——数层级就会去探 `src/node_modules` 并静默退回裸说明符
 * 查找，而那正是本探测要避免的 `mint-faa` 故障。
 */
function defaultPackageRoot(): string {
  const start = dirname(fileURLToPath(import.meta.url));
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, 'package.json'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return start;
    dir = parent;
  }
}

/** 展开开头的 `~`——挂载行的 YAML 值从不过 shell。 */
export function expandMintEntry(entry: string): string {
  if (entry === '~') return homedir();
  if (entry.startsWith('~/')) return join(homedir(), entry.slice(2));
  return entry;
}

/**
 * 定位 `mint-faa` 的 `run-mint.js`，**先不走裸说明符查找**。
 *
 * DSH 经 harness/profile 包表解析插件的裸说明符（`notes/dsh-plugin-dev.md`），那里看不到
 * 插件自己的依赖——那正是 `Cannot find module 'mint-faa/run-mint.js'` 故障。探测插件自己的
 * 包根对 pnpm（隔离与提升布局）和 npm 布局都成立；`require.resolve` 留作本探测没覆盖的
 * 布局的兜底。
 */
export function resolveDependencyEntry(options: MintEntryOptions = {}): string {
  const root = options.packageRoot ?? defaultPackageRoot();
  const probe = join(root, MINT_FAA_ENTRY);
  const exists = options.exists ?? existsSync;
  if (exists(probe)) return probe;
  const resolveBare = options.resolveBare ?? ((specifier: string) => require.resolve(specifier));
  return resolveBare('mint-faa/run-mint.js');
}

/** {@link resolveDependencyEntry}，失败时附上 {@link MINT_ENTRY_HINT}。 */
function dependencyEntry(options: MintEntryOptions): string {
  try {
    return resolveDependencyEntry(options);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${MINT_ENTRY_HINT} (${detail})`);
  }
}

/**
 * 解析 mint CLI 入口。
 *
 * 优先级：挂载行 `mintEntry` 配置 → `MINT_ENTRY` 环境变量 → `mint-faa` 依赖
 * （任一带 {@link MINT_ENTRY_DEPENDENCY} 即强制最后一条）。显式入口可以是
 * `run-mint.js` 路径、原生 mint 二进制、`~` 前缀路径，或由 `spawn` 经 `PATH` 解析的裸
 * 命令名。
 *
 * 依赖范围（`>=0.8.0 <1.0.0`）已经让用户不必等插件发版就能升到任意 pre-1.0 `mint-faa`；
 * 覆写覆盖的是范围做不到的事——dogfood 未发布或本地构建的 mint。
 */
export function resolveMintEntry(options: MintEntryOptions = {}): string {
  const configured = options.entry?.trim();
  if (configured !== undefined && configured.length > 0) {
    return configured === MINT_ENTRY_DEPENDENCY
      ? dependencyEntry(options)
      : expandMintEntry(configured);
  }
  const fromEnv = process.env[MINT_ENTRY_ENV]?.trim();
  if (fromEnv !== undefined && fromEnv.length > 0 && fromEnv !== MINT_ENTRY_DEPENDENCY) {
    return expandMintEntry(fromEnv);
  }
  return dependencyEntry(options);
}

/**
 * 为解析出的入口拼 spawn argv。
 *
 * `.js`/`.mjs`/`.cjs` 入口是 Node 脚本（`mint-faa` 默认）并在宿主 Node 二进制下运行；
 * 其余路径是原生 mint 可执行文件，直接 spawn——这才让会话能 dogfood 本地构建的 Rust 二进制
 * 而不是已发布那个。
 */
export function mintCommand(entry: string): { command: string; prefix: string[] } {
  return NODE_ENTRY.test(entry)
    ? { command: process.execPath, prefix: [entry] }
    : { command: entry, prefix: [] };
}

/**
 * 把一个入口缩短成会话每请求都负担得起的形状。`-V` 在 debug 与 release 构建上读起来一样，
 * 所以区分两者的是入口本身——不只是版本；符号链接启动器（`~/bin/mint`）先解析，好让标签
 * 点名真正的构建（`…/target/release/mint`）。
 */
export function describeMintEntry(entry: string): string {
  if (!entry.includes('/') && !entry.includes('\\')) return `PATH:${entry}`;
  let resolved = entry;
  try {
    resolved = realpathSync(entry);
  } catch {
    // 不在磁盘上（或不可读）——就描述用户写下的东西。
  }
  // pnpm store 路径又长又带版本标签：只留有意思的那段。
  const faa = /mint-faa@([^/\\]+)/.exec(resolved);
  if (faa?.[1] !== undefined) return `mint-faa@${faa[1]}`;
  const parts = resolved.split(/[/\\]+/).filter((part) => part.length > 0);
  return parts.length <= 3 ? resolved : `…/${parts.slice(-3).join('/')}`;
}

/** 从 `mint -V` 输出（`mint 0.8.0-alpha.1`）里取出版本。 */
export function parseMintVersion(text: string | undefined): string | undefined {
  const match = /\bmint\s+v?(\d[^\s]*)/.exec(text ?? '');
  return match?.[1];
}

export interface MintRunOptions extends MintEntryOptions {
  /** CLI 进程的墙钟上限（默认 {@link MINT_TIMEOUT_MS}）。 */
  timeoutMs?: number;
  /**
   * 协作式取消。工具执行携带 `exec.signal`，工具本体应当观察并转发它；abort 会杀掉子进程。
   */
  signal?: AbortSignal;
}

export interface MintRunResult {
  ok: boolean;
  text?: string;
  /**
   * 原始 stderr。成功时它*不是*错误通道：mint 会把建议行写在那里（`mint: hint: …`，例如
   * 去重合并建议或未合并机器的告警），丢掉它们就藏起了一条可行动说明。`list` 的分页脚注
   * 已不再属于它们——自 mint 0.8 起它写到 stdout（`# Page x/y`），所以由 stdout 路径携带。
   * 失败时该消息也会落到 {@link MintRunResult.error}。
   */
  stderr?: string;
  error?: string;
  /** CLI 跑过并失败时的进程退出码；中止/超时时缺失。 */
  exitCode?: number;
  /**
   * 子进程是否被墙钟上限杀掉。只在失败路径上置位：在预算内跑完的运行从不携带它。调用方把
   * 它变成冷下载提示，而不是光秃秃的 `exit timeout`。
   */
  timedOut?: boolean;
  /** 该次运行是否经 `options.signal` 取消。 */
  aborted?: boolean;
}

/**
 * 进程级冷启动记账。
 *
 * 会话启动概览会并发发起三次 mint 调用，而 `mint-faa` 的懒安装器在下载前先删二进制目录
 * 且不加锁——并行首跑会互相破坏安装。所以**首次**运行持一个槽位：并发调用方等它，而不是
 * 再 spawn 一次冷安装。槽位在每次结算时释放，且只有*成功*的冷运行才把进程标成热的，所以
 * 下载失败不会把下一次尝试降级到 30 s 预算。
 */
let mintWarmed = false;
let coldRun: Promise<void> | undefined;
let releaseColdRun: (() => void) | undefined;

/** 测试接缝：忘掉进程级冷启动状态。 */
export function resetMintWarmState(): void {
  mintWarmed = false;
  coldRun = undefined;
  releaseColdRun = undefined;
}

/**
 * 拿冷启动槽位，或等持有它的那次运行（之后再复查：失败的持有者把槽位传下去，而不是让调用方
 * 被当成热的）。
 */
async function acquireColdSlot(): Promise<boolean> {
  while (!mintWarmed) {
    if (coldRun === undefined) {
      coldRun = new Promise<void>((resolve) => {
        releaseColdRun = resolve;
      });
      return true;
    }
    await coldRun;
  }
  return false;
}

/** 释放 {@link acquireColdSlot} 取到的冷启动槽位。 */
function settleColdSlot(ok: boolean): void {
  if (ok) mintWarmed = true;
  const release = releaseColdRun;
  coldRun = undefined;
  releaseColdRun = undefined;
  release?.();
}

/**
 * 直接 spawn `node <mint-entry>` 来运行 mint CLI。
 *
 * 插件代码是宿主信任的，它自己的子进程不过会话文件沙箱（`ctx.shell` / Seatbelt），所以
 * mint 在 `workspace-write` 会话里也能读写自己的数据目录。
 *
 * 非零退出与 spawn 失败都 resolve（不 reject）成一条错误消息，与旧的 shell 实现契约一致，
 * 调用方因此永远不用 catch。
 *
 * `options.timeoutMs` 是调用方自己的预算，并退出冷启动记账；否则进程首次运行拿
 * {@link MINT_COLD_TIMEOUT_MS}、之后拿 {@link MINT_TIMEOUT_MS}。
 */
export async function runMint(
  cwd: string,
  args: readonly string[],
  options: MintRunOptions = {}
): Promise<MintRunResult> {
  const explicitTimeout = options.timeoutMs;
  const cold = explicitTimeout === undefined ? await acquireColdSlot() : false;
  const timeoutMs = explicitTimeout ?? (cold ? MINT_COLD_TIMEOUT_MS : MINT_TIMEOUT_MS);
  const { signal } = options;

  return new Promise((resolvePromise) => {
    let settled = false;
    let stdout = '';
    let stderr = '';
    let aborted = signal?.aborted === true;
    let timedOut = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let child: ChildProcess | undefined;

    const settle = (result: MintRunResult): void => {
      if (settled) return;
      settled = true;
      cleanup();
      if (cold) settleColdSlot(result.ok === true);
      resolvePromise(result);
    };

    function onAbort(): void {
      aborted = true;
      try {
        child?.kill('SIGTERM');
      } catch {
        // 已经没了——close 处理器会结算
      }
      settle({ ok: false, aborted: true, error: 'aborted' });
    }

    function cleanup(): void {
      if (timer !== undefined) {
        clearTimeout(timer);
        timer = undefined;
      }
      signal?.removeEventListener('abort', onAbort);
    }

    if (aborted) {
      settle({ ok: false, aborted: true, error: 'aborted' });
      return;
    }

    // 在 spawn 之前武装，好让它注册在 spawn 自己为同一截止时间设的超时定时器之前：等被杀
    // 的子进程关闭时，标志位已置好，`code === null` 就能报成超时而不是光秃秃的崩溃。
    timer = setTimeout(() => {
      timedOut = true;
    }, timeoutMs);

    try {
      const { command, prefix } = mintCommand(resolveMintEntry(options));
      child = spawn(command, [...prefix, ...args], {
        cwd,
        timeout: timeoutMs,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      settle({ ok: false, error: error instanceof Error ? error.message : String(error) });
      return;
    }

    signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', (error) => {
      settle({ ok: false, error: error.message });
    });
    child.on('close', (code) => {
      if (aborted) {
        settle({ ok: false, aborted: true, error: 'aborted' });
        return;
      }
      if (code === 0) {
        settle({ ok: true, text: stdout, stderr });
        return;
      }
      if (code === null) {
        settle({ ok: false, ...(timedOut ? { timedOut: true } : {}), error: 'exit timeout' });
        return;
      }
      settle({ ok: false, exitCode: code, error: stderr.trim() || `exit ${code}` });
    });
  });
}
