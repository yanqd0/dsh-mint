# dsh-mint

[![npm](https://img.shields.io/npm/v/@yanqd0/dsh-mint.svg)](https://www.npmjs.com/package/@yanqd0/dsh-mint)
[![CI](https://github.com/yanqd0/dsh-mint/actions/workflows/ci.yml/badge.svg)](https://github.com/yanqd0/dsh-mint/actions)
[![codecov](https://codecov.io/gh/yanqd0/dsh-mint/graph/badge.svg)](https://codecov.io/gh/yanqd0/dsh-mint)

English | [中文](README.zh.md)

[mint](https://github.com/yanqd0/mint) issue tracking inside DSH sessions: a
session starts knowing what is open, every change gets registered, and a host
plan always has a mint plan behind it.

## What it does

- **Session context** — every session opens with a `[Mint]` overview: the top
  open issues, the running milestone, and the rule that new plans and standalone
  issues attach to it. When `mint doctor` reports health warnings (a stale plan,
  an idle milestone, stalled dev work), one more line carries the counts and
  points at the tool.
- **`mint` tool, zero approval** — the agent runs the whole mint CLI through a
  host tool: mint is spawned inside the plugin process, so there is no bash
  call, no sandbox write access and no approval prompt. Subagents inherit the
  tool too (their bash is pinned to `never`). Destructive subcommands (`delete`,
  `import`, `sync`, `export`, `tui`) and the global `--db` flag are refused.
- **Cross-project work** — the target project defaults to the session's own cwd,
  so **own-project calls take no `-p`**; `-p` / `--project` (before the subcommand)
  reaches another project's ledger in the same session: reads pass straight
  through, and a **write** asks once, naming the target project and the action,
  then stays quiet for that project in that session. A target that is not a known
  project is refused with the candidate list instead of silently creating one, and
  `autoApprove` never silences this gate.
- **Plan binding (one-way)** — `exit_plan_mode` is refused while the project has
  no **decomposed** mint plan (`running`, or `open` with at least one issue
  attached; an empty plan never passes) and while a **second plan in the same
  milestone** is running (the refusal names the colliding plans and the ways to
  converge: fold this session's work into the running plan, park its `planned`
  issues, or `plan detach` the issue that revived a finished one; plans in
  different milestones are the user's sanctioned parallel versions and pass), so
  a host plan cannot drift away from its mint record — but **creating a mint plan
  does not require plan mode**. Outside plan mode the plugin refuses
  `exit_plan_mode` itself with an actionable message instead of the host-level
  error, and pays no mint run for it (#142).
  Leaving plan mode (the start-of-work point) locks **this plan's** issues to
  `planned` via `plan plan`; advice filed for another plan or milestone stays
  `open`. Leaving plan mode from a session that has written nothing to mint
  appends a reminder to register the work: a running plan in the project may
  belong to someone else's.
  A **non-tool exit** (`/plan off`, the GUI toggle) has no tool result to carry
  it, so the `[Mint]` overview gains the same notice **once**; it disappears as
  soon as the session writes to mint.
- **Reminders** — after a `git commit` — including one run through the host `uv`
  tool (`uv run git commit`) — the agent is reminded to register it
  (`issue state commit --sha`); after `issue state` / `plan plan` / `plan close`
  it is reminded to sync the host todo panel (whose `todos` projection resets
  every turn, so an unwritten list shows stale progress); a failed call is not
  mistaken for a commit, and a failed tool call suggests filing an issue.
- **Bundled mint skill** — the `mint` skill shipped in this package is
  content-synced into `$DSH_HOME/skills/mint` on load, so the agent knows the
  issue/plan/milestone workflow without a manual skill install.
- **bash fallback gate** — bash is a last resort, for sessions where the tool is
  unavailable or the plugin is not installed: there the first mint sandbox
  escalation of a session is approved once and later ones pass automatically
  (`autoApprove: true` skips even that first prompt). When the plugin _is_
  loaded, a recognised `mint -p <project> …` bash write goes through the same
  cross-project confirmation as the tool.

Model-facing text — the injected overview and the reminders — is currently
written in Chinese.

## Requirements

- DSH (`@deepseek-ai/dsh`); the host interfaces are verified against `0.1.1-rc.2`
- Node.js >= 20
- No global mint install: the plugin resolves the mint CLI through its own
  `mint-faa` dependency (`>=0.8.0 <1.0.0`) — see
  [Choosing the mint CLI](#choosing-the-mint-cli). Any pre-1.0 `mint-faa`
  release is trusted, so a `mint-faa` upgrade needs no plugin release; point
  `mintEntry`/`MINT_ENTRY` at a local build to dogfood an unreleased mint

## Install

Installing the package into a profile also mounts it. The package declares its
own DSH bundle patch (`dsh.bundle.patch`), so `dsh plugin` reconciles the
profile's layer list by installed state — there is no YAML to edit by hand.
Restart DSH afterwards: the plugin config and the profile's package resolution
are both fixed at boot.

Installing from source (`dsh plugin --profile web add ./`) links the directory
instead of copying it, and pnpm does not install a linked package's own
dependencies into the profile. The plugin probes its own package root for
`mint-faa` first, so run `pnpm install` in the checkout after a dependency
change (then restart) before the dependency chain can work — or select a local
build instead.

### From npm

```sh
dsh plugin --profile web add @yanqd0/dsh-mint \
  --allow-build=@yanqd0/dsh-mint --allow-build=mint-faa
```

`web` is the profile behind `dsh web`; any other profile name works the same.

`dsh plugin` runs pnpm inside `~/.dsh/profiles/web`. pnpm blocks dependency
build scripts by default, and this install runs two: the plugin's skill sync and
`mint-faa`'s mint-binary download. Without `--allow-build` the install exits with
`ERR_PNPM_IGNORED_BUILDS` — **after** recording the dependency in the profile
manifest, so a plain re-run no longer reconciles the profile's bundle list. If
that already happened, recover with:

```sh
dsh plugin --profile web approve-builds --all      # approve and run the blocked scripts
dsh plugin --profile web remove @yanqd0/dsh-mint   # the recorded dependency has to be
dsh plugin --profile web add @yanqd0/dsh-mint      # added again for the mount row to land
```

`approve-builds` on a profile that never requested this package reports "There
are no packages awaiting approval" and approves nothing. The one-shot allow is
`--allow-build=<pkg>`, but it matches **registry** dependencies by name only — a
`file:`/tarball install (`dsh plugin --profile web add ./`) gets nothing from it.
For that case pnpm 10/11 accepted `--config.dangerouslyAllowAllBuilds=true`, and
pnpm 12 ignores it.

After a failed install the plugin is not mounted at all —
`dsh --profile web --dump-config` prints no `id: mint`. Verify below.

### From GitHub Packages

The same `@yanqd0/dsh-mint` name is published to both registries. GitHub
Packages requires authentication even for public packages, using a personal
access token (classic) with the `read:packages` scope. Add both lines to
`~/.npmrc` (or to `~/.dsh/profiles/<profile>/.npmrc`):

```
@yanqd0:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then install the same way — the build-script step from the npm section applies
here too:

```sh
dsh plugin --profile web add @yanqd0/dsh-mint \
  --allow-build=@yanqd0/dsh-mint --allow-build=mint-faa
```

### From source (development)

```sh
git clone https://github.com/yanqd0/dsh-mint.git
cd dsh-mint
pnpm install && pnpm build
dsh plugin --profile web add ./
```

A linked directory needs no build approval (pnpm does not run lifecycle scripts
for `link:` dependencies), so this records the mount row immediately; the
bundled skill is synced when the plugin loads.

### Verify

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # must be 1
```

The plugin is mounted when `id: mint` appears exactly once and no `patch:`
warning is printed. A duplicated mount (a hand-written `insert` line left in the
profile patch while the bundle patch is also active) shows up as a count of 2 and
fails at boot with `duplicate loader entry id: mint`.

### Choosing the mint CLI

The plugin needs a mint executable: the published `mint-faa` wrapper (the
default, which runs the released binary) or a locally built mint. One knob
selects either one — the mount-line `mintEntry` option, or the `MINT_ENTRY`
environment variable; the mount line wins when both are set.

| Mode                 | How to select                                                                                                                    | What runs                                                                                                                                                     |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Dependency (default) | nothing, or `mintEntry: dependency`                                                                                              | `mint-faa`'s `run-mint.js` inside the installed plugin package, which executes the binary downloaded from the mint release that the installed `mint-faa` pins |
| Local build          | `mintEntry: ~/bin/mint`, an absolute path such as `/path/to/mint/target/release/mint`, or a bare `mint` looked up through `PATH` | that executable directly                                                                                                                                      |

`dependency` at either knob is a sentinel: it forces the dependency chain even
when the other knob carries a path — useful while a development profile is
pinned to a local build but you still want to check the published chain.

```sh
# Which mint would a session run? (works without DSH)
node node_modules/@yanqd0/dsh-mint/dist/check-mint-entry.js --mode dependency
node node_modules/@yanqd0/dsh-mint/dist/check-mint-entry.js --mode local --entry ~/bin/mint
```

Both print the mode, an entry label (`mint-faa@<version>`, `PATH:mint`, or the
resolved build path) and the `-V` output, and exit non-zero when the entry cannot
run. The injected `[Mint]` line names the same entry (`…/target/release/mint`),
so a debug build is distinguishable from a release one (#58).

A change to either knob needs a DSH restart. The first dependency-mode call
downloads the mint binary when the package install did not (pnpm blocks build
scripts by default — see Install); that one download can exceed the 30 s tool
timeout.

If the `mint` tool reports `Cannot find module 'mint-faa/run-mint.js'`, the
profile has no usable `mint-faa`: either its build scripts were never approved
(see the npm section) or, in a linked source checkout, the dependency was added
after the last `pnpm install`. Reinstall as described above and restart, run
`pnpm install` in the checkout, or point `mintEntry` at a local build. The
`[Mint]` overview reports the same outage as a `WARNING` line instead of an
empty project.

## Usage

Start a session in a project tracked by mint: the `[Mint]` overview is injected
on the first turn and the bundled skill teaches the agent the issue → plan →
milestone workflow. Ask in plain language ("what should we do next?", "record
this bug") and the agent drives mint through the `mint` tool — the same calls
you can ask for explicitly:

| Request                  | Tool call behind it                                          |
| ------------------------ | ------------------------------------------------------------ |
| list open issues         | `mint({args:["list"]})` — one TSV page of 5                  |
| file a bug               | `mint({args:["issue","add","<title>","--kind","problem"]})`  |
| start work on an issue   | `mint({args:["issue","state","start","42"]})`                |
| close a plan after tests | `mint({args:["plan","close","7","--test-cmd","<command>"]})` |

Any subcommand is reachable, and `mint({args:["<subcommand>","--help"]})` returns
the mint help verbatim.

## Configuration

| Option             | Default                  | Effect                                                                                                                                                                                      |
| ------------------ | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `autoApprove`      | `false`                  | Auto-allow mint sandbox escalations (bash fallback) without any prompt — an explicit trust of the mint CLI.                                                                                 |
| `autoInstallSkill` | `true`                   | Content-sync the bundled mint skill into `$DSH_HOME/skills/mint` on plugin load.                                                                                                            |
| `debug`            | `false`                  | Reserved for verbose plugin diagnostics.                                                                                                                                                    |
| `mintEntry`        | mint-faa's `run-mint.js` | Mint CLI to run: a `run-mint.js` path, a native mint binary, a `~`-prefixed path, a bare `PATH` command, or the `dependency` sentinel. See [Choosing the mint CLI](#choosing-the-mint-cli). |

Override them in the profile's own patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`).
An entry with the same id _patches_ the mounted row instead of mounting a second
one — the option you omit keeps its default:

```yaml
- id: mint
  config:
    autoApprove: true
    # Dogfood a locally built mint instead of the published dependency
    # (`~` is expanded; a bare `mint` is looked up through PATH):
    mintEntry: ~/bin/mint
    # mintEntry: dependency   # force the published mint-faa chain instead
```

The environment variable `MINT_ENTRY` does the same without touching the profile
(the mount-line `mintEntry` wins when both are set). Both are read at boot, so
restart DSH after changing either one.

## Roadmap

`0.2.0` adds the client face: a **mint panel in the right sidebar**, opened from
the tab strip's add control beside _Workspace files_ and _New terminal_. It reads
the session's project read-only — issues (list, filters, detail), plans and
milestones (lists, details) — through read-only host routes backed by the mint
CLI. `0.3.0` makes the panel bilingual: its own copy ships in Simplified Chinese
and English (Settings → General → Language), mint's own vocabulary — status and
kind values, `P0`–`P3` — stays verbatim in both locales, and `Issue`, `Plan` and
`Milestone` stay English as mint's key concepts.

## Development

```sh
pnpm dev           # run the plugin entry with tsx
pnpm build         # tsup + skill copy → dist/
pnpm test          # vitest
pnpm lint          # ESLint
pnpm check-types   # tsc --noEmit
```

[`AGENTS.md`](AGENTS.md) is the project navigation (Chinese) for AI coding
agents: layout, hard constraints and architecture facts. `notes/` holds the
internal Chinese engineering notes, and [`docs/RELEASING.md`](docs/RELEASING.md)
is the release runbook (the rest of the `docs/` i18n work is still to come).

## License

[MIT](LICENSE)
