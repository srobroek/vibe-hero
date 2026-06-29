---
description: "Generate a Mermaid DAG of task dependencies from tasks.md"
---

# Task Dependency Diagram

Generate a Mermaid directed acyclic graph (DAG) visualizing task dependencies from tasks.md — shows which tasks block which, execution waves, and the critical path.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). The user may specify a particular feature (e.g., "003-user-auth") or request focus on a specific phase.

## Prerequisites

1. Verify a spec-kit project exists by checking for `.specify/` directory
2. Locate the current feature's `tasks.md` (by branch name or most recently modified)
3. Verify tasks.md exists and contains task entries

## Outline

1. **Parse tasks.md**: Extract all tasks with their metadata:
   - **Task ID**: e.g., `T001`, `T002`
   - **Priority**: e.g., `P1`, `P2`
   - **User Story**: e.g., `Story 1`, `Story 2`
   - **Description**: Task summary text
   - **Dependencies**: e.g., `(depends on T001, T003)`
   - **Status**: `[x]` (completed) or `[ ]` (pending)
   - **Phase**: Which phase section the task belongs to

2. **Build dependency graph**: Construct a DAG from the parsed tasks:
   - Nodes = tasks (with ID, short description, and status)
   - Edges = dependency relationships (A depends on B → edge from B to A)
   - Group by phase or execution wave

3. **Detect execution waves**: Tasks with no unresolved dependencies form Wave 1, tasks depending only on Wave 1 form Wave 2, and so on:

   | Wave | Tasks | Criteria |
   |------|-------|----------|
   | Wave 1 | Tasks with no dependencies | Can start immediately |
   | Wave 2 | Tasks depending only on Wave 1 | Start after Wave 1 completes |
   | Wave 3 | Tasks depending on Wave 1 or 2 | Start after Wave 2 completes |

4. **Identify critical path**: The longest chain of dependent tasks that determines the minimum completion time.

5. **Generate Mermaid diagram**: Output a DAG with wave-based grouping:

   ````markdown
   # Task Dependency Graph: [Feature Name]

   ```mermaid
   flowchart LR
       subgraph Wave 1
           T001[T001: Project setup ✅]
           T002[T002: Database schema ✅]
       end

       subgraph Wave 2
           T003[T003: Auth middleware ✅]
           T004[T004: API routes]
       end

       subgraph Wave 3
           T005[T005: Frontend components]
           T006[T006: Integration tests]
       end

       T001 --> T003
       T001 --> T004
       T002 --> T003
       T002 --> T004
       T003 --> T005
       T004 --> T005
       T003 --> T006
       T004 --> T006

       style T001 fill:#4CAF50,color:#fff
       style T002 fill:#4CAF50,color:#fff
       style T003 fill:#4CAF50,color:#fff
       style T004 fill:#FFC107,color:#000
       style T005 fill:#9E9E9E,color:#fff
       style T006 fill:#9E9E9E,color:#fff
   ```

   ## Legend
   - 🟢 Green — Task completed
   - 🟡 Yellow — Task ready (dependencies met, not yet done)
   - ⚪ Gray — Task blocked (waiting on dependencies)

   ## Critical Path
   T001 → T003 → T005 (3 tasks, longest chain)

   ## Statistics
   - Total tasks: 6
   - Completed: 3 (50%)
   - Ready to start: 1 (T004)
   - Blocked: 2 (T005, T006)
   - Execution waves: 3
   ````

6. **Report**: Output the diagram with critical path analysis and task statistics.

## Rules

- **Read-only** — this command never modifies any files
- **Valid DAG** — verify no circular dependencies exist before generating; if found, report the cycle
- **Status-aware** — node colors must reflect actual task completion status from tasks.md
- **Wave grouping** — group tasks by execution wave for clear parallel scheduling visualization
- **Valid Mermaid** — output must render correctly on GitHub, GitLab, and VS Code
- **Handle large task sets** — if tasks.md has 30+ tasks, group by phase and show inter-phase dependencies rather than every individual edge
- **Short labels** — use task ID and abbreviated description (max 30 chars) to keep nodes readable
