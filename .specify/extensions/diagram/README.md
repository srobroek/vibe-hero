# spec-kit-diagram

A [Spec Kit](https://github.com/github/spec-kit) extension that auto-generates Mermaid diagrams for SDD workflow visualization, feature progress tracking, and task dependency graphs.

## Problem

Spec Kit projects grow quickly — multiple features, dozens of tasks, complex dependency chains. Teams struggle with:

- No visual overview of the SDD workflow or where a project currently stands
- No way to see all features and their progress at a glance
- Task dependencies in tasks.md are text-based and hard to reason about
- New team members cannot quickly understand the project's lifecycle state
- No visual aid for sprint planning or stakeholder updates

## Solution

The Diagram extension adds three commands that generate GitHub-renderable Mermaid diagrams:

| Command | Purpose | Modifies Files? |
|---------|---------|-----------------|
| `/speckit.diagram.workflow` | Visualize the full SDD lifecycle with phase status | No — read-only |
| `/speckit.diagram.status` | Show feature progress across all SDD phases | No — read-only |
| `/speckit.diagram.dependencies` | Visualize task dependency DAG with execution waves | No — read-only |

## Installation

```bash
specify extension add --from https://github.com/Quratulain-bilal/spec-kit-diagram-/archive/refs/tags/v1.0.0.zip
```

## Commands

### `/speckit.diagram.workflow`

Generates a Mermaid flowchart of the complete SDD workflow:

- Shows all phases: Constitution → Specify → Plan → Tasks → Implement → Verify
- Color-codes phases by status (completed, in-progress, not started)
- Includes feedback loops and iteration paths (e.g., refine → re-plan)
- Adapts to installed extensions (adds refine, reconcile nodes if present)

### `/speckit.diagram.status`

Generates a Mermaid Gantt chart showing feature progress:

- Lists every feature under `specs/` with its current phase
- Shows task completion percentage for features in the Implement phase
- Identifies stale or blocked features
- Provides a summary table with progress stats

### `/speckit.diagram.dependencies`

Generates a Mermaid DAG from tasks.md:

- Parses task IDs, dependencies, and completion status
- Groups tasks into execution waves (parallel scheduling)
- Identifies the critical path (longest dependency chain)
- Color-codes by status: completed (green), ready (yellow), blocked (gray)
- Reports statistics: total, completed, ready, blocked tasks

## Workflow

```
/speckit.diagram.workflow      ← See the full SDD lifecycle
       │
       ▼
/speckit.diagram.status        ← Track feature progress
       │
       ▼
/speckit.diagram.dependencies  ← Visualize task dependencies
```

## Output Format

All diagrams use [Mermaid](https://mermaid.js.org/) syntax that renders natively on:
- GitHub (README, issues, PRs, wikis)
- GitLab
- VS Code (with Mermaid extension)
- Notion, Obsidian, and other Markdown tools

## Hooks

The extension registers an optional hook:

- **after_tasks**: Auto-generates a task dependency diagram after task breakdown

## Design Decisions

- **Read-only** — all three commands produce output without modifying any files
- **Mermaid syntax** — renders natively on GitHub, no external tools needed
- **Status-aware** — diagrams reflect actual project state, not static templates
- **Wave-based grouping** — dependency diagrams group tasks by execution wave for clear parallel scheduling
- **Scalable** — large task sets are grouped by phase to keep diagrams readable

## Requirements

- Spec Kit >= 0.4.0

## Related

- Issue [#467](https://github.com/github/spec-kit/issues/467) — SpecKit Workflow Diagram (50+ upvotes)

## License

MIT
