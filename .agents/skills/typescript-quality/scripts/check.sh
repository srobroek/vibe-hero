#!/usr/bin/env bash
set -euo pipefail

if [ ! -f package.json ]; then
  echo "Warning: no package.json found; skipping TypeScript checks." >&2
  exit 0
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm exec biome check . && pnpm exec tsc --noEmit
  exit 0
fi
if command -v bun >/dev/null 2>&1; then
  bunx biome check . && bunx tsc --noEmit
  exit 0
fi
if command -v npx >/dev/null 2>&1; then
  npx --yes biome check . && npx --yes tsc --noEmit
  exit 0
fi

# No package manager available: fall back to globally installed tools.
if command -v biome >/dev/null 2>&1; then
  biome check .
  if command -v tsc >/dev/null 2>&1; then
    tsc --noEmit
  else
    echo "Warning: tsc not found; skipping type check." >&2
  fi
  exit 0
fi

echo "Warning: package.json present but no package manager (pnpm/bun/npx) or global biome found; skipping TypeScript checks." >&2
exit 0
