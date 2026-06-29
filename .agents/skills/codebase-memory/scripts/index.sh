#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [ -z "${repo_root}" ]; then
  echo "Not inside a git repository." >&2
  exit 1
fi

if ! command -v codebase-memory-mcp >/dev/null 2>&1; then
  echo "codebase-memory-mcp is not installed." >&2
  exit 1
fi

# Use the CLI entrypoint explicitly and index the repository root with fast mode.
codebase-memory-mcp cli index_repository "{\"repo_path\":\"${repo_root}\",\"mode\":\"fast\"}"
