# Trace With Codebase Memory

Use this path for call-chain and impact analysis.

## Typical Flow

1. `search_graph` to find the exact symbol
2. `trace_call_path` with `inbound`, `outbound`, or `both`
3. `detect_changes` when assessing recent blast radius

## Use Cases

- who calls this function?
- what does this route eventually reach?
- what else may break if this API changes?
