---
name: vibe-hero-status
description: Run when the user asks "where am I with vibe-hero", "what's my progress", "what's my standing on <tool>", "how am I doing with <tool>", "what level am I at", or any question about their current learning status or topic tiers. Works across Claude Code, Codex, and Kiro.
---

# vibe-hero Status

This skill shows the user's current learning standing for a tool (or all tools)
by calling `get_status`. It is pull-based and read-only — no quiz is started.

## When to invoke

- The user asks where they stand, what their progress is, or what level they are.
- The user asks about their status on a specific tool (e.g. "how am I doing with
  Claude Code?").
- The user asks which topics are weak, stale, or due for review.

## Steps

### 1. Check for a named tool

If the user names a specific tool in their request, pass it as the `tool`
argument. If no tool is named, omit the argument and the server returns status
for all configured tools.

### 2. Call `get_status`

```
get_status({ tool?: ToolId })
```

### 3. Handle SETUP_REQUIRED

If the response is `{ "status": "SETUP_REQUIRED" }`, stop and tell the user:

> "vibe-hero isn't configured yet. Run the **vibe-hero-setup** skill first — it
> only takes a minute — then come back to check your status."

Do not proceed further until setup completes.

### 4. Render the status

Present the per-topic results clearly. For each topic in `topics`:

- Show the **title**, current **tier** (or "not started"), and **status**
  (`current`, `due_for_review`, or `not_started`).
- If `status` is `due_for_review`, flag it visibly (e.g. "review due").
- Show the **ability** value if it adds context.

Then call out:

- **Due for review**: list any topics from `dueForReview` by name.
- **Suggestions**: summarize any entries in `suggestions` — each carries a
  `reason` explaining why the server is surfacing that topic.

### 5. Offer a next action

After the summary, offer the user a natural next step. For example:

> "Want guidance on one of these topics, or shall I quiz you on something? You
> can also ask 'what should I learn next?' for a recommendation."

## Notes for the host agent

- This skill is read-only. Do not call `start_quiz` or `get_guidance` unless the
  user explicitly asks for that next step.
- If the user names a tool that has no content yet, the server may return an
  empty `topics` array — surface that clearly rather than showing a blank
  response.
- Keep the tone informational and encouraging; the user is checking in on their
  own growth.
