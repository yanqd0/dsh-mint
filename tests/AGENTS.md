# tests/AGENTS.md — 测试规范（面向 AI）

> 只写工具管不到的（prettier/ESLint/tsc/vitest 已管项不复述）；编码见 `src/AGENTS.md`，导航见根 `AGENTS.md`；本文件与根共享注入字节预算。

**落点**：镜像优先 `tests/unit/<域>/<模块>.test.ts` ↔ `src/<域>/<模块>.ts`；无单一被测模块、守仓根契约/产物的 → `tests/guard/`；必须 `.test.ts`（其它后缀被 vitest 默认 glob 静默漏跑）；路径定位用 `tests/helpers/repo.ts`，不手数 `..`。

**用例**：`describe` = 被测单元，`it` = 「场景 + 预期」（不用裸 `test()`、不写 class）；≥3 组同构输入用 `it.each`；一个 `it` 只断言一个行为，断言写具体值；循环断言要能定位失败输入。

**只测导出面**：只 import `export` 符号，不测内部、不为可测性新增导出；`vi.mock('./x.js')` 隔离副作用；边界覆盖空串/空数组/可选缺省/控制字符/上下限。

**注释**：中文（存量英文不回改）；只讲「为什么」与不显然前提；`// --- 主题 ---` 分组。

**数据与依赖**：写盘落 `mkdtempSync(tmpdir()…)` + `afterAll` 清理，**绝不写仓根或 `src/`**；不读仓内样例、不联网、不依赖真实终端；脚本/构建类从真实入口 `spawnSync(process.execPath, […])` 发起，断言退出码 + 关键输出片段。

**契约守卫**：只读已上库权威文件（`package.json`、`cordis.patch.yml`、`README*.md`、`skill/**/*.md`、`locale/*.json`）或真产物落 tmpdir；期望值从权威源推导；失败信息指出被破坏的契约；改契约面同步守卫；枚举目录的守卫必须断言非空（见 `copy.test.ts`）。

**覆盖率与收口**：合并前 `pnpm test:coverage`（阈值在 `vitest.config.ts`，**不得下调**；exclude 每加一项写理由）；新 public 函数覆盖关键分支；顺序 = 判性质 → 定名 → 只测导出面 → tmpdir → `test`/`lint`/`check-types`；不设 integration/system 层，需要时再加 `tests/e2e/`。
