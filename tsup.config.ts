import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    index: 'src/index.ts',
    'install-skill': 'src/skill/install-skill-cli.ts',
    'check-mint-entry': 'src/mint/check-entry-cli.ts',
  },
  format: ['esm'],
  dts: true,
  sourcemap: true,
  clean: true,
  outDir: 'dist',
  target: 'node20',
});
