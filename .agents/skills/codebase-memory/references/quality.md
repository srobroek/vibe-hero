# Quality Analysis With Codebase Memory

Use this path for cleanup, refactor, and dead-code style questions.

## Typical Flow

1. `search_graph` with degree-oriented filters
2. inspect suspicious nodes with `get_code_snippet`
3. cross-check with tests or callers before claiming dead code

## Use Cases

- unreferenced functions
- high fan-out hotspots
- refactor candidates
- suspiciously isolated modules
