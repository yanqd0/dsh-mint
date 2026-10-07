import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { REPO_ROOT } from '../helpers/repo.js';

/**
 * 上库内容不得出现 mint ID 的防回归守卫。
 *
 * 契约一句话：**溯源留在 mint 与 commit message 里，仓库文本只留可读的说明**。
 * 编号进仓会随重构腐烂（指到的记录被改标题、被 drop，读者却无从核对），也把
 * 「哪次改动、为什么」这类本属工具面的信息混进了正文——清扫之后要有这条守卫
 * 兜住新写法。
 *
 * 判据一律**以井号 + 数字为锚**，不用裸词 issue/plan/milestone：政策文字
 * （`src/AGENTS.md` 的「不写 mint 的 issue/plan/milestone ID」）与 CLI 合法文本
 * （`--milestone 1`）都会撞上裸词——那是自击，不是回归。最宽的那条（井号 +
 * 两位以上数字）靠白名单收敛到零误报。
 *
 * 本文件自己也在受控集里（守卫扫自己），所以这里**不写完整 ID 字面量**：
 * 白名单只用 `digits` 存数字部分定位，正样本用 `HASH` 拼出来。
 */
const GUARD_FILE = 'tests/guard/no-mint-ids.test.ts';

/** 井号字符。写成码点是刻意的：字面量会让守卫命中本文件自己。 */
const HASH = String.fromCharCode(0x23);

/** 被破坏的契约，进失败信息。 */
const CONTRACT =
  '上库内容不得出现 mint ID：溯源留在 mint 与 commit message，仓库文本只留可读的说明';

/**
 * 三条判据。`kind` 只进失败信息，`source` 是要锚的模式。
 *
 * `prefix` 那条的裸词必须带井号：正文里「plan 的执行顺序」「milestone 1」这类
 * 普通用法到处都是，裸词匹配等于自击。
 */
const ID_PATTERNS: ReadonlyArray<{ readonly kind: string; readonly source: string }> = [
  { kind: '括号溯源', source: '\\(#[0-9]+\\)' },
  { kind: '前缀引用', source: '(?:issue|plan|milestone)\\s*#\\d+' },
  { kind: '裸编号', source: '#\\d{2,}' },
];

/**
 * 受控集里允许显式跳过的二进制扩展名。
 *
 * 名单之外的文件要人来定：守卫宁可红（确认后把扩展名补进来），也不静默放过。
 * 当前受控集里一个二进制文件都没有，这条路径是防御性的。
 */
const BINARY_EXTENSIONS = [
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.ico',
  '.woff',
  '.woff2',
  '.pdf',
  '.zip',
];

/** 一处命中。 */
interface Hit {
  readonly file: string;
  readonly line: number;
  readonly kind: string;
  readonly text: string;
}

/**
 * 白名单：合法但形状上撞判据的用法，按「文件 + 命中片段」定位，每条带一句理由。
 *
 * `digits` 只存数字部分：本文件也在受控集里，写全字面量会让守卫自击（见文件头）。
 * 条目只收紧不放宽——不要为了少红一次而拿掉 `digits`、或把 `file` 换成目录。
 */
interface AllowedSite {
  readonly file: string;
  readonly digits: string;
  readonly reason: string;
}

const ALLOWED: readonly AllowedSite[] = [
  {
    file: 'README.md',
    digits: '42',
    reason:
      '面向使用者的口语示例：用户顺口说「开始做某个 bug」时 agent 怎么接手，编号是用户嘴里的泛指，不是溯源。',
  },
  {
    file: 'README.zh.md',
    digits: '42',
    reason: '同上（中文侧）：README 双语对必须同步，示例句一一对应。',
  },
  {
    file: 'notes/dsh-plugin-dev.md',
    digits: '774',
    reason: 'commit sha `774f688` 的前三位——裸编号判据把十六进制串切了一截，不是 ID。',
  },
  {
    file: 'notes/mounting.md',
    digits: '3276',
    reason: '上游 pnpm 仓的 tracker 编号（写成 `pnpm` + 井号 + 3276），不是 mint ID。',
  },
  {
    file: 'skill/references/commands.md',
    digits: '0075',
    reason: '`--color` 的十六进制颜色字面量 `0075ff`（mint label 配色示例）。',
  },
  {
    file: 'src/client/model.ts',
    digits: '12',
    reason: 'doc 注释里的引用**格式**示例：说明 `LinkLine.target` 渲染成什么形状，不是某条记录。',
  },
  {
    file: 'tests/unit/client/model.test.ts',
    digits: '12',
    reason: '`issueHeadline` 的断言值：渲染结果必须带编号，夹具数据。',
  },
  {
    file: 'tests/unit/client/model.test.ts',
    digits: '42',
    reason: '`describeLink` 的断言值：链接文案渲染编号（夹具里的 `other_id` / `id`），夹具数据。',
  },
  {
    file: 'tests/unit/client/styles.test.ts',
    digits: '12345',
    reason: '`HEX_COLOR` 非法分支的颜色字面量（位数越界，就是要它被拒）。',
  },
  {
    file: 'tests/unit/host/planbind.test.ts',
    digits: '27',
    reason: '拒绝文案把碰撞的 plan id 渲染成编号，断言点名的那个 id，夹具数据。',
  },
  {
    file: 'tests/unit/host/planbind.test.ts',
    digits: '31',
    reason: '同上，第二条碰撞的 plan id（同一条断言的两处）。',
  },
];

/** `git ls-files -z`：受控集就是上库内容；`-z` 免去 core.quotePath 对非 ASCII 名的转义。 */
function trackedFiles(): string[] {
  const result = spawnSync('git', ['ls-files', '-z'], { cwd: REPO_ROOT, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`git ls-files 失败（status=${String(result.status)}）：${result.stderr}`);
  }
  return result.stdout.split('\0').filter((file) => file !== '');
}

/** 命中片段里的数字部分：白名单按它定位，守卫文件因此不必写出全字面量。 */
function idDigits(text: string): string {
  return /#(\d+)/.exec(text)?.[1] ?? '';
}

/** 逐行扫一段文本，返回全部命中（行号 1 起）。 */
function scanText(file: string, text: string): Hit[] {
  const hits: Hit[] = [];
  text.split('\n').forEach((line, index) => {
    for (const { kind, source } of ID_PATTERNS) {
      for (const match of line.matchAll(new RegExp(source, 'giu'))) {
        hits.push({ file, line: index + 1, kind, text: match[0] ?? '' });
      }
    }
  });
  return hits;
}

/** 受控集的一次完整扫描结果。 */
interface TrackedScan {
  readonly skipped: readonly string[];
  readonly hits: readonly Hit[];
}

/**
 * 扫描全部受控文件。
 *
 * 二进制按 NUL 字节判定并**记进 `skipped`**；读取失败不 catch——上库文件读不到
 * 是环境坏了（缺工作树、权限），必须炸出来，而不是被当成「没有命中」。
 */
function scanTracked(files: readonly string[]): TrackedScan {
  const skipped: string[] = [];
  const hits: Hit[] = [];
  for (const file of files) {
    const bytes = readFileSync(join(REPO_ROOT, file));
    if (bytes.includes(0)) {
      skipped.push(file);
      continue;
    }
    hits.push(...scanText(file, bytes.toString('utf8')));
  }
  return { skipped, hits };
}

/** 命中是否落在白名单里：同一文件 + 同一串数字。 */
function isAllowed(hit: Hit): boolean {
  return ALLOWED.some((site) => site.file === hit.file && site.digits === idDigits(hit.text));
}

/** 失败信息：`文件:行` + 命中的字符串 + 判据。 */
function describeHit(hit: Hit): string {
  return `${hit.file}:${hit.line} 命中 ${hit.text}（判据：${hit.kind}）`;
}

const tracked = trackedFiles();
const scanned = scanTracked(tracked);

/**
 * 判据的正样本：用来证明守卫不是真空通过（正则写坏时它会先红）。
 * 井号拼出来写，理由见文件头。
 */
const CAUGHT: ReadonlyArray<{ readonly kind: string; readonly line: string }> = [
  { kind: '括号溯源', line: `清扫收口(${HASH}172)` },
  { kind: '前缀引用', line: `plan ${HASH}31 的执行顺序` },
  { kind: '裸编号', line: `见 ${HASH}999` },
];

/** 负样本：政策文字、CLI 参数、渲染模板与颜色字面量——判据一条都不该碰。 */
const BENIGN: readonly string[] = [
  '不写 mint 的 issue/plan/milestone ID',
  'mint({ args: ["milestone","set","1","--status","running"] })',
  "const COLOR = '#8b76f6';",
  '分页脚形如 `# Page x/y`',
  '渲染成 `#${id}` / `#{id}` 的模板字面量',
];

describe('tracked content', () => {
  it('enumerates a non-empty tracked file set', () => {
    // 空集会让下面所有断言真空通过，所以先钉住枚举本身。
    expect(tracked.length).toBeGreaterThan(0);
    expect(tracked).toContain('package.json');
  });

  it('skips binary files explicitly, with no silent swallow', () => {
    const unknown = scanned.skipped.filter(
      (file) => !BINARY_EXTENSIONS.some((extension) => file.endsWith(extension))
    );
    expect(
      unknown,
      `二进制跳过名单缺少这些扩展名，确认后补进 BINARY_EXTENSIONS：${unknown.join(', ')}`
    ).toEqual([]);
  });

  it('leaves no unwhitelisted mint id reference', () => {
    const unallowed = scanned.hits.filter((hit) => !isAllowed(hit));
    expect(
      unallowed.map(describeHit).join('\n'),
      `${CONTRACT}。不在白名单就该清扫（改成描述性表述、或指向规格文档），而不是往 ALLOWED 里加条目。`
    ).toBe('');
  });

  it('keeps every whitelist entry live and reasoned', () => {
    const stale = ALLOWED.filter(
      (site) =>
        !scanned.hits.some((hit) => site.file === hit.file && site.digits === idDigits(hit.text))
    );
    expect(
      stale.map((site) => `${site.file} ${site.digits}`),
      '白名单条目已失效（该处不再命中）：清扫干净就删条目，别留着'
    ).toEqual([]);
    for (const site of ALLOWED) {
      expect(site.reason.length, `条目缺少理由：${site.file}`).toBeGreaterThan(0);
    }
  });

  it('catches every shape it claims to catch', () => {
    for (const { kind, line } of CAUGHT) {
      const kinds = scanText('synthetic.ts', line).map((hit) => hit.kind);
      expect(kinds, `判据「${kind}」没抓住：${line}`).toContain(kind);
    }
  });

  it('leaves policy text, CLI flags and render templates alone', () => {
    for (const line of BENIGN) {
      const hit = scanText('synthetic.ts', line).map((one) => one.text);
      expect(hit, `误报：${line}`).toEqual([]);
    }
  });

  it('scans itself without hitting itself', () => {
    // 白名单用 `digits`、正样本用 `HASH` 拼，就是为了让这一条成立；顺带守住
    // 「守卫文件必须在受控集里」——没入 git 的守卫不随包发布。
    expect(tracked).toContain(GUARD_FILE);
    expect(scanned.hits.filter((hit) => hit.file === GUARD_FILE)).toEqual([]);
  });
});
