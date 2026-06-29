# Data Model: vibe-hero MVP

All shapes are defined with **Zod** schemas in TypeScript and are the single source of truth (types are inferred from schemas). Two storage domains: the **Content Catalog** (read-only at runtime, authored in-repo + fetched) and the **Learner Profile** (read-write, per-user, local).

## Identifiers & enums

- `ToolId` — `"claude-code" | "codex" | "kiro-cli" | "kiro-ide"` (extensible; v1 populates `claude-code` only).
- `ContentClass` — `"general"` | `{ tool: ToolId }`. Discriminated: general content vs tool-specific content.
- `Tier` — `100 | 200 | 300 | 400 | 500` (course-numbering ladder).
- `BloomLevel` — `"remember" | "understand" | "apply" | "analyze" | "evaluate" | "create"`.
- `QuestionType` — `"multiple_choice" | "short_answer" | "free_form"`.
- `Grade` — `"correct" | "incorrect"` (binary outcome feeding the Elo update; free-form verdicts collapse to this).

## Content Catalog (read-only at runtime)

### Topic (file = one `(topic × class)`)

| Field | Type | Notes |
|---|---|---|
| `id` | string (kebab) | e.g. `subagents`, `context-management` |
| `class` | `ContentClass` | `general` or `{tool}` |
| `title` | string | display name |
| `summary` | string | one-line description |
| `triggerSignals` | `TriggerSignal[]` | how observed activity maps to this topic (FR-003a); may be empty |
| `items` | `ContentItem[]` | all tiers for this topic |

A topic file resolves to exactly one `(id, class)` pair. The same `id` may exist in `general` and under one or more tools (independent topics).

### TriggerSignal

| Field | Type | Notes |
|---|---|---|
| `tool` | `ToolId` | which tool's activity this matches |
| `match` | object | `{ toolName?: string; toolNamePattern?: string; mcpToolPattern?: string }` — at least one present |
| `weight` | number (0–1, default 1) | optional relevance weight for offer ranking |

Matching is **trigger-only** (selects which topic to *offer*); it never scores.

### ContentItem

| Field | Type | Notes |
|---|---|---|
| `id` | string | unique within topic |
| `tier` | `Tier` | |
| `bloom` | `BloomLevel` | depth tag |
| `difficulty` | number | Elo item-difficulty (see research defaults) |
| `type` | `QuestionType` | |
| `prompt` | string | the question text |
| `choices` | `Choice[]?` | required iff `type === "multiple_choice"` |
| `answerKey` | `AnswerKey?` | required for deterministic types |
| `rubric` | `Rubric?` | required iff `type === "free_form"` |
| `guidance` | string | teaching text shown after answering / on weakness |

- `Choice` — `{ id: string; text: string }`.
- `AnswerKey` — discriminated: `{ kind: "choice"; correctChoiceId: string }` | `{ kind: "keyword"; anyOf: string[]; normalize?: "lower"|"trim"|"both" }`.
- `Rubric` — `{ criteria: string[]; referenceAnswer: string; passThreshold?: number }`. The reference answer + criteria are handed to the host agent for the judging handshake; they are NOT shown to the user before answering.

**Validation rules**: a `multiple_choice` item MUST have ≥2 `choices` and a `correctChoiceId` that exists; `short_answer` MUST have a keyword `answerKey`; `free_form` MUST have a `rubric` and NO `answerKey`. Catalog load rejects violations with a path-qualified diagnostic (FR-004).

### CatalogManifest

| Field | Type | Notes |
|---|---|---|
| `version` | string (semver) | catalog version |
| `publishedAt` | ISO datetime | |
| `topics` | `{ id, class, file, itemCount, tiers }[]` | index for fast listing |
| `etag?` | string | set by fetch layer for cache validation |

## Learner Profile (read-write, per-user, local at `~/.vibe-hero/`)

### Profile (root document)

| Field | Type | Notes |
|---|---|---|
| `schemaVersion` | number | migration guard |
| `createdAt` / `updatedAt` | ISO datetime | |
| `config` | `Config?` | absent ⇒ first-run setup gate (FR-032) |
| `abilities` | `Record<AbilityKey, AbilityEstimate>` | keyed by `class|topic` |
| `graduations` | `Record<AbilityKey, TierGraduation>` | |
| `reviewSchedule` | `ReviewEntry[]` | due-for-review queue |
| `quizHistory` | `QuizRecord[]` | append-only, capped/rolled |
| `offers` | `OfferLedger` | per-session offer accounting (anti-fatigue) |

`AbilityKey` = serialized `(class, topicId)` — e.g. `claude-code|subagents`, `general|planning`. Graduation is per this key ⇒ inherently per-tool (FR-007).

### Config (written by the setup skill, FR-031)

| Field | Type | Notes |
|---|---|---|
| `toolsLearning` | `ToolId[]` | which tools the user is learning |
| `offerCadence` | `"off" | "per_session" | "per_topic"` | FR-020a |
| `proactiveOffers` | boolean | master switch for Story 1 |
| `quizLength` | int (default 4, range 3–5) | items per session (FR-008a) |
| `createdAt` / `updatedAt` | ISO datetime | |

### AbilityEstimate (Elo-style)

| Field | Type | Notes |
|---|---|---|
| `value` | number | current ability on the Elo scale |
| `itemsSeen` | int | drives provisional→settled K-factor |
| `lastAssessedAt` | ISO datetime | feeds lapse/decay |
| `lastItemIds` | string[] | recent items, to avoid back-to-back repeats |

### TierGraduation

| Field | Type | Notes |
|---|---|---|
| `currentTier` | `Tier | 0` | 0 = not yet graduated |
| `status` | `"current" | "due_for_review"` | FR-009 |
| `graduatedAt` | ISO datetime | |
| `lastChangeReason` | `"graduated" | "demoted" | "review_due"` | audit |

Graduation uses a **hysteresis band**: ability must exceed `tierThreshold + margin` to graduate, and only drops to review/demote below `tierThreshold − demotionMargin` (FR-008, SC-014). Concrete numbers come from research → `research.md`.

### ReviewEntry

`{ key: AbilityKey, dueAt: ISO datetime, reason: "spaced" | "lapsed" }`.

### QuizRecord

`{ id, key: AbilityKey, startedAt, completedAt?, items: AnsweredItem[], abilityBefore, abilityAfter }`. Only `completedAt`-present records count toward graduation (partial sessions discarded — edge case).

- `AnsweredItem` — `{ itemId, tier, difficulty, grade: Grade, gradedBy: "engine" | "host_agent", answeredAt }`. **No raw answer text persisted** (privacy, FR-018/024) — only the derived grade.

### OfferLedger (anti-fatigue, FR-020/020a)

`{ sessionId: string, offersThisSession: int, declinedThisSession: boolean, offeredTopicKeys: AbilityKey[] }`. Reset per session id. Under `per_session` cadence: max 1 offer; a decline sets `declinedThisSession=true` and suppresses further offers; under `per_topic`: at most one offer per distinct `AbilityKey` per session.

### ObservationEvent (transient, privacy-safe — NOT persisted as content)

`{ tool: ToolId, topicKeys: AbilityKey[], success: boolean, timestamp, correlationId }`. Derived from a hook payload and/or transcript record (correlated by `tool_use_id`, FR-017). Used only to populate offer candidates; never stored as raw prompt/tool I/O (FR-018). May be kept in an ephemeral per-session buffer, not the durable profile.

## Relationships

```
Topic (1) ──< (N) ContentItem
Topic (1) ──< (N) TriggerSignal
Profile (1) ──< (N) AbilityEstimate ── keyed by AbilityKey(class, topic)
AbilityEstimate (1) ──(1) TierGraduation     [same key]
Profile (1) ──< (N) ReviewEntry / QuizRecord
ObservationEvent ──> matches TriggerSignal ──> AbilityKey (offer candidate)
```

## Storage notes

- Profile persisted as a single JSON document (Zod-validated on read/write) under `~/.vibe-hero/profile.json`; corruption/missing ⇒ initialize empty (FR-023). SQLite is a possible later optimization; JSON is sufficient for a single-user MVP.
- Catalog cached under `~/.vibe-hero/content/` with the `CatalogManifest.version`/`etag`; bundled snapshot shipped in the package as fallback (FR-025–027).
