# 测试规范

编码见 `src/AGENTS.md`，导航与硬约束见根 `AGENTS.md`。

## 落点

单元测试镜像 `src/` 的域：`tests/unit/<域>/<模块>.test.ts` ↔ `src/<域>/<模块>.ts`；无单一被测模块、守仓根契约/产物的落 `guard/`：

```text
tests/                                     # 测试根：单元镜像 src/，守卫盯仓根契约
├── guard/                                 # 守仓根契约与产物：bundle、注入预算、安装脚本、README 对、skill 文档、包清单
│   └── ...                                # 一契约一文件，见下方「契约守卫」段
├── helpers/repo.ts                        # 仓根与 fixture 定位（不手数 ..）
├── unit/shared/                           # 与 src/shared 对称：文本谓词、路由空间
├── unit/mint/                             # mint CLI/工具面与两条门禁
├── unit/host/                             # 注入、提醒、路由、计划门禁与台账
├── unit/dag/                              # DAG 模型/落盘/生命周期/指标/worktree
├── unit/skill/                            # skill 安装与命令面
├── unit/client/                           # 面板视图逻辑与产物
└── unit/                                  # 另有 index.test.ts（宿主入口装配）
```

- 必须 `.test.ts`（其它后缀被 vitest 默认 glob 静默漏跑）；路径定位用 `tests/helpers/repo.ts`，不手数 `..`。

**用例**：`describe` = 被测单元，`it` = 「场景 + 预期」（不用裸 `test()`、不写 class）；≥3 组同构输入用 `it.each`；一个 `it` 只断言一个行为，断言写具体值；循环断言要能定位失败输入。

**只测导出面**：只 import `export` 符号，不测内部、不为可测性新增导出；`vi.mock('./x.js')` 隔离副作用；边界覆盖空串/空数组/可选缺省/控制字符/上下限。

**注释**：中文（存量英文不回改）；只讲「为什么」与不显然前提；`// --- 主题 ---` 分组。

**数据与依赖**：写盘落 `mkdtempSync(tmpdir()…)` + `afterAll` 清理，**绝不写仓根或 `src/`**；不读仓内样例、不联网、不依赖真实终端；脚本/构建类从真实入口 `spawnSync(process.execPath, […])` 发起，断言退出码 + 关键输出片段。

**契约守卫**：只读已上库权威文件（`package.json`、`cordis.patch.yml`、`README*.md`、`skill/**/*.md`、`locale/*.json`）或真产物落 tmpdir；期望值从权威源推导；失败信息指出被破坏的契约；改契约面同步守卫；枚举目录的守卫必须断言非空（见 `copy.test.ts`）。

**覆盖率与收口**：合并前 `pnpm test:coverage`（阈值在 `vitest.config.ts`，**不得下调**；exclude 每加一项写理由）；新 public 函数覆盖关键分支；顺序 = 判性质 → 定名 → 只测导出面 → tmpdir → `test`/`lint`/`check-types`；不设 integration/system 层，需要时再加 `tests/e2e/`。
