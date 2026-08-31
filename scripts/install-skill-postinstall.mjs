// postinstall 守卫入口（#34）：`pnpm install` 可能先于 `pnpm build` 运行
// （CI 全新 checkout），此时 dist/install-skill.js 尚不存在——直接执行内置
// 入口会 MODULE_NOT_FOUND 使安装失败。本守卫只在入口存在时 import 它，
// 任何失败都只告警并退出 0：skill 安装是 best-effort，插件加载时的运行时
// 同步才是保证路径（#28）。顶层 await 保证 import 的拒绝回调有机会执行。
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const entry = join(dirname(fileURLToPath(import.meta.url)), '..', 'dist', 'install-skill.js')

if (existsSync(entry)) {
  try {
    await import(pathToFileURL(entry).href)
  } catch (error) {
    process.stderr.write(`[dsh-mint] skill install failed: ${error?.message ?? String(error)}\n`)
  }
}
