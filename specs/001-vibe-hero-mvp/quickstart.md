# Quickstart / Validation Guide: vibe-hero MVP

How to prove the MVP works end-to-end. References `contracts/mcp-tools.md` and `data-model.md` for shapes; does not duplicate them.

## Prerequisites

- Node ≥18, pnpm.
- Repo built: `pnpm install && pnpm --filter @vibe-hero/server build` (from repo root).
- A clean profile dir for testing: point `VIBE_HERO_HOME` at a temp dir so tests never touch a real `~/.vibe-hero/`.

## Run the server (host-agent connected)

The MCP server is launched over stdio by the host (Claude Code v1). For local validation, run it directly and drive it with the MCP inspector or the vitest e2e harness:

```bash
VIBE_HERO_HOME="$(mktemp -d)" pnpm --filter @vibe-hero/server start   # stdio MCP server
```

## Validation scenarios (map to spec Success Criteria)

### V0 — First-run gate (US-0, SC-012)
1. With an empty `VIBE_HERO_HOME`, call any tool (e.g. `get_status`).
2. **Expect** `status: "SETUP_REQUIRED"`. No quiz/status proceeds.
3. Call `save_config` with a valid config; call `get_status` again.
4. **Expect** normal status output. Gate cleared.

### V1 — Deterministic full loop (US-1/US-3, SC-001/004/005/009)
1. `save_config` (tool `claude-code`, cadence `per_session`).
2. `start_quiz { key: "claude-code|subagents" }` → returns 3–5 `PresentedItem`s, no answer keys leaked.
3. `submit_answer` each with the correct choice → **expect** `grade: "correct"`, ability rises, identical answer ⇒ identical grade (run twice, compare).
4. Repeat across sessions with increasingly hard correct answers → **expect** a `graduation.changed: true` once ability crosses `boundary + 30` for **2 consecutive** items (hysteresis + dwell).
5. Then submit several wrong easier items → **expect** the topic flips to `due_for_review` only after crossing `boundary − 30` (no flip-flop in the band → SC-014).

### V2 — Usage never scores (SC-003)
1. `record_observation` with subagent/MCP signals, but answer **no** quiz.
2. `get_status` → **expect** ability and graduation **unchanged** from baseline.

### V3 — Non-interrupting offer + cadence (US-1, SC-002/013)
1. `record_observation` (topic `subagents` exercised) → returns offer candidates.
2. `get_offer { sessionId }` → returns an offer; `record_offer_response decline`.
3. `get_offer` again same session → **expect** `suppressed: "declined"`. Under `per_session`, a second distinct candidate is also suppressed after the first offer.
4. With `offerCadence: "off"` → `get_offer` always `suppressed: "offers_off"`.

### V4 — Free-form handshake (US-4, OD-002 contract)
1. Seed a fixture `free_form` item; `start_quiz` → `PresentedItem` includes `rubric` + `referenceAnswer`.
2. Host agent (or test stub) computes a verdict; `submit_answer { verdict }`.
3. **Expect** ability updates identically to a deterministic grade of the same score; no MCP sampling involved.
4. With free-form judging disabled → **expect** the engine defers/substitutes a deterministic item (FR-014), quiz still completes.

### V5 — Offline + freshness (US-5, SC-006/007)
1. No network + only bundled catalog → `list_topics` and `start_quiz` still succeed (SC-006).
2. Point fetch at a newer published catalog version → next refresh caches it; `list_topics.catalogVersion` advances (SC-007).
3. Make the fetch source unreachable → **expect** no user-facing error; serves cached/bundled (FR-027).

### V6 — Privacy (SC-008)
1. After a quiz with text answers, inspect the persisted `~/.vibe-hero/profile.json`.
2. **Expect** only derived `Grade`/scores/timestamps — **no** raw answer text, prompts, or tool I/O.

## Skill / hook validation (portable surface)

- The `vibe-hero-setup`, `vibe-hero-quiz`, `vibe-hero-status`, `vibe-hero-learn` **skills** each drive the corresponding MCP tools. Validate a skill triggers, calls the tool, and renders the result.
- The Claude Code **Stop hook** calls `get_offer` and, when an offer is returned, surfaces it to the agent at end-of-work (verified hook event). Validate it never fires mid-task and respects `record_offer_response`.

## Done = all V0–V6 pass

The MVP success criterion (full loop on Claude Code, ~3–5 topics) is satisfied when V0–V3 pass with real `claude-code` content and V4–V6 pass with fixtures/bundled content.
