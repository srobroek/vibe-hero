---
name: codebase-index
description: Rebuild the codebase-memory graph index when it is missing or stale. Use before graph-backed exploration (`codebase-memory`) when queries fail, return empty results, or the index predates recent commits.
---

# Codebase Index

Rebuild the index that backs `codebase-memory` graph queries.

## Dependency

Requires the `codebase-memory-mcp` binary (installed via the
`mcp-codebase-memory` package). If it is not installed, `scripts/index.sh`
exits with an error -- report that, skip indexing, and degrade to plain
`grep` / `glob` exploration (the `explore` skill).

## Workflow

1. Run `scripts/index.sh`. It resolves the repo root via
   `git rev-parse --show-toplevel`, then runs:

   ```bash
   codebase-memory-mcp cli index_repository "{\"repo_path\":\"<repo-root>\",\"mode\":\"fast\"}"
   ```

2. Verify the graph is queryable (e.g. `get_graph_schema` returns results)
   before resuming exploration.
3. Report whether indexing was triggered, completed, or skipped (and why).

## Steering

- Only re-index when the graph is genuinely stale or absent. Avoid redundant index runs.

## Scripts

- Index: `scripts/index.sh`
