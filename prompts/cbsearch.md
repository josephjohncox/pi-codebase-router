---
description: Semantic codebase search by meaning (codebase-index)
argument-hint: "<query>"
---
# Indexed code search

Use the `codebase_search` tool to find code by meaning for:
$@

Prefer `codebase_peek` first when only locations are needed. Keep this search
narrow with a small limit and relevant fileType, directory, chunkType, or
contextLines=0.

If the tool reports the codebase is not indexed, stop and tell me to run
/cbindex first (do not auto-index).
