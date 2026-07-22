---
description: Analyze PR/branch impact via the call graph (codebase-index)
argument-hint: "[branch-or-PR#]"
---
Use the `pr_impact` tool:
- If my argument is a number, pass it as pr: <number>
- If it is a branch name, pass it as branch: <name>
- If empty, analyze the current branch's changes

Then summarize the impacted symbols and their caller/callee neighborhoods.
Argument: ${1:-}
