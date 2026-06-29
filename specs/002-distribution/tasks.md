---
description: "Task list for vibe-hero distribution (spec 002)"
---

# Tasks: vibe-hero Distribution — npm + Claude Code Marketplace

**Input**: Design documents from `specs/002-distribution/`

**Prerequisites**: plan.md, spec.md, research.md, data-model.md, contracts/cli-and-plugin.md, quickstart.md

**Tests**: INCLUDED — FR-019a mandates verifying the BUILT/PACKED artifact (bin dispatch, npm-pack contents, offline bundled content) + FR-019 (144 spec-001 tests stay green). vitest for code; CI jobs for pack/staleness.

**Organization**: by user story. US1 = one-gesture install; US2 = CI release; US3 = agent-mediated end-of-work offer. Server code in `packages/server/`; plugin/marketplace at repo root; CI in `.github/workflows/`.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: parallelizable (different files, no incomplete-task deps)
- **[Story]**: US1–US3 for story-phase tasks only

## Path Conventions

Monorepo. npm package = `packages/server/`. Plugin/marketplace = repo root (`apm.yml`, `.claude-plugin/`, `.mcp.json`, `.apm/hooks/`). Hook = `hooks/claude-code/`. CI = `.github/workflows/`.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: prerequisites shared across the publish + plugin work.

- [X] T001 Confirm/record the bootstrap prerequisites doc target (`CONTRIBUTING.md` or `docs/distribution.md`) and add a stub section "Maintainer one-time bootstrap" (org, manual first publish, Trusted Publisher) to be filled in T024 — placeholder only.
- [X] T002 [P] Verify the spec-001 baseline is green before packaging changes: `pnpm install && pnpm --filter @vibe-hero/server build && pnpm --filter @vibe-hero/server test` (record the 144-test baseline; FR-019 guard).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: the publishable-package shape + bin dispatcher that BOTH the npm channel (US1/US2) and the plugin (US1) depend on. **No user story can complete until done.**

**⚠️ CRITICAL**: blocks US1, US2, US3.

- [X] T003 Make `packages/server/package.json` publishable (FR-001): remove `private`; add `license` (Apache-2.0), `repository`, `homepage`, `bugs`, `publishConfig: { access: "public", provenance: true }`, `files: ["dist"]`, and `bin: { "vibe-hero": "dist/cli/index.js" }`. Leave `version` as-is (release-please owns it later).
- [X] T004 Implement the unified bin dispatcher `packages/server/src/cli/index.ts` (FR-002): no-arg/`mcp` → run the server bootstrap `main()` from `../index.js`; `get-offer` → run `./getOffer.js` `main()` (optional utility); unknown → usage to stderr + nonzero exit. Reuse the existing exported `main()`s; routing only, no logic.
- [X] T005 Extend the build to bundle real content (FR-004/019b): update `packages/server/package.json` `copy-assets` (and add `prepublishOnly: "pnpm run build"`) so `tsc` output PLUS a MINIMAL baseline of `content/**` (claude-code + general) is copied into `dist/catalog/bundled/`. Keep the snapshot deliberately small (offline baseline); full catalog comes via runtime fetch.
- [X] T006 [P] Packaging tests `packages/server/test/integration/packaging.test.ts` (FR-019a): assert (a) `vibe-hero` bin dispatches mcp vs get-offer vs unknown; (b) a `pnpm pack`/`npm pack --dry-run` tarball includes `dist/` (incl. bundled content) and EXCLUDES `src/`,`test/`,configs; (c) the built server loads bundled content offline with ≥3 real topics, 0 errors.
- [X] T007 [P] Confirm no spec-001 regression after T003–T005 (FR-018/019): `pnpm --filter @vibe-hero/server build && test` → 144 prior tests still pass; runtime behavior unchanged.

**Checkpoint**: `@vibe-hero/server` is a publishable package with a working `vibe-hero` bin and real offline content; all tests green.

---

## Phase 3: User Story 1 — One-gesture install (Priority: P1) 🎯 MVP

**Goal**: add the vibe-hero marketplace + install the plugin → MCP server (npx), skills, Stop hook, offline content, zero manual config.

**Independent Test**: from a clean Claude Code, add `srobroek/vibe-hero` marketplace + install → MCP tools present, skills present, Stop hook registered, offline quiz works — no config-file edits (quickstart V4; manual e2e for the live install).

- [ ] T008 [US1] Author/modify root `apm.yml` (FR-005/008/009): identity + `marketplace` block (owner, the vibe-hero plugin listed by `source`) + plugin `dependencies.mcp: [{ name: vibe-hero, registry: false, transport: stdio, command: npx, args: ["-y","@vibe-hero/server"] }]` + skills surfaced via the APM skills convention (the four `skills/*`).
- [ ] T009 [US1] Generate the plugin/marketplace artifacts via `apm pack` (OD-001) → committed `.claude-plugin/marketplace.json`, `.claude-plugin/plugin.json`, top-level `.mcp.json` (`mcpServers.vibe-hero` → `npx -y @vibe-hero/server`, floating latest per FR-012). Verify `plugin.json` carries identity + skills path and NO name-only `{name}` deps (standalone plugin has none).
- [ ] T010 [P] [US1] Marketplace/manifest test `packages/server/test/integration/plugin-manifests.test.ts` (or a repo-root check script): assert `.mcp.json` npx shape, `plugin.json` has no `{name}`-only deps, marketplace lists the plugin by source. (Quickstart V4 automated portion.)
- [ ] T011 [US1] Document the install gesture in the distribution doc (T001 target): `apm marketplace add srobroek/vibe-hero` → install plugin → run setup; note offline content works, first server launch needs the npx package cached (FR-019c).

**Checkpoint**: installing the plugin wires MCP + skills + hook with zero manual config (manifests verified).

---

## Phase 4: User Story 3 — Agent-mediated end-of-work offer (Priority: P2)

**Goal**: the Stop hook spawns nothing; it nudges via `additionalContext` and the agent calls `get_offer` on the running server. (Sequenced before US2 because the hook ships inside the plugin US1 builds, and US2 release just packages whatever exists.)

**Independent Test**: run the hook with a synthetic Stop payload → emits the nudge JSON, spawns no process, references no local `dist` (quickstart V5).

- [ ] T012 [US3] Rewrite `hooks/claude-code/stop-offer.sh` to be agent-mediated (FR-011): pure shell, no `npx`/`node`/`get-offer` call; read the Stop payload, honor `stop_hook_active` loop guard, print `{"hookSpecificOutput":{"hookEventName":"Stop","additionalContext":"…call the get_offer MCP tool…"}}`, exit 0 always. Remove the `node dist/cli/getOffer.js` invocation and the `VIBE_HERO_SERVER_DIST` dependency.
- [ ] T013 [US3] Author `.apm/hooks/vibe-hero-claude-hooks.json` (+ byte-identical codex variant if needed) declaring the `Stop` hook `command: ${PLUGIN_ROOT}/scripts/stop-offer.sh` (FR-007, `${PLUGIN_ROOT}` token); regenerate `hooks/hooks.json` via `apm pack` so it auto-registers on install. Ensure the plugin ships `stop-offer.sh` at the path the hook references.
- [ ] T014 [US3] Reinforce end-of-work offering in the quiz skill steering (`skills/vibe-hero-quiz/SKILL.md`) as the backstop for when `additionalContext` can't trigger a follow-up (FR-011 degrade-safe).
- [ ] T015 [P] [US3] Hook test `packages/server/test/integration/stop-hook.test.ts` (or a shell test): feed a synthetic Stop payload → assert the script emits the `additionalContext` JSON, spawns NO subprocess, and exits 0; with `stop_hook_active` set → emits nothing. (Quickstart V5.)
- [ ] T016 [US3] Update `hooks/claude-code/README.md`: auto-registration via the plugin is the norm; manual steps are dev-only; document the agent-mediated flow.

**Checkpoint**: end-of-work offer works in an npx-only install with zero process spawn.

---

## Phase 5: User Story 2 — Maintainer publishes via CI (Priority: P1)

**Goal**: merging the release PR versions + publishes `@vibe-hero/server` to npm (OIDC) + regenerates/commits marketplace artifacts — no manual publish, no token.

**Independent Test**: simulate a release (release-please PR merge) → npm publish via OIDC at the new version + marketplace artifacts updated; token in zero logs (quickstart V6; CI dry-run).

- [ ] T017 [US2] Add `.github/workflows/ci.yml` (FR-015/019/019a): on PR/push — `pnpm install`, build, `pnpm --filter @vibe-hero/server test` (144 green), run the packaging tests (T006/T010), and a **staleness gate** that regenerates the marketplace/plugin/.mcp/hooks artifacts via `apm pack` and fails if committed ≠ regenerated.
- [ ] T018 [US2] Add `.github/workflows/release-please.yml` (FR-013/017): release-please in **single-package mode** (one component, `v{version}` tag, single version source of truth) maintaining the release PR on pushes to `main`.
- [ ] T019 [US2] Add `.github/workflows/release.yml` (FR-013/014/016): triggered on the release-please release/tag — `permissions: id-token: write`; `pnpm build`; `pnpm publish --access public --provenance --no-git-checks` authenticating via **OIDC Trusted Publishers** (NO `NPM_TOKEN`); THEN regenerate + commit the marketplace pointer. Publish-before-marketplace ordering; fail the job (no marketplace advance) if publish fails (FR-016, npm = source of truth, idempotent reconcile on next run).
- [ ] T020 [P] [US2] CI/release validation (quickstart V6/V7, SC-005): a dry-run or inspection check asserting the publish workflow uses OIDC (no `NPM_TOKEN` referenced anywhere), includes `--provenance`, triggers only on the release event, and the staleness gate fails on a hand-edited generated artifact.

**Checkpoint**: a release is fully automated (after the one-time bootstrap), token-free, with a working staleness gate.

---

## Phase 6: Polish & Cross-Cutting

- [ ] T021 [P] Write the maintainer bootstrap doc (T001 target, FR-014a): the exact one-time steps — create `@vibe-hero` org, `pnpm publish` first version manually (logged in, 2FA), configure the Trusted Publisher (repo + `release.yml`); note the bootstrap publish has no provenance (only CI publishes do — critique E6).
- [ ] T022 [P] Document the rollback procedure (FR-012a/017a): `npm deprecate` a bad version and/or move the `latest` dist-tag to last-good + publish a fixed patch; note floating-`latest` users pick up the fix on next resolution.
- [ ] T023 [P] Document the agentic-packages cross-publish as a FAST-FOLLOW (FR-009, OD-004): the direct remote-git `source: srobroek/vibe-hero` + `ref:` marketplace entry, gated on the agentic-packages local-generator refactor preserving external-source entries. Do NOT implement here.
- [ ] T024 Final verification pass: run quickstart V1–V8 (V1–V3 package, V4 plugin manifests, V5 hook, V6 release inspection, V7 staleness, V8 144-test regression); fix gaps. Confirm `pnpm --filter @vibe-hero/server test` green + build clean.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks all stories** (publishable package + bin + bundled content are the substrate).
- **US1 (P3)** → after Foundational (needs the package + bin to declare the npx `.mcp.json`).
- **US3 (P4)** → after US1 (the hook + its manifest ship inside the US1 plugin; sequence US3 before US2 so the release packages the finished hook).
- **US2 (P5)** → after US1 + US3 (release packages/publishes whatever the plugin + package contain; the staleness gate needs the generated artifacts from US1/US3 to exist).
- **Polish (P6)** → after the desired stories.

### MVP scope

**Setup + Foundational + US1 + US2** = installable AND releasable: a user can add the marketplace and install (US1), and the maintainer can ship updates via CI (US2). US3 (agent-mediated offer) is P2 but small and ships in the same plugin. The one-time maintainer bootstrap (org + manual first publish + Trusted Publisher) is a prerequisite to the FIRST real CI release, documented in Polish.

### Parallel opportunities

- Setup: T002 ∥ T001.
- Foundational: T006 ∥ T007 (after T003–T005).
- US1: T010 ∥ T011 (after T008/T009).
- US3: T015 ∥ T016 (after T012/T013).
- US2: T020 ∥ (after T017–T019).
- Polish: T021 ∥ T022 ∥ T023 (docs), then T024.

---

## Parallel Example: Foundational verification

```text
Task: "packaging.test.ts — bin dispatch + pack contents + offline content"  # T006
Task: "confirm 144 spec-001 tests still pass after package.json/build changes" # T007
```

## Implementation Strategy

1. **Setup + Foundational** → publishable package + `vibe-hero` bin + bundled content; tests green.
2. **US1** → APM plugin + generated manifests (`.mcp.json` npx, marketplace, plugin.json); install wiring verified. **STOP & VALIDATE** (V1–V4).
3. **US3** → agent-mediated Stop hook + auto-register manifest. **VALIDATE** (V5).
4. **US2** → CI: ci.yml (tests + staleness), release-please (version), release.yml (OIDC publish, atomic). **VALIDATE** (V6/V7) via dry-run.
5. **Polish** → bootstrap doc, rollback doc, cross-publish fast-follow doc; full quickstart pass (V1–V8).
6. **Out-of-band (maintainer)**: create org → manual first publish → configure Trusted Publisher → first CI release.

## Notes

- Floating `latest` in `.mcp.json` is intentional (auto-distribute; users may pin) — FR-012.
- Stop hook spawns NOTHING (agent-mediated) — FR-011.
- OIDC Trusted Publishers only; no `NPM_TOKEN` anywhere — FR-014.
- npm is the source of truth; marketplace is a derived, idempotently-reconciled pointer — FR-016.
- No spec-001 behavior change; 144 tests stay green — FR-018/019.
- Cross-publish to agentic-packages is documented-only here (fast-follow) — FR-009/OD-004.
- Commit after each task or logical group; the repo signs commits (use the established unsigned-commit path if `op-ssh-sign` fails in this env).
