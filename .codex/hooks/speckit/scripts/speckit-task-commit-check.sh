#!/usr/bin/env bash
set -euo pipefail

[[ -d ".specify" ]] || exit 0

input="$(cat)"
command="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null || true)"

if ! printf '%s' "$command" | grep -qE 'git commit '; then
  exit 0
fi

if printf '%s' "$command" | grep -qE '\-\-amend'; then
  exit 0
fi

active_spec=""
# `git branch --show-current` exits 128 outside a repo; under `set -e` that
# aborts the hook. Swallow the failure so non-repo invocations are a no-op.
current_branch="$(git branch --show-current 2>/dev/null || true)"
if printf '%s' "$current_branch" | grep -qE '[0-9]{3}-'; then
  active_spec="$(printf '%s' "$current_branch" | grep -oE '[0-9]{3}-[a-z0-9-]+' | head -1)"
fi

unchecked=""
checked=""
if [[ -n "$active_spec" && -f "specs/$active_spec/tasks.md" ]]; then
  # `grep -c` prints 0 AND exits 1 on no match. The old `|| echo 0` produced a
  # second 0 ("0\n0"), breaking the later `-gt` test. Use `|| true` so grep's own
  # 0 stands and `set -e` does not abort on the non-match exit; then default.
  unchecked="$(grep -c '^\- \[ \]' "specs/$active_spec/tasks.md" 2>/dev/null || true)"; unchecked="${unchecked:-0}"
  checked="$(grep -c '^\- \[X\]\|^\- \[x\]' "specs/$active_spec/tasks.md" 2>/dev/null || true)"; checked="${checked:-0}"
fi

last_msg="$(git log -1 --format=%s 2>/dev/null || true)"
has_issue_ref=false
if printf '%s' "$last_msg" | grep -qE '#[0-9]+'; then
  has_issue_ref=true
fi

context=""
if [[ -n "$unchecked" && "$unchecked" -gt 0 ]]; then
  context="SPECKIT TASK CHECK: Commit created. Spec $active_spec has $checked completed / $unchecked remaining tasks. Check if this commit completes any tasks -- mark them [X] in tasks.md."
fi

if [[ "$has_issue_ref" == false && -n "$active_spec" ]]; then
  if [[ -n "$context" ]]; then
    context="$context"$'\n'
  fi
  context="${context}SPECKIT ISSUE REF: Commit message has no issue reference (#N). Add for traceability (but remember: only PR body refs trigger auto-close with squash merges). Ignore if this commit is not related to the active spec."
fi

if [[ -n "$context" ]]; then
  jq -n --arg ctx "$context" '{
    hookSpecificOutput: {
      hookEventName: "PostToolUse",
      additionalContext: $ctx
    }
  }'
fi
