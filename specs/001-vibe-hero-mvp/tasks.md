---
description: "Task list for vibe-hero MVP (spec 001)"
---

# Tasks: vibe-hero — Adaptive Learning for Agentic Coding Tools

**Input**: Design documents from `specs/001-vibe-hero-mvp/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/mcp-tools.md, quickstart.md

**Tests**: INCLUDED — the spec mandates them (FR-018 redaction test, deterministic-grade reproducibility SC-004, quickstart V0–V6) and the stack is `vitest`. Pure-engine math and grading are unit-tested; MCP tools are integration-tested.

**Organization**: by user story. All code under `packages/server/` unless noted. Content under `content/`, skills under `skills/`, hooks under `hooks/claude-code/`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task deps)
- **[Story]**: US0–US5 for story-phase tasks only

## Path Conventions

Monorepo: MCP server in `packages/server/src/`, tests in `packages/server/test/`. Skills in `skills/`, content in `content/`, CC hook in `hooks/claude-code/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: TypeScript MCP-server project initialization.

- [X] T001 Create `packages/server/` TypeScript project (package.json `@vibe-hero/server`, `tsconfig.json` strict ES2022, `src/` + `test/`) per plan.md structure
- [X] T002 Add dependencies: `@modelcontextprotocol/sdk`, `zod`, `js-yaml`, `proper-lockfile`; dev: `vitest`, `typescript`, `@types/node`, `@types/js-yaml` (pnpm)
- [X] T003 [P] Configure `vitest.config.ts` (unit/integration/e2e projects) and `package.json` scripts (`build`, `test`, `start`)
- [X] T004 [P] Create top-level `content/general/` and `content/claude-code/` dirs and `skills/` + `hooks/claude-code/` dirs with `.gitkeep`

**Checkpoint**: project builds and `pnpm --filter @vibe-hero/server test` runs (no tests yet).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: schemas, config, stores, pure engine math, catalog load, MCP bootstrap, observation abstraction. **No user story can proceed until done.**

**⚠️ CRITICAL**: blocks all user stories.

### Schemas (Zod — single source of truth, data-model.md)

- [X] T005 [P] Define identifier/enum schemas (`ToolId`, `ContentClass`, `Tier`, `BloomLevel`, `QuestionType`, `Grade`, `AbilityKey` codec) in `packages/server/src/schemas/common.ts`
- [X] T006 [P] Define content schemas (`Topic`, `ContentItem`, `Choice`, `AnswerKey`, `Rubric` with `criteria:{id,text}[]`, `TriggerSignal`, `CatalogManifest`) + cross-field validation rules (FR-003/003a/004) in `packages/server/src/schemas/content.ts`
- [X] T007 [P] Define profile schemas (`Profile`, `Config`, `AbilityEstimate`, `TierGraduation`, `ReviewEntry`, `QuizRecord`, `AnsweredItem`, `OfferLedger` incl. cross-session backoff fields, `ObservationEvent`) in `packages/server/src/schemas/profile.ts`
- [X] T008 [P] Define MCP tool I/O schemas (one per contract tool, incl. `SETUP_REQUIRED` sentinel + per-criterion free-form verdict) in `packages/server/src/schemas/tools.ts`

### Tunable config + pure engine (research.md OD-005; engine is IO-free, clock injected — E5)

- [X] T009 [P] Create tunable assessment config (S=400, θ₀=300, K 64→24 @15 items, tiers/boundaries, hysteresis ±30, dwell 2, decay H=60d, stale 30d, selection windows, **decline-mute N=3 + backoff curve**, free-form `passThreshold=0.6`, default `quizLength=4`) in `packages/server/src/config.ts`
- [X] T010 [P] Implement pure Elo ability update (`expectedScore`, `updateAbility` against FIXED item rating — items never self-update, FR-006/E3; partial-credit score∈[0,1]) in `packages/server/src/engine/elo.ts`
- [X] T011 [P] Implement difficulty-targeted item selection (target `min(θ+50,nextBoundary+30)`, ±60 window, one ±20 anchor, info-weighted, avoid recent `lastItemIds`) in `packages/server/src/engine/selection.ts`
- [X] T012 [P] Unit tests for `elo.ts` + `selection.ts` (monotonicity, fixed-difficulty invariant, window/anchor selection, determinism) in `packages/server/test/unit/engine.test.ts`

### Profile store (atomic + locked — E1/FR-023a)

- [X] T013 [US-shared] Implement profile store: load/validate/init-empty (FR-023), **atomic write-temp+rename under advisory lock** (`proper-lockfile`), `VIBE_HERO_HOME` override, in `packages/server/src/profile/store.ts`
- [X] T014 [P] Integration test: concurrent writers do not lose updates; corrupt/missing profile re-initializes cleanly, in `packages/server/test/integration/store.test.ts`

### Catalog (load + bundled; fetch/cache deferred to US5)

- [X] T015 [P] Implement YAML catalog loader → Zod-validated `Topic[]` with path-qualified diagnostics on malformed items (FR-004), in `packages/server/src/catalog/loader.ts`
- [X] T016 [P] Create bundled baseline catalog snapshot scaffold + loader wiring (`packages/server/src/catalog/bundled/`) so the server works offline first-run (FR-025)

### Observation abstraction (trigger-only; privacy boundary — E4/FR-018)

- [X] T017 [P] Define `ObservationSource` interface + self-report source (FR-016) in `packages/server/src/observation/source.ts`
- [X] T018 [P] Implement hook-payload → derived-signal extractor that emits ONLY `{tool_name, topicKeys, success, timestamp, tool_use_id}` and NEVER `tool_input`/`tool_output` (FR-018) in `packages/server/src/observation/hookEvents.ts`
- [X] T019 [P] Privacy test: feed a hook payload containing secrets in `tool_input`/`tool_output`; assert no raw payload field is ever persisted/returned (FR-018, SC-008) in `packages/server/test/unit/privacy.test.ts`

### MCP server bootstrap + gate

- [X] T020 Implement stdio MCP server bootstrap + tool registration scaffold in `packages/server/src/index.ts` (depends on T008)
- [X] T021 Implement the `SETUP_REQUIRED` gate middleware (every tool except `get_config`/`save_config` returns the sentinel when `profile.config` absent — FR-032, gates vibe-hero actions only) in `packages/server/src/tools/gate.ts`

**Checkpoint**: server starts, schemas validate, engine math + store + privacy tests green. User stories can begin.

---

## Phase 3: User Story 0 - First-run setup (required, skill-driven) (Priority: P1) 🎯 MVP

**Goal**: missing config routes the user into a setup Q&A; nothing else proceeds until it completes once.

**Independent Test**: empty `VIBE_HERO_HOME` → any tool returns `SETUP_REQUIRED`; `save_config` → tools proceed; re-run skips setup (quickstart V0).

- [ ] T022 [US0] Implement `save_config` + `get_config` tools (persist/read `Config`, clear gate, re-runnable without wiping progress — FR-031/033) in `packages/server/src/tools/config.ts`
- [ ] T023 [US0] Author portable `vibe-hero-setup` skill (SKILL.md) — interactive Q&A (tools learning, offer cadence per/​session vs per/​topic vs off, proactive on/off, quiz length) → calls `save_config`, in `skills/vibe-hero-setup/SKILL.md`
- [ ] T024 [P] [US0] Integration test V0: gate→setup→cleared, re-run skips, reconfigure preserves progress, in `packages/server/test/integration/us0-setup.test.ts`

**Checkpoint**: first-run gate works end-to-end; config persisted.

---

## Phase 4: User Story 2 - Check standing & get guidance (Priority: P1)

**Goal**: per-tool status, weak/stale highlights, what-to-learn-next, on-demand quiz/guidance — works with zero telemetry (SC-011).

**Independent Test**: with a seeded profile, `get_status`/`get_guidance` return per-tool standing and recommendations; on-demand quiz works without any observation (quickstart V1 pull path).

- [ ] T025 [P] [US2] Implement `get_status` tool (per-(topic×tool) tier/status/ability, due-for-review, suggestions) in `packages/server/src/tools/status.ts`
- [ ] T026 [P] [US2] Implement `list_topics` tool (catalog enumeration + version) in `packages/server/src/tools/listTopics.ts`
- [ ] T027 [P] [US2] Implement `get_guidance` tool (teaching text + next-step; weakest/stale pick when no key) in `packages/server/src/tools/guidance.ts`
- [ ] T028 [US2] Author portable `vibe-hero-status` + `vibe-hero-learn` skills (SKILL.md) driving status/guidance, in `skills/vibe-hero-status/SKILL.md` and `skills/vibe-hero-learn/SKILL.md`
- [ ] T029 [P] [US2] Integration test: status/guidance scoped per tool, weak/stale surfaced, telemetry-free path works, in `packages/server/test/integration/us2-status.test.ts`

**Checkpoint**: pull-based status/guidance fully functional with no telemetry.

---

## Phase 5: User Story 1 - Knowledge check after a teachable moment (Priority: P1) 🎯 core loop

**Goal**: end-of-work, non-interrupting offer when a topic was exercised → quiz → deterministic grade → ability updates. Usage never scores.

**Independent Test**: simulate a session exercising a topic → offer surfaces only at end-of-work → accept → answer → graded → ability moves; usage-without-quiz changes nothing (quickstart V1/V2/V3).

### Quiz + deterministic grading

- [ ] T030 [P] [US1] Implement deterministic grading (MC exact, short-answer keyword/normalize) — reproducible (SC-004) in `packages/server/src/grading/deterministic.ts`
- [ ] T031 [US1] Implement `start_quiz` tool (select 3–5 items via `engine/selection`, return `PresentedItem`s WITHOUT answer keys; create `QuizRecord`) in `packages/server/src/tools/startQuiz.ts` (depends on T011, T013, T015)
- [ ] T032 [US1] Implement `submit_answer` tool (deterministic path): grade → `engine/elo` ability update → persist derived `Grade` only (no raw text, FR-018) → return guidance + ability before/after, in `packages/server/src/tools/submitAnswer.ts` (depends on T030, T010, T013)
- [ ] T033 [P] [US1] Author portable `vibe-hero-quiz` skill (SKILL.md) — runs the start_quiz→present→submit_answer loop, in `skills/vibe-hero-quiz/SKILL.md`

### Observation → offer (trigger-only) + non-interrupting delivery

- [ ] T034 [US1] Implement `record_observation` tool: match derived signals to topics via `TriggerSignal`, produce offer candidates, award NOTHING (FR-005/SC-003); accept `toolUseId` for correlation. **Scope note (analyze C2):** v1 ships the single real-time hook source only; two-source transcript-backfill correlation by `tool_use_id` (FR-017) is architecture-ready via `ObservationSource` (FR-016) and NOT built in v1. In `packages/server/src/tools/recordObservation.ts` (depends on T017/T018, T015)
- [ ] T035 [US1] Implement offer engine + `OfferLedger` (cadence per-session/per-topic/off FR-020a; within-session decline suppression; **cross-session backoff + global mute** FR-020b) in `packages/server/src/observation/offers.ts`
- [ ] T036 [US1] Implement `get_offer` + `record_offer_response` tools (resolve/suppress offer; record accept/decline/defer) in `packages/server/src/tools/offers.ts` (depends on T035)
- [ ] T037 [US1] Author Claude Code **Stop hook** (thin shell → `get_offer` → surface end-of-work offer; all logic in MCP — E7) in `hooks/claude-code/stop-offer.sh` + document install
- [ ] T038 [P] [US1] Integration tests V2/V3: usage-without-quiz scores nothing; offers only at end-of-work; cadence + within/cross-session suppression honored, in `packages/server/test/integration/us1-offers.test.ts`
- [ ] T039 [P] [US1] e2e test V1: exercise topic → offer → accept → deterministic quiz → ability rises; identical answer ⇒ identical grade, in `packages/server/test/e2e/loop.test.ts`

### v1 Claude Code content (≥3 topics — SC-009)

- [ ] T040 [P] [US1] Author `content/claude-code/subagents.yaml` (tiers 100–500, trigger signals, deterministic items + difficulty tags)
- [ ] T041 [P] [US1] Author `content/claude-code/context-management.yaml` (same shape)
- [ ] T042 [P] [US1] Author `content/claude-code/planning.yaml` (same shape)

**Checkpoint**: the core adaptive loop runs end-to-end on real Claude Code content (ability moves; not yet graduating tiers).

---

## Phase 6: User Story 3 - Earn a tier (graduation) (Priority: P2)

**Goal**: ability crossing a tier threshold (by margin + dwell) graduates per-(topic×tool); lapse surfaces review.

**Independent Test**: feed graded sequences → graduate only on `boundary+30` for 2 consecutive items; demote/review only below `boundary−30`; no flip-flop in the band (quickstart V1 graduation + SC-014).

- [ ] T043 [P] [US3] Implement graduation logic (tier thresholds + **hysteresis band ±30 + dwell 2**, FR-008) in `packages/server/src/engine/graduation.ts`
- [ ] T044 [P] [US3] Implement lapse model (staleness ≥30d + exponential ability decay H=60d → due-for-review, FR-009/010, OD-003) in `packages/server/src/engine/lapse.ts`
- [ ] T045 [P] [US3] Unit tests: hysteresis prevents flip-flop (SC-014), dwell blocks single-fluke, decay triggers review at the right boundary, in `packages/server/test/unit/graduation.test.ts`
- [ ] T046 [US3] Wire graduation + lapse into `submit_answer`/`get_status`; **own all `reviewSchedule` writes** — on graduation enqueue a proactive `ReviewEntry{reason:"spaced"}` (FR-010), and on decay/staleness enqueue `{reason:"lapsed"}` (FR-009); emit `graduation.changed`, set `due_for_review`, and surface the schedule in `get_status` — extends T032/T025, in `packages/server/src/tools/submitAnswer.ts` & `status.ts`
- [ ] T047 [P] [US3] Integration test: independent graduation state per tool for the same general concept (SC-010), in `packages/server/test/integration/us3-graduation.test.ts`

**Checkpoint**: full loop incl. graduation + review on Claude Code content — satisfies the MVP success criterion.

---

## Phase 7: User Story 4 - Free-form depth questions judged fairly (Priority: P3)

**Goal**: free-form items judged via host-agent handshake with anti-gaming (MCP-supplied reference + per-criterion verdict; MCP computes score).

**Independent Test**: free-form item → `start_quiz` returns rubric+reference → host returns per-criterion verdict → `submit_answer` records score like a deterministic grade; degrade gracefully if judging unavailable (quickstart V4).

- [ ] T048 [US4] Implement free-form handshake in grading (`start_quiz` includes `rubric`+`referenceAnswer` for free-form; `submit_answer` accepts **per-criterion verdict**, MCP computes score vs `passThreshold`; reject bare-boolean — E2/FR-012/013) in `packages/server/src/grading/freeform.ts` + extend `startQuiz.ts`/`submitAnswer.ts`
- [ ] T049 [US4] Implement graceful degradation when free-form judging unavailable (defer/substitute deterministic item — FR-014) in `packages/server/src/tools/startQuiz.ts`
- [ ] T050 [P] [US4] Update `vibe-hero-quiz` skill with strict per-criterion judging instructions (steering mandates rubric-based justification) in `skills/vibe-hero-quiz/SKILL.md`
- [ ] T051 [P] [US4] Integration test V4: per-criterion verdict scored correctly; bare-boolean rejected; degradation path, in `packages/server/test/integration/us4-freeform.test.ts`
- [ ] T052 [P] [US4] Add ≥1 free-form item (tier 400/500) to a Claude Code content file with rubric criteria + reference answer

**Checkpoint**: free-form judging works end-to-end without MCP sampling.

---

## Phase 8: User Story 5 - Works offline and stays fresh (Priority: P3)

**Goal**: bundled content works offline; connected users get latest published catalog; unreachable source falls back silently.

**Independent Test**: no network → bundled quizzes succeed; newer published catalog → fetched+cached+served; unreachable → cached/bundled, no user-facing error (quickstart V5).

- [ ] T053 [US5] Implement GitHub catalog fetcher (download-only) + local cache with version/ETag under `~/.vibe-hero/content/`, periodic refresh (FR-026), in `packages/server/src/catalog/fetcher.ts`
- [ ] T054 [US5] Wire resolution order fetch→cache→bundled with **Zod validation of fetched content before cache** and silent fallback on unreachable/invalid source (FR-027, E8), extending `catalog/loader.ts`
- [ ] T055 [P] [US5] Integration test V5: offline serves bundled (SC-006); update picked up (SC-007); unreachable/malformed → fallback, no error, in `packages/server/test/integration/us5-content.test.ts`

**Checkpoint**: content delivery resilient + updatable independent of releases.

---

## Phase 9: Polish & Cross-Cutting Concerns

- [ ] T056 [P] Schema-version/migration policy for profile + content (reject unknown major, migrate minor — E6) in `packages/server/src/profile/migrate.ts` + `catalog/loader.ts`
- [ ] T057 [P] Author `packages/server/README.md` (install, `VIBE_HERO_HOME`, host wiring for MCP + skills + Stop hook) and a root usage doc in `docs/`
- [ ] T058 [P] Author `content/general/` seed topic(s) (≥1 tool-agnostic topic) to exercise the general class
- [ ] T059 Run full `quickstart.md` V0–V6 validation pass; fix gaps
- [ ] T060 [P] Final unit-coverage sweep for engine/grading + `pnpm test` green; tidy exports

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks all stories**.
- **US0 (P3)** → after Foundational. Gate prerequisite for real use.
- **US2 (P4)** → after Foundational; independent of US1.
- **US1 (P5)** → after Foundational; uses engine/store/catalog. Independent of US2/US3 (ability moves without graduation).
- **US3 (P6)** → after US1 (extends `submit_answer`/`get_status`).
- **US4 (P7)** → after US1 (extends quiz/grading).
- **US5 (P8)** → after Foundational (extends catalog); independent of US1/US3/US4.
- **Polish (P9)** → after desired stories.

### MVP scope

**US0 + US2 + US1 + US3** = the full adaptive loop on Claude Code (detect → offer → grade → update per-tool profile → graduate → guide) over ≥3 real topics. This satisfies SC-009 and is the headline MVP. US4 (free-form) and US5 (remote content) are P3 increments.

### Parallel opportunities

- Setup: T003, T004 parallel.
- Foundational: schemas T005–T008 parallel; engine T009–T012 parallel; store T013/T014, catalog T015/T016, observation T017–T019 parallel across groups.
- US1 content authoring T040–T042 fully parallel; tests T038/T039 parallel.
- US3 engine T043/T044/T045 parallel; US4/US5 tests parallel.
- After Foundational, US2 / US1 / US5 can proceed by different developers concurrently.

---

## Parallel Example: Foundational schemas

```text
Task: "Define common enums in src/schemas/common.ts"        # T005
Task: "Define content schemas in src/schemas/content.ts"    # T006
Task: "Define profile schemas in src/schemas/profile.ts"    # T007
Task: "Define MCP tool I/O schemas in src/schemas/tools.ts" # T008
```

## Implementation Strategy

1. **Setup + Foundational** → server boots, engine/store/privacy tests green.
2. **US0** → first-run gate (everything else gated on config).
3. **US2** → pull-based status/guidance (telemetry-free value immediately).
4. **US1** → the core teachable-moment loop + real Claude Code content. **STOP & VALIDATE** (V1/V2/V3).
5. **US3** → graduation/lapse → MVP complete (full loop). **STOP & VALIDATE** (SC-009/010/014).
6. **US4, US5** → free-form depth + remote content as P3 increments.
7. **Polish** → migration, docs, full quickstart pass.

## Notes

- [P] = different files, no incomplete-task deps.
- Pure `engine/` functions take an injected `now()` — never read the clock inside the engine (E5).
- Items carry FIXED difficulty; only user ability moves (E3).
- Profile writes are atomic + locked (E1).
- Observation persists derived signals only — never `tool_input`/`tool_output` (E4).
- Commit after each task or logical group; validate at each checkpoint.
