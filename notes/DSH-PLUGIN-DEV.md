# DSH 插件开发调研笔记（项目记忆）

> dogfooding 期间对 DSH host 面的实测结论。写插件代码前先读本文件；与代码冲突时以**源码**为准（本文件附源码位置）。

## 权威源码位置

- **harness 主仓（MIT 开源）**：`github.com/deepseek-ai/deepseek-harness`
  - 本地 clone：`/Users/yanqd0/my/GitHub/deepseek/deepseek-harness`（`packages/` 下是各插件的 TS 源码）
  - **cordis 也在此仓**：`vendor/cordis`（`@deepseek-ai/cordis` = cordiverse/cordis 的 fork，作者 Shigma）
- 本机 npm 安装目录（打包产物，无 TS 源时可读）：
  `~/.nvm/versions/node/v22.23.2/lib/node_modules/@deepseek-ai/dsh/`（`lib/*.js` 反编译）及其 `node_modules/@deepseek-ai/` 下各插件包
- 优先级：**GitHub TS 源码 > 本机 lib 产物 > 运行时 CLI 行为 > 项目旧调研结论**

## 挂载与补丁层（profile）

- profile 树 = 空根 + 层层 patch：`dsh.profile.bundles` 各 bundle patch → profile `cordis.patch.yml` → home 级 `$DSH_HOME/cordis.patch.yml` → `--patch` overlay。
- **补丁行三种语义**（`packages/boot/app-boot/src/profile.ts` applyEntryPatches）：
  - `- id: x` + config/disabled 等 → 对既有条目覆盖/禁用（找不到 → `patch: entry "x" not found` 警告跳过）
  - `- insert: [...]`（无 id）→ 追加到根列表；`- id: <group> / insert: [...]` → 插入组内
  - **新插件必须用 `insert:` 包裹**——裸 `- id/name` 行是覆盖语义，不会新建条目
- `name` 模块解析（`vendor/cordis` loader import()）：`cordis:` 内置 → 以 `.` 开头按 profile baseUrl 解析 → **其余直接 `import(name)`**：
  - 目录 specifier 报 `ERR_UNSUPPORTED_DIR_IMPORT`——绝对/相对路径必须指向**文件**（如 `dist/index.js`）
  - 裸包名走 harness internal loader（从 harness 自身 node_modules 解析）
- 验证：`dsh --profile web --dump-config`（组合树 + 补丁警告一次看清）；`--dump-default-config` 不含用户层。

## inject 与 DI（cordis）

- 插件**自身 ctx** 上访问服务必须先声明：`export const inject = ['tools', ...]`，否则运行时 `cannot get property "shell" without inject`（单测 mock 测不出，实载必炸）。
- `agent.ctx` 是 agent 作用域 ctx（session-start 时由宿主提供），其上的服务（如 `systemPrompt`）**不要**加进 root inject（root 上没有该服务会直接 apply 失败）。
- 教训：`inject = {}` 占位符 + mock 单测 = 实载全工具瘫痪（#16）。

## 真实事件/工具签名（实载验证过，勿凭示例）

- `agent/session-start`：payload 是 **`{ agent, source }`**，不是 `{ ctx }`；用 `agent.ctx`（作用域 ctx）+ `agent.session.header.cwd`（项目目录）。
- `tools/pre-execute`（allow/deny/ask 门禁）：`(exec, next)`；**在检查工具名前不要碰任何服务**（监听器抛错会打断所有工具调用，见 #16）。
- `tools/post-execute`（enrich）：`(exec, result, next)` → `{ kind: 'accept', content: [...result.content, 追加块] }`；实测 commit 提醒生效。
- `tools/result`：emit-only 观察，失败信号写 stderr。
- `ctx.tools.register(definition)`：`definition.execute(args, exec)` 有**第二参数 exec**；项目目录取 `exec.agent.session.header.cwd`。
- 写码前先 grep 本机 lib（或 clone 的 TS 源）核对签名，`cordis_inspect_list/query` 本机未见，需要时从源码仓找。

## 沙箱（dsh-sandbox / sandbox-policy / sandbox-local）

- **文件效应策略，无命令白名单**；workspace-write 可写根硬编码 `[session.cwd, /tmp, tmpdir()]`（writableRoots）。
- 每会话边界 = **会话 cwd**（`resolve()` 用 `session.header.cwd ?? config.workspaceRoot`）；config `workspaceRoot` 只是无 cwd 会话的 fallback——patch 它不影响普通会话。
- 沙箱只缝在 `ctx.shell`（bash/pwsh）与 fs 工具上；**插件直 `node:child_process` spawn 不经 confine**（宿主信任代码）——dsh-mint 已用此路径（#18）。
- 升级阶梯：`read-only → workspace-write → danger-full-access`；`DSH_PERMISSION_MODE` 改部署默认。
- 「当前目录 + ~/.local/share/mint」双根不可表达；要双根须上游 PR 加额外可写根配置。

## package.json 的 dsh.* 字段与插件识别（2026-08-30 调研）

**dsh.* 全集只有两个字段，且都与浏览器半边/整包应用有关**：

- `dsh.client`（client 面声明，`packages/client/modules/src/index.ts` 解析）：
  `{ platform: 'web'（必填）, inject?: string[], immediately?: boolean, external?: string[] }`；
  client bundle 由 `exports["./client"]` 指向预构建产物（缺失 → MissingClientBundleError）。
  `dsh.client` **不替代挂载**：client/modules 只扫描**已挂载行**里声明了它的包（双面包 = 宿主行 + 浏览器半边）。
- `dsh.bundle.patch`（app bundle 声明，`packages/boot/app-boot/src/profile.ts`）：
  `"dsh": { "bundle": { "patch": "./cordis.patch.yml" } }`——只有整包应用（dsh-base/dsh-acp-app）用，
  声明自己携带的 patch 层。插件不用。

**宿主面插件如何被识别**：不靠 package.json 自描述，靠**组合行挂载**——
`cordis.patch.yml` 行 `{ id, name, config }` → classifyRowSpecifier 分类
（package/file/builtin/preset）→ rowResolves 验证可解析 → cordis loader
`import(name)` → 模块导出即插件契约（`apply` + 可选 `name`/`inject`/`Config`）。
package.json 对宿主面只需 `"type": "module"` + `exports` 指向 ESM 入口，
**无需任何 dsh 标记**；任何符合 cordis 契约的包都可被挂载（"everything is a plugin"）。

## 开发环与验证手段

- `pnpm build` → 挂载绝对路径 `…/dist/index.js` → **重启 harness 生效**（HMR 理论上监听 cordis.patch.yml，实测 touch 未热应用，重启为准）。
- 判定插件是否加载：会话工具列表出现 `mint_query`；上下文注入看 systemPrompt 是否含 `[Mint]` 块。
- 取证：`~/.dsh/sessions/<proj>/<id>/session.jsonl.zstd`（zstd 解压看事件/工具/系统提示）；`~/.dsh/profiles/web/cordis.yml` 是 loader 写回产物；`dsh --profile web --dump-config` 验证组合。
- 挂载失败回滚：`cordis.patch.yml` 改回 `[]` + 重启。

## 历史教训

- 调研结论两处被证伪（裸 id 行可挂载新插件、绝对路径目录可导入）→ 结论必须回到源码复核（#14 修 skill，#774f688 修文档）。
- mock 单测覆盖不了 DI 约束与真实 payload 形状 → **实机验证是 dogfooding 不可省的环节**（#7 因此抓出 4 个 bug：inject、schema 超集、planbind 顺序、session-start payload）。
- **mint 子模块内 commit 只存在于本地 detached HEAD**；dsh-mint 指针引用未推送的 ref → CI checkout 报 `upload-pack: not our ref`。**流程**：子模块改动 → 先 push mint 仓（用户手动）→ 再 push dsh-mint（#33）。
