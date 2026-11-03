---
description: Show codebase index status (codebase-index)
---
Run `index_status`. Report indexed/readiness state, chunk count, provider/model,
compatibility, and any pending storage migration or failed batches. Suggest
incremental /cbindex for a missing/stale index or storage migration; reserve
force for an explicitly requested full rebuild or provider/model incompatibility.
Unavailable/incompatible indexes should allow known-file/direct-tool fallback,
not block the task. Do not rebuild automatically.
