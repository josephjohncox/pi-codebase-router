---
name: indexed-codebase-workflow
description: Scoped, token-efficient repository exploration and editing with opencode-codebase-index. Use for unfamiliar code, definitions, dependency flow, impact, and source changes without a mandatory retrieval chain.
---

# Indexed codebase workflow

Use the index as a navigation layer **for its actual cwd**, not as a prerequisite
for every read/edit. Built-in `read`, `edit`, and `write` are always allowed.
This is workflow guidance, not a security boundary.

## Readiness and scope

- Check `index_status` when readiness is unknown. Missing tools, an unindexed or
  incompatible index, pending storage migration, or failed retrieval must not
  trap the task: use known files, direct tools, and focused fallback discovery.
- `/cbindex` / `index_codebase({ force: false })` performs an incremental update,
  including storage migrations. Reserve force for an explicitly requested full
  rebuild or provider/model incompatibility; never force automatically.
- Do not use main-checkout evidence for a sibling worktree. Outside paths,
  `../`, symlink escapes, and cwd-changing commands are outside this router's
  proof. Do not widen a scoped miss beyond the indexed cwd/directory.
- Linked Git worktrees (including nested cwd) bypass router guidance, guards,
  and auto-indexing by default. Set router `worktreeMode: "inherit"` only when
  intentionally using that worktree's own index. Submodules are not linked
  worktrees.

## Choose the tool for the question

- **Unfamiliar orientation** (layout, key symbols, cross-file intent): optionally
  use `codebase_context` with `tokenBudget: 600`, `limit: 5` for a compact first
  pass. Inspect evidence before broad reads; do not run it mechanically.
- **Known definition**: use `implementation_lookup` directly, without context or
  peek prerequisites. Read exact returned lines only if needed.
- **Callers/callees**: `call_graph`; **dependency path**: `call_graph_path` once
  endpoints are identified. **Blast radius**: `pr_impact`.
- **Pre-edit evidence around a known/suspected target**: optionally
  `codebase_edit_context` for bounded source and direct graph neighbors.
- **Repository-scale map**: `architecture_context` when that scale is needed.
- **Metadata-only locations**: optional `codebase_peek`. **Semantic source
  matches**: `codebase_search`, scoped with small limits and appropriate
  fileType/directory/chunkType/contextLines filters. Neither requires context
  first; do not repeat broad reads when compact evidence answers the question.

## Files, lexical search, and edits

Reserve `grep` for exact known identifiers/literals or exhaustive occurrence
checks when the index is usable. Use `find`/`ls` for filesystem inventory. When
indexed discovery is unavailable, allow focused fallback rather than repeatedly
requesting broken tools. Use built-in `read`/`edit`/`write` for source contents
and mutations; prefer them over shell cat/sed/tee/redirection. Run relevant
tests/diagnostics and inspect the diff after edits.

## Router controls and optional background indexing

`/cbrouter off|on|toggle|warn|enforce|status|reset` changes a durable same-session
override. `on` means enforce; reset clears session overrides. Local/global scoped
mode commands persist to router.json. Precedence is session > env > local >
global > defaults. Untrusted local settings are ignored and cannot be saved;
session/global controls remain available. Commands work while off.

`PI_CODEBASE_AUTO_INDEX=1` (session start) and
`PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=1` (successful scoped built-in edit/write,
then agent settled) opt into an incremental background MCP child, host `pi`.
No LLM turn or package install occurs by default. Errors/busy results are not
current and do not cause retry churn. Off/shutdown cancel router-owned pending
work and children, **not the companion's own watcher**. Only explicit
`PI_CODEBASE_AUTO_INDEX_VIA_TURN=1` uses an agent follow-up; Pi cannot retract an
already queued follow-up, so it may still run after off.
