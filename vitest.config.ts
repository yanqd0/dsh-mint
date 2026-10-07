import { fileURLToPath } from 'node:url';

import { defineConfig } from 'vitest/config';

export default defineConfig({
  resolve: {
    alias: {
      // The shell resolves this from the page's frozen module table, so the
      // package is not (and must not be) a dependency. Type checking uses
      // `src/client/primitives.d.ts`; importing the client modules in Node needs
      // a real module, which is what the stub provides.
      '@deepseek-ai/dsh-client-ui-primitives': fileURLToPath(
        new URL('tests/helpers/primitives.stub.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    // 测试集中在 tests/：显式声明收集范围，避免 tests/helpers 下的支持模块被当作用例。
    include: ['tests/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Presentation layer: React components need a DOM environment, which
        // 0.2.0 does not carry (jsdom + component tests are 0.3.0 work). Their
        // pure logic lives in `.ts` modules that *are* covered.
        'src/client/**/*.tsx',
        // Type-only declarations emit nothing.
        'src/**/*.d.ts',
        'src/shared/records.ts',
      ],
      reporter: ['text', 'lcov'],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 70,
        statements: 80,
      },
    },
  },
});
