import { defineConfig } from 'tsup';

export default defineConfig({
  entry: { index: 'src/index.ts', 'install-skill': 'src/install-skill-cli.ts' },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  target: 'node20',
});
