---
description: Scoped indexed discovery without a mandatory retrieval chain (codebase-index)
argument-hint: "<query>"
---
# Indexed code search

Find code for: $@

Check `index_status` if readiness is unknown. For unfamiliar subsystem
orientation, optionally use `codebase_context` with tokenBudget: 600, limit: 5.
For known definitions, use `implementation_lookup` directly; for callers/callees
or identified dependency endpoints use `call_graph` / `call_graph_path`.
Use `codebase_peek` for metadata-only locations or narrow `codebase_search` for
semantic source matches when useful. No context/peek prerequisite chain.
Read exact files/line ranges with built-in `read`; built-in read/edit/write are
always allowed. Reserve grep for exact identifiers/literals or exhaustive checks
when indexed discovery is usable.

If tools/index are unavailable, incompatible, migrating, or retrieval fails,
report that briefly and continue with known-file/direct-tool fallback. Suggest
incremental /cbindex for missing/stale indexes or storage migrations; do not
force a rebuild automatically. Keep evidence within the actual cwd and requested
directory; never substitute main-checkout results for sibling worktrees.
