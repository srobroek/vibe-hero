#!/usr/bin/env bash
# Hook: PostToolUse - refresh the local Repomix snapshot cache.
# Repomix is a snapshot packer, not an incremental index. Run only after
# successful branch/worktree creation or integration events, and only when the
# worktree is clean.

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

command -v repomix >/dev/null 2>&1 || exit 0

cwd="$(json_value '.cwd // empty')"
[[ -n "$cwd" && "$cwd" != "null" && -d "$cwd" ]] || cwd="$PWD"

repo_root="$(git -C "$cwd" rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]] || { [[ ! -d "$repo_root/.git" ]] && [[ ! -f "$repo_root/.git" ]]; }; then
  exit 0
fi

head_sha="$(git -C "$repo_root" rev-parse HEAD 2>/dev/null || true)"
[[ -n "$head_sha" ]] || exit 0

# Avoid packing conflicted, partially merged, or locally dirty snapshots.
if [[ -n "$(git -C "$repo_root" status --porcelain=v1 2>/dev/null)" ]]; then
  exit 0
fi

output_rel="repomix.xml"
git -C "$repo_root" check-ignore -q "$output_rel" 2>/dev/null || exit 0

state_root="${XDG_STATE_HOME:-$HOME/.local/state}/agentic-tools/repomix"
mkdir -p "$state_root" 2>/dev/null || exit 0

repo_hash="$(printf '%s' "$repo_root" | md5sum 2>/dev/null | awk '{print $1}' || true)"
if [[ -z "$repo_hash" ]]; then
  repo_hash="$(printf '%s' "$repo_root" | md5 -q 2>/dev/null || true)"
fi
[[ -n "$repo_hash" ]] || exit 0

head_marker="$state_root/$repo_hash.sha"
last_head="$(cat "$head_marker" 2>/dev/null || true)"
[[ "$last_head" == "$head_sha" ]] && exit 0

# Dedupe concurrent packs with an atomic lockdir. mkdir succeeds for exactly
# one racer; the others bail out. Do NOT pre-write the marker here: a premature
# write makes a later invocation believe the (possibly failed) pack succeeded.
lock_dir="$state_root/$repo_hash.lock"
mkdir "$lock_dir" 2>/dev/null || exit 0

(
  trap 'rmdir "$lock_dir" 2>/dev/null || true' EXIT
  output="$repo_root/$output_rel"
  # Write the marker ONLY on a successful pack.
  if timeout 180 repomix --directory "$repo_root" --style xml --output "$output" >/dev/null 2>&1; then
    printf '%s\n' "$head_sha" >"$head_marker" 2>/dev/null || true
  fi
) >/dev/null 2>&1 &

exit 0
