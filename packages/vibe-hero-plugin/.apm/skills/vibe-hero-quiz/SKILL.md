---
name: vibe-hero-quiz
description: Run when the user wants to take a quiz, says "quiz me", "test me", accepts a quiz offer, or asks for a knowledge check on a topic or tool. Drives the start_quiz / submit_answer loop and judges free-form answers strictly against the MCP-supplied rubric. Works across Claude Code, Codex, and Kiro.
---

# vibe-hero Quiz

This skill runs a quiz session: it calls `start_quiz`, presents each item to the
user one at a time, collects an answer, and submits it via `submit_answer`. The
MCP server is the scoring authority — it grades deterministic items itself and
computes the free-form score from the **per-criterion verdict** the host agent
returns. The host agent never sets the score directly.

## When to invoke

- The user asks to take a quiz, says "quiz me", "test me", or "check my knowledge".
- The user accepts a quiz offer surfaced at an end-of-work breakpoint.
- The user asks for a knowledge check on a named topic or tool.
- Another skill (`vibe-hero-learn`) hands off because the user wants to practice.

## Steps

### 1. Identify the topic key

Pass the topic `key` (an `AbilityKey`) the user named, or the `key` handed off
from `get_guidance`. If the user only named a tool, use `vibe-hero-status` or
`get_guidance` to resolve a concrete topic `key` first.

### 2. Call `start_quiz`

```
start_quiz({ key: AbilityKey, length?: 3|4|5, allowFreeForm?: boolean })
```

- Omit `length` to use the user's configured default.
- `allowFreeForm` defaults to `true`. Set it to `false` **only** if you (the host
  agent) genuinely cannot judge free-form answers in this environment; the server
  then defers/substitutes a deterministic item instead (FR-014). Do not set it
  false merely to avoid the work of judging.

The result is `{ quizId, items: PresentedItem[] }`. Each `PresentedItem` =
`{ itemId, tier, type, prompt, choices?, rubric?, referenceAnswer? }`.

If the response is `{ "status": "SETUP_REQUIRED" }`, stop and tell the user to
run the **vibe-hero-setup** skill first; do not proceed until setup completes.

### 3. Present items one at a time

Show **one** item, wait for the user's answer, submit it, relay the result, then
move to the next. Never show the next prompt before the current one is graded.
**Never reveal the correct answer, the choice key, the rubric, or the reference
answer before the user has answered** — that defeats the assessment.

### 4a. Deterministic items (`multiple_choice` / `short_answer`)

These have **no** `rubric` and **no** `referenceAnswer`. Collect the user's
answer and submit it as-is; the engine grades it:

```
submit_answer({ quizId, itemId, answer: { choiceId } })   // multiple_choice
submit_answer({ quizId, itemId, answer: { text } })       // short_answer
```

### 4b. Free-form items (`free_form`) — JUDGE STRICTLY

Free-form items include `rubric.criteria` (an array of `{ id, text }`) **and** a
`referenceAnswer`. You are the judge. Evaluate the user's answer **strictly
against each criterion**, comparing to the reference answer, and return a verdict
covering **every** criterion id:

```
submit_answer({
  quizId, itemId,
  verdict: { criteria: [ { id, met: boolean, justification }, ... ] }
})
```

Judging rules — follow exactly:

- **One verdict per criterion.** Include every `id` from `rubric.criteria`. A
  missing or extra id is non-conformant. A single overall boolean is rejected.
- **Strict and honest, not lenient.** A criterion is `met: true` only if the
  user's answer actually demonstrates it. When in doubt, mark `met: false`. Do
  not give credit for things the user did not say.
- **Compare to the supplied reference answer**, not to your own opinion of a good
  answer. The rubric and reference are authoritative; do not invent or relax
  criteria.
- **Justify each verdict in one line** citing what the user did or did not say
  (e.g. "User named the cache-control header but not the 5-minute TTL").
- **Do not rubber-stamp.** Marking all criteria `met` without genuine assessment
  defeats the entire purpose — the score the user sees depends on your honesty.
  Partial credit is expected and fine; the MCP computes the score from the
  fraction of criteria met versus the pass threshold.

### 5. Relay the result after each submit

`submit_answer` returns `{ grade, score, correctAnswer?, guidance, ability,
graduation? }`. After each item:

- Tell the user whether they got it right (`grade`) and, for free-form, which
  criteria they met/missed from your verdict.
- Now it is fine to show `correctAnswer` and the `guidance` text — present the
  guidance in full so the user learns from the miss.
- If `graduation.changed` is `true`, announce the tier/status change and the
  `reason` (e.g. "You've graduated to the next tier on this topic").

### 6. Close the session

After the last item, give a short recap: how many correct, any tier change, and
offer a natural next step (review a weak topic, get guidance, or quiz again).

## Notes for the host agent

- The MCP is the scoring chokepoint. You report observations (verdict criteria);
  the server decides the score, applies the Elo update, and emits graduation.
- Only completed submissions count. If the user abandons mid-quiz, nothing is
  recorded for the unanswered items.
- The server persists only the derived grade/score — never the user's raw answer
  text. Do not paraphrase or store answers yourself.
- Keep the tone encouraging; a missed item is a learning moment, and accurate
  judging is what makes the user's progress meaningful.
