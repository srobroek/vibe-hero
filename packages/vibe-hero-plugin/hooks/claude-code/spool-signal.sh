#!/bin/sh
# =============================================================================
# vibe-hero spool-writer hook: organic observation intake.
#
# Registered for PreToolUse, PostToolUse, SubagentStop, PreCompact,
# TaskCreated, TaskCompleted, SessionStart, SessionEnd (hooks.json). Appends
# ONE JSON line per event to the per-session spool:
#
#   ~/.vibe-hero/spool/<session_id>.jsonl        (0600, dir 0700)
#
# The resident MCP server drains the spool on a timer (observation/drain.ts),
# matches signals against catalog trigger declarations, and arms offers. This
# script is the ONLY hot-path component: it must stay silent (no stdout),
# always exit 0, and finish in milliseconds — no npx, no node, no network.
#
# PRIVACY: spools carry tool_input.command / tool_input.file_path (needed for
# drain-time topic matching — git vs test vs debug). They are user-private
# (0600 under $HOME) and short-lived (deleted each drain, ~30s). tool_output
# is NEVER spooled. Raw strings never reach the profile or logs (the server
# discards them after matching).
#
# jq strongly preferred (correct JSON in/out). WITHOUT jq the hook degrades
# gracefully: only privacy-trivial scalar fields (event names, tool name,
# ids) are extracted via grep; command/path extraction is SKIPPED entirely
# rather than risk mis-parsing raw content into malformed JSON.
# =============================================================================

set -eu

. "${CLAUDE_PLUGIN_ROOT}/hooks/claude-code/_lib.sh"

payload=$(cat 2>/dev/null || true)
[ -n "$payload" ] || exit 0

session_id=$(vh_session_id "$payload")

spool_dir="$(vh_home)/spool"
mkdir -p "$spool_dir" 2>/dev/null || exit 0
chmod 700 "$spool_dir" 2>/dev/null || true
spool_file="${spool_dir}/${session_id}.jsonl"

now_epoch=$(date +%s 2>/dev/null || printf '0')

if command -v jq >/dev/null 2>&1; then
  # jq builds the line in one pass: correct escaping for arbitrary command
  # strings, and drops null fields. kind: pre|post|event by hook_event_name.
  line=$(printf '%s' "$payload" | jq -c --argjson ts "$now_epoch" '
    (.hook_event_name // "") as $e |
    (if $e == "PreToolUse" then "pre"
     elif $e == "PostToolUse" then "post"
     else "event" end) as $kind |
    {
      kind: $kind,
      session: (.session_id // "default"),
      ts: $ts,
      tool: .tool_name,
      id: .tool_use_id,
      input: (.tool_input.command // null),
      path: (.tool_input.file_path // null),
      event: (if $kind == "event" then $e else null end)
    } | with_entries(select(.value != null))
  ' 2>/dev/null || true)
else
  # Degraded no-jq path: scalar fields only, no raw input/path (see header).
  event_name=$(vh_json_field "$payload" "hook_event_name")
  tool_name=$(vh_json_field "$payload" "tool_name")
  tool_use_id=$(vh_json_field "$payload" "tool_use_id")
  case "$event_name" in
    PreToolUse)  kind="pre" ;;
    PostToolUse) kind="post" ;;
    *)           kind="event" ;;
  esac
  line="{\"kind\":\"${kind}\",\"session\":\"${session_id}\",\"ts\":${now_epoch}"
  [ -n "$tool_name" ]   && line="${line},\"tool\":\"$(vh_json_escape "$tool_name")\""
  [ -n "$tool_use_id" ] && line="${line},\"id\":\"$(vh_json_escape "$tool_use_id")\""
  [ "$kind" = "event" ] && [ -n "$event_name" ] && line="${line},\"event\":\"$(vh_json_escape "$event_name")\""
  line="${line}}"
fi

[ -n "$line" ] || exit 0

# O_APPEND single-line writes are atomic for these sizes on POSIX — concurrent
# hook invocations interleave whole lines, never partial ones. Create 0600.
umask 077
printf '%s\n' "$line" >> "$spool_file" 2>/dev/null || true

exit 0
