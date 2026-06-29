#!/usr/bin/env bash
# Hook: SessionStart -- index codebase if stale (async, non-blocking)
INPUT=$(cat)
AGENT_ID=$(echo "$INPUT" | jq -r '.agent_id // empty')
[ -n "$AGENT_ID" ] && exit 0  # Skip in subagents

REPO_ROOT=$(git rev-parse --show-toplevel 2>/dev/null)
[ -z "$REPO_ROOT" ] && exit 0

STATE_DIR="$HOME/.local/state/codebase-memory"
mkdir -p "$STATE_DIR" 2>/dev/null
LAST_INDEX="$STATE_DIR/last-index-$(echo "$REPO_ROOT" | md5 2>/dev/null || echo "$REPO_ROOT" | md5sum 2>/dev/null | cut -d' ' -f1)"

# Check staleness (>1 hour)
if [ -f "$LAST_INDEX" ]; then
    LAST_MOD=$(stat -f %m "$LAST_INDEX" 2>/dev/null || stat -c %Y "$LAST_INDEX" 2>/dev/null || echo 0)
    NOW=$(date +%s)
    AGE=$(( NOW - LAST_MOD ))
    [ "$AGE" -lt 3600 ] && exit 0
fi

# Trigger fast reindex via CLI if available
if command -v codebase-memory-mcp >/dev/null 2>&1; then
    codebase-memory-mcp cli index_repository "{\"repo_path\":\"$REPO_ROOT\",\"mode\":\"fast\"}" 2>/dev/null
    touch "$LAST_INDEX" 2>/dev/null
fi

exit 0
