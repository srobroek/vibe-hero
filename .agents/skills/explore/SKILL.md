---
name: explore
description: Lightweight read-only codebase orientation -- file discovery, path tracing, "where is X" lookups. Use when orienting in a repo without editing files. For structured graph queries (callers, impact, architecture), use `codebase-memory`.
---

# Explore

`explore` is lightweight read-only orientation; `codebase-memory` is structured
graph queries against the indexed code graph.

- Answer quick "where/what" questions with `grep`, `glob`, and targeted file reads.
- For structural questions (callers, callees, architecture, impact), delegate to
  the `codebase-memory` skill when the codebase-memory-mcp server is available;
  otherwise stay with `grep` / `glob`.
- Do not edit or write any files.
