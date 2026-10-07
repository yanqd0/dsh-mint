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
  issues attach to it. `mint doctor` health warnings (a stale plan, an idle
  milestone) arrive as one more line.
- **`mint` tool, zero approval** — the agent runs the whole mint CLI through a
  host tool spawned inside the plugin process: no bash call, no sandbox write
  access, no approval prompt. Subagents inherit it too. Destructive subcommands
  (`delete`, `import`, `sync`, `export`, `tui`) and the global `--db` flag are
  refused.
- **Cross-project work** — the target project defaults to the session's own cwd,
  so **own-project calls take no `-p`**; `-p` / `--project` reaches another
  project's ledger in the same session: reads pass straight through, and a write
  asks once, naming the target project and the action.
- **Plan binding (one-way)** — `exit_plan_mode` is refused while the project has
  no **decomposed** mint plan, so a host plan cannot drift away from its mint
  record — but **creating a mint plan does not require plan mode**.
- **Mint panel in the right sidebar** — opened from the tab strip's add control
  beside _Workspace files_ and _New terminal_, it shows this project's issues,
  plans and milestones read-only.
- **Plan DAG panel** — a second sidebar tab, beside the mint panel, draws the
  execution graph the agent records through the `mint_plan_dag` tool: pending,
  running (pulsing) and settled nodes, with the full title, the self-reported
  token count and the conclusion text on hover. It opens itself as soon as a DAG
  exists for the session and refreshes while it is on screen.
- **Reminders** — after a `git commit` the agent is reminded to register it, and
  after a mint state change to sync the host todo panel.
- **Bundled mint skill** — the `mint` skill ships with this package and is
  installed into `$DSH_HOME/skills/mint` on load, so the agent knows the
  issue/plan/milestone workflow without a manual skill install.

## Requirements

- DSH (`@deepseek-ai/dsh`); the host interfaces are verified against `0.2.0-rc.2`
- Node.js >= 20
- No global mint install: the plugin resolves the mint CLI through its own
  `mint-faa` dependency

## Install

Installing the package into a profile also mounts it. The package declares its
own DSH bundle patch (`dsh.bundle.patch`), so `dsh plugin` reconciles the
profile's layer list by installed state — there is no YAML to edit by hand.
Restart DSH afterwards: the plugin config and the profile's package resolution
are both fixed at boot.

### From npm

```sh
dsh plugin --profile web add @yanqd0/dsh-mint \
  --allow-build=@yanqd0/dsh-mint --allow-build=mint-faa
```

`web` is the profile behind `dsh web`; any other profile name works the same.

`dsh plugin` runs pnpm inside `~/.dsh/profiles/web`. pnpm blocks dependency
build scripts by default, and this install runs two: the plugin's skill install
and `mint-faa`'s mint-binary download. Without `--allow-build` the install exits
with `ERR_PNPM_IGNORED_BUILDS` — **after** recording the dependency in the
profile manifest, so a plain re-run no longer reconciles the profile's bundle
list. If that already happened, recover with:

```sh
dsh plugin --profile web approve-builds --all      # approve and run the blocked scripts
dsh plugin --profile web remove @yanqd0/dsh-mint   # the recorded dependency has to be
dsh plugin --profile web add @yanqd0/dsh-mint      # added again for the mount row to land
```

### From GitHub Packages

The same `@yanqd0/dsh-mint` name is published to both registries. GitHub
Packages requires authentication even for public packages, using a personal
access token (classic) with the `read:packages` scope. Add both lines to
`~/.npmrc` (or to `~/.dsh/profiles/<profile>/.npmrc`):

```
@yanqd0:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${GITHUB_TOKEN}
```

Then install the same way as from npm.

### Verify

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # must be 1
```

The plugin is mounted when `id: mint` appears exactly once and no `patch:`
warning is printed.

### Uninstall

The bundled skill lives outside the profile, so removing the package leaves it
behind. Remove both halves in the same pass:

```sh
# with the package still installed (or from a source checkout, scripts/install-dsh.sh --uninstall):
node ~/.dsh/profiles/web/node_modules/@yanqd0/dsh-mint/dist/install-skill.js --uninstall
dsh plugin --profile web remove @yanqd0/dsh-mint
```

If the package is already gone, delete the leftover copy by hand — check it
first (`name: mint` on line 2 means it is the plugin's copy, and a symlink is
removed as a link, never followed):

```sh
head -2 "$HOME/.dsh/skills/mint/SKILL.md"
rm -rf "$HOME/.dsh/skills/mint"
```

## Usage

Start a session in a project tracked by mint: the `[Mint]` overview is injected
on the first turn and the bundled skill teaches the agent the issue → plan →
milestone workflow. Ask in plain language — "what should we do next?", "record
this bug", "start working on #42" — and the agent drives mint through the `mint`
tool, which reaches every mint subcommand.

## Configuration

Options are overridden in the profile's own patch layer
(`~/.dsh/profiles/<profile>/cordis.patch.yml`). An entry with the same id
_patches_ the mounted row instead of mounting a second one, and the options you
omit keep their defaults:

```yaml
- id: mint
  config:
    # Auto-allow mint's bash-fallback escalations without any prompt — an
    # explicit trust of the mint CLI (default false):
    autoApprove: true
```

`autoApprove` is the option users change in practice. The remaining options
(`mintEntry`, `autoInstallSkill`, `debug`) are development switches, documented
in [CONTRIBUTING.md](CONTRIBUTING.md).

## Contributing

Issues and pull requests are welcome — [CONTRIBUTING.md](CONTRIBUTING.md) has
the development loop and the full configuration and troubleshooting reference.
AI coding agents start from [AGENTS.md](AGENTS.md); `notes/` holds the internal
engineering notes.

## License

[MIT](LICENSE)
