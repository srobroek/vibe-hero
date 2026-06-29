#!/usr/bin/env bash
# Hook: PostToolUse - refresh codebase-memory after git commit.
# Fires only when the repository HEAD changed. Async and best-effort.

set -u

payload="$(cat 2>/dev/null || true)"

json_value() {
  local expr="$1"
  if [[ -z "$payload" ]] || ! command -v jq >/dev/null 2>&1; then
    return 0
  fi
  printf '%s' "$payload" | jq -r "$expr" 2>/dev/null || true
}

agent_id="$(json_value '.agent_id // empty')"
[[ -n "$agent_id" && "$agent_id" != "null" ]] && exit 0

exit_code="$(json_value '.tool_response.exit_code // .tool_result.exit_code // .result.exit_code // empty')"
if [[ "$exit_code" =~ ^[0-9]+$ ]] && (( exit_code != 0 )); then
  exit 0
fi

cwd="$(json_value '.cwd // empty')"
[[ -n "$cwd" && "$cwd" != "null" && -d "$cwd" ]] || cwd="$PWD"

repo_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]] || { [[ ! -d "$repo_root/.git" ]] && [[ ! -f "$repo_root/.git" ]]; }; then
  exit 0
fi

head_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)"
[[ -n "$head_sha" ]] || exit 0

command -v codebase-memory-mcp >/dev/null 2>&1 || exit 0

state_root="${XDG_STATE_HOME:-$HOME/.local/state}/agentic-tools"
mkdir -p "$state_root/codebase-memory" 2>/dev/null || exit 0

repo_hash="$(printf '%s' "$repo_root" | md5sum 2>/dev/null | awk '{print $1}' || true)"
if [[ -z "$repo_hash" ]]; then
  repo_hash="$(printf '%s' "$repo_root" | md5 -q 2>/dev/null || true)"
fi
[[ -n "$repo_hash" ]] || exit 0

head_marker="$state_root/last-commit-$repo_hash"
last_head="$(cat "$head_marker" 2>/dev/null || true)"
[[ "$last_head" == "$head_sha" ]] && exit 0

(
  if codebase-memory-mcp cli index_repository "{\"repo_path\":\"$repo_root\",\"mode\":\"fast\"}" >/dev/null 2>&1; then
    printf '%s\n' "$head_sha" >"$head_marker" 2>/dev/null || true
    touch "$state_root/codebase-memory/last-index-$repo_hash" 2>/dev/null || true
    old_state="${XDG_STATE_HOME:-$HOME/.local/state}/codebase-memory"
    mkdir -p "$old_state" 2>/dev/null || true
    touch "$old_state/last-index-$repo_hash" 2>/dev/null || true
  fi
) >/dev/null 2>&1 &

exit 0
