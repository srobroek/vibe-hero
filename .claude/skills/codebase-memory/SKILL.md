---
name: codebase-memory
description: Structured graph queries against the indexed code graph -- trace callers/callees, find references, map architecture. Use for structural codebase questions. Requires the codebase-memory-mcp server; for lightweight read-only orientation, use `explore`.
---

# Codebase Memory

`codebase-memory` is structured graph queries; `explore` is lightweight
read-only orientation with grep/glob.

## Dependency

This skill requires the `codebase-memory-mcp` MCP server (installed via the
`mcp-codebase-memory` package). If its tools are not available, skip the graph
flow entirely and degrade to plain `grep` / `glob` exploration (the `explore`
skill).

## Preferred Flow

1. Choose the intent first: explore, trace, reference, or quality.
2. Start with the lightest graph-aware query that can answer the question.
3. Read only the specific code snippets or graph results needed to confirm the answer.
4. Fall back to plain file search only when the graph tooling cannot answer the question.

## Intent Routing

- Explore architecture or locate symbols: use `get_graph_schema` -> `get_architecture` -> `search_graph` -> `get_code_snippet`
- Trace callers, callees, or impact: LOAD references/trace.md
- Check tool capabilities or query patterns: LOAD references/reference.md
- Look for dead code, hotspots, or refactor targets: LOAD references/quality.md

## Steering

- Prefer graph-aware lookup before broad grep when the tool can answer the question.
- Use the code graph to narrow the search surface, then verify against real code.
- Keep the answer grounded in observed results, not assumed graph completeness.

## Scripts

- Index refresh helper: `scripts/index.sh` (errors if `codebase-memory-mcp` is not installed)
