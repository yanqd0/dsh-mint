import { readdirSync } from 'node:fs';
import { relative } from 'node:path';

import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';

import { REPO_ROOT, repoPath } from '../helpers/repo.js';

/**
 * prettier 忽略面的契约守卫。
 *
 * `.prettierignore` 交给 prettier 的忽略引擎，那套匹配是 **gitignore 语义**：裸目录名
 * `skill/` 会命中**任意深度**，把 `src/skill/**` 一起排除；而被忽略的文件**不进**
 * `prettier --check` 的匹配集，门禁于是**假绿**（0.3.0 收敛时 `src/skill/**` 的 3 个文件
 * 就是这样漏掉的，实测记录见 `notes/prettier-gate.md`）。本守卫把「格式面覆盖
 * `src/skill/**`、同时排除仓根 `skill/**`」钉成可定位失败的判据。
 *
 * 判据取自 prettier 自己的忽略判定而不是 `.prettierignore` 的文本：文本判据在等价改写
 * （换行、加注释）下会误报。两条纪律：目标写成**相对仓根的路径**且进程 cwd 必须是仓根
 * （路径含 `.git/` 分量时 prettier 报 `No matching files`）；`ignorePath` 必须显式给出，
 * 该 API 的默认值是不读任何忽略文件（prettier 3.9.6 实测）。
 */
const IGNORE_PATH = '.prettierignore';

/** 被裸 `skill/` 误伤的格式面输入。 */
const FORMATTED_FILES: readonly string[] = [
  'src/skill/install-skill.ts',
  'src/skill/skill-cli.ts',
  'tests/unit/skill/skill-cli.test.ts',
];

/** 手工对齐到固定注释列的 tree，靠排除豁免。 */
const HAND_ALIGNED: readonly string[] = ['src/AGENTS.md', 'tests/AGENTS.md'];

/** 锚定契约被破坏时的失败提示。 */
const ANCHOR_HINT =
  '`src/skill/**` 掉出了 prettier 格式面：检查 .prettierignore 的 skill 条目是否写成裸 `skill/`（gitignore 语义下命中任意深度），锚定写法是 `/skill/`';

/** 排除契约被破坏时的失败提示。 */
const EXCLUDE_HINT =
  '仓根 `skill/**`（含 references 模板）与手工对齐的 AGENTS.md 必须排除在 prettier 格式面外';

/** 相对仓根的路径 → prettier 的忽略判定。 */
async function isIgnored(target: string): Promise<boolean> {
  const { ignored } = await prettier.getFileInfo(relative(REPO_ROOT, repoPath(target)), {
    ignorePath: IGNORE_PATH,
  });
  return ignored;
}

/** `skill/references/**` 下的全部 `.md`（含两层模板子目录）。 */
function referenceFiles(): string[] {
  return readdirSync(repoPath('skill', 'references'), { recursive: true, encoding: 'utf8' })
    .filter((entry) => entry.endsWith('.md'))
    .map((entry) => `skill/references/${entry}`);
}

describe('prettier 忽略面', () => {
  // 契约守卫：`src/skill/**` 属格式面，忽略规则一旦写成裸 `skill/` 就在这里红。
  // 直接问 prettier 的忽略判定「这个路径是否被忽略」，输入是相对仓根的路径。
  it.each(FORMATTED_FILES)('keeps %s inside the format surface', async (target) => {
    expect(await isIgnored(target), `${target} 被 prettier 忽略；${ANCHOR_HINT}`).toBe(false);
  });

  // 排除契约：仓根 skill 整树（含 references 两层模板）必须被忽略。
  // 先把 references 枚举成路径表并断言非空，再逐个问 prettier 的忽略判定。
  it('excludes the whole repo-root skill tree', async () => {
    const references = referenceFiles();
    expect(references.length, 'references 枚举为空：本守卫会退化成假绿').toBeGreaterThan(0);
    for (const target of ['skill/SKILL.md', ...references]) {
      expect(await isIgnored(target), `${target} 未被 prettier 忽略；${EXCLUDE_HINT}`).toBe(true);
    }
  });

  // 手工对齐豁免：两份嵌套 AGENTS.md 的 tree 靠空格对齐，prettier 重排就会擦掉。
  // 逐个问 prettier 的忽略判定，条目被删即红。
  it.each(HAND_ALIGNED)('excludes the hand-aligned %s', async (target) => {
    expect(await isIgnored(target), `${target} 未被 prettier 忽略；${EXCLUDE_HINT}`).toBe(true);
  });
});
