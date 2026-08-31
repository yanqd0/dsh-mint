# 隔离环境实测发布包（PNPM_HOME/DSH_HOME 隔离法）

> 用途：验证 `pnpm add -g @yanqd0/dsh-mint` 安装路径与 skill/mint-faa 自动安装，
> **不污染用户真实全局环境**。来源 #28/#29/#32 实载验证；对外文档可引用（#8）。

## 标准步骤

```bash
cd dsh-mint
pnpm pack                       # 产出 yanqd0-dsh-mint-<ver>.tgz（scoped 名去 @ 加连字符）
export P=$(mktemp -d) D=$(mktemp -d)   # P=假 PNPM_HOME，D=假 DSH_HOME
PATH="$P/bin:$PATH"             # 必须：pnpm 校验全局 bin 在 PATH，否则报
                                # "The configured global bin directory ... is not in PATH"
PNPM_HOME=$P DSH_HOME=$D pnpm add -g ./yanqd0-dsh-mint-<ver>.tgz
```

检查点：

- **skill 落点**：`ls $D/skills/mint/`——postinstall 生效时立即存在；被拦时为空，
  由插件加载时的运行时同步兜底（#28）。
- **全局包位置**：`$P/store/v11/links/@yanqd0/dsh-mint/<ver>/<hash>/node_modules/@yanqd0/dsh-mint/`
  （scoped 名在 links 下是 `@yanqd0/dsh-mint` 一段，无嵌套 `@`；`v11` = pnpm 大版本）。
- **mint-faa 二进制**：`.../node_modules/mint-faa/bin/`——缺失 = postinstall 被拦
  （mint CLI 不可用，见下方坑 1；该缺口待跟进 issue）。

## 附加实验

- **运行时路径模拟**（= 插件 apply 调用 installSkill）：
  `DSH_HOME=$D2 node <全局包>/dist/install-skill.js`；再跑一次验证幂等（内容一致则跳过）。
- **放行构建脚本对照**：重装加 `--config.dangerouslyAllowAllBuilds=true` → 输出
  `... postinstall: Done` 即执行成功；`--allow-build=<pkg>` 对全局 tarball 无效。

## 实证坑（三次踩坑结论）

1. **pnpm 10+ 默认拦截依赖构建脚本**：仓库内靠 `pnpm-workspace.yaml`
   `allowBuilds`（esbuild/mint-faa）放行；`pnpm add -g` 无仓库配置 → postinstall
   不跑是常态。因此 #28 的**插件加载时同步才是保证路径**，postinstall 只是加分。
2. **tsup 代码分割 + `import.meta.url` 守卫失效**：逻辑被挪进共享 chunk 后，
   入口只剩 re-export，守卫比较 chunk URL 永不成立 → CLI 入口必须是**独立文件**
   + entry 命名映射（`'install-skill': 'src/install-skill-cli.ts'`），调用放在入口
   顶层，不要在共享模块里用 argv 守卫。
3. **pnpm 全局 bin PATH 检查**：隔离测试必须 `PATH="$P/bin:$PATH"`，否则装不上。
4. **postinstall 入口须有存在性守卫**：CI fresh checkout 时 `pnpm install` 先于
   `pnpm build`，dist 尚未构建——直接 `node dist/install-skill.js` 会
   MODULE_NOT_FOUND 挂掉整个安装。postinstall 实际指向
   `scripts/install-skill-postinstall.mjs`：入口存在才 import，任何失败告警并退出 0（#34）。

## 关联

- `notes/MOUNTING.md` §3（安装途径与自动安装语义）。
- #28（skill 自动安装）、#29（发布 workflow）；mint-faa 二进制兜底待另立 issue。
