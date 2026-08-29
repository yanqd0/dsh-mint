# Mounting dsh-mint in DSH

dsh-mint is a DSH host plugin (`@deepseek-ai/dsh`, cordis plugin system) plus a
bundled `mint` skill. `dsh-mint` resolves the `mint` CLI from its own
`mint-faa` dependency — no global install needed.

## Prerequisites

- DSH CLI (`@deepseek-ai/dsh`)
- The plugin must be installed into the profile's node_modules (bare package
  names resolve from the harness's own node_modules, two-anchor).

## 1. Install the plugin

```
npm install -g dsh-mint            # published package (bare name)
```

Or skip publishing and mount a local build directly (dogfooding) — see below.

## 2. Add the mount line

Edit `~/.dsh/profiles/<profile>/cordis.patch.yml`. A **new** plugin is an
`insert` list — a bare `- id/name` row is a config *override* and fails with
`patch: entry "mint" not found`:

```yaml
- insert:
    - id: mint
      name: dsh-mint
      config:
        debug: false
```

For a local build, point `name` at the built entry **file** (ESM does not
import directories; `dist/index.js` must be explicit):

```yaml
- insert:
    - id: mint
      name: /path/to/dsh-mint/dist/index.js
      config:
        debug: false
```

Relative (`./dist/index.js`) paths resolve from the profile directory. Validate
before restarting with `dsh --profile <profile> --dump-config` — the `mint` row
must appear and no `patch:` warnings may be emitted.

## 3. Install the skill

After a build (`pnpm build` produces `dist/skill`), either:

```sh
scripts/install-dsh.sh          # symlink -> ~/.dsh/skills/mint (recommended)
scripts/install-dsh.sh --copy   # copy instead
scripts/install-dsh.sh --uninstall
```

`DSH_HOME` is respected. The skill is discovered by `dsh-skill-filesystem`
under the `user-dsh` source.

## 4. Verify

- `dsh --profile <profile> --dump-config` shows the `mint` row with no
  `patch:` warnings (pre-boot check).
- The mount line loads without errors (`dsh` session starts).
- `~/.dsh/skills/mint/SKILL.md` is present.
- For runtime host-face signatures, prefer `cordis_inspect_list` /
  `cordis_inspect_query` over hardcoded examples.

## 5. Workspace-write sessions and the `mint` CLI

dsh-mint's own features (context injection, `mint_query`, plan binding) spawn
the mint CLI as a host-trusted child process, so they work in every session
mode. The agent's *manual* `mint ...` shell commands, however, run under DSH's
file sandbox, which allows writes only to the session workspace, `/tmp`, and
`os.tmpdir()` in `workspace-write` mode (hardcoded — see
`dsh-sandbox` `writableRoots`). mint's database lives outside the workspace
(`$XDG_DATA_HOME/mint/…`), so those manual commands are denied unless one of:

| Option | Setup | Effect |
| --- | --- | --- |
| **Project-local db (recommended)** | `MINT_DB_PATH=$PWD/.mint/mint.db mint ...` (or export `XDG_DATA_HOME` per project; gitignore the file/dir) | `mint *` works in `workspace-write`; sandbox boundary unchanged |
| Session-wide `danger-full-access` | `/permission danger-full-access` or `DSH_PERMISSION_MODE` | Everything allowed — widest boundary, use sparingly |
| Extra writable roots | Not expressible today: the writable-root set is hardcoded and a session's cwd always overrides the configured fallback root (`dsh-sandbox-policy` `resolve()`). Allowing two roots (workspace + mint data dir) requires an upstream `deepseek-harness` change. | — |

## Publishing

npm publishes to both npmjs (`dsh-mint`) and GitHub Packages
(`@yanqd0/dsh-mint`) — see `docs/RELEASING.md` (#8).
