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
  issues attach to it.
- **`mint` tool, zero approval** — the agent runs the whole mint CLI through a
  host tool: mint is spawned inside the plugin process, so there is no bash
  call, no sandbox write access and no approval prompt. Subagents inherit the
  tool too (their bash is pinned to `never`). Destructive subcommands (`delete`,
  `import`, `sync`, `export`, `tui`) and the global `--db` / `--project` flags
  are refused.
- **Plan-mode binding** — `exit_plan_mode` is refused while the project has no
  active mint plan, so a host plan cannot drift away from its mint plan.
- **Reminders** — after a `git commit` the agent is reminded to register it
  (`issue state commit --sha`); a failed tool call suggests filing an issue.
- **Bundled mint skill** — the `mint` skill shipped in this package is
  content-synced into `$DSH_HOME/skills/mint` on load, so the agent knows the
  issue/plan/milestone workflow without a manual skill install.
- **bash fallback gate** — if the tool is ever unavailable, the first mint
  sandbox escalation of a session is approved once and later ones pass
  automatically; `autoApprove: true` skips even that first prompt.

Model-facing text — the injected overview and the reminders — is currently
written in Chinese.

## Requirements

- DSH (`@deepseek-ai/dsh`); the host interfaces are verified against `0.1.1-rc.2`
- Node.js >= 20
- No global mint install: the plugin resolves the mint CLI through its own
  `mint-faa` dependency

## Install

Installing the package into a profile also mounts it. The package declares its
own DSH bundle patch (`dsh.bundle.patch`), so `dsh plugin` reconciles the
profile's layer list by installed state — there is no YAML to edit by hand.
Restart DSH afterwards.

### From npm

```sh
dsh plugin --profile web add @yanqd0/dsh-mint
```

`web` is the profile behind `dsh web`; any other profile name works the same.

`dsh plugin` runs pnpm inside `~/.dsh/profiles/web`. pnpm 11 blocks dependency
build scripts by default and exits with `ERR_PNPM_IGNORED_BUILDS`. Approve the
builds with pnpm itself, without editing any YAML, then re-run the install:

```sh
dsh plugin --profile web approve-builds --all
dsh plugin --profile web add @yanqd0/dsh-mint
```

If you prefer a single command and accept allowing all builds during install:

```sh
dsh plugin --profile web add @yanqd0/dsh-mint --config.dangerouslyAllowAllBuilds=true
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

Then install the same way:

```sh
dsh plugin --profile web add @yanqd0/dsh-mint
```

### From source (development)

```sh
git clone https://github.com/yanqd0/dsh-mint.git
cd dsh-mint
pnpm install && pnpm build
dsh plugin --profile web add ./
```

### Verify

```sh
dsh --profile web --dump-config | grep -c "id: mint"   # must be 1
```

The plugin is mounted when `id: mint` appears exactly once and no `patch:`
warning is printed. A duplicated mount (a hand-written `insert` line left in the
profile patch while the bundle patch is also active) shows up as a count of 2 and
fails at boot with `duplicate loader entry id: mint`.

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

| Option             | Default | Effect                                                                                                      |
| ------------------ | ------- | ----------------------------------------------------------------------------------------------------------- |
| `autoApprove`      | `false` | Auto-allow mint sandbox escalations (bash fallback) without any prompt — an explicit trust of the mint CLI. |
| `autoInstallSkill` | `true`  | Content-sync the bundled mint skill into `$DSH_HOME/skills/mint` on plugin load.                            |
| `debug`            | `false` | Reserved for verbose plugin diagnostics.                                                                    |

Override them in the profile's own patch layer (`~/.dsh/profiles/<profile>/cordis.patch.yml`).
An entry with the same id _patches_ the mounted row instead of mounting a second
one — the option you omit keeps its default:

```yaml
- id: mint
  config:
    autoApprove: true
```

## Roadmap

`0.2.0` adds the client face: a mint tab in the conversation area with an issue
panel, backed by host RPC queries.

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
internal Chinese engineering notes, `docs/` the future English documentation.

## License

[MIT](LICENSE)
