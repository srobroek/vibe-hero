# QA Testing Extension for Spec Kit

Systematic QA testing with browser-driven or CLI-based validation of acceptance criteria from the spec.

## Installation

```bash
specify extension add qa --from https://github.com/arunt14/spec-kit-qa/archive/refs/tags/v1.0.0.zip
```

## Usage

```bash
/speckit.qa.run [focus area or test mode]
```

## What It Does

- Runs systematic QA testing against the running application
- **Browser QA** mode: navigates routes, fills forms, validates UI states, takes screenshots
- **CLI QA** mode: runs test suites, validates API endpoints, checks build output
- Validates acceptance criteria from `spec.md` against actual behavior
- Generates QA report in `FEATURE_DIR/qa/`
- Provides verdicts: ✅ ALL PASSED / ⚠️ PARTIAL PASS / ❌ FAILURES FOUND

## QA Report

Reports are generated at `FEATURE_DIR/qa/qa-{timestamp}.md` using `commands/qa-template.md`.

## Workflow Position

```
/speckit.implement → /speckit.qa.run → /speckit.ship
```

## Hook

This extension hooks into `after_implement` — you'll be prompted to run QA after implementation completes.

## License

MIT
