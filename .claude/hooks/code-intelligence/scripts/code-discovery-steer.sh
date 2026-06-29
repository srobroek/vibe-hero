#!/usr/bin/env bash
# Hook: PreToolUse -- advisory steering toward codebase-memory and repomix
# Injects additionalContext when agent uses plain Grep/Glob/Read for code discovery.
# Never blocks -- always exit 0.

INPUT=$(cat)
TOOL=$(echo "$INPUT" | jq -r '.tool_name // empty')
COMMAND=$(echo "$INPUT" | jq -r '.tool_input.command // empty')

# Fire at most once per session. Key the gate on the hook payload's
# session_id; $PPID is a transient shell that changes per invocation and
# would re-fire the advisory on every tool call.
SESSION_ID=$(echo "$INPUT" | jq -r '.session_id // empty')
GATE="/tmp/code-discovery-steer-${SESSION_ID:-$PPID}"
find /tmp -maxdepth 1 -name 'code-discovery-steer-*' -mtime +1 -delete 2>/dev/null
if [ -f "$GATE" ]; then
    exit 0
fi
touch "$GATE"

CTX="CODE DISCOVERY: Prefer codebase-memory-mcp (search_graph, trace_path, get_code_snippet) for symbol and call-path exploration. Use Repomix only when broad repository snapshot context is useful; it is a packer, not an incremental index. Grep/Glob/Read are fine for text content, config values, and non-code files."

jq -n --arg ctx "$CTX" '{
  hookSpecificOutput: {
    hookEventName: "PreToolUse",
    additionalContext: $ctx
  }
}'
exit 0
