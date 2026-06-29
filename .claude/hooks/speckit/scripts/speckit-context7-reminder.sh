#!/usr/bin/env bash
# Hook: PreToolUse:Skill - Remind to use context7 for library research
# Triggers on speckit.plan, speckit.tasks, speckit.implement

# Only activate in speckit projects
[ -d ".specify" ] || exit 0

INPUT=$(cat)
TOOL_INPUT=$(echo "$INPUT" | jq -r '.tool_input // empty' 2>/dev/null)

# Extract skill name from tool input
SKILL_NAME=$(echo "$TOOL_INPUT" | jq -r '.skill // empty' 2>/dev/null)

# Only trigger on relevant speckit skills
case "$SKILL_NAME" in
  speckit.plan|speckit.tasks|speckit.implement)
    ;;
  *)
    exit 0
    ;;
esac

CONTEXT=""
case "$SKILL_NAME" in
  speckit.plan)
    CONTEXT="CONTEXT7 REMINDER: Before planning, use context7 MCP (resolve-library-id -> query-docs) to research libraries being considered. Compare alternatives, check compatibility, verify current API status."
    ;;
  speckit.tasks)
    CONTEXT="CONTEXT7 REMINDER: Before defining tasks, use context7 MCP to look up API signatures, patterns, and constraints for chosen libraries. Tasks should reflect actual library capabilities."
    ;;
  speckit.implement)
    CONTEXT="CONTEXT7 REMINDER: During implementation, use context7 MCP to look up exact API usage, function signatures, configuration options, and idiomatic patterns. Do not rely on training data alone."
    ;;
esac

if [ -n "$CONTEXT" ]; then
  jq -n --arg ctx "$CONTEXT" '{
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      additionalContext: $ctx
    }
  }'
fi

exit 0
