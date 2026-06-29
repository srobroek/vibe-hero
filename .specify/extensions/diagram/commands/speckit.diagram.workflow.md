---
description: "Generate a Mermaid flowchart of the full SDD workflow for the current project"
---

# Workflow Diagram

Generate a Mermaid flowchart showing the complete Spec-Driven Development workflow for the current project — which phases exist, what artifacts are generated, and the review/verification loops.

## User Input

```text
$ARGUMENTS
```

You **MUST** consider the user input before proceeding (if not empty). The user may request a specific focus (e.g., "just the implement phase") or output format.

## Prerequisites

1. Verify a spec-kit project exists by checking for `.specify/` directory
2. Check which artifacts and features exist to determine project state

## Outline

1. **Scan project state**: Detect which SDD phases have been completed:
   - **Constitution**: Check for `.specify/constitution.md`
   - **Specify**: Check for `specs/*/spec.md` files
   - **Plan**: Check for `specs/*/plan.md` files
   - **Tasks**: Check for `specs/*/tasks.md` files
   - **Implement**: Check for completed tasks (`[x]` items in tasks.md)
   - **Verify**: Check for verification artifacts or checklist completions
   - **Extensions**: Check `.specify/extensions/` for installed extensions

2. **Build workflow graph**: Construct a Mermaid flowchart with these elements:

   - **Phases as nodes**: Each SDD phase is a node with status indicator
   - **Artifacts as sub-nodes**: Files generated at each phase
   - **Transitions as edges**: Arrows showing the flow between phases
   - **Current position**: Highlight the active phase
   - **Feedback loops**: Show iteration paths (e.g., refine → re-plan → re-task)

3. **Generate Mermaid diagram**: Output a fenced Mermaid code block:

   ````markdown
   # SDD Workflow Diagram

   ```mermaid
   flowchart TD
       A[🏛️ Constitution] -->|defines governance| B[📋 Specify]
       B -->|generates| B1[spec.md]
       B -->|next phase| C[📐 Plan]
       C -->|generates| C1[plan.md]
       C -->|next phase| D[📝 Tasks]
       D -->|generates| D1[tasks.md]
       D -->|next phase| E[🔨 Implement]
       E -->|builds from| D1
       E -->|next phase| F[✅ Verify]
       F -->|validates against| B1

       E -->|issues found| G[🔄 Refine]
       G -->|updates| B1
       G -->|propagates to| C1
       G -->|propagates to| D1
       G -->|resume| E

       style A fill:#4CAF50,color:#fff
       style B fill:#4CAF50,color:#fff
       style C fill:#4CAF50,color:#fff
       style D fill:#FFC107,color:#000
       style E fill:#9E9E9E,color:#fff
       style F fill:#9E9E9E,color:#fff
   ```

   ## Legend
   - 🟢 Green — Phase completed
   - 🟡 Yellow — Phase in progress
   - ⚪ Gray — Phase not started
   ````

4. **Adapt to project context**: Customize the diagram based on what exists:
   - If extensions are installed (e.g., refine, reconcile), add their workflow nodes
   - If multiple features exist, show them as parallel swim lanes or note the count
   - If hooks are configured, show them as intermediate steps

5. **Report**: Output the Mermaid diagram with a brief explanation of the current workflow state.

## Rules

- **Read-only** — this command never modifies any files, output is to the conversation only
- **Mermaid syntax only** — output must be valid Mermaid flowchart syntax that renders on GitHub, GitLab, and VS Code
- **Status-aware** — node colors must reflect actual project state (completed, in-progress, not started)
- **Include all phases** — show the full lifecycle even if some phases are not yet reached
- **Show feedback loops** — include iteration and refinement paths, not just the happy path
- **Readable** — keep the diagram clean with clear labels, avoid overcrowding with too many nodes
