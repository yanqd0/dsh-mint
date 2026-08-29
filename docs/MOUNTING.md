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

## Publishing

npm publishes to both npmjs (`dsh-mint`) and GitHub Packages
(`@yanqd0/dsh-mint`) — see `docs/RELEASING.md` (#8).
