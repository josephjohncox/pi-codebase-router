---
description: Find code with token-efficient semantic discovery plus exact matching (codebase-index)
argument-hint: "<query>"
---
# Indexed code search

Use this workflow for: $@

1. Call `codebase_peek` first with a small limit to locate likely
   implementations.
2. If the user needs actual code, call `implementation_lookup` or
   `codebase_search` only for the narrowed candidates.
3. Use the built-in `grep` tool only after discovery, for exact
   identifiers/literals or exhaustive occurrence checks.
4. Read exact files/line ranges with the built-in `read` tool and summarize the
   result.

If the index is unavailable, stop and tell me to run /cbindex first. Do not
replace conceptual discovery with broad grep or shell rg.
