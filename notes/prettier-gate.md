# prettier 忽略语义与格式门禁实测（prettier-gate）

> 定位：本文件是 `.prettierignore` + `pnpm format:check` 门禁的**实测口径**——为什么 skill 条目
> 必须写成锚定的 `/skill/`、为什么被忽略的文件会让门禁**假绿**、以及 worktree 内调 prettier 的
> 路径纪律。守卫落点：[tests/guard/prettier-ignore.test.ts](../tests/guard/prettier-ignore.test.ts)
> （把 `/skill/` 改回裸 `skill/` 即红，见 §4 负控）。

## 1. 忽略引擎是 gitignore 语义：裸目录名命中任意深度

- prettier 的忽略判定（API 的 `getFileInfo(...).ignored`、CLI `--check` 的匹配集）走 **gitignore
  语义**。条目 `skill/` **没有前导斜杠** → 命中**任意深度**的同名目录，`src/skill/**` 与
  `tests/unit/skill/**` 会被一起排除。
- 正确写法是前导斜杠**锚定到忽略文件所在目录**（仓根）：`/skill/` 只排除仓根 skill 树。
- 可自证：`getFileInfo('src/skill/install-skill.ts', { ignorePath: '.prettierignore' })` 在
  `/skill/` 下 `ignored:false`、把它改成 `skill/` 后 `ignored:true`（本仓 prettier 3.9.6 实测）。

## 2. 被忽略的文件不进 `--check` 的匹配集 → 门禁假绿

- `prettier --check .` 先按忽略规则过滤出匹配集，再检查；被排除的文件**既不检查也不报错**。
- 后果：「格式面覆盖全仓」这类门禁对 `src/skill/**` 完全无感——本轮就是这 3 个文件
  （`src/skill/install-skill.ts`、`src/skill/skill-cli.ts`、`tests/unit/skill/skill-cli.test.ts`）
  静默掉出了格式面。
- 所以忽略条目必须有守卫。**文本判据**（读 `.prettierignore` 找 `/skill/`、找裸行）在等价改写
  （换行、调整注释）下会误报，故守卫改用 prettier 自己的忽略判定（见 §4）。

## 3. 路径含 `.git/` 分量：`No matching files`，但 stdout 仍打印全绿

实测（3.9.6；cwd = 主工作树，路径参数指向 `.git/dsh-mint/worktrees/…` 内的文件）：

| 调用                                   | stderr / 退出码                                      | stdout                                                                  |
| -------------------------------------- | ---------------------------------------------------- | ----------------------------------------------------------------------- |
| `prettier --check <绝对路径含 .git/…>` | `[error] No matching files. Patterns: …`，exit **2** | `Checking formatting...` + `All matched files use Prettier code style!` |
| `prettier --write <同一路径>`          | 同上，且**一个字节都不写**                           | 空                                                                      |
| cwd = 目标树 + **相对路径**            | 无                                                   | 正常                                                                    |

- 根因：prettier 的 CLI 按 **cwd** 展开路径参数的 glob；cwd 不是目标树、路径又含 `.git/` 分量时
  展开为空（worktree 的绝对路径必然如此）。
- 坑在**误导性输出**：退出码虽是 2，stdout 照样打印 `All matched files use Prettier code style!`；
  只读 stdout、或吞掉退出码，就会把它当成「通过 / 无需改动」——这正是「静默返回原文」的来源。
- 纪律：**一律 `cwd = 目标树` + 相对路径**（本仓的验收命令都这么写）。

## 4. 本轮事实与守卫

| 项                        | 值                                                                                                                                                                                |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| prettier                  | 3.9.6                                                                                                                                                                             |
| 改前 `prettier --check .` | 101 个文件偏离，其中 `skill/` 24、`src/skill` 3                                                                                                                                   |
| 收敛提交                  | `ca8ed85`：78 个文件（`.prettierignore` + 77 个排版文件）；`git show --stat ca8ed85 -- skill/` 为空 → 仓根 `skill/` 0 改动                                                        |
| 守卫                      | `tests/guard/prettier-ignore.test.ts`：问 prettier 的忽略判定（相对仓根路径 + 显式 `ignorePath`），不读忽略文件文本                                                               |
| 负控                      | 把 `/skill/` 改回裸 `skill/` → 3 个用例红（`src/skill/install-skill.ts`、`src/skill/skill-cli.ts`、`tests/unit/skill/skill-cli.test.ts`），失败信息点名 `src/skill/**` 掉出格式面 |

覆盖的非空断言：`skill/references/**/*.md` 由守卫枚举（含 `body-templates/`、`title-templates/`
两层子目录），枚举为空即失败——否则守卫会退化成假绿。

## 5. 复现手法

```bash
# 1) 直接问 prettier 的忽略判定（cwd 必须是仓根，路径必须是相对仓根）
node -e "const p=require('prettier');p.getFileInfo('src/skill/skill-cli.ts',{ignorePath:'.prettierignore'}).then(i=>console.log(i))"
# 2) 负控：把 .prettierignore 的 /skill/ 改成 skill/，跑守卫应红，然后恢复
pnpm test tests/guard/prettier-ignore.test.ts
# 3) 门禁本身（cwd = 仓根 + 相对路径）
pnpm format:check
```

注：`.prettierignore` 里其余条目同理按 gitignore 语义解释——`dist/`、`node_modules/`、`coverage/`
也是「任意深度命中」，只是本仓这些目录只在仓根出现；`skill/` 是唯一仓内多处同名的，所以必须锚定。
