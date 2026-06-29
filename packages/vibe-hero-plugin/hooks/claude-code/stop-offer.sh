#!/bin/sh
# =============================================================================
# vibe-hero Stop hook: end-of-work quiz offer (agent-mediated — FR-011)
#
# This hook SPAWNS NOTHING. A Claude Code hook cannot reach the running stdio
# MCP server (Claude Code owns the server's pipes), and spawning a process per
# turn-end would add latency/hang risk on a hot path. So the offer is
# AGENT-MEDIATED: this script only emits a short `additionalContext` nudge, and
# the agent — which already holds the live MCP connection — decides whether to
# call the `get_offer` MCP tool against the already-running server.
#
# Contract:
#   - Reads the Stop-hook JSON payload from stdin.
#   - Honors the `stop_hook_active` loop guard: if true, emit nothing, exit 0
#     (prevents re-nudging after our own additionalContext re-triggered Claude).
#   - Otherwise prints exactly:
#       {"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…"}}
#   - ALWAYS exits 0 (advisory only — never blocks the user).
#
# Dependency-light: uses `jq` only to read the loop-guard flag when present; if
# `jq` is absent it falls back to a tiny grep and still degrades safely. It
# references NO node/npx/get-offer CLI and NO plugin-local build artifact.
# =============================================================================

set -eu

# Read the whole payload from stdin (a few KB at most). Tolerate empty stdin.
payload=$(cat 2>/dev/null || true)

# --- Loop guard: skip if stop_hook_active is true ---------------------------
# Prefer jq for a correct JSON read; fall back to a conservative grep so the
# guard still works without jq. Either way, default to "not active".
stop_hook_active="false"
if command -v jq >/dev/null 2>&1; then
  stop_hook_active=$(printf '%s' "$payload" | jq -r '.stop_hook_active // false' 2>/dev/null || printf 'false')
elif printf '%s' "$payload" | grep -q '"stop_hook_active"[[:space:]]*:[[:space:]]*true'; then
  stop_hook_active="true"
fi

if [ "$stop_hook_active" = "true" ]; then
  # Re-invoked after our own nudge — emit nothing to avoid an infinite loop.
  exit 0
fi

# --- Emit the agent-mediated nudge ------------------------------------------
nudge="[vibe-hero] A unit of work just ended — a knowledge check may be available. Call the get_offer MCP tool to see if there is a quiz to offer the user, and if so, offer it (do not interrupt; the offer is advisory)."

if command -v jq >/dev/null 2>&1; then
  jq -cn --arg ctx "$nudge" \
    '{hookSpecificOutput:{hookEventName:"Stop",additionalContext:$ctx}}'
else
  # No jq: the nudge text is fixed and contains no characters needing escaping,
  # so emit the JSON directly.
  printf '{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"%s"}}\n' "$nudge"
fi

exit 0
