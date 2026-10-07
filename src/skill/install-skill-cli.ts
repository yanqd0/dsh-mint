import { runSkillCli } from './skill-cli.js';

// The package-manager entry (`node dist/install-skill.js`), and the manual skill
// tool behind `pnpm skill` / `scripts/install-dsh.sh`. Executed directly by the
// package manager or by hand — never imported by the plugin.
//
// A bare invocation only installs and always exits 0: skill installation is
// best-effort and must not fail a package install (#28). Explicit modes return a
// real code, so a guarded refusal is distinguishable from success (#154).
process.exitCode = runSkillCli(process.argv.slice(2));
