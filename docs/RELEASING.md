# Releasing dsh-mint

Maintainer runbook. A release is a **tag push**: the `Publish npm` workflow does
the rest (npmjs, GitHub Packages, GitHub Release). The version bump, the
CHANGELOG entry and the tag itself come from the `my-git-tag` skill, which a
human runs by hand — nothing in the plugin or CI decides a version.

## Preconditions

- `main` is pushed and CI is green (`lint`, `check-types`, `test:coverage`,
  `build`, `pack:check`).
- No release-blocking issue is still open in the running milestone.
- The working tree is clean and `pnpm build` succeeds from the commit to tag.

## Version model

- `package.json` `version` is the source of truth. The tag must equal it
  (`0.2.0`, or `v0.2.0` — the workflow strips a leading `v`).
- A prerelease suffix (`-alpha.N`, `-beta.N`, `-rc.N`) makes the workflow run the
  gate and the tests **without publishing**; use it to rehearse.
- npmjs publishing is trusted publishing (OIDC): the `publish` job needs
  `id-token: write`, plus a one-time npmjs-side authorization of this repository
  and workflow file. GitHub Packages uses the repository `GITHUB_TOKEN` with
  `packages: write`, so no PAT is stored.
- The published tarball is built by the workflow itself (`pnpm build` in each
  publishing job); `dist/` is git-ignored and never committed.

## Steps

1. Run the local pre-check checklist below.
2. Run the `my-git-tag` skill with the target version. It determines the version,
   integrates the CHANGELOG entry for `<last tag>..HEAD`, creates the annotated
   tag, and commits the next development version (`chore: bump version to …`).
3. Push the commits and the tag:

   ```sh
   git push origin main
   git push origin <version>
   ```

4. Watch the `Publish npm` workflow: `gate` (tag == `package.json` version, and
   stable vs prerelease) → `test` → `publish` (npmjs with `--provenance`) →
   `publish-github` (GitHub Packages) → `release` (GitHub Release).
5. Verify the artifacts:

   ```sh
   npm view @yanqd0/dsh-mint@<version> version
   npm view @yanqd0/dsh-mint@<version> dist.tarball
   gh release view <version>
   ```

   The tarball must contain `dist/index.js`, `dist/client.js`, the whole
   `dist/skill/` tree, `cordis.patch.yml` and `scripts/install-skill-postinstall.mjs`.
6. Close the milestone in mint (`milestone set <id> --status done`) and move the
   remaining work to the next one.

## Local pre-check checklist

```sh
pnpm install --frozen-lockfile
pnpm lint && pnpm check-types && pnpm test:coverage
pnpm build && pnpm pack:check
git status --short                    # expect clean
git log --oneline origin/main..HEAD   # expect empty: nothing unpushed
node -p "require('./package.json').version"
```

If the plugin is installed in a profile, also confirm the mount composes:

```sh
dsh --profile web --dump-config | grep -A3 'id: mint'
```

That command **writes** `~/.dsh/profiles/web/cordis.yml`, so it needs write
access to the profile directory (it fails with `EACCES` under a workspace-write
sandbox).

## Failure modes

- **Tag ≠ `package.json` version** — the `gate` job fails before anything is
  published. Delete the tag, fix, re-tag.
- **Prerelease tag pushed by mistake** — nothing is published; the tag still
  runs the gate and the tests, which is a harmless rehearsal.
- **Publish failed while the tag exists** — re-run the workflow from Actions.
  npm refuses to republish an existing version, so a fixed build needs a new
  version number.
- **A bad release is already published** — `npm unpublish` is restricted (72 h,
  and often refused for a scoped package); publish a patch and
  `npm deprecate` the broken version instead.
- **GitHub Release notes are a placeholder** — the `release` job extracts the
  current version's section from `CHANGELOG.md` and falls back to
  "See git log / CHANGELOG" when it is missing. Add the entry before tagging.

## Where the pieces live

- `.github/workflows/ci.yml` — lint, types, tests with coverage, build and pack
  check on every push to `main` and every pull request.
- `.github/workflows/publish-npm.yml` — tag gate, npmjs (OIDC), GitHub Packages,
  GitHub Release.
- `CHANGELOG.md` — the release-notes source.
- `notes/isolated-install.md` — verifying the install path in an isolated
  `PNPM_HOME` / `DSH_HOME` without touching the real global environment.
