# Changelog

All notable changes to this project are documented here. This project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.0] - 2026-07-22

### Added

- `codebase-router` extension: index-first routing for Pi.
  - Injects index-first guidance on code/repository turns
    (`before_agent_start`).
  - Guards discouraged discovery (`tool_call`): conceptual `grep`/`rg`, shell
    source reads (`cat`/`head`/`tail`/`sed`/`less`/`more`), and shell source
    writes (redirection, `tee`, `sed -i`, `perl -i`). Exact identifiers,
    literals, and toolchain commands (git/npm/etc.) pass through.
  - `PI_CODEBASE_ROUTER_MODE` = `enforce` (default) | `warn` | `off`.
  - Optional auto-indexing: `PI_CODEBASE_AUTO_INDEX=1` (session start) and
    `PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=1` (after a settled write/edit turn).
    Never forces a rebuild; only queues incremental `/cbindex`.
  - Status-bar telemetry for blocks and indexed searches.
- `indexed-codebase-workflow` skill documenting the discovery → read →
  edit/write loop.
- `cb*` prompt templates: `/cbindex`, `/cbstatus`, `/cbreindex`, `/cbpeek`,
  `/cbsearch`, `/cbfind`, `/cbdef`, `/cbcallgraph`, `/cbpath`, `/cbimpact`,
  `/cbhealth`.

### Notes

- Complements (does not replace) [`opencode-codebase-index`](https://www.npmjs.com/package/opencode-codebase-index),
  which provides the `codebase_*` / `index_*` tools this package routes toward.
