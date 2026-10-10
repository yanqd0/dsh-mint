import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
  type Stats,
} from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * skill 自动安装——两个触发点共用本模块：
 *
 * 1. `package.json` postinstall 跑 `node dist/install-skill.js`（npm 总会跑；pnpm 10+ 会拦下
 *    依赖的构建脚本除非被放行，所以这个触发点在 pnpm 下是尽力而为）。
 * 2. 宿主插件在每次加载的 `apply()` 里调 {@link installSkill}——这是
 *    `pnpm add -g @yanqd0/dsh-mint` 的保证路径：安装后的第一个会话会在 skill 目录首次收集
 *    之前把随包 skill 复制进 DSH skill 目录（filesystem provider 每次查找都重读该目录，所以
 *    skill 就在同一个会话里被发现）。
 *
 * 语义是**整棵 skill 树**上的内容同步：只有当随包 skill 的每个文件都已逐字节一致时目标才不
 * 被动（只看 SKILL.md 会漏掉 `references/` 的改动）；其余情况一律替换。跳过路径上容忍目标里
 * 多出来的文件，所以用户自己的添加能在空转同步中存活。
 *
 * 所有权——本模块只碰**它**装的副本：
 *
 * - 副本带 {@link OWNER_MARKER}；标记出现之前装的副本靠它的 `SKILL.md` frontmatter 识别。
 *   其余情况（别人的目录、普通文件）只报告一次并放过，只有显式 `force` 才接管；
 * - 符号链接目标从不被跟随或覆盖：开发流程（`scripts/install-dsh.sh --link`）拥有符号链接，
 *   所以悬空或异主的链接只报告、不修复——`force` 会先摘链。
 *
 * 每次失败记一行日志并返回 `{ ok: false }`；它绝不弄坏插件加载或包安装。
 */

const DIRNAME = dirname(fileURLToPath(import.meta.url));

/** skill 名：`$DSH_HOME/skills` 下的目录名，也是 frontmatter 的 `name`。 */
export const SKILL_NAME = 'mint';

/**
 * 写进已安装副本的标记文件。
 *
 * 删除任何东西之前，所有权必须能被**正面**回答，而同步到一半被打断的副本可能还没有
 * `SKILL.md`——所以标记先落盘，即使那种情况也能认出这个目录。
 */
export const OWNER_MARKER = '.dsh-mint-skill';

const OWNER_MARKER_CONTENT = '@yanqd0/dsh-mint\n';

export interface InstallResult {
  ok: boolean;
  reason?: string;
}

/** {@link installSkill} 的选项。 */
export interface InstallOptions {
  /** harness 配置根；默认 `$DSH_HOME` 或 `~/.dsh`。 */
  dshHome?: string | undefined;
  /** 随包 skill 目录；默认本模块旁的 `dist/skill`。 */
  source?: string | undefined;
  /** 接管无法识别为本插件所有的目标。 */
  force?: boolean | undefined;
  /** 每个值得解释的结果一行。 */
  log?: ((message: string) => void) | undefined;
}

/** 环境里的 DSH_HOME，否则 `~/.dsh`——与 scripts/install-dsh.sh 对齐。 */
export function resolveDshHome(env: NodeJS.ProcessEnv = process.env): string {
  return env.DSH_HOME ?? join(homedir(), '.dsh');
}

/** 随包 skill 目录：本模块旁的 `dist/skill`。 */
export function skillSource(): string {
  return join(DIRNAME, 'skill');
}

/** `dsh-skill-filesystem` 读取的发现目标。 */
export function skillTarget(dshHome: string): string {
  return join(dshHome, 'skills', SKILL_NAME);
}

/**
 * skill 文件开头 frontmatter 块的 `name`，解析不出来时 `undefined`。
 *
 * 只读该块的第一个 `name:` 行；它用来识别一次安装，不校验 skill 文件。
 */
export function frontmatterName(raw: string): string | undefined {
  const block = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(raw)?.[1];
  if (block === undefined) return undefined;
  const value = /^\s*name:\s*(.+?)\s*$/mu.exec(block)?.[1];
  if (value === undefined) return undefined;
  return value.replace(/^(['"])(.*)\1$/u, '$2');
}

/**
 * `dir` 是否本插件装的副本。
 *
 * 只做正面识别，好让守卫永不删除别人的东西：{@link installSkill} 写的标记，或——标记出现
 * 之前的副本——`SKILL.md` 的 frontmatter 点名本 skill。读不出来或悬空的路径答 `false`，那
 * 只意味着「别动它」。
 */
export function looksLikeOurSkill(dir: string): boolean {
  try {
    readFileSync(join(dir, OWNER_MARKER));
    return true;
  } catch {
    // 没有标记：回退到 pre-marker 副本的 frontmatter
  }
  try {
    return frontmatterName(readFileSync(join(dir, 'SKILL.md'), 'utf8')) === SKILL_NAME;
  } catch {
    return false;
  }
}

/**
 * `root` 下的每个文件，以相对路径表示并排序。
 *
 * skill 是一棵树（SKILL.md + references/），而只有 SKILL.md 被注入会话、references 按需读取
 * ——所以只看 SKILL.md 的比较看不见过期的 reference。
 */
function listFiles(root: string, base: string = root): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...listFiles(full, base));
    } else if (entry.isFile()) {
      files.push(relative(base, full));
    }
  }
  return files.sort();
}

/**
 * 随包文件是否都已逐字节存在于目标中。
 *
 * 目标里多出来的文件被刻意忽略：跳过路径绝不能删用户放在那里的文件（所有权标记就是其一），
 * 而副本里一个孤儿 reference 也无害，因为唯一的路由是**总会被同步**的 SKILL.md。
 */
function isCurrent(source: string, target: string): boolean {
  try {
    for (const file of listFiles(source)) {
      const matches = readFileSync(join(source, file)).equals(readFileSync(join(target, file)));
      if (!matches) return false;
    }
    return true;
  } catch {
    // 读不出来或装了一半的副本永远不算「当前」
    return false;
  }
}

/**
 * `target` 是否已逐字节持有随包的全部文件。
 *
 * 为状态视图（`dist/install-skill.js --status`）而导出，好让「副本过期了吗？」对同步与报告
 * 只有一个答案。
 */
export function skillInSync(target: string, source: string = skillSource()): boolean {
  return isCurrent(source, target);
}

/** `lstatSync` 不抛的版本：形状检查必须把符号链接看成一个链接。 */
function lstatOrUndefined(path: string): Stats | undefined {
  try {
    return lstatSync(path);
  } catch {
    return undefined;
  }
}

/**
 * 把随包 skill 同步进 DSH skill 目录。
 *
 * 绝不抛：每条失败路径都在一行日志之后返回 `{ ok: false, reason }`，所以 postinstall 与插件
 * 加载都不会因它失败。
 */
export function installSkill(opts: InstallOptions = {}): InstallResult {
  const log = opts.log ?? ((message: string) => process.stderr.write(`${message}\n`));
  const source = opts.source ?? skillSource();
  const target = skillTarget(opts.dshHome ?? resolveDshHome());
  const force = opts.force === true;
  try {
    if (!existsSync(source)) {
      log(`[dsh-mint] skill source missing (${source}) — skipping skill install`);
      return { ok: false, reason: 'source missing' };
    }
    const existing = lstatOrUndefined(target);
    if (existing !== undefined) {
      if (existing.isSymbolicLink()) {
        if (!force) {
          // 开发流程（scripts/install-dsh.sh）拥有符号链接——绝不覆盖
          if (existsSync(target)) {
            return { ok: true, reason: 'symlink' };
          }
          log(
            `[dsh-mint] skill target is a dangling symlink (${target}) — repoint or remove it, then reload`
          );
          return { ok: false, reason: 'dangling symlink' };
        }
        // unlink 摘的是链接本身，绝不是它指向的目录
        unlinkSync(target);
      } else if (existing.isDirectory()) {
        if (!force) {
          if (!looksLikeOurSkill(target)) {
            log(
              `[dsh-mint] skill target is not this plugin's copy, left alone (${target}) — use --force to replace it`
            );
            return { ok: false, reason: 'foreign skill' };
          }
          if (isCurrent(source, target)) {
            return { ok: true };
          }
        }
        rmSync(target, { recursive: true, force: true });
      } else {
        if (!force) {
          log(`[dsh-mint] skill target is not a directory, left alone (${target})`);
          return { ok: false, reason: 'not a directory' };
        }
        unlinkSync(target);
      }
    }
    // 标记先于内容落盘，好让被打断的同步仍可识别为本插件的副本，并在下次加载时被修复。
    mkdirSync(target, { recursive: true });
    writeFileSync(join(target, OWNER_MARKER), OWNER_MARKER_CONTENT);
    cpSync(source, target, { recursive: true });
    return { ok: true };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log(`[dsh-mint] skill install failed: ${reason}`);
    return { ok: false, reason };
  }
}
