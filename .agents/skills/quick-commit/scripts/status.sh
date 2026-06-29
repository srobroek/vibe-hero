#!/usr/bin/env bash
set -euo pipefail

git status --short
echo
git diff --stat
echo

if [ -f .changeset/config.json ]; then
  echo "CHANGESETS_ENABLED"
else
  echo "CHANGESETS_DISABLED"
fi
