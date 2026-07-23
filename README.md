# pi-codebase-router

Index-first routing for [Pi](https://pi.dev). It makes the agent reach for the
[`opencode-codebase-index`](https://www.npmjs.com/package/opencode-codebase-index)
semantic tools (`codebase_peek`, `codebase_search`, `implementation_lookup`,
`call_graph`) **before** falling back to exploratory `grep` and shell — which
saves tokens and keeps context focused — and keeps file access/mutation on the
built-in `read` / `edit` / `write` tools.

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

On code/repository-flavored prompts it appends a short routing block to the
system prompt: peek → look up the definition → `read` exact lines; reserve grep
for exact identifiers; keep edits on `read`/`edit`/`write`; use `/cbindex` when
the index is missing or stale.

### 2. Discovery guard (`tool_call`)

| Attempt | Verdict |
| --- | --- |
| `grep` / shell `rg` for a **concept** (`"where is auth handled?"`) | blocked → use `codebase_peek` |
| `grep` for an exact identifier/literal (`validateToken`, `-F` fixed strings) | allowed |
| Shell **source read** (`cat`/`head`/`tail`/`sed`/`less`/`more` a file) | blocked → use `read` |
| Shell **source write** (`>`/`>>` to a file, `tee <file>`, `sed -i`, `perl -i`) | blocked → use `edit`/`write` |
| Toolchain commands (`git`, `npm`, `pytest`, …) and `2>/dev/null` / `2>&1` | allowed |

The guard is deliberately conservative: single-token identifier-shaped patterns,
fd redirects (`2>/dev/null`, `2>&1`), and normal toolchain commands are never
blocked.

### 3. Optional background auto-indexing

Off by default. When enabled, indexing runs **in the background** — a detached
`opencode-codebase-index` MCP subprocess does the work. There is **no agent
turn and no LLM cost**, and Pi is never blocked: you keep typing while the index
refreshes into the same `.codebase-index/` directory Pi's `codebase_search`
reads (host `pi`).

| Env var | Effect |
| --- | --- |
| `PI_CODEBASE_AUTO_INDEX=1` | Background index on session start / resume / new / fork when the cwd looks like a project. |
| `PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=1` | After a settled turn that used `write`/`edit`, background index once. |
| `PI_CODEBASE_INDEX_BIN=/abs/path/dist/cli.js` | Point at the `opencode-codebase-index` CLI explicitly (otherwise auto-located under `~/.pi/agent/npm`, the project's `.pi/npm`, or `npx`). |
| `PI_CODEBASE_AUTO_INDEX_VIA_TURN=1` | Revert to the legacy behavior: queue `/cbindex` as a follow-up **agent turn** instead of a background subprocess. |

Always an **incremental** index (never `force`), only in project directories
(detected via `.git`, `package.json`, `pyproject.toml`, `Cargo.toml`, `go.mod`,
`pom.xml`, `build.gradle`). At most one index runs at a time; writes that land
during a run coalesce into a single follow-up index. The subprocess is killed on
session shutdown (indexing is incremental and resumes next time). If the CLI
can't be located or spawned, it automatically falls back to the follow-up-turn
path.

## Configuration

Settings resolve with precedence **env var > project `router.json` > global
`router.json` > built-in default**. Nothing is required; the defaults are safe
(`enforce` mode, no auto-indexing).

### Config file — `router.json`

| Scope | Path |
| --- | --- |
| Global | `~/.config/codebase-index/router.json` (respects `$XDG_CONFIG_HOME`) |
| Project | `<repo>/.codebase-index/router.json` (overrides global) |

It sits next to the companion's `config.json`, so one dotfiles sync covers both.
Re-read on `/reload` and on each new session. Example (all keys optional):

```json
{
  "mode": "enforce",
  "autoIndex": false,
  "autoIndexAfterWrite": true,
  "autoIndexViaTurn": false,
  "indexTimeoutMs": 900000
}
```

### Keys and env overrides

| `router.json` key | Env override | Values | Default | Meaning |
| --- | --- | --- | --- | --- |
| `mode` | `PI_CODEBASE_ROUTER_MODE` | `enforce` \| `warn` \| `off` | `enforce` | `enforce` blocks discouraged calls; `warn` allows but shows a hint and still injects guidance; `off` disables everything. |
| `autoIndex` | `PI_CODEBASE_AUTO_INDEX` | bool | `false` | Background index on session start / resume / new / fork. |
| `autoIndexAfterWrite` | `PI_CODEBASE_AUTO_INDEX_AFTER_WRITE` | bool | `false` | Background index after a settled turn that used `write`/`edit`. |
| `autoIndexViaTurn` | `PI_CODEBASE_AUTO_INDEX_VIA_TURN` | bool | `false` | Use a follow-up **agent turn** instead of a background subprocess. |
| `indexBin` | `PI_CODEBASE_INDEX_BIN` | path | auto | Explicit path to `opencode-codebase-index`'s `dist/cli.js`. |
| `indexTimeoutMs` | `PI_CODEBASE_INDEX_TIMEOUT_MS` | int (ms) | `900000` | Background-index kill timeout. |

Env booleans accept `1`/`true`/`yes`/`on` and `0`/`false`/`no`/`off`. An env
value always wins over the files — set `PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=0` to
switch off a file `true` for one session.

## Commands (prompt templates)

| Command | Tool | Purpose |
| --- | --- | --- |
| `/cbindex [estimate\|force\|verbose]` | `index_codebase` | Build/update the index (incremental by default). |
| `/cbstatus` | `index_status` | Show index status and provider/model. |
| `/cbreindex` | `index_codebase force` | Full rebuild. |
| `/cbpeek <query>` | `codebase_peek` | Metadata-only locations (cheapest). |
| `/cbsearch <query>` | `codebase_search` | Semantic search with content. |
| `/cbfind <query>` | peek → lookup/search → grep | Token-efficient hybrid discovery. |
| `/cbdef <symbol>` | `implementation_lookup` | Authoritative definition site. |
| `/cbcallgraph <name> [callers\|callees]` | `call_graph` | Callers/callees. |
| `/cbpath <from> <to>` | `call_graph_path` | Shortest call path. |
| `/cbimpact [branch\|PR#]` | `pr_impact` | Change blast radius. |
| `/cbhealth` | `index_health_check` | GC and health report. |

## Skill

`indexed-codebase-workflow` documents the loop:
`codebase_peek` → `implementation_lookup`/`codebase_search` → `read` exact lines
→ `edit`/`write` → tests/diagnostics → inspect the diff. Load it with
`/skill:indexed-codebase-workflow`.

## Compatibility

- Pi loads the extension as TypeScript via jiti — no build step required.
- Requires Node ≥ 18.
- Peers (both optional/informational): `@earendil-works/pi-coding-agent`
  (provided by the Pi runtime) and `opencode-codebase-index` (install
  separately — see above; declared optional so it is not auto-downloaded).

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

- **CI** (`.github/workflows/ci.yml`): typechecks on every push/PR.
- **Publish** (`.github/workflows/publish.yml`): on a published GitHub Release
  it runs `npm publish --provenance --access public`. Manual runs
  (`workflow_dispatch`) support a `--dry-run`.

One-time setup: add an npm **Automation** token as the `NPM_TOKEN` repository
secret (`gh secret set NPM_TOKEN`). Release flow:

```bash
npm version patch   # or minor / major — bumps package.json + tags
git push --follow-tags
gh release create "v$(node -p 'require("./package.json").version')" --generate-notes
```

The workflow verifies the release tag matches `package.json`. First release can
also be published locally with `npm publish --access public`.

## License

MIT © Joseph Cox
