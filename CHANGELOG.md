# Changelog

All notable changes to this project are documented here. This project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.0] - 2026-07-22

### Added

- **`router.json` config file** (in addition to env vars). Global
  `~/.config/codebase-index/router.json` (respects `$XDG_CONFIG_HOME`) and
  project `<repo>/.codebase-index/router.json`. Keys: `mode`, `autoIndex`,
  `autoIndexAfterWrite`, `autoIndexViaTurn`, `indexBin`, `indexTimeoutMs`.
  Precedence: env var > project file > global file > default. Env booleans
  accept 1/true/yes/on and 0/false/no/off (so `=0` disables a file `true`).
  Files are re-read on `/reload` and each new session.
- `PI_CODEBASE_INDEX_TIMEOUT_MS` env override for the background-index timeout.
- GitHub Actions: `ci.yml` (typecheck) and `publish.yml` (release-triggered
  `npm publish --provenance`, with a manual dry-run and a tag/version check).
- Declared `opencode-codebase-index` as an optional peer (documents the link
  without auto-downloading its ~235 MB of native binaries).

### Documentation

- Ollama setup guide and an embedding-model recommendation table
  (qwen3-embedding 8b/4b/0.6b, mxbai-embed-large, bge-m3, nomic-embed-text),
  companion config locations/host, and why the companion is a separate install.

## [0.2.0] - 2026-07-22

### Changed

- Auto-indexing now runs **in the background** as a detached
  `opencode-codebase-index` MCP subprocess (driven over stdio with a single
  `index_codebase` call) instead of queuing a follow-up agent turn. No agent
  turn, no LLM cost, non-blocking. Uses host `pi` so it writes the same
  `.codebase-index/` directory Pi's tools read.
- Concurrent writes coalesce into one follow-up index; the subprocess is killed
  on session shutdown (indexing is incremental and resumes).

### Added

- `PI_CODEBASE_INDEX_BIN` to point at the CLI explicitly.
- `PI_CODEBASE_AUTO_INDEX_VIA_TURN=1` to opt back into the legacy
  follow-up-turn path. The extension also auto-falls-back to it if the CLI
  can't be located or spawned.

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
