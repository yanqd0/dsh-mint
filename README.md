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

## Status

Early development — milestones 0.1.0 (host face) and 0.2.0 (tab UI). Install
and usage docs land with the first release; see [CHANGELOG](CHANGELOG.md) once
released.

## License

[MIT](LICENSE)
