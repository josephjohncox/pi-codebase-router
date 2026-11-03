---
description: Semantic codebase search by meaning (codebase-index)
argument-hint: "<query>"
---
# Indexed code search

Use the `codebase_search` tool to find code by meaning for:
$@

Use `codebase_search` directly for semantic source matches; `codebase_peek` is
an optional alternative for metadata-only locations, not a prerequisite. Keep
limits and fileType/directory/chunkType/contextLines=0 filters narrow. Check
`index_status` when readiness is unknown; do not widen scope after a miss.

If tools/index are unavailable or incompatible, report it, suggest /cbindex as
appropriate, and allow focused known-file/direct-tool fallback. Do not force a
rebuild or auto-index without being asked.
