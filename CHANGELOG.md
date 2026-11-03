# Changelog

All notable changes to this project are documented here. This project adheres
to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.4.0] - 2026-11-03

### Added

- Runtime `/cbrouter off|on|toggle|warn|enforce|status|reset` controls with durable
  same-session overrides, plus scoped local/global persistent mode commands.
- Typed settings controller under `src/` and a documented UI integration seam.
  Effective values/sources, clearing layer overrides, strict validation,
  unknown-key preservation, atomic file saves, and surfaced save failures.
- Settings screen: `/cbrouter-settings [global|local]`, bare `/cbrouter`, and
  `/cbrouter settings|config [global|local]`. Shows the scope and its file path,
  effective status, env/session overrides and per-file inheritance; mode,
  worktree, auto-index, index CLI and timeout edits apply immediately, with
  inherit/reset per file and session-override clearing. Native dialogs in RPC;
  actionable command usage in print/JSON. `@earendil-works/pi-tui` is an optional
  host-provided peer.
- `worktreeMode: off|inherit` / `PI_CODEBASE_WORKTREE_MODE`, default off for actual
  linked Git worktrees including nested cwd. Submodules are distinguished.
- Compact optional `/cbcontext` orientation and context/edit-context/architecture
  counters. Mocked ExtensionAPI, temp-config, real-worktree/submodule, and MCP
  subprocess regression tests; CI runs tests, typecheck, and pack dry-run.
- Pi 1.5 / 1.4 / 1.2 / 1.0 compatibility audit and current UI API handoff, with
  structured-prompt, nested-event/final-settle, MCP status, runtime minimum, and
  shipped version-matched package-changelog regressions.

### Fixed

- Current companion compatibility: readiness/status/migration handling, optional
  compact orientation, direct definition/graph tools, no mandatory peek chain,
  and custom-message starts without a prompt.
- Built-in read/edit/write always allowed; guards fail open for outside paths,
  parent traversal, sibling worktrees, symlink escapes/new-file parents, cwd
  changes, ambiguous shell scope, missing tools, and broken indexes.
- Successful scoped writes alone schedule after-write indexing, with inputs
  captured by toolCallId. Failed/blocked/outside writes never dirty the index.
- MCP newline transport, explicit incremental force:false and Pi host/project
  arguments, initialization/isError/busy/text/partial-index failures, child and
  timer cleanup, cancellation, and coalesced reruns. Off/shutdown invalidate
  pending work and stale callbacks; no surprise agent-turn or npx fallback.
- Source snippets and query-validation errors no longer determine index health or
  enter routing prompts. Operational errors use bounded diagnostics, and healthy
  text-only MCP status can recover readiness.
- Worktrees nested inside the indexed cwd bypass guards and mutation indexing;
  worktree detection also works without newer Git path-format flags.
- Atomic settings saves preserve dotfile-manager symlinks and target permissions.
- Consumed legacy index follow-ups no longer suppress future indexing requests.
  Text commands report status in print and JSON modes without model turns.
- Entire untrusted local config is ignored and local saves/CLI discovery require
  Pi project trust. Session/global controls remain available while untrusted/off.

### Changed

- Precedence is now session > env > local > global > defaults. Current Pi 1.5
  development types and Node >=22.19.0 (matching coding-agent and pi-tui);
  optional companion >=0.38.2 remains a separate install. CI includes the exact minimum
  Node release. Updated README/skill/prompts and corrected OIDC guidance.
- Routing guidance now mutates only systemPromptOptions.sections.codebase_router
  rather than replacing the complete system prompt; inactive/custom/non-code
  starts clear that owned section without disturbing other prompt contributions.
- Off only stops router-owned work, not the companion watcher. Explicit opt-in
  agent follow-ups already queued in Pi cannot be retracted; commands warn when
  this applies rather than aborting the user's run.

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
