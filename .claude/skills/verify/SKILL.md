---
name: verify
description: Run and report a final local verification pass before handoff, commit, push, merge, or PR. Use when the user asks to verify, test everything, check readiness, or prove local changes are safe to hand off.
---

# Verify

## Preferred Flow

1. Prefer project-native commands when they are obvious (`just verify`,
   `make verify`, `package.json` scripts, `Makefile`/`justfile` targets,
   language-specific quality skills).
2. Otherwise run `scripts/verify.sh`.
3. Report what ran, what was skipped, and what failed.
4. Distinguish environment gaps from real code or test failures.
5. If the repo is polyglot, explain which checks were selected and why.

## Steering

- Do not claim coverage for checks that were skipped or unavailable.
- Keep the report concrete: command, exit code, failure summary.
- Never silently swallow failures -- report every non-zero exit.
- This is a final readiness pass, not a replacement for focused language
  quality skills such as `typescript-quality`, `python-quality`, `go-quality`,
  or `rust-quality`.

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/verify.sh` | Polyglot verify runner (detects languages, runs checks) |
