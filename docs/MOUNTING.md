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
npm install -g dsh-mint            # or pnpm add dsh-mint in the profile
```

## 2. Add the mount line

Edit `~/.dsh/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: mint
  name: dsh-mint
  config:
    debug: false
```

Relative (`./`) and absolute paths are also accepted instead of a bare name;
relative resolves from the profile directory.

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

- The mount line loads without errors (`dsh` session starts).
- `~/.dsh/skills/mint/SKILL.md` is present.
- For runtime host-face signatures, prefer `cordis_inspect_list` /
  `cordis_inspect_query` over hardcoded examples.

## Publishing

npm publishes to both npmjs (`dsh-mint`) and GitHub Packages
(`@yanqd0/dsh-mint`) — see `docs/RELEASING.md` (#8).
