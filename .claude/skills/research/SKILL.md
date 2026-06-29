---
name: research
description: Multi-source research synthesis -- comparisons, technology evaluations, tradeoff analysis. Not for "where is X" lookups (use `explore`) or single-URL fetches (use `web-fetch`).
---

# Research

Route and coordinate multi-source research. This skill decides which tools and
delegation targets to use, then synthesizes findings into a structured report.

## Workflow

1. Clarify the research question -- narrow scope before searching.
2. Check for existing local notes or prior research.
3. Map the question to sources:
   - Codebase exploration -> delegate to **explore** skill
   - Library/framework docs -> orchestrator should pass Context7 or web search
   - Live URLs -> delegate to **web-fetch** skill
   - Deep multi-source -> delegate to **hyperresearch** wrapper
   - Independent angles -> parallel subagents
4. Synthesize findings. Distinguish facts, inferred conclusions, and open questions.
5. Save findings by default. For output format, LOAD references/report-template.md.

## Delegation

This skill coordinates -- it does not implement research directly.
Prefer primary sources over derivative summaries.
For questions a single explore or web-fetch call can answer, skip this skill and use those directly.
