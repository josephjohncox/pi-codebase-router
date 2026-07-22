---
name: indexed-codebase-workflow
description: Token-efficient repository exploration and editing with opencode-codebase-index. Use before investigating unfamiliar code, tracing behavior, locating definitions, assessing impact, or making source changes.
---

# Indexed codebase workflow

Use the semantic index as the default navigation layer. It is local,
branch-aware, and returns structured chunks instead of forcing broad file dumps
into context.

## Route the question

1. **Unknown concept, behavior, or location**: call `codebase_peek` first. Use a
   focused natural-language query and a small `limit` (usually 5).
2. **Authoritative definition**: call `implementation_lookup`.
3. **Need implementation details**: read only the returned file and relevant
   line range with the built-in `read` tool. Do not request full files by
   default.
4. **Need behavior or dependency flow**: use `call_graph` or
   `call_graph_path` after discovering symbols.
5. **Need change blast radius**: use `pr_impact` before merging or making risky
   refactors.
6. **Need actual indexed code context across several candidates**: call
   `codebase_search` with `limit`, `fileType`, `directory`, `chunkType`, and
   `contextLines=0` rather than dumping files.

## Keep lexical search in its lane

Use the built-in `grep` tool only for an exact known identifier, literal, regex,
or exhaustive occurrence check. Do not use grep or shell `rg` to answer
conceptual questions such as “where is authentication enforced?” Use `find`/`ls`
only for filesystem inventory, not code discovery.

Use the built-in `read`, `edit`, and `write` tools for file access and source
mutations. Avoid `cat`, `sed`, `head`, `tail`, shell redirection, `tee`,
`sed -i`, and `perl -i` for source files.

## Index readiness

- Run `index_status` when the index may be missing, stale, or incompatible.
- Use `/cbindex` or `index_codebase` for a normal incremental update.
- Use `/cbindex force` or `index_codebase({ force: true })` only for a full
  rebuild, corruption, or provider/model incompatibility.
- Do not automatically force-reindex after every edit; normal indexing is
  incremental. In Pi, opt into the after-write hook if automatic refresh is
  required.

## Optional background indexing

`PI_CODEBASE_AUTO_INDEX=1` (session start) and
`PI_CODEBASE_AUTO_INDEX_AFTER_WRITE=1` (after a settled write/edit turn) trigger
an **incremental** index. It runs in the background as a detached
`opencode-codebase-index` subprocess — no agent turn, no LLM cost, non-blocking
— into the same `.codebase-index/` directory the search tools read. Never a
force rebuild. Set `PI_CODEBASE_AUTO_INDEX_VIA_TURN=1` to use a follow-up agent
turn instead.

## Compact workflow

`codebase_peek` → `implementation_lookup`/`codebase_search` as needed → `read`
exact lines → edit/write → tests or diagnostics → inspect the diff.

If indexed search is weak, check `index_status` before falling back to grep. Use
web search only after local indexed code and documentation fail.
