# Codebase Memory Reference

Prefer loading this only when the question is about the tool itself.

## Common Tool Families

- indexing: `index_repository`, `index_status`, `detect_changes`
- graph search: `search_graph`, `query_graph`, `get_graph_schema`
- code lookup: `get_code_snippet`, `search_code`
- architecture and impact: `get_architecture`, `trace_call_path`

## Common Edge Types

- `CALLS`
- `HTTP_CALLS`
- `ASYNC_CALLS`
- `IMPORTS`
- `DEFINES`
- `IMPLEMENTS`

## Guidance

- Use the schema before guessing labels or edge names.
- Use `search_graph` before writing custom graph queries unless the question truly needs Cypher.
