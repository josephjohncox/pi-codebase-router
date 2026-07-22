---
description: Build/update the codebase index (codebase-index)
argument-hint: "[estimate|force|verbose]"
---
Run the `index_codebase` tool for the current project, interpreting my argument:

- "estimate" -> call with estimateOnly: true (show the estimate only; do NOT index)
- "force"    -> call with force: true (full rebuild from scratch)
- "verbose"  -> call with verbose: true
- empty      -> normal incremental index

Then briefly report files/chunks indexed and the detected provider/model.
Prefer the normal incremental mode; reserve force for a full rebuild or
provider/model incompatibility.
Argument: ${1:-}
