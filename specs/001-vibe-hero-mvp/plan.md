# Implementation Plan: vibe-hero — Adaptive Learning for Agentic Coding Tools

**Branch**: `001-vibe-hero-mvp` | **Date**: 2026-06-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `specs/001-vibe-hero-mvp/spec.md`

## Summary

vibe-hero is a TypeScript **MCP server** plus portable **Agent Skills** (and a Claude Code Stop hook) that turns everyday agentic-coding tool use into measured, growing competence. The MCP server owns all state and logic — a per-user learner profile, an **Elo-style adaptive assessment** engine with per-(topic × tool) graduation and hysteresis, deterministic grading (with a host-agent handshake for free-form items since MCP sampling is unavailable), a privacy-safe observation intake that only *triggers* offers (never scores), and a GitHub-fetched-and-cached content catalog with a bundled offline fallback. Skills are the portable surface that steers the host agent to call the MCP; the MCP is the enforcement chokepoint (including the first-run setup gate). v1 proves the full loop on Claude Code for ~3–5 topics; the architecture already supports multiple tools and the general/tool-specific content split.

## Technical Context

**Language/Version**: TypeScript (ES2022), Node ≥18 (dev on Node 25)

**Primary Dependencies**: `@modelcontextprotocol/sdk` (stdio MCP server), `zod` (all data modeling + runtime validation; types inferred from schemas). Content fetch via built-in `fetch`. `js-yaml` for YAML content parse (then Zod-validated).

**Storage**: JSON documents under `~/.vibe-hero/` (overridable via `VIBE_HERO_HOME`): `profile.json` (read-write) + `content/` cache. Bundled baseline content snapshot in the package. (SQLite is a deferred optimization, not v1.)

**Testing**: `vitest` — unit (pure Elo math, deterministic grading, hysteresis/dwell, decay), integration (MCP tool round-trips, gate, cadence), and an e2e fixture exercising the full loop incl. the free-form handshake contract.

**Target Platform**: local developer machine; MCP stdio server launched by the host agent. Claude Code v1; Codex/Kiro architecture-ready (skills portable; per-tool hooks/triggers added later).

**Project Type**: monorepo. MCP server in `packages/server`; portable skills + CC hook shipped alongside; curriculum in `content/`.

**Performance Goals**: deterministic grading + status are synchronous and instant (no network, SC-004); content refresh is async with cache + bundled fallback. No throughput target (single-user, interactive).

**Constraints**: offline-capable (bundled content, SC-006); privacy — never persist raw prompts/tool I/O (FR-018/024); no network transmission of user content; curriculum fetch is download-only. MCP **sampling unavailable** in CC/Codex ⇒ free-form grading uses the host-agent handshake.

**Scale/Scope**: one user per profile; small v1 catalog (general + Claude Code, ~3–5 topics proven end-to-end); design supports N tools and the general/tool-specific split.

All Technical Context unknowns are resolved in [research.md](./research.md) (OD-001..005 + observation/correlation + tech choices). No `NEEDS CLARIFICATION` remain.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

The project constitution (`.specify/memory/constitution.md`) is still the unpopulated template — it defines **no enforced principles or gates yet**. Therefore there are no constitutional violations to evaluate, and the gate passes vacuously.

Self-imposed engineering guardrails adopted for this feature (to be ratified into the constitution later):
- **Schema-first**: Zod schemas are the single source of truth; all I/O validated at boundaries.
- **Pure core**: assessment math (Elo, hysteresis, decay, selection) is pure and unit-tested independent of MCP/IO.
- **Privacy by construction**: the profile model has no field for raw user content; observation extracts only derived signals.
- **Portability first**: the user-facing surface is Agent Skills (portable); CC-only mechanisms (hooks, optional subagents) are additive, never on the critical path.

Re-check after Phase 1: **PASS** — design artifacts (data-model, contracts, quickstart) honor all four guardrails; no new complexity requiring justification.

**Post-critique hardening (applied to spec/design before tasks):**
- **E1 / FR-023a**: profile writes are atomic + lock-serialized (concurrent host sessions); `profile/store.ts` owns this.
- **E2 / FR-012-013**: free-form **stays in v1**; anti-gaming via MCP-supplied reference + per-criterion verdict (MCP computes the score); `grading/freeform.ts`.
- **E3 / FR-006**: item difficulty is **fixed/authored**, never self-updates; only user ability moves (`engine/elo.ts`).
- **E4 / FR-018**: observation persists only derived signals; a test asserts no `tool_input`/`tool_output` is ever written (`observation/`).
- **E5**: `now()` is injected into the pure engine; no clock reads inside `engine/`.
- **P4 / FR-020b**: cross-session decline backoff + global mute after N declines (`observation/offers.ts`).

## Project Structure

### Documentation (this feature)

```text
specs/001-vibe-hero-mvp/
├── plan.md              # This file
├── research.md          # Phase 0 — OD-001..005 + tech resolution
├── data-model.md        # Phase 1 — Zod entity model
├── quickstart.md        # Phase 1 — V0–V6 validation scenarios
├── contracts/
│   └── mcp-tools.md     # Phase 1 — MCP tool contract (external interface)
├── checklists/
│   └── requirements.md  # spec quality checklist
└── tasks.md             # Phase 2 — /speckit.tasks (NOT created here)
```

### Source Code (repository root)

```text
packages/server/                 # @vibe-hero/server — the MCP server (TypeScript)
├── src/
│   ├── index.ts                 # stdio MCP server bootstrap + tool registration
│   ├── config.ts                # tunable params (Elo, tiers, hysteresis, decay) — OD-005
│   ├── schemas/                 # Zod schemas (single source of truth)
│   │   ├── content.ts           # Topic, ContentItem, TriggerSignal, CatalogManifest
│   │   ├── profile.ts           # Profile, Config, AbilityEstimate, TierGraduation, ...
│   │   └── tools.ts             # MCP tool input/output schemas (from contracts/)
│   ├── catalog/                 # content load + fetch + cache + bundled fallback
│   │   ├── loader.ts            # YAML → Zod-validated Topic[]
│   │   ├── fetcher.ts           # GitHub fetch + ETag cache (download-only)
│   │   └── bundled/             # baseline catalog snapshot shipped in package
│   ├── profile/                 # profile store (JSON), init/migrate, persistence
│   │   └── store.ts
│   ├── engine/                  # PURE assessment core (unit-tested, no IO)
│   │   ├── elo.ts               # ability update, expected-score
│   │   ├── graduation.ts        # tier thresholds + hysteresis + dwell
│   │   ├── lapse.ts             # staleness + ability decay (review scheduling)
│   │   └── selection.ts         # difficulty-targeted item selection
│   ├── grading/
│   │   ├── deterministic.ts     # MC + short-answer grading (in-engine)
│   │   └── freeform.ts          # host-agent handshake contract (rubric out, verdict in)
│   ├── observation/             # trigger-only; never scores
│   │   ├── source.ts            # ObservationSource interface (+ self-report)
│   │   ├── hookEvents.ts        # PostToolUse/Stop payload → derived signals
│   │   └── offers.ts            # OfferLedger cadence + anti-nag
│   └── tools/                   # one module per MCP tool (thin; calls engine/store/catalog)
├── test/                        # vitest: unit/ integration/ e2e/
└── package.json

content/                         # curriculum (authored, published via GitHub release/raw)
├── general/                     # tool-agnostic topics (one file per topic)
│   └── <topic>.yaml
└── claude-code/                 # v1 populated: ~3–5 topics
    ├── subagents.yaml
    ├── context-management.yaml
    └── planning.yaml

skills/                          # portable Agent Skills (SKILL.md) — the user surface
├── vibe-hero-setup/SKILL.md     # required first-run Q&A → save_config
├── vibe-hero-quiz/SKILL.md      # start_quiz + submit_answer loop (+ free-form judging)
├── vibe-hero-status/SKILL.md    # get_status / get_guidance
└── vibe-hero-learn/SKILL.md     # guidance / what-to-learn-next

hooks/claude-code/               # CC-specific, additive (not on portable critical path)
└── stop-offer.sh                # Stop hook → get_offer → surface end-of-work offer
```

**Structure Decision**: Monorepo with the engine isolated in `packages/server` (per the chosen layout), curriculum in a top-level `content/` (same repo, published independently — FR-025..027), the portable surface in `skills/` (Agent Skills, OD-001), and Claude-Code-only glue in `hooks/claude-code/`. The pure `engine/` is deliberately IO-free so the adaptive math is fully unit-testable and the model-grading handshake lives only in `grading/freeform.ts`.

## Complexity Tracking

No constitution violations (constitution is unpopulated). No deviations requiring justification — the design stays within the schema-first / pure-core / privacy-by-construction / portability-first guardrails. Table intentionally empty.
