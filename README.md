# pi-codebase-router

Index-first routing for [Pi](https://pi.dev). It makes the agent reach for the
[`opencode-codebase-index`](https://www.npmjs.com/package/opencode-codebase-index)
semantic tools (`codebase_context`, `implementation_lookup`, `call_graph`,
`codebase_search`) for scoped discovery, without a mandatory retrieval chain.
It keeps context focused and file access/mutation on the built-in `read` /
`edit` / `write` tools, which are **always allowed**. Missing/incompatible indexes
and out-of-context work degrade to direct tools instead of trapping the agent.

It bundles three things:

- **An extension** that injects index-first guidance, guards discouraged
  discovery, and can auto-index on session start / after writes.
- **A skill** (`indexed-codebase-workflow`) documenting the discovery loop.
- **`cb*` prompt templates** — thin, safe wrappers over the index tools.

> **Requires the companion package** `opencode-codebase-index`, which provides
> the `codebase_*` / `index_*` tools this package routes toward. It is a
> **separate install** (see below for why). Without it, this extension degrades
> gracefully and shows `index tools unavailable` in the status bar.

## Install

```bash
# 1. the companion that provides the actual index tools (~235 MB native)
pi install npm:opencode-codebase-index

# 2. this router (extension + skill + cb* prompts)
pi install npm:pi-codebase-router
#   …or straight from git:
pi install git:github.com/josephjohncox/pi-codebase-router
```

Use `pi install ... -l` to write to project settings (`.pi/settings.json`)
instead of global (`~/.pi/agent/settings.json`).

### Why two installs (and not one)?

This package intentionally does **not** bundle or auto-install
`opencode-codebase-index`:

- It ships **~235 MB of per-platform native binaries** (tree-sitter + usearch,
  5 platforms). Vendoring that into a ~12 KB routing package via
  `bundledDependencies` — the only way Pi reliably loads a sibling pi-package,
  since it hoists normal deps into one flat `node_modules` — would be absurd.
- Pi has no supported "install this other package into settings" hook, and a
  `postinstall` shelling out to `pi install` is fragile and invasive.

So they stay decoupled: install the companion once, globally, and every project
reuses it. This package is declared an **optional peer** of it (documents the
relationship without triggering a 235 MB auto-download).

## Configuring the companion (`opencode-codebase-index`)

The router points at whatever `opencode-codebase-index` is configured to do; it
does not have its own indexing config. Under Pi, that package runs in **host
`pi`**, which uses the neutral `.codebase-index/` layout:

| Scope | Config | Index storage |
| --- | --- | --- |
| Global | `~/.config/codebase-index/config.json` | `~/.codebase-index/global-index` |
| Project | `<repo>/.codebase-index/config.json` | `<repo>/.codebase-index/index` |

Project config overrides global. The router's background indexer launches the
companion with `--host pi`, so it writes the **same** directory the in-process
`codebase_search` reads — no split-brain index.

### Example config (local Ollama embeddings)

The reference setup uses a local Ollama server via its OpenAI-compatible API
(`/v1`), so nothing leaves the machine and there are no embedding-API costs:

```json
// ~/.config/codebase-index/config.json
{
  "embeddingProvider": "custom",
  "customProvider": {
    "baseUrl": "http://127.0.0.1:11434/v1",
    "model": "qwen3-embedding:8b",
    "dimensions": 4096,
    "apiKey": "ollama"
  }
}
```

### Ollama setup (recommended: local + free + private)

```bash
# 1. install Ollama — https://ollama.com  (macOS: brew install ollama)
# 2. start the server (the desktop app does this too)
ollama serve
# 3. pull an embedding model (see the table below)
ollama pull qwen3-embedding:8b
```

Then point the companion at it. Two ways:

- **Custom `/v1` (recommended for any model / larger models)** — the example
  above. `baseUrl` must end in `/v1` (the companion appends `/embeddings`);
  `apiKey` can be any placeholder (`"ollama"`).
- **Built-in Ollama provider (simplest)** — `{ "embeddingProvider": "ollama" }`.
  Uses Ollama's native API with `nomic-embed-text`, but budgets input to ~2048
  tokens, so prefer the custom `/v1` route for larger-context models.

Remote Ollama? Set `OLLAMA_HOST=http://host:11434` (built-in provider) or the
full `baseUrl` (custom provider).

### Which embedding model?

All run locally via Ollama. Pick by the RAM/VRAM you can spare; bigger =
better retrieval but slower indexing.

| `ollama pull …` | `dimensions` | Footprint | Use when |
| --- | --- | --- | --- |
| `qwen3-embedding:8b` | `4096` | ~8B (needs real RAM/VRAM) | **Best quality.** Workstations/servers. (the reference config) |
| `qwen3-embedding:4b` | `2560` | ~4B | Strong quality, lighter than 8B |
| `qwen3-embedding:0.6b` | `1024` | ~0.6B | Best quality-for-size on laptops |
| `mxbai-embed-large` | `1024` | ~335M | Strong English retrieval, low resource |
| `bge-m3` | `1024` | ~567M | Multilingual / longer context |
| `nomic-embed-text` | `768` | ~137M | Fast, tiny default; fine for most repos |

**Rules of thumb**

- Laptop / low memory → `nomic-embed-text` (or `qwen3-embedding:0.6b` for better
  recall).
- Plenty of memory and you want the best hits → `qwen3-embedding:8b`.
- Set `dimensions` to the value in the table (the model's native output width).
  Ollama does not reliably honor a requested smaller dimension, so don't guess —
  if unsure, check the model card on ollama.com. A wrong `dimensions` yields a
  dimension-mismatch error and a forced rebuild.
- Changing model **or** `dimensions` invalidates the index: run `/cbindex force`
  once after the change.

### Provider options (if not using Ollama)

`embeddingProvider` accepts `auto` (default; detects Copilot → OpenAI → Google →
Ollama), `ollama`, `openai`, `google`, `github-copilot`, or `custom` (any
OpenAI-compatible `/v1/embeddings` endpoint). Hosted providers read their key
from the usual env vars (e.g. `OPENAI_API_KEY`, `GOOGLE_API_KEY`); GitHub
Copilot reuses existing OpenCode auth. See the
[companion README](https://www.npmjs.com/package/opencode-codebase-index) for
the full schema (chunking, hybrid weights, reranker, knowledge bases, etc.).

### Verifying / building the index

```text
/cbstatus            # provider, model, chunk count, readiness
/cbindex             # incremental build/update
/cbindex force       # full rebuild (after changing provider/model/dimensions)
```

## What it does

### 1. Index-first guidance (`before_agent_start`)

On code/repository-flavored user prompts it updates only the structured
`systemPromptOptions.sections.codebase_router` section, allowing Pi to preserve
its prompt prefix instead of forcing a complete system-prompt replacement. It
clears that section for off/custom-message/non-code starts. Guidance:
check `index_status` when readiness is unknown; optionally use compact
`codebase_context` (`tokenBudget: 600`, `limit: 5`) for unfamiliar orientation;
use `implementation_lookup` directly for definitions and `call_graph`/path for
flow. `codebase_edit_context` is optional bounded pre-edit evidence. Peek/search
remain optional tools, not mandatory prerequisites. Custom-message starts with
no prompt are supported. Observed missing/incompatible/migration states and
index-specific retrieval failures release guards and allow known-file/direct-tool
fallback. Query-validation errors do not change index readiness, and successful
source snippets are never interpreted as health diagnostics.
Storage migrations use incremental indexing, not an automatic forced rebuild.

### 2. Discovery guard (`tool_call`)

| Attempt | Verdict |
| --- | --- |
| Scoped `grep` / simple shell `rg` for a **concept** (`"where is auth handled?"`) | enforce: blocked; warn: hint only |
| `grep` for an exact identifier/literal (`validateToken`, `-F` fixed strings) | allowed |
| Shell **source read** (`cat`/`head`/`tail`/`sed`/`less`/`more` a file) | blocked → use `read` |
| Shell **source write** (`>`/`>>` to a file, `tee <file>`, `sed -i`, `perl -i`) | blocked → use `edit`/`write` |
| Toolchain commands (`git`, `npm`, `pytest`, …) and `2>/dev/null` / `2>&1` | allowed |

The guard is deliberately conservative: exact identifiers/literals, fd redirects
(`2>/dev/null`, `2>&1`), and normal toolchain commands pass through. **Built-in
read/edit/write always pass**, even before any index query. Explicit outside
paths, `../`, sibling or nested linked worktrees, symlink escapes (including new files under
symlinked parents), cwd-changing shell commands, and shell targets whose scope
cannot be proven all bypass guards. The indexed scope is exactly Pi's cwd, never
an automatically widened repository root. Main-checkout evidence is not a
prerequisite for sibling-worktree work. This is a workflow router, **not a
security boundary**.

### 3. Optional background auto-indexing

Off by default. When enabled, indexing runs **in the background** — a
router-owned `opencode-codebase-index` MCP subprocess does the work. There is **no agent
turn and no LLM cost**, and Pi is never blocked: you keep typing while the index
refreshes into the same `.codebase-index/` directory Pi's `codebase_search`
reads (host `pi`).

| Env var | Effect |
| --- | --- |
| `PI_CODEBASE_AUTO_INDEX=1` | Background index on session start / resume / new / fork when the cwd looks like a project. |
| `PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=1` | After successful in-scope built-in `write`/`edit` calls settle, background index once. Failed/blocked/outside writes do not dirty the index. |
| `PI_CODEBASE_INDEX_BIN=/abs/path/dist/cli.js` | Point at the companion CLI explicitly; otherwise locate it under Pi's agent npm directory or the trusted project's Pi npm directory. Never runs `npx` or installs anything. |
| `PI_CODEBASE_AUTO_INDEX_VIA_TURN=1` | Explicitly request incremental `index_codebase` on a follow-up **agent turn** instead of a background subprocess. |

Always **incremental** (`force: false`) with `--project <cwd> --host pi`, using
newline-delimited MCP JSON-RPC. Only project directories (Git, including nested
cwd, or recognized project markers) are indexed. At most one run is active;
writes during a successful run coalesce into one follow-up. Busy, transport,
initialization, timeout, `isError`, partial embedding, and text-level failures
are not reported as current and do not trigger retry churn. A missing/broken CLI
shows a hint, **never an automatic agent-turn fallback**.

`/cbrouter off` clears pending work, invalidates callbacks/reruns, and terminates
router-owned indexing immediately (SIGTERM, then SIGKILL if needed). Shutdown
does the same. This does **not** stop the companion extension's independent
watcher/auto-indexer; configure that in the companion. Explicitly opting into
`autoIndexViaTurn` can queue a real agent follow-up; Pi cannot retract an already
queued message, so it may still run after off. The off command warns when this
actually applies and schedules no new follow-ups.

## Configuration

Settings resolve with precedence **session override > env var > local
`router.json` > global `router.json` > built-in default**. Nothing is required:
`enforce` mode, no auto-indexing, and **linked worktrees bypassed by default**.

### Runtime command (no LLM turn)

```text
/cbrouter off|on|toggle|warn|enforce|status|reset
/cbrouter local off|on|toggle|warn|enforce|status|reset
/cbrouter global off|on|toggle|warn|enforce|status|reset
```

Unscoped mode commands change the session override; `on` means `enforce`.
`toggle` switches configured off/enforce. `reset` clears all session overrides.
Overrides are appended to Pi session entries and restored on reload/resume of
the same session ID (not inherited by a fork). Commands remain available while
off. Scoped mode commands persist to the selected file; scoped `reset` removes
only that file's `mode`. Higher layers still win; status reports each effective
value and its source.

### Settings screen

```text
/cbrouter                      # opens settings (also /cbrouter settings | config)
/cbrouter-settings [global|local]
/cbrouter settings [global|local]
```

The screen shows the selected scope and its actual file path, the effective
mode/index status, environment and session overrides, and each setting's value
in that file or where it is inherited from (`from global: warn`,
`from default: off`). Values shadowed by a higher layer show that layer's value
(`session: off`, `environment: …`, `local: …`).

- **Tab** (or Enter on *Scope*) switches between the global and local file.
  Without an argument, an existing trusted local file opens first; otherwise global.
- **Enter** on a setting opens its choices or editor. Every choice is saved
  immediately; **Inherit** removes the key from that file so the lower layer
  applies (local inherit never copies or masks the global value).
- *Index CLI* and *Index timeout* are text fields; an empty value inherits.
  Invalid values and save failures (malformed file, untrusted project, write
  error) stay on screen with the draft kept.
- *Reset file* removes every router key from the selected file after a
  confirmation choice (default Cancel). *Session overrides* clears all or one
  `/cbrouter off|warn|enforce` override. Environment overrides can only be
  removed by unsetting the shown variable.
- **Esc** backs out of a choice/editor without saving and closes the screen.
  Navigation, paging and confirm/cancel follow your Pi keybindings.

In RPC mode the same settings are offered through native select/input/confirm
dialogs. Print and JSON modes report the textual `/cbrouter` commands and both
file paths instead. Untrusted projects show the local file as read-only.
Integrators can reuse the [typed controller seam](docs/settings-controller.md).

### Config file — `router.json`

| Scope | Path |
| --- | --- |
| Global | `~/.config/codebase-index/router.json` (respects `$XDG_CONFIG_HOME`) |
| Local | `<cwd>/.codebase-index/router.json` (overrides global when trusted) |

It sits next to the companion's `config.json`. Files are re-read when settings
are resolved; commands/saves apply immediately, no reload needed. The entire
local layer is ignored unless `ctx.isProjectTrusted()` is true (Pi 1.5); local
saves are rejected without creating files when untrusted. Session/global controls
remain usable. Saves validate known keys, preserve unknown keys, atomically
rename a same-directory temporary file at the resolved target, preserve existing
symlinks and target permissions, and surface errors. Malformed JSON,
arrays, and other non-object documents are never silently overwritten.

Example (all keys optional):

```json
{
  "mode": "enforce",
  "worktreeMode": "off",
  "autoIndex": false,
  "autoIndexAfterWrite": true,
  "autoIndexViaTurn": false,
  "indexTimeoutMs": 900000
}
```

### Keys and env overrides

| `router.json` key | Env override | Values | Default | Meaning |
| --- | --- | --- | --- | --- |
| `mode` | `PI_CODEBASE_ROUTER_MODE` | `enforce` \| `warn` \| `off` | `enforce` | Guard/guidance mode; off also cancels router-owned indexing. Commands remain accessible. |
| `worktreeMode` | `PI_CODEBASE_WORKTREE_MODE` | `off` \| `inherit` | `off` | Actual Git linked worktrees (including nested cwd) bypass guidance, guards, and auto-indexing unless opted in. Submodules are not confused with linked worktrees. |
| `autoIndex` | `PI_CODEBASE_AUTO_INDEX` | bool | `false` | Background index on session start / resume / new / fork. |
| `autoIndexAfterWrite` | `PI_CODEBASE_AUTO_INDEX_AFTER_WRITE` | bool | `false` | Background index after successful scoped built-in `write`/`edit` calls settle. |
| `autoIndexViaTurn` | `PI_CODEBASE_AUTO_INDEX_VIA_TURN` | bool | `false` | Use a follow-up **agent turn** instead of a background subprocess. |
| `indexBin` | `PI_CODEBASE_INDEX_BIN` | path | auto | Explicit path to `opencode-codebase-index`'s `dist/cli.js`. |
| `indexTimeoutMs` | `PI_CODEBASE_INDEX_TIMEOUT_MS` | int (ms), 1–2147483647 | `900000` | Background-index kill timeout. |

Env booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. An env
value wins over files, but a session override wins over env. Set
`PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=0` to switch off a file `true`. Clear a
session override to reveal env/files; editing a file cannot override env.

## Commands (prompt templates)

| Command | Tool | Purpose |
| --- | --- | --- |
| `/cbindex [estimate\|force\|verbose]` | `index_codebase` | Build/update the index (incremental by default). |
| `/cbstatus` | `index_status` | Show index status and provider/model. |
| `/cbreindex` | `index_codebase force` | Full rebuild. |
| `/cbpeek <query>` | `codebase_peek` | Metadata-only locations (cheapest). |
| `/cbsearch <query>` | `codebase_search` | Semantic search with content. |
| `/cbfind <query>` | context/lookup/search as needed | Scoped discovery, no mandatory chain. |
| `/cbcontext <query>` | `codebase_context` | Compact unfamiliar-subsystem orientation (600 tokens / 5 results). |
| `/cbdef <symbol>` | `implementation_lookup` | Authoritative definition site. |
| `/cbcallgraph <name> [callers\|callees]` | `call_graph` | Callers/callees. |
| `/cbpath <from> <to>` | `call_graph_path` | Shortest call path. |
| `/cbimpact [branch\|PR#]` | `pr_impact` | Change blast radius. |
| `/cbhealth` | `index_health_check` | GC and health report. |

## Skill

`indexed-codebase-workflow` documents readiness, optional compact orientation,
direct definition/graph lookup, bounded source reads, precise edits, and tests.
Load it with `/skill:indexed-codebase-workflow`.

## Compatibility

- Pi loads the extension as TypeScript via jiti — no build step required.
- Targets Pi coding-agent / pi-tui 1.5.0, Node ≥ 22.19.0 (matching both hosts).
  See the [recent Pi changelog compatibility audit](docs/pi-compatibility.md) for
  structured prompts, nested tool events, lifecycle, trust, UI, and release notes.
- Requires `opencode-codebase-index` >=0.38.2, the tested companion API baseline.
  Missing callable tools degrade to fallback rather than blocking normal work.
- Optional peers: `@earendil-works/pi-coding-agent` and `@earendil-works/pi-tui`
  (provided by Pi), plus `opencode-codebase-index` (install separately; it is
  not auto-downloaded).

## Migrating from a local copy

If you previously hand-placed `codebase-routing.ts` in
`~/.pi/agent/extensions/` (plus the skill/prompts), remove those local copies
after installing this package so the extension doesn't load twice:

```bash
rm -f ~/.pi/agent/extensions/codebase-routing.ts
rm -rf ~/.pi/agent/skills/indexed-codebase-workflow
rm -f ~/.pi/agent/prompts/cb*.md
```

## Continuous integration & publishing

- **CI** (`.github/workflows/ci.yml`): typecheck, tests, and pack dry-run on push/PR.
- Local validation: `npm ci --ignore-scripts && npm run typecheck && npm test && npm pack --dry-run`.
  Tests use mocked ExtensionAPI events/commands, isolated temp config, real Git
  worktrees/submodules, and a fixture MCP child; no embedding server or companion
  install is needed. Optional companion peer is not installed automatically.
- **Publish** (`.github/workflows/publish.yml`): on a published GitHub Release
  it runs `npm publish --provenance --access public`. Manual runs
  (`workflow_dispatch`) support a `--dry-run`.

One-time setup: configure npm **Trusted Publishing (OIDC)** for this repository
and `publish.yml`; no `NPM_TOKEN` secret is used. Release flow:

```bash
npm version patch   # or minor / major — bumps package.json + tags
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
```

The workflow verifies the release tag matches `package.json`. First release can
also be published locally with `npm publish --access public`.

## License

MIT © Joseph Cox
