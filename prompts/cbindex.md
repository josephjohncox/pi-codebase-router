---
description: Build/update the codebase index (codebase-index)
argument-hint: "[estimate|force|verbose]"
---
Run the `index_codebase` tool for the current project, interpreting my argument:

- "estimate" -> call with estimateOnly: true (show the estimate only; do NOT index)
- "force"    -> call with force: true (full rebuild from scratch)
- "verbose"  -> call with force: false, verbose: true
- empty      -> call with force: false (normal incremental index)

Then briefly report files/chunks indexed and the detected provider/model.
Inspect isError, details.code, and text-level failures: INDEX_BUSY or
"index_codebase failed: ..." is not success/current. Report these accurately.
Prefer normal incremental mode for updates and storage migrations; reserve
force for an explicitly requested full rebuild or provider/model incompatibility.
Argument: ${1:-}
