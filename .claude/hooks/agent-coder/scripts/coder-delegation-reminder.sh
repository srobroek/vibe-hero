#!/usr/bin/env bash
# Hook: PreToolUse:Edit|Write|MultiEdit|apply_patch
# Soft reminder: when the top-level session writes source code directly,
# nudge it to delegate to the `coder` subagent.
#
# Behavior:
#   - Subagent edits (Claude: .agent_id present) pass silently.
#   - Non-code paths (docs, configs, plans, memory) pass silently.
#   - Otherwise emits a non-blocking reminder via hookSpecificOutput.additionalContext
#     (works for both Claude Code and Codex CLI) and exits 0.
#   - Never blocks.

set -euo pipefail

payload="$(cat || true)"
[ -z "$payload" ] && exit 0

agent_id="$(printf '%s' "$payload" | jq -r '.agent_id // empty' 2>/dev/null || true)"
if [ -n "$agent_id" ] && [ "$agent_id" != "null" ]; then
  exit 0
fi

# Extract any path-like strings from tool_input. Covers Claude's Edit/Write/MultiEdit
# (file_path, edits[].file_path, notebook_path) and Codex's apply_patch (the patch
# body in tool_input.input/command references files by name).
candidates="$(printf '%s' "$payload" | jq -r '
  [
    .tool_input.file_path?,
    .tool_input.path?,
    .tool_input.paths[]?,
    .tool_input.notebook_path?,
    .tool_input.edits[]?.file_path?,
    .tool_input.input?,
    .tool_input.command?,
    .tool_input.patch?
  ]
  | map(select(type == "string"))
  | .[]
' 2>/dev/null || true)"

[ -z "$candidates" ] && exit 0

code_ext_regex='\.(ts|tsx|js|jsx|mjs|cjs|py|go|rs|java|kt|rb|php|cs|swift|c|cc|cpp|h|hpp|sh|bash|zsh|fish|lua|ex|exs|erl|clj|scala|sql|vue|svelte|css|scss)(\b|$)'

if ! printf '%s' "$candidates" | grep -Eiq "$code_ext_regex"; then
  exit 0
fi

reminder='You are the top-level session writing code directly. The `coder` agent (`.apm/agents/coder.agent.md`) is the designated implementation subagent for bounded code changes, tests, refactors, and migrations. Prefer delegating: in Claude Code, spawn via the Agent tool with subagent_type=coder; in Codex, hand off through the configured coder profile. Skip this nudge only when the edit is trivial (single-line fix, comment, rename) or already part of a plan you are executing.'

jq -n --arg ctx "$reminder" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'

exit 0
