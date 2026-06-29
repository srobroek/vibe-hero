#!/usr/bin/env bash
set -euo pipefail

[[ -d ".specify" ]] || exit 0

payload="$(cat)"
[[ -n "$payload" ]] || exit 0

tool_name="$(printf '%s' "$payload" | jq -r '.tool_name // .tool // empty' 2>/dev/null || true)"
case "$tool_name" in
  apply_patch|functions.apply_patch|"") ;;
  *) exit 0 ;;
esac

patch="$(
  printf '%s' "$payload" | jq -r '
    if (.tool_input | type) == "string" then
      .tool_input
    else
      .tool_input.patch // .tool_input.input // .input // empty
    end
  ' 2>/dev/null || true
)"

[[ -n "$patch" && "$patch" != "null" ]] || exit 0

if ! printf '%s' "$patch" | grep -qE '(^|\n)\*\*\* (Update|Add) File: .*/?tasks\.md(\n|$)'; then
  exit 0
fi

# BSD grep/sed do not support \b. A task id is T followed by exactly 3 digits;
# match the trailing boundary explicitly as "not another digit" (or end of token).
if ! printf '%s' "$patch" | grep -qE '^\+.*- \[[xX]\] T[0-9]{3}([^0-9]|$)'; then
  exit 0
fi

task_ids="$(printf '%s' "$patch" | sed -nE 's/^\+.*- \[[xX]\] (T[0-9]{3})([^0-9].*)?$/\1/p' | sort -u | paste -sd ', ' -)"
[[ -n "$task_ids" ]] || task_ids="completed task IDs"

context="SPECKIT ISSUE SYNC: This patch marks $task_ids complete in tasks.md. If this repo uses GitHub task issues, immediately find the matching issue(s), close/comment only the tasks that are genuinely complete, and leave blocked or partial tasks open with a blocker note. If no matching issue exists, say that explicitly."

jq -n --arg ctx "$context" '{
  hookSpecificOutput: {
    hookEventName: "PostToolUse",
    additionalContext: $ctx
  }
}'
