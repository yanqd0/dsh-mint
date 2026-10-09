import {
  existsSync,
  lstatSync,
  mkdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  type Stats,
} from 'node:fs';
import { dirname } from 'node:path';

import {
  installSkill,
  looksLikeOurSkill,
  resolveDshHome,
  skillInSync,
  skillSource,
  skillTarget,
} from './install-skill.js';

/**
 * skill 命令行（`dist/install-skill.js`）——安装形态与其守卫的唯一实现，由
 * `scripts/install-dsh.sh` 与 `pnpm skill` 共用。
 *
 * 为什么守卫住在这里而不是 shell 脚本里：卸载 skill 必须和安装它一样安全（dsh 没有插件卸载
 * 钩子，所以残留副本是常态）。每个模式都拒绝碰它无法识别为本插件自己的路径，符号链接只会被
 * 摘链（绝不跟随），而 `--force` 是接管这类路径的唯一方式。
 *
 * `uninstallSkill` 与 `linkSkill` 镜像 `installSkill` 的所有权规则，好让安装与移除对「什么
 * 是我们的」永不产生分歧。
 */

/** 命令行接受的模式；只能给一个。 */
const MODES = ['--copy', '--link', '--uninstall', '--status'] as const;

type Mode = (typeof MODES)[number];

const USAGE = 'usage: install-skill.js [--copy|--link|--uninstall|--status] [--force]';

/** 下面各工具共用的选项。 */
export interface SkillOptions {
  /** harness 配置根；默认 `$DSH_HOME` 或 `~/.dsh`。 */
  dshHome?: string | undefined;
  /** 随包 skill 目录；默认本模块旁的 `dist/skill`。 */
  source?: string | undefined;
  /** 接管无法识别为本插件所有的目标。 */
  force?: boolean | undefined;
  /** 每个值得解释的结果一行。 */
  log?: ((message: string) => void) | undefined;
}

/** {@link uninstallSkill} 的结果。 */
export interface SkillRemoval {
  /** 目标为何被放过，或本插件的安装已移除。 */
  reason: 'absent' | 'removed' | 'kept';
}

/** {@link linkSkill} 的结果。 */
export interface SkillLinkResult {
  /** 为何没建链接，或目标现在就是一个链接。 */
  reason: 'linked' | 'kept' | 'source missing';
}

/** {@link skillStatus} 报告的已安装 skill 形状。 */
export interface SkillStatus {
  /** `$DSH_HOME/skills/mint`，无论那里有没有东西。 */
  target: string;
  form: 'absent' | 'symlink' | 'copy' | 'foreign';
  /** 链接目标，符号链接形态才有。 */
  linkTarget?: string | undefined;
  /** 符号链接形态：链接解析不了。 */
  dangling?: boolean | undefined;
  /** 副本形态：随包每个文件都逐字节一致。 */
  inSync?: boolean | undefined;
}

/** `lstatSync` 不抛的版本，好让链接被报成链接。 */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** `target` 是否是解析到本插件 skill 的符号链接。 */
function isOurLink(target: string): boolean {
  return existsSync(target) && looksLikeOurSkill(target);
}

/**
 * 报告已安装 skill 的状态。
 *
 * 只读：没有任何分支会创建、移除或改写东西。
 */
export function skillStatus(options: SkillOptions = {}): SkillStatus {
  const target = skillTarget(options.dshHome ?? resolveDshHome());
  const source = options.source ?? skillSource();
  const info = lstatOrUndefined(target);
  if (info === undefined) return { target, form: 'absent' };
  if (info.isSymbolicLink()) {
    return {
      target,
      form: 'symlink',
      linkTarget: readlinkSync(target),
      dangling: !existsSync(target),
    };
  }
  if (info.isDirectory()) {
    if (!looksLikeOurSkill(target)) return { target, form: 'foreign' };
    return { target, form: 'copy', inSync: skillInSync(target, source) };
  }
  return { target, form: 'foreign' };
}

/** 汇总 {@link skillStatus} 的一行。 */
export function statusLine(status: SkillStatus): string {
  const details: string[] = [];
  if (status.linkTarget !== undefined) details.push(`-> ${status.linkTarget}`);
  if (status.dangling === true) details.push('dangling');
  if (status.form === 'symlink' && status.dangling === false) details.push('ok');
  if (status.inSync !== undefined) details.push(status.inSync ? 'in-sync' : 'stale');
  if (status.form === 'foreign') details.push("not this plugin's copy");
  if (status.form === 'absent') details.push('nothing installed');
  const suffix = details.length > 0 ? ` (${details.join(', ')})` : '';
  return `[dsh-mint] skill ${status.form} ${status.target}${suffix}`;
}

/**
 * 把 `$DSH_HOME/skills/mint` 指向随包 skill（开发/dogfood 形态）。
 *
 * 幂等：已经指向源目录的现有符号链接原样保留。异主目录（或文件）只报告并保留；`force` 才替换
 * 它。绝不跟随符号链接。
 */
export function linkSkill(options: SkillOptions = {}): SkillLinkResult {
  const log = options.log;
  const source = options.source ?? skillSource();
  const target = skillTarget(options.dshHome ?? resolveDshHome());
  const force = options.force === true;
  try {
    if (!existsSync(source)) {
      log?.(`[dsh-mint] skill source missing (${source}) — cannot link it`);
      return { reason: 'source missing' };
    }
    const existing = lstatOrUndefined(target);
    if (existing !== undefined) {
      if (existing.isSymbolicLink()) {
        if (readlinkSync(target) === source) return { reason: 'linked' };
        // unlink 摘的是链接本身，绝不是它指向的目录
        unlinkSync(target);
      } else if (existing.isDirectory()) {
        if (!force && !looksLikeOurSkill(target)) {
          log?.(
            `[dsh-mint] skill target is not this plugin's copy, left alone (${target}) — use --force to replace it`,
          );
          return { reason: 'kept' };
        }
        rmSync(target, { recursive: true, force: true });
      } else if (!force) {
        log?.(`[dsh-mint] skill target is not a directory, left alone (${target})`);
        return { reason: 'kept' };
      } else {
        unlinkSync(target);
      }
    }
    mkdirSync(dirname(target), { recursive: true });
    symlinkSync(source, target);
    log?.(`[dsh-mint] linked ${source} -> ${target}`);
    return { reason: 'linked' };
  } catch (error) {
    log?.(`[dsh-mint] skill link failed: ${messageOf(error)}`);
    return { reason: 'kept' };
  }
}

/**
 * 移除本插件装在 `$DSH_HOME/skills/mint` 的东西。
 *
 * 幂等（不存在即成功）且有守卫：异主目录或文件只报告并保留，符号链接摘链而不跟随，而无法确认
 * 为本插件所有的链接只有带 `force` 才移除。绝不抛。
 */
export function uninstallSkill(options: SkillOptions = {}): SkillRemoval {
  const log = options.log;
  const target = skillTarget(options.dshHome ?? resolveDshHome());
  const force = options.force === true;
  const existing = lstatOrUndefined(target);
  if (existing === undefined) {
    log?.(`[dsh-mint] nothing to remove (${target})`);
    return { reason: 'absent' };
  }
  try {
    if (existing.isSymbolicLink()) {
      if (!force && !isOurLink(target)) {
        log?.(
          `[dsh-mint] kept ${target}: it does not resolve to this plugin's skill — use --force to unlink it anyway`,
        );
        return { reason: 'kept' };
      }
      // unlink 摘的是链接本身，绝不是它指向的目录
      unlinkSync(target);
    } else if (existing.isDirectory()) {
      if (!force && !looksLikeOurSkill(target)) {
        log?.(`[dsh-mint] kept ${target}: it is not this plugin's skill directory`);
        return { reason: 'kept' };
      }
      rmSync(target, { recursive: true, force: true });
    } else if (!force) {
      log?.(`[dsh-mint] kept ${target}: it is not this plugin's skill directory`);
      return { reason: 'kept' };
    } else {
      unlinkSync(target);
    }
  } catch (error) {
    log?.(`[dsh-mint] skill removal failed (${target}): ${messageOf(error)}`);
    return { reason: 'kept' };
  }
  log?.(`[dsh-mint] removed installed skill: ${target}`);
  return { reason: 'removed' };
}

/** {@link runSkillCli} 的输出汇；默认写 stdout/stderr。 */
export interface SkillCliIo extends SkillOptions {
  /** 用法与拒绝；默认 stderr。 */
  error?: ((message: string) => void) | undefined;
}

/**
 * 跑 skill 命令行并返回进程退出码。
 *
 * **裸**调用只做安装（复制形态，即打包安装的形状）且总答 0：skill 安装是尽力而为，绝不能
 * 让 `pnpm install` 失败。显式模式给真实退出码，好让脚本能区分带守卫的拒绝（1）与成功（0）；
 * 用法错误是 2。
 *
 * @param argv - 不含 `node script` 前缀的参数。
 * @param io - 输出汇与路径覆写；测试注入临时 `dshHome`。
 * @returns 本次调用的退出码。
 */
export function runSkillCli(argv: readonly string[], io: SkillCliIo = {}): number {
  const log = io.log ?? ((message: string) => process.stdout.write(`${message}\n`));
  const error = io.error ?? ((message: string) => process.stderr.write(`${message}\n`));
  if (argv.includes('-h') || argv.includes('--help')) {
    log(USAGE);
    return 0;
  }
  const unknown = argv.filter((arg) => arg !== '--force' && !(MODES as readonly string[]).includes(arg));
  if (unknown.length > 0) {
    error(`unknown option: ${unknown[0]}`);
    error(USAGE);
    return 2;
  }
  const modes = argv.filter((arg): arg is Mode => (MODES as readonly string[]).includes(arg));
  if (modes.length > 1) {
    error(`only one mode at a time: ${modes.join(' ')}`);
    error(USAGE);
    return 2;
  }
  const mode = modes[0];
  const force = argv.includes('--force');
  const common: SkillOptions = { dshHome: io.dshHome, source: io.source, force, log };
  if (mode === '--status') {
    log(statusLine(skillStatus({ dshHome: io.dshHome, source: io.source })));
    return 0;
  }
  if (mode === '--uninstall') {
    const removal = uninstallSkill(common);
    return removal.reason === 'kept' ? 1 : 0;
  }
  if (mode === '--link') {
    return linkSkill(common).reason === 'linked' ? 0 : 1;
  }
  // 裸调用与 `--copy`：安装（或重新同步）整棵树。
  const installed = installSkill(common);
  if (mode === undefined) return 0; // 尽力而为的安装：绝不让调用方失败
  return installed.ok ? 0 : 1;
}
