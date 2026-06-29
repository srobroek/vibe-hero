#!/usr/bin/env bash
# Bootstrap a SpecKit project: scaffold .specify/, register the community
# extension catalog, install + enable the required extension set, register their
# command files for the requested integration, and install the workflow
# definitions. Idempotent -- safe to re-run.
#
# This is the single source of truth for the spec-kit side of SpecKit setup.
# The global `project-setup` skill delegates here (after `apm install speckit`)
# rather than carrying its own copy.
#
# Prereqs: `specify` CLI on PATH (uv tool install specify-cli).
# The APM speckit orchestration bundle (agents, DAG, hooks) carries this script;
# the bundle's DAG keys off the `.specify/` scaffold this produces.
#
# Usage: setup-speckit.sh [--integration <name>] [--render-for <csv>] [--script <sh|ps>] [--force]
#   --integration   PRIMARY coding-agent integration -- the one `specify init` records as
#                   default_integration and the one this script lands on at the end.
#                   DEFAULT: auto-detected from the agent running this script (see below);
#                   falls back to codex with a warning only when undetectable. The agent
#                   invoking the skill SHOULD pass this explicitly (it knows what it is).
#   --render-for    Comma-separated integrations to render extension command files for, so
#                   /speckit.* exists in every agent the project compiles steering for (e.g.
#                   "claude,codex"). The primary is always included. DEFAULT: just --integration.
#   --script        script flavor for `specify init` (default: sh)
#   --force         pass --force to `specify init` (skip dir-not-empty prompt)
#
# WHY auto-detect the primary: `specify extension add` renders an extension's command files
# ONLY for the integration active at add-time. If `specify init` records the wrong primary
# (historically a hardcoded `codex`), every extension renders for codex even when a Claude Code
# session is driving setup -- and a naive re-run repeats the mistake. Detecting the running
# agent makes the default correct; the explicit --integration parameter lets the agent decide.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
WORKFLOW_ROOT="$SCRIPT_DIR/workflows"

INTEGRATION=""        # empty => auto-detect (resolve_primary_integration below)
RENDER_FOR=""         # empty => render for the primary only
SCRIPT_FLAVOR="sh"
FORCE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --integration) INTEGRATION="${2:?--integration needs a value}"; shift 2 ;;
    --render-for)  RENDER_FOR="${2:?--render-for needs a value}"; shift 2 ;;
    --script)      SCRIPT_FLAVOR="${2:?--script needs a value}"; shift 2 ;;
    --force)       FORCE="--force"; shift ;;
    -h|--help)     sed -n '2,30p' "$0"; exit 0 ;;
    *) echo "unknown arg: $1" >&2; exit 2 ;;
  esac
done

# Detect which coding agent is running this script from its environment. Returns the
# spec-kit integration name (claude|codex) or empty if undetectable (plain shell / CI).
# Ordered most-specific-first; AI_AGENT is the normalized cross-agent marker, then each
# agent's own native env vars as a fallback.
detect_agent() {
  case "${AI_AGENT:-}" in
    *claude*) echo claude; return ;;
    *codex*)  echo codex;  return ;;
  esac
  if [ -n "${CLAUDECODE:-}" ] || [ -n "${CLAUDE_CODE_ENTRYPOINT:-}" ] || [ -n "${CLAUDE_CODE_SESSION_ID:-}" ]; then
    echo claude; return
  fi
  if [ -n "${CODEX_SANDBOX:-}" ] || [ -n "${CODEX_HOME:-}" ] || [ -n "${CODEX_SANDBOX_NETWORK_DISABLED:-}" ]; then
    echo codex; return
  fi
  echo ""
}

# Built-in integration to bounce through when forcing a re-registration switch onto an
# already-active integration (switch-to-self is a no-op and renders nothing).
other_builtin() { [ "$1" = "codex" ] && echo claude || echo codex; }

# Resolve the primary integration: explicit flag wins; else detect; else codex + warn.
if [ -z "$INTEGRATION" ]; then
  INTEGRATION="$(detect_agent)"
  if [ -n "$INTEGRATION" ]; then
    echo "==> auto-detected primary integration: $INTEGRATION (pass --integration to override)"
  else
    INTEGRATION="codex"
    echo "WARNING: could not detect the running agent; defaulting primary integration to '$INTEGRATION'." >&2
    echo "         Pass --integration <claude|codex> explicitly to be sure." >&2
  fi
fi

# Build the ordered, de-duplicated render list: every requested integration with the
# primary forced LAST, so the script lands on the primary after rendering the others.
RENDER_LIST=()
_add_render() {
  local want="$1" have
  [ -z "$want" ] && return
  # Guard the array expansion: bash 3.2 (macOS default) under `set -u` errors on
  # "${arr[@]}" when arr is empty, so only iterate when there is something to compare.
  if [ "${#RENDER_LIST[@]}" -gt 0 ]; then
    for have in "${RENDER_LIST[@]}"; do [ "$have" = "$want" ] && return; done
  fi
  RENDER_LIST+=("$want")
}
# Split --render-for on commas (bash 3.2-safe), excluding the primary for now.
_old_ifs="$IFS"; IFS=','
for _r in $RENDER_FOR; do
  _r="${_r#"${_r%%[![:space:]]*}"}"; _r="${_r%"${_r##*[![:space:]]}"}"  # trim
  [ "$_r" = "$INTEGRATION" ] && continue
  _add_render "$_r"
done
IFS="$_old_ifs"
_add_render "$INTEGRATION"   # primary always last

CATALOG_NAME="community"
CATALOG_URL="https://raw.githubusercontent.com/github/spec-kit/main/extensions/catalog.community.json"

# The required extension set the DAG depends on. Keep in sync with the README
# "Setting up a SpecKit project" list and the speckit-dag node coverage.
# agent-assign is mandatory: steering routes implementation through the
# agent-assign flow and the DAG hard-blocks the deprecated /speckit.implement.
#
# Entries are either a bare extension name (resolved from the community catalog)
# or `name=source-url` for a first-party extension not yet in the catalog, which
# installs via `specify extension add --from <url>`. Custom-source installs are
# best-effort: an unreachable/unpublished source warns and is skipped rather than
# aborting setup. One list, one source of truth; bash 3.2-safe (no associative arrays).
#   roadmap -- the spec-roadmap extension (srobroek/speckit-roadmap); accepted into the
#   community catalog 2026-06, so it resolves by name like the rest.
#
# An entry's source value (after `=`) takes one of two forms:
#   * a direct archive URL              -> installed via `specify extension add NAME --from <url>`
#   * `latest-release:<owner>/<repo>`   -> the latest published GitHub release tag is resolved
#                                          at setup time and its .zip archive is installed
# `specify extension add --from` requires a real archive URL (a bare repo URL is fetched as a
# zip and fails); `latest-release:` exists so we track newest WITHOUT pinning a version.
EXTENSIONS=(
  agent-assign
  archive brownfield bugfix checkpoint cleanup conduct critique diagram doctor
  fix-findings fleet github-issues iterate onboard optimize qa reconcile
  refine retro review roadmap security-review status tinyspec verify verify-tasks worktree
)

# Workflow definitions, installed via the `workflow` primitive (since spec-kit
# 0.11.x workflows are a first-class primitive, NOT extensions -- they do not
# resolve through `extension add`). All three ship in this package under
# workflows/<id>/workflow.yml and are installed from those local dirs:
#   speckit          -- our gated override of the upstream Full SDD Cycle
#   speckit-quality  -- post-implementation QA cycle
#   speckit-full     -- spec -> implement -> QA in one run
WORKFLOWS=(speckit speckit-quality speckit-full)

need() { command -v "$1" >/dev/null 2>&1 || { echo "ERROR: '$1' not found on PATH" >&2; exit 1; }; }
need specify

echo "==> 1/5 specify init (.specify/ scaffold) -- integration=$INTEGRATION script=$SCRIPT_FLAVOR"
if [ -d .specify ] && [ -z "$FORCE" ]; then
  echo "    .specify/ already present -- skipping init (pass --force to re-run)"
else
  # stdin from /dev/null so the post-init "Agent Folder Security" prompt and any
  # other interactive confirmations resolve to their non-interactive default
  # instead of blocking (or aborting under set -e).
  specify init --here --integration "$INTEGRATION" --script "$SCRIPT_FLAVOR" $FORCE </dev/null
fi

echo "==> 2/5 register community extension catalog"
# Match on URL, not just name: a default catalog (e.g. 'custom' from
# SPECKIT_CATALOG_URL) may already point at this community URL.
catalogs="$(specify extension catalog list 2>/dev/null || true)"
if printf '%s\n' "$catalogs" | grep -qF "$CATALOG_URL"; then
  echo "    a catalog for this URL is already registered -- skipping"
elif printf '%s\n' "$catalogs" | grep -qw "$CATALOG_NAME"; then
  echo "    catalog '$CATALOG_NAME' already registered -- skipping"
else
  specify extension catalog add --name "$CATALOG_NAME" --install-allowed "$CATALOG_URL" </dev/null
fi

echo "==> 3/5 install + enable ${#EXTENSIONS[@]} extensions"
installed="$(specify extension list 2>/dev/null || true)"
for entry in "${EXTENSIONS[@]}"; do
  # Split "name=source" (custom source) from a bare "name" (community catalog).
  ext="${entry%%=*}"
  src="${entry#*=}"
  [ "$src" = "$entry" ] && src=""   # no '=' present -> no custom source
  if printf '%s\n' "$installed" | grep -qw "$ext"; then
    echo "    = $ext (already installed)"
  elif [ -n "$src" ]; then
    # Custom-source extension (not in the community catalog). Best-effort:
    # an unreachable/unpublished source warns and continues, leaving the rest
    # of the required catalog set intact.
    case "$src" in
      latest-release:*)
        repo="${src#latest-release:}"
        # Resolve the latest published release tag via the GitHub API (no auth needed
        # for public repos), then install that tag's source archive. Tracks newest
        # without pinning a version in this file.
        tag="$(curl -fsSL "https://api.github.com/repos/${repo}/releases/latest" 2>/dev/null \
                 | grep -m1 '"tag_name"' | sed 's/.*"tag_name"[^"]*"\([^"]*\)".*/\1/')"
        if [ -z "$tag" ]; then
          echo "    WARNING: could not resolve latest release of '$repo' for '$ext' -- skipping" >&2
          continue
        fi
        url="https://github.com/${repo}/archive/refs/tags/${tag}.zip"
        echo "    + $ext (latest release $tag of $repo)"
        ;;
      *)
        url="$src"
        echo "    + $ext (from $url)"
        ;;
    esac
    if ! specify extension add "$ext" --from "$url" </dev/null; then
      echo "    WARNING: could not install '$ext' from $url -- skipping (publish it or check access)" >&2
      continue
    fi
  else
    echo "    + $ext"
    specify extension add "$ext" </dev/null
  fi
  specify extension enable "$ext" </dev/null >/dev/null 2>&1 || true
done

echo "==> 4/5 register extension commands for: ${RENDER_LIST[*]} (primary=$INTEGRATION)"
# `specify extension add` only renders an extension's command files for the
# integration that is ACTIVE at add-time, and `specify integration switch`
# re-registers all installed+enabled extensions ONLY on a genuine switch
# (switching to the already-active integration is a no-op). So if extensions were
# added under a different integration than the one now requested (e.g. the
# default `codex` init, then later using `claude`), their command files are never
# rendered for the requested agent -- and re-running this script does not fix it,
# because the extensions are already "installed" and the install loop skips them.
#
# We render for EVERY integration in RENDER_LIST so /speckit.* exists in each agent
# the project compiles steering for, walking the list in order (primary last so we
# land on it). For each target:
#   - target is NOT the active integration -> one genuine switch re-registers all.
#   - target IS already active             -> bounce through the other built-in and
#     back to force a re-registration (switch-to-self is a no-op).
# Switching built-in integrations (claude/codex) is offline; only the local
# extension registry is read to re-render command files.
read_active_integration() {
  grep -o '"default_integration"[[:space:]]*:[[:space:]]*"[^"]*"' .specify/integration.json 2>/dev/null \
    | sed 's/.*"\([^"]*\)".*/\1/' | head -n1
}
current_integration="$(read_active_integration)"
for target in "${RENDER_LIST[@]}"; do
  if [ -n "$current_integration" ] && [ "$current_integration" != "$target" ]; then
    specify integration switch "$target" </dev/null
    echo "    switched $current_integration -> $target (extensions re-registered)"
    current_integration="$target"
  else
    bounce="$(other_builtin "$target")"
    echo "    $target already active -- bouncing via $bounce to force re-registration"
    # Disable -e around the bounce so a mid-bounce failure cannot leave the project
    # stranded on the bounce integration; always attempt to land back on "$target".
    set +e
    specify integration switch "$bounce" </dev/null && specify integration switch "$target" </dev/null
    bounce_rc=$?
    set -e
    if [ "$bounce_rc" -ne 0 ]; then
      echo "    WARNING: re-registration bounce failed; ensuring active integration is $target" >&2
      specify integration switch "$target" </dev/null || true
    fi
    current_integration="$target"
  fi
done

echo "==> 5/5 install workflow definitions from local dirs: ${WORKFLOWS[*]}"
for wf in "${WORKFLOWS[@]}"; do
  wf_dir="$WORKFLOW_ROOT/$wf"
  if [ ! -f "$wf_dir/workflow.yml" ]; then
    echo "    WARN: workflow asset missing for $wf at $wf_dir -- skipping" >&2
    continue
  fi
  # Replace any existing definition so our opinionated overrides win over the
  # version spec-kit bundles at init (e.g. the upstream `speckit` workflow).
  if specify workflow list 2>/dev/null | grep -qw "$wf"; then
    echo "    ~ $wf (replacing existing)"
    specify workflow remove "$wf" </dev/null >/dev/null 2>&1 || true
  else
    echo "    + $wf"
  fi
  specify workflow add "$wf_dir" </dev/null
done

echo ""
echo "==> SpecKit setup complete."
echo "    The speckit orchestration layer (agents + DAG hooks) ships in the same"
echo "    package as this script. If steering is not yet compiled, run:"
echo "      apm compile --target codex,claude --no-constitution"
echo "    Then start the workflow with /speckit.specify."
