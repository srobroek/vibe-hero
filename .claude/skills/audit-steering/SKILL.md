---
name: audit-steering
description: Audit agent rules, hooks, skills, and guardrails for drift, duplication, stale files, and token waste. Use when asked to audit agent config, review steering health, or clean up hooks and rules.
---

# Steering Audit

Use this skill to review and improve agent configuration surfaces.

## Checks

1. **Lint scan**: Run `agnix --show-fixes` on config directories. Categorize findings as real errors, false positives, or auto-fixable.
2. **Hook efficiency**: Count hooks per event type. Flag unconditional Bash hooks, duplicate references, prompt-type hooks doing pure string checks.
3. **Duplication scan**: Cross-reference CLAUDE.md, rules, hooks, and skills. Flag policies stated in 2+ places, and rules that hooks enforce mechanically.
4. **Stale file detection**: Empty rule files, unreferenced agent files, outdated memory entries, empty directories.
5. **Token budget**: Identify always-loaded rules without glob scoping. Flag files exceeding 5KB. Suggest lazy-loading candidates.

## Output Format

- Summary line: X errors, Y warnings, Z suggestions
- Section per check with findings (file, severity, description, fix)
- Priority actions sorted by impact
- No prose filler

## Steering

- Prefer enforceable automation for mechanical policy.
- Prefer short guidance for judgment-heavy policy.
- Focus findings on real drift, not stylistic preferences.

## References

- For the full audit pass, LOAD references/checklist.md
