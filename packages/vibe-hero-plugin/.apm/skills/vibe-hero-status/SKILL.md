---
name: vibe-hero-status
description: Run when the user asks "where am I with vibe-hero", "what's my progress", "what's my standing on <tool>", "how am I doing with <tool>", "what level am I at", or any question about their current learning status or topic tiers. Works across Claude Code, Codex, and Kiro.
---

# vibe-hero Status

This skill shows the user's full progress dashboard by calling `get_dashboard`
(and optionally `get_status` for a quick text summary). It is pull-based and
read-only — no quiz is started.

## When to invoke

- The user asks where they stand, what their progress is, or what level they are.
- The user asks about their status on a specific tool (e.g. "how am I doing with
  Claude Code?").
- The user asks which topics are weak, stale, or due for review.
- The user asks for a progress dashboard or overview.

## Steps

### 1. Check for a named tool

If the user names a specific tool in their request, pass it as the `tool`
argument. If no tool is named, omit the argument.

### 2. Call `get_dashboard`

```
get_dashboard({ tool?: ToolId })
```

### 3. Handle SETUP_REQUIRED

If the response is `{ "status": "SETUP_REQUIRED" }`, stop and tell the user:

> "vibe-hero isn't configured yet. Run the **vibe-hero-setup** skill first — it
> only takes a minute — then come back to check your status."

Do not proceed further until setup completes.

### 4. Render the dashboard

Render the result using EXACTLY this template (fixed-width, aligned):

```
╔══════════════════════════════════════════════════════════════╗
║  🚀  vibe-hero Progress Dashboard                            ║
╚══════════════════════════════════════════════════════════════╝

Legend:
  ⬜ not started   🟥 100   🟧 200   🟨 300   🟩 400   🟢 500
  ▲ graduated   ⚠ due   ▽ in review
```

#### 4a. Matrix table

Emit one header row listing all scopes and one data row per topic.
Left-align the topic title column (pad to 24 chars). Each cell shows:
- The tier emoji (`⬜`/`🟥`/`🟧`/`🟨`/`🟩`/`🟢`) — use `⬜` for tier 0.
- The 3-digit ability score (e.g. `312`) — `000` if ability ≤ 0 or topic not
  started, `—` (em-dash) if `status === "not_in_scope"`.
- A text marker immediately after the score: `▲` if `markers` contains
  `"graduated"`, `⚠` if it contains `"due"`, `▽` if it contains `"in_review"`,
  blank otherwise.

Example (with two scopes):

```
Topic                    | General        | claude-code
-------------------------|----------------|----------------
Placeholder Topic        | 🟥 180 ⚠      | 🟥 180 ⚠
```

#### 4b. Summary block

```
Items answered : <itemsAnswered>
Graduated      : <graduated>
Due for review : <dueForReview>
Streak         : <streak> correct in a row
Strongest      : <strongest topic title or "—">
Weakest        : <weakest topic title or "—">
Next suggested : <next topic title or "—">
```

#### 4c. History graphs

For each entry in `history` (General first, then tools), emit a single-line
ASCII sparkline graph — ONE per scope, stacked vertically, FULL-WIDTH.

- y-axis range: 200–600 (ability), quantized to 8 levels using block chars
  `▁▂▃▄▅▆▇█`.
- x-axis: ISO dates of snapshots, shown beneath the line.
- Label each line with the scope name.

Example:

```
General     ▁▂▃▄▃▄▅▆
claude-code ▁▁▂▃▄▄▅▅
```

If `history` is empty (no quizzes completed yet), print:
```
No history yet — complete a quiz to start tracking ability over time.
```

### 5. Offer a next action

After the dashboard, offer the user a natural next step. For example:

> "Want guidance on one of these topics, or shall I quiz you on something? You
> can also ask 'what should I learn next?' for a recommendation."

## Notes for the host agent

- This skill is read-only. Do not call `start_quiz` or `get_guidance` unless the
  user explicitly asks for that next step.
- If `matrix` is empty, the user has no content for the requested scope — surface
  that clearly.
- Keep the tone informational and encouraging; the user is checking in on their
  own growth.
- The history graph is a single sparkline per scope (one text line each), not a
  multi-line chart. Keep it compact.
