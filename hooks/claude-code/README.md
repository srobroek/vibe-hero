# vibe-hero Claude Code hooks

The scripts here are **symlinks** into the canonical copies at
`packages/vibe-hero-plugin/hooks/claude-code/` (single source of truth — a
former byte-for-byte duplicate drifted; see code-review findings).

## prompt-offer.sh — deferred quiz offer (UserPromptSubmit, dumb relay)

Reads the per-session arm cache the server writes at
`~/.vibe-hero/arm/vibe-hero-offer-<session_id>.json`, verifies the embedded
session id, checks the cooldown/expiry arithmetic, and relays the
server-built `context` string as `additionalContext`. All offer wording and
policy lives server-side (`observation/armCache.ts`); the hook spawns
nothing and always exits 0.

## spool-signal.sh — organic observation intake (PreToolUse/PostToolUse/events)

Appends one JSON line per hook event to
`~/.vibe-hero/spool/<session_id>.jsonl` (0600). The resident MCP server
drains the spool every ~30s (`observation/drain.ts`), matches signals
against catalog `triggerSignals`, accumulates evidence, and arms offers at
work seams. Sub-millisecond hot path: no node, no npx, no network, no
output.

Privacy: spool lines may carry `tool_input.command` / `file_path` for
drain-time topic matching; they are user-private, short-lived, and the raw
strings are discarded server-side after matching — never persisted.
`tool_output` is never recorded.

## _lib.sh — shared helpers

Session-id parsing, JSON field extraction (jq-optional), JSON string
escaping, ISO-8601→epoch conversion (GNU + BSD date).
