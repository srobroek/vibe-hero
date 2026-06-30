# Implementation Plan: vibe-hero Distribution — npm + Claude Code Marketplace

**Branch**: `002-distribution` | **Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/002-distribution/spec.md`

## Summary

Package and ship the spec-001 MVP. Two channels: (1) publish the MCP server to npm as a scoped public package `@vibe-hero/server` with one `vibe-hero` bin (default → MCP stdio server; `get-offer` → Stop-hook query) that bundles the real curriculum for offline use; (2) a single Claude Code plugin — sourced from this repo's root APM marketplace and cross-listed in `agentic-packages` by reference — that bundles the four skills, the auto-registered Stop hook, and an `.mcp.json` that npx-launches the published server. Releases are automated via release-please + an OIDC Trusted-Publisher publish workflow (no long-lived npm token), with a PR staleness gate on generated artifacts. No spec-001 runtime behavior changes.

## Technical Context

**Language/Version**: TypeScript (existing `packages/server`, strict, ESM/NodeNext), Node ≥18, pnpm.

**Primary Dependencies**: no new runtime deps — `@modelcontextprotocol/sdk`, `zod`, `js-yaml` already present; the plugin launches the server via `npx` (the published npm package). CI adds release-please + npm publish (OIDC) GitHub Actions.

**Testing**: existing `vitest` suite (144 tests) MUST stay green (FR-019); add packaging-level checks — `npm pack` content assertion, CLI-dispatch test, offline-bundled-content load, and an artifact staleness gate in CI.

**Target Platform**: developer machines running Claude Code (architecture-ready for Codex/Kiro). Server runs via npx; plugin installs from a Claude Code marketplace. Public npm registry.

**Project Type**: distribution/packaging of an existing monorepo package — npm publish + Claude Code plugin/marketplace + CI/CD. Not a new runtime component.

**Performance Goals**: install is one gesture (SC-001); server launch via npx with no local build (SC-002); offline quizzes work from bundled content (SC-003). No throughput target.

**Constraints**: no `NPM_TOKEN` secret — OIDC Trusted Publishers only (FR-014); floating-`latest` npx pin (FR-012); `${PLUGIN_ROOT}` hook token (the variable Claude Code substitutes in hook commands); one-time manual bootstrap publish (FR-014a); publish-before-marketplace atomic ordering (FR-016); no spec-001 behavior change (FR-018) and 0 test regressions (FR-019).

**Scale/Scope**: ONE plugin + ONE npm package (not a monorepo of packages) — so plain `apm pack` suffices, no ported Python generator (OD-001).

All Technical Context unknowns are resolved in [research.md](./research.md) (OD-001/004/005 + bin/content/plugin/hook/release mechanics). No `NEEDS CLARIFICATION` remain.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is still the unpopulated template — no enforced principles/gates — so the gate passes vacuously, as in spec 001.

Self-imposed guardrails carried from 001 + distribution-specific:
- **No runtime behavior change**: 002 only packages/launches 001; the server's tools/gate/grading/privacy are untouched (FR-018), enforced by keeping all 144 tests green (FR-019).
- **No long-lived secrets**: OIDC Trusted Publishers, never an `NPM_TOKEN` (FR-014).
- **Generated-not-hand-authored manifests**: marketplace/plugin/.mcp/hook manifests come from `apm pack`/generator and are staleness-gated (FR-010/015).
- **Single version source of truth**: release-please owns the version across npm + marketplace (FR-017).

Re-check after Phase 1: **PASS** — design artifacts (data-model, contracts, quickstart) honor all four; no new complexity needing justification.

## Project Structure

### Documentation (this feature)

```text
specs/002-distribution/
├── plan.md              # This file
├── research.md          # Phase 0 — OD-001/004/005 + mechanics resolved
├── data-model.md        # Phase 1 — packaging/release artifact manifests
├── quickstart.md        # Phase 1 — V1–V8 validation scenarios
├── contracts/
│   └── cli-and-plugin.md # Phase 1 — npm CLI + plugin install contract
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 — /speckit.tasks (NOT created here)
```

### Source Code / artifacts (repository root)

```text
packages/server/
├── package.json                 # MODIFIED: drop private; add bin/files/license/repository/publishConfig; build copies real content
├── src/
│   ├── cli/
│   │   ├── index.ts             # NEW: unified `vibe-hero` bin dispatcher (mcp | get-offer | usage)
│   │   └── getOffer.ts          # existing get-offer CLI (reused by dispatcher)
│   └── index.ts                 # existing server bootstrap (reused by dispatcher)
└── test/integration/packaging.test.ts   # NEW: bin dispatch + npm-pack content + offline bundled content

apm.yml                          # NEW/MODIFIED at repo root: marketplace block + plugin + dependencies.mcp (npx)
.claude-plugin/
├── marketplace.json             # NEW (generated): lists the vibe-hero plugin by source
└── plugin.json                  # NEW (generated): plugin identity + skills path
.mcp.json                        # NEW (generated): mcpServers.vibe-hero -> npx -y @vibe-hero/server
.apm/hooks/vibe-hero-claude-hooks.json  # NEW: Stop hook (${PLUGIN_ROOT}) -> generated hooks/hooks.json
hooks/claude-code/
├── stop-offer.sh                # MODIFIED: invoke `npx -y @vibe-hero/server get-offer` + keep VIBE_HERO_SERVER_DIST local override
└── README.md                    # MODIFIED: auto-registration via plugin; manual steps become dev-only
.github/workflows/
├── ci.yml                       # NEW: PR build + 144 tests + artifact staleness gate
├── release-please.yml           # NEW: release PR + version (single source of truth)
└── release.yml                  # NEW: on release -> pnpm build + publish (OIDC, provenance) + regenerate/commit marketplace; atomic ordering
CONTRIBUTING.md (or docs/)       # NEW/MODIFIED: document one-time maintainer bootstrap (org, manual first publish, Trusted Publisher)
```

**Structure Decision**: Keep everything in this repo (marketplace at root), reusing the existing `packages/server`. Add a thin `cli/index.ts` dispatcher (not two bins, per FR-002), extend the existing `copy-assets` build step to bundle real content, declare the plugin via APM (`apm.yml` + `.apm/hooks` + generated `.mcp.json`/`plugin.json`/`marketplace.json`), and rewire the Stop hook to the published `npx` CLI. CI is release-please-gated with OIDC publish. The agentic-packages cross-listing is a reference entry there, not a copy (OD-004).

## Complexity Tracking

No constitution violations (constitution unpopulated). No deviations needing justification. The one notable simplification vs the sibling repo — NOT porting `build-native-plugins.py` — reduces complexity (a single plugin needs only `apm pack`) and avoids inheriting the name-only-dependency bug. Table intentionally empty.
