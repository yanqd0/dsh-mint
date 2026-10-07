import { MINT_ENTRY_DEPENDENCY, describeMintEntry, resolveMintEntry, runMint } from './mint.js';

// Standalone smoke entry (`node dist/check-mint-entry.js`), built as its own
// tsup entry for the same reason as `install-skill-cli.ts`: code splitting would
// move the logic into a shared chunk and the process-entry check would never
// hold (notes/isolated-install.md, pit #2). Never imported by the plugin.
//
// It answers "which mint would a session run, and does it start?" without a DSH
// session. A plain `node` process is NOT under DSH's profile-resolution
// interception, so this proves the mint-faa wrapper + downloaded binary chain
// and an explicit local build; DSH's own bare-specifier routing is covered by
// src/mint.test.ts (#66) and by the live session after a harness restart.
//
//   node dist/check-mint-entry.js --mode dependency
//   node dist/check-mint-entry.js --mode local --entry ~/bin/mint
//
// Exit code 0 = the entry resolved and `-V` ran; 1 = it did not.

const argv = process.argv.slice(2);

function option(flag: string): string | undefined {
  const index = argv.indexOf(flag);
  return index >= 0 ? argv[index + 1] : undefined;
}

const mode = option('--mode') ?? 'dependency';
const entry = mode === 'local' ? (option('--entry') ?? '~/bin/mint') : MINT_ENTRY_DEPENDENCY;

try {
  const resolved = resolveMintEntry({ entry });
  const result = await runMint(process.cwd(), ['-V'], { entry });
  if (result.ok !== true) {
    process.stderr.write(
      `[check-mint-entry] ${mode}: FAILED — ${result.error ?? 'mint 未返回版本'}\n`
    );
    process.exit(1);
  }
  process.stdout.write(`mode\t${mode}\n`);
  process.stdout.write(`entry\t${describeMintEntry(resolved)}\n`);
  process.stdout.write(`version\t${(result.text ?? '').trim()}\n`);
} catch (error) {
  const detail = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[check-mint-entry] ${mode}: FAILED — ${detail}\n`);
  process.exit(1);
}
