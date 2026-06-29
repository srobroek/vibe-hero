---
name: speckit-setup
description: Bootstrap a SpecKit project end-to-end -- scaffold .specify/, register the community extension catalog, install and enable all required extensions and workflow definitions. Use when setting up SpecKit in a repo, when /speckit.* commands are missing, or when the user asks to initialize/enable SpecKit.
---

# SpecKit Setup

Automates the one-time SpecKit project bootstrap that otherwise has to be done by hand.
Runs `scripts/setup-speckit.sh`, which is idempotent (safe to re-run).

## When to use

- A repo needs SpecKit but `.specify/` doesn't exist yet.
- `/speckit.*` slash commands are missing or extensions are not installed.
- The user asks to "set up / initialize / enable SpecKit".

## What it does

`scripts/setup-speckit.sh` performs five steps:

1. **`specify init --here`** -- scaffolds `.specify/` (constitution, feature dirs, workflow
   state). Defaults to `--integration codex --script sh`; override with `--integration` /
   `--script`. The DAG hooks key off `.specify/feature.json` (or the git branch) to resolve
   the active feature, so this scaffold is a prerequisite.
2. **Register the community catalog** -- `specify extension catalog add --name community
   --install-allowed <catalog.community.json>`.
3. **Install + enable the 28 required extensions** -- `agent-assign`, `archive`, `brownfield`,
   `bugfix`, `checkpoint`, `cleanup`, `conduct`, `critique`, `diagram`, `doctor`, `fix-findings`,
   `fleet`, `github-issues`, `iterate`, `onboard`, `optimize`, `qa`, `reconcile`,
   `refine`, `retro`, `review`, `roadmap`, `security-review`, `status`, `tinyspec`, `verify`,
   `verify-tasks`, `worktree`. `agent-assign` is mandatory: steering routes implementation
   through it and the DAG hard-blocks the deprecated `/speckit.implement`. Most install from
   the community catalog by name. The setup list also supports inline custom sources for
   extensions whose catalog version lags upstream: `name=<archive-url>` (install a specific
   archive via `specify extension add NAME --from <url>`) or `name=latest-release:<owner>/<repo>`
   (resolve the newest GitHub release tag at setup time and install its archive — tracks
   latest without pinning). Custom-source installs are best-effort: an unreachable source
   warns and is skipped rather than aborting setup.
4. **Register extension commands for the requested integration** -- `specify extension add`
   only renders an extension's command files for the integration active at add-time, and
   `specify integration switch` re-registers all extensions only on a *genuine* switch
   (switch-to-self is a no-op). If extensions were added under a different integration than
   the one requested (e.g. the default `codex` init, then later `claude`), their commands are
   never rendered for the requested agent and a naive re-run won't fix it. This step forces a
   (re-)registration: one switch if the requested integration isn't active, or a
   bounce-through-another-integration-and-back if it already is. Offline (reads the local
   registry).
5. **Install workflow definitions** -- `speckit`, `speckit-quality`, `speckit-full`, via
   `specify workflow add` from this package's local `workflows/<id>/` dirs. Since spec-kit
   0.11.x, workflows are a first-class primitive, not extensions. The local `speckit` definition
   overrides the upstream `Full SDD Cycle` that `specify init` bundles, and routes implementation
   through the agent-assign flow instead of the deprecated `/speckit.implement`.

## How to run

```bash
# from the project root, after `uv tool install specify-cli`
bash scripts/setup-speckit.sh                 # defaults: codex integration, sh scripts
bash scripts/setup-speckit.sh --integration claude --script sh
bash scripts/setup-speckit.sh --force         # re-scaffold even if .specify/ exists
```

Then install this repo's orchestration bundle (agents + DAG hooks -- the layer that enforces
the workflow) and compile:

```bash
apm install speckit@<marketplace> --target claude,codex,agent-skills
apm compile --target codex,claude --no-constitution
```

Start the workflow with `/speckit.specify`.

## The workflow DAG

The orchestration layer (shipped by the `speckit-dag` skill) enforces a fixed graph: every
step is mandatory by default, ordering is fixed, and a hook layer hard-blocks out-of-order or
precondition-violating moves. Edges and conditions live in `speckit-dag-hooks/scripts/nodes.json`
(each node has a `pre` block with predecessors + preconditions and a `post` block with successors
+ postconditions).

```mermaid
flowchart TD
    classDef gate fill:#fff3cd,stroke:#d39e00,color:#333;
    classDef interactive fill:#cfe2ff,stroke:#0d6efd,color:#333;
    classDef auto fill:#e2e3e5,stroke:#6c757d,color:#333;
    classDef parallel fill:#d1e7dd,stroke:#198754,color:#333;

    subgraph P1["Phase 1 -- Specification (human-gated)"]
        direction TB
        S1["1 specify"]:::gate --> S2["2 clarify"]:::interactive
        S2 --> S3["3 plan"]:::gate
        S3 --> S4["4 tasks"]:::gate
        S4 --> S5["5 checklist"]:::interactive
        S5 --> S5b["5b critique.run"]:::parallel
        S5 --> S5c["5c security-review"]:::parallel
        S5b --> S6["6 analyze"]:::interactive
        S5c --> S6
        S6 --> S7["7 taskstoissues"]:::auto
        S7 --> S8["8 checkpoint.commit"]:::auto
    end

    subgraph P2["Phase 2 -- Implementation"]
        direction TB
        A9a["9a agent-assign.assign"]:::gate --> A9b["9b agent-assign.validate"]:::auto
        A9b --> A9c["9c agent-assign.execute<br/>(per-task subagents, checkpoint each)"]:::auto
    end

    subgraph P3["Phase 3 -- Post-implementation quality (ALL mandatory)"]
        direction TB
        V10["10 verify-tasks"]:::auto --> V11["11 verify"]:::auto
        V11 --> RR["11b review.run"]:::auto --> QA["11c qa.run"]:::auto
        QA --> CR12["12 code-review"]:::parallel --> CL14
        QA --> SR13["13 security-review"]:::parallel --> CL14["14 cleanup"]:::auto
        CL14 --> SY15["15 sync.analyze"]:::parallel
        CL14 --> SY16["16 sync.conflicts"]:::parallel
        SY15 --> R17["17 retro.run"]:::auto
        SY16 --> R17
        R17 --> D18["18 docs update"]:::auto
        D18 --> C19["19 checkpoint.commit"]:::auto
    end

    S8 --> A9a
    A9c --> V10

    ITER["iterate.define -> iterate.apply<br/>(MANDATORY once tasks.md exists)"]:::interactive
    A9c -. "requirements change /<br/>approach won't work" .-> ITER
    P3 -. "scope change" .-> ITER
    ITER -. "resume at trigger step" .-> S4
```

Legend: yellow = approval gate - blue = interactive (needs user) - green = runs parallel with
its pair - grey = automatic. Dashed edges = the iterate loop.

## Step reference (mirrors the pre/post node store)

Each row is a `/speckit.<step>` command. "Next (default -> conditions)" reflects the
`post.md` successor edges; conditional branches are noted.

| Step | What it does | Produces | Next (default -> conditions) |
|------|-------------|----------|-----------------------------|
| `specify` | Create spec.md from requirements | `spec.md` | `clarify` - one-paragraph -> `tinyspec.classify`; bug -> `bugfix.report` |
| `clarify` | Interactive requirements clarification | `clarifications.md` | `plan` |
| `plan` | Architecture & implementation plan | `plan.md` | `tasks` -> `critique.run` if user requests critique first |
| `tasks` | Task breakdown with dependency graph | `tasks.md` | `checklist` |
| `checklist` | Requirements-quality gate over spec + plan + tasks | `checklist.md` | `critique.run` + `security-review` (parallel) -> `diagram.dependencies` if both skipped |
| `critique.run` | Plan/task quality critique | critique notes | `analyze` |
| `security-review` (5c) | Security review of plan/tasks | findings | `analyze` |
| `analyze` | Risk analysis, resolve gaps | (resolved gaps) | `taskstoissues` |
| `taskstoissues` | Create GitHub/GitLab issues | issues | `checkpoint.commit` |
| `checkpoint.commit` (8) | Snapshot before implementation | commit | `agent-assign.assign` |
| `agent-assign.assign` | Route each task to a specialized subagent | `agent-assignments.yml` | `agent-assign.validate` |
| `agent-assign.validate` | Validate agent assignments (read-only) | (no artefact; stdout report) | `agent-assign.execute` |
| `agent-assign.execute` | Per-task subagent execution, checkpoint each | code + `task-<n>.report.md` | `verify-tasks` -> `verify` if verify-tasks skipped; scope change -> `iterate` |
| `verify-tasks` | Detect phantom completions (fresh context) | `verify-tasks-report.md` | `verify` |
| `verify` | Validate code against FR/SC | `verify-report.md` | `review.run` |
| `review.run` (11b) | Full review cycle | findings | `qa.run` -> `fix-findings` if findings (after triage) |
| `qa.run` (11c) | QA retest of the implementation | QA results | `code-review` + `security-review` (parallel) -> `fix-findings` if failed |
| `code-review` (12) | General code-quality review | findings | `cleanup` (with 13 clean) |
| `security-review` (13) | Security/compliance review | findings | `cleanup` (with 12 clean) |
| `cleanup` | Auto-fix small issues, file issues for large | `cleanup-report.md` | `sync.analyze` |
| `sync.analyze` | Detect spec<->code drift | `sync-report.md` | `sync.conflicts` |
| `sync.conflicts` | Detect inter-spec contradictions | findings | `retro.run` |
| `retro.run` | Retrospective (needs full session context) | retro notes | docs update |
| `checkpoint.commit` (19) | Final commit | commit | (done) |
| `iterate.define` / `iterate.apply` | Scope change (MANDATORY once tasks.md exists) | `pending-iteration.md`, updated spec/plan/tasks | resume at the step where the change was triggered |

This table covers the default workflow path. The node store guards ~74 commands
in total, including optional/diagnostic ones (`status.*`, `doctor`, `diagram.*`,
`tinyspec.*`, `bugfix.*`, `worktree.*`, ...). Run
`/speckit.status.show` for the current state, or see the steering-speckit
Command Reference for the full list.

## Rules

- This skill only bootstraps the upstream spec-kit side. The orchestration that ENFORCES the
  DAG (agents, hooks, node store) comes from the APM `speckit` bundle -- install it too.
- Do not hand-edit `.specify/` scaffolding or invent extension ids; the set above is what the
  DAG nodes expect. Keep the extension list in sync with the script's `EXTENSIONS` array.
- The script is idempotent; prefer re-running it over partial manual fixes.
