---
name: speckit-diagram-status
description: Generate a Mermaid diagram showing feature progress across SDD phases
compatibility: Requires spec-kit project structure with .specify/ directory
metadata:
  author: github-spec-kit
  source: diagram:commands/speckit.diagram.status.md
---

# Feature Status Diagram

Generate a Mermaid diagram showing the progress of all features across the SDD lifecycle phases — a visual dashboard of what is specified, planned, tasked, implemented, and verified.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). The user may specify a particular feature to focus on or request a specific diagram style.

## Prerequisites

1. Verify a spec-kit project exists by checking for `.specify/` directory
2. Locate all feature directories under `specs/`

## Outline

1. **Scan all features**: For each directory under `specs/`, check which artifacts exist:

   | Artifact | Phase | Check |
   |----------|-------|-------|
   | `spec.md` | Specify | File exists |
   | `plan.md` | Plan | File exists |
   | `tasks.md` | Tasks | File exists |
   | Tasks completed | Implement | Count `[x]` vs `[ ]` in tasks.md |
   | `checklist.md` | Verify | File exists or all tasks completed |

2. **Calculate progress**: For each feature, determine:
   - **Phase**: Which SDD phase the feature is currently in
   - **Completion %**: For implementation, calculate task completion percentage
   - **Status**: Active (current branch), stale (has staleness warnings), or complete

3. **Generate Mermaid diagram**: Output a Gantt-style or quadrant diagram:

   ````markdown
   # Feature Progress Dashboard

   ```mermaid
   gantt
       title SDD Feature Progress
       dateFormat X
       axisFormat %s

       section 003-user-auth
       Specify     :done, spec1, 0, 1
       Plan        :done, plan1, 1, 2
       Tasks       :done, task1, 2, 3
       Implement   :active, impl1, 3, 4
       Verify      :veri1, 4, 5

       section 004-chat-system
       Specify     :done, spec2, 0, 1
       Plan        :done, plan2, 1, 2
       Tasks       :task2, 2, 3
       Implement   :impl2, 3, 4
       Verify      :veri2, 4, 5

       section 005-api-gateway
       Specify     :done, spec3, 0, 1
       Plan        :plan3, 1, 2
       Tasks       :task3, 2, 3
       Implement   :impl3, 3, 4
       Verify      :veri3, 4, 5
   ```

   ## Summary
   | Feature | Phase | Tasks | Progress |
   |---------|-------|-------|----------|
   | 003-user-auth | Implement | 12/18 | 67% |
   | 004-chat-system | Plan | 0/0 | — |
   | 005-api-gateway | Specify | 0/0 | — |
   ````

4. **Alternative: Pie chart per feature** (if user requests or single feature):

   ````markdown
   ```mermaid
   pie title 003-user-auth Task Progress
       "Completed" : 12
       "Remaining" : 6
   ```
   ````

5. **Report**: Output the diagram with a summary table showing each feature's current phase and task completion stats.

## Rules

- **Read-only** — this command never modifies any files
- **Show all features** — include every feature directory found under `specs/`
- **Accurate status** — phases must reflect actual artifact existence, not assumptions
- **Valid Mermaid** — output must render correctly on GitHub, GitLab, and VS Code
- **Handle empty projects** — if no features exist, show an empty dashboard with instructions to run `/speckit.specify`
- **Sort features** — list features in branch number order (ascending)