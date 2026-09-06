# dsh-mint

[![npm](https://img.shields.io/npm/v/@yanqd0/dsh-mint.svg)](https://www.npmjs.com/package/@yanqd0/dsh-mint)
[![CI](https://github.com/yanqd0/dsh-mint/actions/workflows/ci.yml/badge.svg)](https://github.com/yanqd0/dsh-mint/actions)
[![codecov](https://codecov.io/gh/yanqd0/dsh-mint/graph/badge.svg)](https://codecov.io/gh/yanqd0/dsh-mint)

DSH plugin for the [mint](https://github.com/yanqd0/mint) issue tracker. Brings
mint into DSH sessions:

- session context injection (active issue overview + milestone check)
- event reminders (git commit → `state commit`, failure signals)
- plan-mode binding (no mint plan → no plan-mode exit)
- a `mint_query` tool for the agent
- (0.2.0) a session tab with an issue panel

## Install from source (DSH web profile)

For dogfooding / local development, install this checkout into the DSH `web`
profile:

```bash
pnpm build
dsh plugin --profile web add ./
```

`dsh plugin` runs pnpm inside `~/.dsh/profiles/web`. pnpm 11 blocks dependency
build scripts by default and exits with `ERR_PNPM_IGNORED_BUILDS`. Approve the
builds with pnpm itself, without editing any YAML, then re-run the install:

```bash
dsh plugin --profile web approve-builds --all
dsh plugin --profile web add ./
```

If you prefer a single command and accept allowing all builds during install:

```bash
dsh plugin --profile web add ./ --config.dangerouslyAllowAllBuilds=true
```

## Status

Early development — milestones 0.1.0 (host face) and 0.2.0 (tab UI). See
[CHANGELOG](CHANGELOG.md) once released.

## License

[MIT](LICENSE)
