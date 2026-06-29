# Changelog

## [1.0.0] - 2026-03-31

### Added

- Initial release of Fix Findings extension
- Automated analyze-fix-reanalyze loop (`/speckit.fix-findings.run`)
- Severity-based finding categorization (Critical, Warning, Info)
- 5-iteration safety limit to prevent infinite loops
- Deferred findings support for ambiguous issues
- Complete audit log generation (`findings.fixed.md`)
