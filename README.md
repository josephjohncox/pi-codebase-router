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

> This package **complements** `opencode-codebase-index`; it does not vendor it.
> Install that package too (it provides the `codebase_*` / `index_*` tools).
> Without it, the extension degrades gracefully and shows
> `index tools unavailable` in the status bar.

## Install

```bash
# from npm (after publish)
pi install npm:pi-codebase-router

# or straight from git
pi install git:github.com/josephjohncox/pi-codebase-router

# the companion that provides the actual index tools
pi install npm:opencode-codebase-index
```

Use `pi install ... -l` to write to project settings (`.pi/settings.json`)
instead of global (`~/.pi/agent/settings.json`).

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

| Env var | Values | Default | Meaning |
| --- | --- | --- | --- |
| `PI_CODEBASE_ROUTER_MODE` | `enforce` \| `warn` \| `off` | `enforce` | `enforce` blocks discouraged calls; `warn` allows them but shows a status hint and still injects guidance; `off` disables everything (no prompt, no guard, no auto-index). |
| `PI_CODEBASE_AUTO_INDEX` | `1` | unset | Background index on session start. |
| `PI_CODEBASE_AUTO_INDEX_AFTER_WRITE` | `1` | unset | Background index after settled write/edit turns. |
| `PI_CODEBASE_INDEX_BIN` | path | auto | Explicit path to `opencode-codebase-index`'s `dist/cli.js`. |
| `PI_CODEBASE_AUTO_INDEX_VIA_TURN` | `1` | unset | Use a follow-up agent turn instead of a background subprocess. |

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
- Peer: `@earendil-works/pi-coding-agent` (provided by the Pi runtime;
  optional/informational here).

## Migrating from a local copy

If you previously hand-placed `codebase-routing.ts` in
`~/.pi/agent/extensions/` (plus the skill/prompts), remove those local copies
after installing this package so the extension doesn't load twice:

```bash
rm -f ~/.pi/agent/extensions/codebase-routing.ts
rm -rf ~/.pi/agent/skills/indexed-codebase-workflow
rm -f ~/.pi/agent/prompts/cb*.md
```

## License

MIT © Joseph Cox
