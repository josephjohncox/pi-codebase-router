---
description: Semantic search, metadata only — file/lines/symbol (codebase-index)
argument-hint: "<query>"
---
# Indexed code peek

Use the `codebase_peek` tool (metadata-only results: file, lines, symbol) for:
$@

Keep the result small (usually limit=5). After locating candidates, use
`implementation_lookup` or the built-in `read` tool on exact files/lines; do
not dump full files.
