# 条件分支决策表（flow-conditions）

> 标题/body 模板：`body-templates/11.md、14.md`
> 命令一律经 `mint` 工具：`mint({ args: [...] })`。

供各 flow 在登记/推进时按场景选择。

## 挂载规则（issue 二选一：属 plan 后不能直接挂 milestone）

| 场景 | 动作 |
|---|---|
| 有关联 plan（正在开发的计划） | `mint({ args: ["plan","attach","<PLAN>","<ISSUE>"] })` |
| 无 plan 但有目标版本 | `mint({ args: ["milestone","attach","<RM>","<ISSUE>"] })`（直接挂 milestone） |
| 都不确定 / 独立项 | 不挂（独立 issue，后续排期） |

## 测试分支（close 的 test-cmd 必填）

| 场景 | test-cmd |
|---|---|
| 有测试的项目 | 实际测试命令（如 `pnpm test`） |
| 无测试的项目 | `not-tested` |

## git 分支（state commit --sha）

| 场景 | 处理 |
|---|---|
| git 仓库 | 默认读 HEAD（可省略 `--sha`；建议显式传 `git rev-parse --short=7 HEAD`） |
| 非 git 目录 / 普通目录 | 需显式 `--sha <SHA>`；无 commit 可考虑 `drop` / `reopen` |

## link 规则

| 场景 | 动作 |
|---|---|
| 被别的修改引入（回归） | `mint({ args: ["issue","link","create","<issue>","solves","<引入 issue>"] })` |
| 相关但不解决 | `mint({ args: ["issue","link","create","<issue>","related","<other>"] })` |
| 重复 | `mint({ args: ["issue","link","create","<issue>","duplicates","<existing>"] })` |

## kind 选择（决定状态机是否含 dev 态）

| 场景 | kind |
|---|---|
| 缺陷 / 问题 | `problem` |
| 需求 / 改进 | `requirement` |
| 杂务 / 文档 / 调研 / CI（不改行为，**跳过 dev 态**） | `task` |
