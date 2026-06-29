---
name: typescript-quality
description: Use to run TypeScript or JavaScript format, lint, type-check, and test commands.
---

# TypeScript Quality

## Preferred Flow

1. Run `scripts/check.sh`.
2. If issues are mechanical (formatting, auto-fixable lint rules), run `scripts/fix.sh`.
3. Re-run `scripts/check.sh` to confirm fixes.
4. When the agent needs language-level design guidance or framework/library-specific docs, LOAD references/idioms.md.

## Tooling Preference

Order the scripts implement (first available package manager wins):

1. `pnpm exec`, then `bun`/`bunx`, then `npx --yes` to run `biome check` and `tsc --noEmit`
2. Globally installed `biome` (and `tsc` if present) when `package.json` exists but no package manager is found
3. If neither is available, the scripts warn and exit 0 (no hard failure) -- fall back to project-native `package.json` scripts or `eslint` manually

## Scripts

| Script | Purpose |
|--------|---------|
| `scripts/check.sh` | Run all checks (biome check, tsc --noEmit) |
| `scripts/fix.sh` | Apply mechanical fixes only (biome check --write) |

`fix.sh` is narrower than `check.sh`: it only applies formatting and
auto-fixable lint rules. Type errors need manual fixes. Re-run `check.sh`
after `fix.sh`.

## References

When making API design decisions or choosing between framework/library alternatives, LOAD references/idioms.md.
