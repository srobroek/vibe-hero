# Fix Findings — Spec Kit Extension

Automated analyze-fix-reanalyze loop for [Spec Kit](https://github.com/github/spec-kit) projects. Runs `/speckit.analyze`, reads findings, applies fixes, and re-analyzes until all issues are resolved — no manual intervention required between iterations.

Addresses [github/spec-kit#2011](https://github.com/github/spec-kit/issues/2011).

## Features

- **Automated loop**: Analyze → fix → re-analyze until clean
- **Severity-based prioritization**: Critical findings fixed first, then warnings
- **Safety limits**: Maximum 5 iterations to prevent infinite loops
- **Spec-safe**: Never modifies spec artifacts — only fixes implementation code
- **Deferred findings**: Ambiguous issues logged for human follow-up
- **Full audit log**: Every iteration, fix, and deferral recorded in `findings.fixed.md`

## Installation

```bash
# Install from catalog
specify extension add fix-findings

# Or install from GitHub archive
specify extension add fix-findings --from \
  https://github.com/Quratulain-bilal/spec-kit-fix-findings/archive/refs/tags/v1.0.0.zip
```

## Usage

```bash
# Run the fix-findings loop
/speckit.fix-findings.run

# Or use the alias
/speckit.fix-findings

# With constraints
/speckit.fix-findings.run only fix critical issues
```

### Prerequisites

Before running, ensure you have completed:

1. `/speckit.specify` — spec.md exists
2. `/speckit.plan` — plan.md exists
3. `/speckit.tasks` — tasks.md exists
4. Implementation is complete or in progress

### Output Files

| File | Description |
|------|-------------|
| `specs/{branch}/analysis.md` | Latest analysis results (updated each iteration) |
| `specs/{branch}/findings.fixed.md` | Complete log of all iterations and fixes |

### Example Output

```
Fix Findings Complete
====================
Iterations:  3
Resolved:    12 findings
Deferred:    2 findings
Status:      DEFERRED_REMAINING

Log saved to: specs/001-my-feature/findings.fixed.md
```

## How It Works

1. **Initial analysis**: Runs `/speckit.analyze` if `analysis.md` doesn't exist
2. **Parse findings**: Extracts issues categorized as Critical, Warning, or Info
3. **Apply fixes**: Addresses each actionable finding (Critical first)
4. **Re-analyze**: Generates fresh analysis to verify fixes
5. **Loop**: Repeats until clean, no new fixes possible, or 5 iterations reached
6. **Log**: Saves complete audit trail to `findings.fixed.md`

## Constraints

- All fixes must align with `spec.md` and `plan.md`
- Spec artifacts are never modified
- Ambiguous findings are deferred for human decision
- Maximum 5 iterations (safety limit)

## License

MIT License — see [LICENSE](LICENSE)

## Support

- **Issues**: https://github.com/Quratulain-bilal/spec-kit-fix-findings/issues
- **Spec Kit**: https://github.com/github/spec-kit
