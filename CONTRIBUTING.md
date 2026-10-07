# Contributing to dsh-mint

Thanks for helping. This file covers the development loop, the configuration and
troubleshooting reference, and where the deeper documentation lives. It is the
human-facing counterpart of [AGENTS.md](AGENTS.md), the project navigation
(Chinese) for AI coding agents; `notes/` holds the internal engineering notes
(index: [`notes/memory.md`](notes/memory.md)).

## Development loop

```sh
git clone https://github.com/yanqd0/dsh-mint.git
cd dsh-mint
pnpm install
pnpm build
dsh plugin --profile web add ./
```

`dsh plugin --profile web add ./` links the checkout instead of copying it, and
pnpm neither runs lifecycle scripts for `link:` dependencies nor installs a
linked package's own dependencies into the profile. The plugin probes **its own
package root** for `mint-faa` first, so after a dependency change run
`pnpm install` in the checkout and restart DSH (or point `mintEntry` at a local
mint build). A linked directory needs no build-script approval, so the mount row
is recorded immediately; the bundled skill is installed when the plugin loads.

Register-only installs (`dsh plugin --profile web add @yanqd0/dsh-mint`) do run
dependency build scripts, and pnpm blocks them by default:

```sh
dsh plugin --profile web approve-builds --all      # approve, then re-run add
dsh plugin --profile web add @yanqd0/dsh-mint --allow-build=@yanqd0/dsh-mint --allow-build=mint-faa
```

`--allow-build=<pkg>` matches **registry** dependencies by name only — a
`file:`/tarball install gets nothing from it. pnpm 10/11 also accepted
`--config.dangerouslyAllowAllBuilds=true`; pnpm 12 ignores it. If an install
exited with `ERR_PNPM_IGNORED_BUILDS` the dependency is already recorded, so
`remove` it and `add` again for the mount row to land.

### Gates

```sh
pnpm dev           # run the plugin entry with tsx
pnpm build         # tsup + client bundle + skill copy → dist/
pnpm test          # vitest
pnpm test:coverage # vitest + v8 thresholds (80/80/70/80)
pnpm lint          # ESLint
pnpm check-types   # tsc --noEmit
pnpm pack:check    # pnpm pack --dry-run
```

CI (Node 22, pnpm 11) runs `lint`, `check-types`, `test:coverage`, `build` and
`pack:check`. Keep one logical change per commit, with an Angular-style prefix.
**Do not run prettier over `skill/**/*.md`**: table padding blows the SKILL.md
byte budget that `src/skill-doc.test.ts` guards.

### Verifying a mount

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # must be 1
```

`id: mint` exactly once, no `patch:` warning. A **duplicated mount** — a
hand-written `insert:` line left in the profile patch while the package's own
bundle patch is also active — shows a count of 2 and fails at boot with
`duplicate loader entry id: mint`. `--dump-config` alone does not catch it:
count the ids.

## Skill distribution

The single source of the skill is [`skill/`](skill/) in this repository;
`pnpm build` copies it to `dist/skill`. The **installed form depends on the
install**:

| Form | Created by | Effect |
| --- | --- | --- |
| symlink (dev/dogfood) | `scripts/install-dsh.sh` / `pnpm skill --link` | `~/.dsh/skills/mint -> <repo>/dist/skill`; `pnpm build` is enough, no restart |
| copy (packaged) | the plugin's load-time sync and postinstall | a real directory; re-synced on the next plugin load, so a restart is needed |

Both land on `$DSH_HOME/skills/mint` (rank 400 `user-dsh`), which is what
shadows the same-named `~/.agents/skills/mint` (rank 500) — an in-plugin skill
provider registers in the global layer and cannot win that comparison, so the
on-disk sync stays.

```sh
scripts/install-dsh.sh            # symlink (default); --copy for the copy form
scripts/install-dsh.sh --status   # form + whether a copy is in sync
scripts/install-dsh.sh --uninstall
```

`scripts/install-dsh.sh` is a thin wrapper over `dist/install-skill.js` — every
mode and every ownership guard has one implementation (`pnpm skill --<mode>` is
equivalent). A symlink is **never** overwritten; a copy carries the
`.dsh-mint-skill` ownership marker, and a directory that cannot be identified as
this plugin's copy is reported and kept unless `--force` is given.

**Removal needs an explicit step**: DSH has no plugin uninstall hook and pnpm
does not run `preuninstall`, so `dsh plugin … remove` leaves
`$DSH_HOME/skills/mint` behind — a skill whose tools are gone. Run
`--uninstall` first (or delete the directory after confirming its `SKILL.md`
says `name: mint`). Details in [`notes/mounting.md`](notes/mounting.md) §3.

## Configuration reference

Options live on the mount line. Override them in the profile's own patch layer
(`~/.dsh/profiles/<profile>/cordis.patch.yml`); an entry with the same id
_patches_ the mounted row instead of mounting a second one, and omitted options
keep their defaults:

```yaml
- id: mint
  config:
    autoApprove: true
    mintEntry: ~/bin/mint
```

| Option | Default | Effect |
| --- | --- | --- |
| `autoApprove` | `false` | Auto-allow mint sandbox escalations on the bash fallback path without any prompt — an explicit trust of the mint CLI. |
| `autoInstallSkill` | `true` | Install the bundled skill into `$DSH_HOME/skills/mint` on plugin load. A symlink target is left alone (the dev form owns it). |
| `debug` | `false` | Reserved for verbose plugin diagnostics. |
| `mintEntry` | mint-faa's `run-mint.js` | Mint CLI to run: a `run-mint.js` path, a native mint binary, a `~`-prefixed path, a bare `PATH` command, or the `dependency` sentinel. |
| `openDagTab` | `true` | Auto-open the plan DAG sidebar tab once the session has a DAG. The browser half probes `GET /dsh-mint/dag` every 5s and stops after the host answers `autoOpen: false`; set it to `false` to leave the tab manual (the tab strip's add control still opens it). |

## Plan DAG (`mint_plan_dag`)

The DAG panel is fed by a host tool, not by mint: `mint_plan_dag` (init / add /
set / get) writes `/tmp/mint/dag/<rootSessionId>.json`, and the panel polls the
read-only `GET /dsh-mint/dag` route for it. Two things are worth knowing while
developing on it:

- **Session attribution resolves to the root session**: a call from a subagent
  walks `session.header.parentSession` up to the top-level session, so a child
  writes its own node into the parent's graph. The file is keyed by that root
  session id, and the panel reads the session whose sidebar it is.
- **The file is `/tmp`-only**: a reboot or `/tmp` cleanup is the documented
  "no DAG" state (the panel shows an empty state, the tool tells the model to
  `init`). Nothing tries to outlive the machine.
- Per the skill, `init`/`add` (new nodes and edges) belong to the main agent;
  subagents only `set` their own node. The tool validates data, not identity.

## Choosing the mint CLI

The plugin needs a mint executable: the published `mint-faa` wrapper (the
default) or a locally built mint. One knob selects either one — the mount-line
`mintEntry` option, or the `MINT_ENTRY` environment variable; the mount line
wins when both are set, and both are read at boot (restart after changing one).

| Mode | How to select | What runs |
| --- | --- | --- |
| Dependency (default) | nothing, or `mintEntry: dependency` | `mint-faa`'s `run-mint.js` inside the installed plugin package, which executes the binary downloaded from the mint release that the installed `mint-faa` pins |
| Local build | `mintEntry: ~/bin/mint`, an absolute path such as `/path/to/mint/target/release/mint`, or a bare `mint` looked up through `PATH` | that executable directly |

`dependency` at either knob is a sentinel: it forces the dependency chain even
when the other knob carries a path — useful while a development profile is
pinned to a local build but you still want to check the published chain. The
dependency range is `>=0.8.0 <1.0.0`: any pre-1.0 `mint-faa` is trusted, so a
`mint-faa` upgrade needs no plugin release.

```sh
# Which mint would a session run? (works without DSH)
node node_modules/@yanqd0/dsh-mint/dist/check-mint-entry.js --mode dependency
node node_modules/@yanqd0/dsh-mint/dist/check-mint-entry.js --mode local --entry ~/bin/mint
```

Both print the mode, an entry label (`mint-faa@<version>`, `PATH:mint`, or the
resolved build path) and the `-V` output, and exit non-zero when the entry cannot
run. The injected `[Mint]` line names the same entry, so a debug build is
distinguishable from a release one (#58).

If the package install did not run the build scripts (pnpm blocks them by
default), the first dependency-mode call downloads the mint binary — that one
call can exceed the 30 s tool timeout. If the `mint` tool reports
`Cannot find module 'mint-faa/run-mint.js'`, the profile has no usable
`mint-faa`: either its build scripts were never approved, or — in a linked
source checkout — the dependency was added after the last `pnpm install`.
Reinstall as described above and restart, run `pnpm install` in the checkout, or
point `mintEntry` at a local build.

## Releases

[`docs/RELEASING.md`](docs/RELEASING.md) is the release runbook (tag gate, the
two registries, release notes, failure handling). Version plans are not kept in
the README: they live in the mint ledger — this project's plans and milestones.
