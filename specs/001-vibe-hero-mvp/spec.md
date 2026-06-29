# Feature Specification: vibe-hero — Adaptive Learning for Agentic Coding Tools

**Feature Branch**: `001-vibe-hero-mvp`

**Created**: 2026-06-29

**Status**: Draft

**Input**: User description: adaptive learning MCP server + portable steering that takes users "from zero to hero" on agentic coding tools (Claude Code first; architecture generalizes to Codex, Kiro CLI, Kiro IDE). Builds a per-user competence profile, awards progress for demonstrated knowledge (not mere tool usage), guides users on weak topics, and quizzes them at non-interrupting moments.

## Overview

vibe-hero helps a person genuinely *learn* the agentic coding tool they use every day. Most users touch only a fraction of a tool's capability surface (subagents, context management, planning, MCP, parallelization, hooks, worktrees, …) and never discover the rest. vibe-hero maintains a per-user **competence profile**, periodically **checks the user's knowledge** with short quizzes offered at natural breakpoints, **awards progress only for demonstrated knowledge** (answering correctly — never for the agent merely invoking a tool), and **guides** the user toward the next thing worth learning on the specific tool they are using.

Because the assistant model is stateless, all learning state lives **outside** the model in a profile the system owns. The user interacts in natural language with their existing coding agent; lightweight steering tells that agent when and how to consult vibe-hero.

The v1 goal is to prove the **full adaptive loop end-to-end on Claude Code** for a small set of real topics, with an architecture that already accommodates multiple tools and a general-vs-tool-specific content split.

## Clarifications

### Session 2026-06-29

- Q: How does a raw session/tool event map to a curriculum topic for triggering an offer? → A: Each topic declares explicit **trigger signals** (tool names / patterns) in the content catalog; the engine matches observed events to topics by those declarations (data-driven, extensible via content, no code change to add topics).
- Q: How many items per quiz session, and what is the per-session pass criterion? → A: 3–5 adaptively-selected items per session near the user's current ability; each item updates the ability estimate; there is **no single-session pass/fail gate** — graduation is the accumulated ability crossing a tier threshold. Additionally, graduation requires crossing the threshold by a **margin (hysteresis band)** and demotion/review triggers only when ability falls a separate, lower amount below, to prevent flip-flopping at the boundary.
- Q: How frequently may quiz offers fire (anti-fatigue)? → A: **Configurable** between "at most one offer per session" and "at most one offer per surfaced topic (multiple per session allowed)"; a decline suppresses further offers for the session; cadence is set by the user during setup.
- Q: Is product configuration required before use, and how is it gated? → A: Configuration is driven by a **required, interactive setup skill** that runs a Q&A on user preferences. It is a **hard gate**: if config is missing, any vibe-hero action first routes the user into setup and nothing else proceeds until setup completes once. The setup skill is the intended first thing a new user does.
- Q: How is the content catalog organized for authoring? → A: **One file per (topic × class)** (e.g. `content/claude-code/subagents.<ext>`) containing all tiers and that topic's trigger-signal declarations, in a structured, human-editable, schema-validated format. (Exact serialization format — YAML/JSON/TOML — is a plan-level decision; see OD-004.)

### Session 2026-06-29 (post-critique remediation)

- Q: Concurrent sessions share one global profile — how to avoid lost updates? → A: Profile writes MUST be **atomic and serialized** (write-temp + rename, under an advisory lock), so simultaneous host sessions cannot clobber each other's ability/graduation updates.
- Q: For free-form items, the host agent both answers and judges — how to prevent it just passing itself? → A: **Free-form stays in v1.** Design around gaming: the **MCP provides the reference answer and explicit per-criterion rubric**; the host agent MUST return a **per-criterion verdict** (which criteria met/missed), not a single boolean, and steering mandates strict rubric-based judging. The reference/criteria come from the MCP (authoritative), not invented by the agent.
- Q: Should item difficulty self-update from answers (Elo two-way)? → A: **No.** Each item has a **fixed expected Elo rating** (authored). Answering moves **only the user's** ability up/down against that fixed item rating; items never self-update. (Avoids single-learner difficulty corruption.)
- Q: Privacy — what about hook tool input/output? → A: The observation layer MUST **never store `tool_input`/`tool_output`** (or any raw prompt/code); only derived signals `{tool_name, topicKeys, success, timestamp, tool_use_id}` are extracted. A test MUST assert no raw payload field is persisted.
- Q: Decline anti-nag — only within a session? → A: No — add **cross-session backoff**: repeated declines increase the interval before re-offering, with a **global mute after N consecutive declines**, in addition to the within-session suppression.

## User Scenarios & Testing *(mandatory)*

### User Story 0 - First-run setup (required, skill-driven) (Priority: P1)

The very first time a user engages vibe-hero (or any time configuration is missing), they are routed into an interactive setup conducted by a dedicated setup skill. It runs a short Q&A on the user's preferences — at minimum: which tool(s) they're learning, offer cadence (one offer per session vs one per surfaced topic), and whether proactive offers are enabled at all — and writes a configuration the rest of the product reads. No quizzes, offers, status, or guidance happen until setup has completed once.

**Why this priority**: This is the front door. Every other behavior (offers, cadence, which tool's curriculum is in focus) depends on configuration existing, and the user explicitly required that setup be the first thing that happens and that it be skill-driven and portable. Without it the product has undefined behavior on first run, so it is P1 and gates the others.

**Independent Test**: With no existing config, invoke any vibe-hero action; confirm the user is taken through the setup Q&A, a configuration is persisted, and only afterward do normal actions proceed. Re-invoking with config present skips setup.

**Acceptance Scenarios**:

1. **Given** no configuration exists, **When** the user (or a trigger) initiates any vibe-hero action, **Then** the setup Q&A runs first and nothing else proceeds until it completes.
2. **Given** the user completes setup, **When** configuration is saved, **Then** subsequent actions use those preferences and setup is not repeated.
3. **Given** configuration already exists, **When** the user explicitly asks to reconfigure, **Then** the setup skill can be re-run to update preferences.
4. **Given** setup asks for offer cadence, **When** the user chooses, **Then** the choice (per-session vs per-topic, or offers off) is honored by the offer engine.

---

### User Story 1 - Knowledge check after a teachable moment (Priority: P1)

A user finishes a unit of work in their coding agent. At that natural breakpoint (not mid-task), vibe-hero notices the session touched a topic in the curriculum (e.g. the user/agent used subagents) and the agent offers: "Want a quick 2-minute check on subagents?" The user accepts, answers a few questions, and immediately sees how they did and what to review next. Their profile updates to reflect demonstrated knowledge for that topic on that tool.

**Why this priority**: This is the core loop — observe a teachable moment → offer a non-interrupting check → grade → update profile → guide. If only this works, the product already delivers its central value: turning everyday tool use into measured, growing competence. Everything else is enhancement.

**Independent Test**: Simulate a session that uses a curriculum topic; confirm an offer surfaces only at the end-of-work breakpoint (never mid-task), the user can answer a short quiz, the result is graded, and the profile reflects the new evidence — all without the offer ever blocking active work.

**Acceptance Scenarios**:

1. **Given** a curriculum topic was exercised during a session, **When** the agent reaches an end-of-work breakpoint, **Then** the agent offers a relevant quiz and does not interrupt any in-progress task.
2. **Given** the user declines the offer, **When** they continue working, **Then** no quiz is forced and the decline is respected for the rest of the session.
3. **Given** the user accepts and answers questions, **When** grading completes, **Then** the user sees per-question correctness, an updated standing for that topic on that tool, and a pointer to what to study next.
4. **Given** the agent merely used a tool many times, **When** no quiz is answered, **Then** the user's points and graduation status do **not** change (usage alone never awards progress).

---

### User Story 2 - Check my standing and get guidance (Priority: P1)

At any time the user asks their agent something like "where am I with Claude Code?" or "what should I learn next?". vibe-hero returns the user's current standing per topic and tier for the tool in use, highlights weak or stale areas, and offers concrete guidance (a short explanation plus a way to practice). The user can also pull a quiz on demand ("quiz me on context management").

**Why this priority**: Self-directed learners need to see progress and steer their own study. This is the always-available, pull-based companion to the push-based offer in Story 1, and it is the primary way guidance is delivered. It must work even when no telemetry is available.

**Independent Test**: With a profile that has mixed standings, ask for status and for "what next"; confirm the response is scoped to the current tool, names specific topics/tiers, surfaces weak/stale areas, and that an on-demand quiz request produces a quiz without needing any prior telemetry.

**Acceptance Scenarios**:

1. **Given** an existing profile, **When** the user asks for their status on the current tool, **Then** they see per-topic standing and tier graduation state scoped to that tool.
2. **Given** weak or stale topics exist, **When** the user asks "what should I learn next?", **Then** the system recommends specific topics/tiers with a short rationale.
3. **Given** the user requests a quiz on a named topic, **When** there is content for it, **Then** a quiz is delivered and graded regardless of whether any usage was observed.
4. **Given** the user asks for guidance on a topic they are weak in, **When** guidance is returned, **Then** it includes a concise teaching explanation and an option to practice.

---

### User Story 3 - Earn a tier on a topic (graduation) (Priority: P2)

Over multiple sessions the user repeatedly answers questions on a topic at increasing difficulty. Their ability on that (topic, tool) rises as they answer harder items correctly and falls when they miss easier ones. When their ability crosses a tier's threshold, vibe-hero congratulates them and graduates them to the next tier for that topic on that tool — and later schedules a light review so a one-time streak doesn't count as permanent mastery.

**Why this priority**: Graduation is the motivational backbone and the durable signal of real competence. It depends on Stories 1–2 existing first (you need quizzing and a profile), so it is P2, but it is essential to the "zero to hero" promise.

**Independent Test**: Feed a sequence of graded answers of varying difficulty for one (topic, tool); confirm ability moves in the right direction, a tier graduates only when the threshold is crossed, graduation is announced, and a later review opportunity is scheduled.

**Acceptance Scenarios**:

1. **Given** a series of correct answers on progressively harder items, **When** ability crosses the tier threshold, **Then** the user is graduated to that tier for the (topic, tool) and informed.
2. **Given** the user later misses several easier items on a graduated topic, **When** ability drops below the retention threshold, **Then** the topic is flagged for review rather than silently kept as mastered.
3. **Given** graduation in one tool, **When** the user is assessed on the same general concept under a different tool, **Then** graduation state is tracked separately per tool (and per general vs tool-specific class).

---

### User Story 4 - Free-form depth questions judged fairly (Priority: P3)

At higher tiers the user is asked an open-ended question ("explain when you would *not* parallelize subagents"). Because the answer can't be matched exactly, the user's own coding agent evaluates the free-text answer against a hidden rubric and reports a verdict back to vibe-hero, which records it like any other graded item.

**Why this priority**: Open-ended questions are how the system distinguishes genuine expert understanding (tiers 400–500) from recall. It is P3 because the deterministic question types already prove the loop; free-form depth is a meaningful enhancement that can be a fast-follow.

**Independent Test**: Present a free-form item; confirm the system hands the agent a rubric and reference answer, the agent returns a structured verdict, and the verdict is recorded and affects ability exactly as a deterministic grade would.

**Acceptance Scenarios**:

1. **Given** a free-form question, **When** the user answers, **Then** the system provides the judging agent a rubric and reference answer and requests a verdict.
2. **Given** the agent returns a verdict, **When** it is recorded, **Then** ability updates consistently with deterministic grading.
3. **Given** no judging capability is available, **When** a free-form item would be served, **Then** the system degrades gracefully (defers the item or substitutes a deterministic one) rather than failing.

---

### User Story 5 - Works offline and stays fresh (Priority: P3)

The curriculum is maintained centrally and improves over time. A user on a plane (no network) can still be quizzed from a bundled baseline. A connected user automatically benefits from the latest curriculum without reinstalling the tool.

**Why this priority**: Content freshness and offline resilience matter for adoption and for letting the curriculum evolve independently of software releases, but the core loop works with bundled content alone, so this is P3.

**Independent Test**: With no network, confirm quizzes still work from bundled content; with network, confirm newer published content is picked up and cached, and that an unreachable update source falls back to cache/bundle without error.

**Acceptance Scenarios**:

1. **Given** no network, **When** the user requests a quiz, **Then** content is served from the bundled/cached catalog.
2. **Given** newer published content exists, **When** the system next refreshes, **Then** it fetches and caches the update and serves it thereafter.
3. **Given** the update source is unreachable, **When** a refresh is attempted, **Then** the system continues on cached/bundled content without surfacing an error to the user.

---

### Edge Cases

- **No telemetry available** (hook not installed, logs unreadable, or a tool that exposes neither): the system must still work fully in pull mode (Story 2) — status, on-demand quizzes, guidance — with offers simply not firing.
- **Telemetry is misleading**: a skill or the agent autonomously invokes a tool the user does not understand. Because usage never scores, this can at worst trigger an *offer* for a quiz the user is free to decline; it must never change standing on its own.
- **User abandons a quiz mid-way**: partial sessions must not corrupt the profile; only completed, graded items count.
- **Repeated identical questions**: the system should avoid re-serving the same item back-to-back and should vary items to measure rather than train-to-the-test.
- **Conflicting signals across tools**: strong on a concept in Claude Code, never tested in Codex — standing must remain independent per tool.
- **Profile corruption / first run**: a missing or unreadable profile must initialize cleanly to an empty baseline without data loss for other tools.
- **Stale graduation**: long absence from a topic should surface it for review rather than presenting outdated mastery as current.
- **Content references a tool with no curriculum yet**: the system must handle a known-but-unpopulated tool gracefully (no crash, clear "no content yet" state).
- **Privacy-sensitive sessions**: telemetry must never persist raw prompts, tool inputs, or tool outputs.

## Requirements *(mandatory)*

### Functional Requirements

**Content catalog**

- **FR-001**: The system MUST organize learning content as a matrix of (topic × skill-level tier), where tiers use a 100–500 scale (100 = introductory … 500 = expert) aligned to an increasing cognitive-depth ladder.
- **FR-002**: The system MUST separate content into two classes: **general** (tool-agnostic agentic-coding concepts) and **tool-specific** (keyed by tool identity such as claude-code, codex, kiro-cli, kiro-ide), and MUST be able to assess either class.
- **FR-003**: Each content item MUST carry: topic, class (general or a specific tool), tier, question text, question type (multiple-choice, short-answer, or free-form), the gradeable answer key (correct option/keywords for deterministic types; rubric + reference answer for free-form), teaching/guidance text, an item difficulty value used for ability estimation, and a cognitive-depth level.
- **FR-003a**: Each topic MUST be able to declare **trigger signals** (tool names / patterns it corresponds to) in the catalog, so the engine can attribute observed activity to that topic without code changes. Topics without trigger signals are still fully usable in the pull-based path (status / on-demand quiz / guidance).
- **FR-004**: The content catalog MUST be validated against a defined schema on load, and malformed items MUST be rejected with a clear diagnostic rather than silently mis-served.
- **FR-004a**: The catalog MUST be authored as **one file per (topic × class)** containing all of that topic's tiers and its trigger-signal declarations, in a structured, human-editable, schema-validated format, so the curriculum can be co-authored and updated per topic. (Serialization format is a plan decision — OD-004.)

**Competence, scoring, and graduation**

- **FR-005**: The system MUST award progress **only** for demonstrated knowledge (correctly answered quiz items). Observed tool usage MUST NOT award points or change graduation state under any circumstance.
- **FR-006**: The system MUST maintain a user **ability estimate per (topic × class)** that increases when harder items are answered correctly and decreases when easier items are missed (adaptive/Elo-style estimation against item difficulty). Each content item has a **fixed expected difficulty rating** (authored); answering moves **only the user's** ability against that fixed rating — item ratings MUST NOT self-update from a single learner's answers.
- **FR-007**: The system MUST track tier graduation **independently per tool and per topic** (and for the general class), never as a single global level.
- **FR-008**: The system MUST graduate a (topic, tool/class) to a tier when the user's ability crosses that tier's threshold **by a defined margin (hysteresis band)**, and MUST inform the user when graduation occurs. The graduation margin and the (separate, lower) demotion threshold MUST differ so a user hovering at the boundary does not flip-flop between graduated and not-graduated.
- **FR-008a**: A quiz session MUST consist of a small, bounded number of items (default **3–5**), adaptively selected near the user's current ability for the topic. Each answered item updates the ability estimate; there is **no single-session pass/fail gate** — graduation is solely a function of accumulated ability crossing the FR-008 threshold-plus-margin.
- **FR-009**: The system MUST support **knowledge lapse**: when ability on a previously graduated topic falls below the demotion threshold (the lower bound of FR-008's hysteresis band), or after a defined period without assessment, the topic MUST be surfaced for review rather than presented as currently mastered.
- **FR-010**: The system MUST schedule spaced review opportunities so graduation reflects durable knowledge rather than a single lucky session.

**Grading**

- **FR-011**: The system MUST grade deterministic question types (multiple-choice, short-answer/keyword) itself, producing an objective, reproducible result without requiring the host agent.
- **FR-012**: For free-form questions, the system MUST support a host-agent judging handshake: it provides the judging agent the **authoritative reference answer and an explicit per-criterion rubric** (supplied by the system, not invented by the agent), receives a **per-criterion structured verdict** (which criteria were met/missed, not a single boolean), and records the resulting score equivalently to a deterministic grade. (The system MUST NOT rely on the assistant client calling back into the model directly — MCP sampling is unavailable in the target clients.)
- **FR-013**: The system MUST instruct the judging agent (via steering) to evaluate **strictly** against the supplied rubric, justify each criterion verdict, and MUST record the per-criterion verdict it returns. The design assumes the agent may be lenient; mitigations are the system-supplied reference + per-criterion structure (a single self-pass is not accepted as a verdict).
- **FR-014**: The system MUST degrade gracefully when free-form judging is unavailable (defer or substitute a deterministic item) rather than failing the quiz.

**Observation (trigger only)**

- **FR-015**: The system MUST be able to observe a session's activity to detect when a curriculum topic was exercised, for the sole purpose of **triggering an offer** to quiz — never for scoring.
- **FR-016**: Observation MUST sit behind an abstraction so additional sources (transcript backfill, other tools' telemetry) can be added without redesign, and a **manual/self-report path MUST always work** even when no telemetry source is present.
- **FR-017**: When both a real-time event source and a session record are available, the system MUST be able to correlate them deterministically (by a shared per-action identifier) to attribute activity to topics.
- **FR-018**: Observation MUST NOT persist raw prompts, tool inputs (`tool_input`), or tool outputs (`tool_output`), nor any code/content from them; it MUST extract only derived signals: `{ tool_name, topicKeys, success, timestamp, tool_use_id }`. This boundary MUST be covered by a test asserting no raw payload field is ever written to disk.

**Quiz delivery (non-interrupting)**

- **FR-019**: The system MUST offer quizzes only at end-of-work breakpoints (after the agent finishes a unit of work), never interrupting an in-progress task.
- **FR-020**: The user MUST be able to accept, decline, or defer an offered quiz, and a decline MUST be respected without nagging (no further offers for the remainder of the session after a decline).
- **FR-020a**: Offer cadence MUST be **configurable** (set during setup, FR-031) across at least: offers off; at most one offer per session; and at most one offer per surfaced topic (multiple per session permitted). The configured cadence MUST be honored by the offer engine.
- **FR-020b**: Beyond within-session suppression, the system MUST apply **cross-session decline backoff**: repeated declines increase the interval before a topic (or offers generally) are re-offered, and after **N consecutive declines** offers are **globally muted** until the user re-enables or requests one. This prevents persistent nagging across sessions.
- **FR-021**: The user MUST be able to request a quiz, status, or guidance on demand at any time, independent of any offer (subject to the first-run setup gate, FR-031).

**First-run setup and configuration**

- **FR-031**: The product MUST be configured via a dedicated, interactive **setup skill** that conducts a Q&A on user preferences (at minimum: tool(s) being learned, offer cadence per FR-020a, and whether proactive offers are enabled) and persists a configuration the rest of the system reads.
- **FR-032**: Setup MUST be a **hard gate** on **vibe-hero actions only** (offer, on-demand quiz, status, guidance) — NOT on the host session or the user's actual coding work. When configuration is missing, any vibe-hero action MUST first route the user into setup, and no other vibe-hero behavior proceeds until setup completes once. The gate MUST NOT block or interrupt the user's non-vibe-hero work.
- **FR-033**: The user MUST be able to re-run setup to update preferences when configuration already exists, without losing learning progress in the profile.

**Profile store and privacy**

- **FR-022**: The system MUST persist a **single per-user profile** that spans all projects (learning the tool is a user-level skill), recording per-(topic × class) ability, tier graduation state, review schedule, and quiz history.
- **FR-023**: The profile MUST initialize cleanly on first run and MUST tolerate a missing/partial profile without losing unrelated data.
- **FR-023a**: Because a single global profile may be written by **multiple concurrent host sessions**, all profile writes MUST be **atomic and serialized** (e.g. write-temp + atomic rename under an advisory lock, or an append-only event log projected into the profile) so concurrent updates cannot silently lose ability or graduation changes.
- **FR-024**: The system MUST NOT transmit user content (prompts, code, tool I/O) over the network; only the user's local profile and the (public) curriculum are involved in network activity, and curriculum fetch is one-directional (download only).

**Content delivery**

- **FR-025**: The system MUST ship a bundled baseline catalog so it works offline and on first run with no network.
- **FR-026**: The system MUST be able to fetch an updated catalog from a central published source, cache it locally with a version/validator, and serve the cached copy thereafter.
- **FR-027**: The system MUST allow the curriculum to be updated independently of a software release, and MUST fall back to cached/bundled content (without user-facing error) when the update source is unreachable.

**Interface and portability**

- **FR-028**: The system MUST expose its capabilities (status, get a question, submit an answer, get guidance, list topics) as agent-callable operations the host agent invokes on the user's behalf via natural language, steered by installed guidance.
- **FR-029**: The portable command-like surface MUST be implemented in a tool-portable form (not tied to one client's proprietary command mechanism) so it can work across Claude Code, Codex, and Kiro. *(The choice between a skill-based and an agent-based surface is an open design tradeoff to be resolved in planning — see Open Design Decisions.)*
- **FR-030**: The system architecture MUST support multiple tools and the general/tool-specific split from day one, even though only Claude Code content is populated in v1.

### Key Entities *(include if feature involves data)*

- **Content Item**: A single assessable unit. Attributes: topic, class (general | tool:<id>), tier (100–500), question type, question text, answer key or rubric+reference, teaching text, difficulty, cognitive-depth level. Belongs to a Topic.
- **Topic**: A named learning subject (e.g. "subagents", "context management", "planning"), existing in the general class and/or per tool. Groups Content Items across tiers, and declares **Trigger Signals**. Authored as one file per (topic × class).
- **Trigger Signal**: A declaration on a Topic (tool name / pattern) that lets the engine attribute an Observation Event to that Topic for offer-triggering. Lives in the catalog, not in code.
- **Configuration**: The per-user product settings captured by the setup skill — tool(s) being learned, offer cadence (off | per-session | per-topic), proactive-offers on/off, and other preferences. Read by all behaviors; its absence hard-gates the product into setup.
- **Tool**: An agentic coding environment the user may be learning (claude-code, codex, kiro-cli, kiro-ide, …). Scopes tool-specific content and per-tool graduation.
- **Learner Profile**: The single per-user record of learning state. Contains per-(topic × class) Ability Estimates, Tier Graduation states, the review schedule, and Quiz History.
- **Ability Estimate**: The current estimated competence for one (topic × class), updated by graded answers against item difficulty; drives graduation and lapse.
- **Tier Graduation**: The achieved tier for a (topic × tool/class), with timestamp and retention status (current | due-for-review).
- **Quiz Session**: An offered or requested set of items, the user's answers, per-item grades, and the resulting profile updates; only completed items count.
- **Observation Event**: A derived, privacy-safe signal that a topic was exercised (tool/topic, success, timestamp, correlation id) — used solely to trigger offers, never stored as raw content and never scored.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A new user can complete their first knowledge check (from offer or on-demand) in **under 3 minutes**, end to end.
- **SC-002**: Quiz offers occur **only** at end-of-work breakpoints — in testing, **0%** of offers interrupt an in-progress task.
- **SC-003**: Observed tool usage with **no** answered quizzes results in **0** change to points or graduation state (usage never scores) — verifiable in 100% of such cases.
- **SC-004**: Deterministically graded items return a result **immediately** (no dependence on an external judgment) and produce the **same** grade for the same answer every time.
- **SC-005**: A user who correctly answers progressively harder items on a topic graduates the corresponding tier, and the system announces it; a user who then misses easier items has that topic surfaced for review.
- **SC-006**: With no network connection, **100%** of bundled-topic quiz requests still succeed.
- **SC-007**: A published curriculum update is picked up and served by a connected user **without** any software reinstall.
- **SC-008**: The profile records **no** raw prompts, tool inputs, or tool outputs — verifiable by inspection of stored data in 100% of cases.
- **SC-009**: For the v1 target tool (Claude Code), the **full loop** (detect → offer → grade → update per-tool profile → graduate → guide) is demonstrable on at least **3** real topics.
- **SC-010**: The same general concept assessed under two different tools yields **independent** graduation state per tool.
- **SC-011**: When telemetry is entirely absent, a user can still reach status, on-demand quizzes, and guidance — **0** features in the pull-based path require telemetry.
- **SC-012**: When configuration is missing, **100%** of vibe-hero actions route the user into setup first; **0** quizzes/offers/status proceed before setup completes once.
- **SC-013**: The configured offer cadence is honored — under "per-session" at most **1** offer occurs per session; under "offers off" **0** offers occur; verifiable in testing.
- **SC-014**: A user whose ability oscillates within the hysteresis band around a tier threshold does **not** flip-flop between graduated and not-graduated — graduation toggles only on crossing the margin, and demotion only on crossing the separate lower threshold.

## Open Design Decisions

These are deferred to planning and must be resolved there; they do not block specification.

- **OD-001 — Portable surface: Skills vs Agents.** The portable command-like surface (FR-029) can be implemented as installable **skills** or as dedicated **agents**. Planning MUST weigh: discoverability (how the user finds/invokes it), portability across Claude Code / Codex / Kiro (which mechanism each supports), invocation model (pull on demand vs the host agent delegating), conversational vs command ergonomics, and maintenance cost of keeping one surface vs per-client variants. Recommend a primary with rationale; a hybrid is acceptable if justified.
- **OD-002 — Free-form judging in v1 vs fast-follow.** Whether User Story 4 (free-form judged items) ships in v1 or as an immediate fast-follow, given the deterministic loop already satisfies the MVP criterion.
- **OD-003 — Spaced-review scheduling model.** The specific retention/review scheduling approach (e.g. a spaced-repetition schedule vs ability-decay over time) satisfying FR-009/FR-010.
- **OD-004 — Content serialization format.** The on-disk format for the per-(topic × class) content files (FR-004a) — YAML, JSON, or TOML. All validate equally via schema after parse, so the decision is authoring ergonomics for prose-heavy items (questions, options, rubrics, guidance) vs tooling simplicity. Recommend with rationale in planning.
- **OD-005 — Elo parameters & tier thresholds.** Concrete values for the ability scale, per-tier thresholds, the graduation margin and demotion threshold (the hysteresis band, FR-008), the K-factor/update rule, and item-difficulty calibration — to be specified in planning and tuned thereafter.

## Assumptions

- **Stateless host model**: the assistant model retains nothing between turns; all durable learning state lives in the system-owned profile, and the host agent consults the system rather than remembering.
- **Single primary user per profile**: one human per profile; team/classroom/shared profiles are out of scope for v1.
- **User-level learning scope**: competence with a tool is a property of the user, not a repository, so the profile is global per user rather than per project.
- **v1 target is Claude Code**: only Claude Code content is populated in v1; Codex/Kiro are architecturally supported but unpopulated.
- **Public curriculum**: learning content is non-sensitive and publicly distributable; only the local profile is private.
- **Host agent can follow steering and perform a judging handshake**: the user's coding agent can be steered to call the system and, for free-form items, to return a rubric-based verdict.
- **Reasonable assessment cadence**: end-of-work offers are infrequent enough not to fatigue the user; the cadence is user-configurable at setup (FR-020a) with sensible defaults, and exact numeric limits are a tuning detail for planning.
- **Setup precedes everything**: the host environment can invoke the setup skill and persist its configuration before any other vibe-hero behavior runs; first-run users are expected to complete setup once.

## Out of Scope (v1)

- Populated Codex / Kiro CLI / Kiro IDE curricula (architecture-ready only).
- A web dashboard or graphical UI.
- Team, classroom, or shared/multi-user profiles and leaderboards.
- Network transmission, syncing, or central storage of user profiles or any user content.
- Using tool-usage telemetry as a scoring signal (explicitly excluded by design).
