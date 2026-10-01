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
        new URL('src/client/primitives.stub.ts', import.meta.url)
      ),
    },
  },
  test: {
    environment: 'node',
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: [
        // Presentation layer: React components need a DOM environment, which
        // 0.2.0 does not carry (jsdom + component tests are 0.3.0 work). Their
        // pure logic lives in `.ts` modules that *are* covered.
        'src/client/**/*.tsx',
        // Test-only double for a shell-provided module; no shipped statement.
        'src/client/primitives.stub.ts',
        // Type-only declarations emit nothing.
        'src/**/*.d.ts',
        'src/records.ts',
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
