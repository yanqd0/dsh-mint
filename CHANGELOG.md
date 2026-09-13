# Change Log

## 0.1.0

### Features

- **Session context injection** — every session opens with a `[Mint]` overview of the top open issues and the running milestone, plus the rule that new plans and standalone issues attach to that milestone; with no milestone running the agent is told to infer the next version by semver and ask, not to set one itself.
- **`mint` host tool** — the whole mint CLI is reachable from the agent through one host tool executed inside the plugin process (no bash call, no sandbox write access, no approval prompt); output is passed through verbatim as mint's own TSV and `--help` works through the same tool; destructive subcommands (`delete`, `import`, `sync`, `export`, `tui`) and the global `--db` / `--project` flags are refused; registered on the root context, so subagents inherit it.
- **Plan-mode binding** — `exit_plan_mode` is refused while the project has no active mint plan, so a host plan cannot drift away from its mint plan.
- **Event reminders** — after a `git commit` the agent is reminded to register it with `issue state commit --sha`, and a failed tool call suggests filing an issue.
- **Bundled mint skill** — the mint skill packaged with the plugin is content-synced into `$DSH_HOME/skills/mint` on plugin load and by a postinstall hook, so the issue/plan/milestone workflow needs no manual skill install; the repository's `skill/` directory is its single source.
- **Self-mounting package** — the package declares its own DSH bundle patch (`dsh.bundle.patch`), so installing it mounts it by installed state with no YAML to edit by hand.
- **Approval fallback gate** — if the tool is ever unavailable, the first mint sandbox escalation of a session is approved once and later ones pass automatically; `autoApprove: true` skips even that first prompt.

### Bug Fixes

- Fixed the plugin failing to load in DSH by declaring its `tools` and `shell` injection dependencies.
- Hardened plan binding to check the tool name before touching the shell, so it fails open instead of throwing.
- Guarded the postinstall entry with an existence check, so installing the package in a clean environment no longer fails.
- Made the approval gate recognise its own escalations by two signals and remember grants per session id, so a session's first approval is not requested again.

### Others

- Added CI gates (lint, type check, tests with coverage, build, pack check) with Codecov upload and badges.
- Added the npm publish workflow: a tag-triggered version gate, the npmjs release through OIDC trusted publishing with provenance, the same package on GitHub Packages, and a GitHub Release whose notes come from this changelog.
- Rewrote the README as the external entry point (install from npm, GitHub Packages or source; verify; usage; configuration; roadmap) and added the synchronized Chinese `README.zh.md`.
- Collected the DSH plugin research into `notes/` (plugin development, mounting and install, sandbox escalation, isolated-install testing, install self-check, graph-memory mechanism) and replaced `CLAUDE.md` with `AGENTS.md` as the project navigation.
- Rewrote the mint skill for the DSH single-host, tool-only workflow, moved its source into this repository and dropped the mint git submodule.
- Set up the TypeScript toolchain (tsup, vitest, ESLint, tsc).
