# Change Log

## 0.2.0

### Features

- **mint panel in the right sidebar** — the plugin's client face: a read-only mint tab opened from the tab strip's add control beside _Workspace files_ and _New terminal_, with copy served through the client locale service (Simplified Chinese for now).
  - Issue view: list with search, an _include settled_ switch and paging, plus a full detail page whose body renders as a markdown code block.
  - Plan and milestone views: lists with the same _include settled_ switch, and detail pages that inline their child issues and plans as the very rows the outer lists use.
  - Label badges in their own record colour, and placement on every row — the owning plan and the effective milestone, solid when attached directly, dashed when reached through a plan.
- **Prebuilt client bundle** — `dsh.client` declares the browser platform and the plugins that must load first; `scripts/build-client.mjs` builds the `__ModuleLoader__` artifact, which requires only the browser kernel's frozen modules; a contract test keeps declaration and artifact in step.
- **Read-only query routes** — `/dsh-mint/{issues,plans,milestones,issue,plan,milestone,meta}` registered as one prefix on the host `webServer`; `/dsh-mint/meta` carries the plans, milestones, labels and placement that `list --json` omits, placement lookups are memoised briefly (the panel's refresh bypasses that cache), and each request owns one `AbortController`, so a dropped connection cancels all of its child processes.
- **Cross-project `mint` calls** — `-p/--project` (only before the subcommand) is accepted, and the target is checked against `project list` before anything runs, so an unknown or unprobeable project is refused instead of letting mint silently create a project database; `--db` stays refused.
- **Cross-project write gate** — a write on another project asks once per session and target project, with the project and the action in the reason the user reads; reads pass through, anything the classifier cannot decide fails closed, and a recognizable bare `mint` command in bash goes through the same classifier.
- **mint entry and version reporting** — the `[Mint]` overview opens with the mint actually being run and how it resolved (`mint-faa@0.7.0`, `PATH:mint`, `…/target/release/mint`); a clap-level failure suggests checking `-V` and pointing `mintEntry` / `MINT_ENTRY` at a newer mint.
- **mint entry dual mode** — `mintEntry` / `MINT_ENTRY` picks the dependency chain or a local build (`dependency` sentinel, `~` expansion, PATH names); resolution probes the plugin package root before `require.resolve`, covering pnpm isolated/hoisted, npm and `link:` layouts; `dist/check-mint-entry.js` self-checks either chain in one command.
- **Per-request budget** — the fixed injection shrank from 2657 B to 1323 B (top issues 8 → 5 with the real total, labels dropped, one-line milestone branches), and all four byte ceilings are regression tests now.
- **Root flags and stderr** — `-V` / `--version` / `--help-llm` are allowed as root flags, and mint's stderr footer (the `--- Page 1/3 (… total) ---` line) reaches the agent on success, so one page is not mistaken for the whole list.
- **mint skill** — split into gates plus routing, with branch topics moved into `references/` (13883 B down to the 4000 B budget) and its command reference, state machine and flow rules brought up to mint 0.8; new flows cover the orphan-issue sweep, body-editing discipline and cross-project registration, and label rules moved into their own reference.

### Bug Fixes

- Record decoding no longer drops what mint legitimately returns: the shape guard accepts null `body` / `version` fields, a nullable `label.color` keeps its label (falling back to a neutral badge), a milestone without a `version` still shows up in the overview, and link targets are read from `other_id` so details keep their number.
- Cross-project classification: `--help` anywhere in the argv is no longer a read shortcut (values after `--` are not exempt either), and a call with only root flags or no subcommand is no longer mistaken for a write.
- `exit_plan_mode` now requires a running plan, and `plan list` reads with `--no-page`, so a running plan past the first page is not missed.
- Plan and milestone lists drop settled states (`partial`, `dropped`, `done`) by default and repaginate the requested page; an explicit status or `allStates=1` still goes straight to mint.
- The panel no longer mixes its tabs up: the open target carries its `kind`, so a plan and a milestone sharing an id each resolve in their own table.
- The route prefix lost its trailing slash — the host matches a `prefix` route as `pathname === prefix || startsWith(prefix + '/')`, so `/dsh-mint/` sent `/dsh-mint/issues` into the SPA fallback as an empty 404.
- `output.schema` gained `timedOut`, so timeout notices are not rejected by the host's validation.
- `project list` probes are memoised for a short TTL and shared by the gate and the tool, so one cross-project call no longer spawns twice.
- mint-faa cold starts are serialised, the first call gets a 180 s budget, and a timeout says what happened; the dependency range became `>=0.8.0 <1.0.0`, since `^0.8.0` freezes patches under 0.x.
- The `[Mint]` overview warns when `list --json` drifts in shape instead of quietly rendering an empty overview.
- Skill install sync compares the whole tree, so a `references/` change no longer skips resynchronisation silently.
- The skill's `link` argument follows the CLI again and uses `blocked-by`, with a regression guard.
- The host-side footer wording and fixtures were aligned with the mint 0.8 output contract.

### Others

- New release runbook `docs/RELEASING.md`: the tag gate, dual-registry publishing, release notes taken from this changelog, and the failure modes.
- The README pair documents the mint-CLI entry choice (dependency chain vs local build, the sentinel, the self-check command, the `Cannot find module` path) and the install recovery sequence for pnpm's ignored build scripts; the roadmap now describes the client face.
- New engineering notes on the client face's seat and RPC contracts, the panel's architecture and data flow, the skill sync model and a session-cost review; the mounting, install-check and sandbox notes were updated.
- Single sources and contracts instead of duplicated rules: route paths, control-character helpers and skill markers each live in one module, with tests holding SKILL.md, the tool description and the injection to their budgets.
- Approval gate, plan binding and the tool's argument validator were tightened as their shared helpers moved out of the plugin entry.

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
