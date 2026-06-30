# Runbook: Testing vibe-hero end-to-end

How to exercise every part of vibe-hero yourself: install it, get quizzed, **level
up**, get **advice/guidance**, see your **progress dashboard** (ranking / score /
level), watch the **Stop hook** offer reviews, and verify the **remote catalog**.
The steps below map natural-language prompts to what vibe-hero does.

> **One paragraph.** vibe-hero ships as a Claude Code plugin that registers an
> **MCP server** (11 tools), four **skills** (setup, quiz, status, learn), and a
> **Stop hook**. You don't call tools directly — you talk to Claude ("quiz me",
> "how am I doing?") and Claude calls the tools. The tool you're using is
> **auto-detected** from the MCP host (it does *not* ask you). Progress lives in a
> single local profile at `~/.vibe-hero/profile.json`; nothing about your code or
> prompts leaves the machine.

---

## 1. Install

For real use, install globally (see the README). For testing in one repo without
touching your global config, use `--scope project`:

```bash
cd your-project              # any git repo
claude plugin marketplace add srobroek/vibe-hero --scope project
claude plugin install vibe-hero@vibe-hero --scope project
```

Either way your profile is the same (`~/.vibe-hero/profile.json`); scope only
controls where the plugin is enabled. The plugin's `.mcp.json` launches the server
via `npx -y @vibe-hero/server` (first run downloads it once, then cached). Remove
later with `claude plugin uninstall vibe-hero --scope project` +
`claude plugin marketplace remove vibe-hero`.

Supported hosts: Claude Code, Codex, Kiro CLI, Kiro IDE. On any other host (Cursor,
Windsurf, …) vibe-hero returns an `UNSUPPORTED_TOOL` message rather than guessing.

## 2. First-run setup (clears the gate)

Say: **"Set up vibe-hero."** Claude asks only about **offer cadence**
(`off` / `per_session` / `per_topic`), **proactive offers**, and **quiz length**
(3–5). It does **not** ask which tool — that's auto-detected from the host. This
calls `save_config` and unlocks the rest.

## 3. Get quizzed and LEVEL UP

Say: **"Quiz me on subagents"** (or hooks, mcp servers, git, debugging, codex,
kiro …). Claude calls `start_quiz` (3–5 difficulty-targeted items), then
`submit_answer` per question — you'll see correct/incorrect, the **guidance**, and
your **ability before → after**. Some items are **free-form** (written answers),
judged against a rubric.

Leveling is automatic: answering harder items correctly raises your Elo ability;
crossing a tier boundary (and holding) **graduates** you:

| Tier | Level | Focus |
|------|-------|-------|
| 100 | Introductory | Remember |
| 200 | Foundational | Understand |
| 300 | Intermediate | Apply |
| 400 | Advanced | Analyze |
| 500 | Expert | Evaluate |

*Verified live:* two correct subagents answers moved ability 300 → 337 and
graduated tier 100.

## 4. Get advice / guidance (the "steering")

Say: **"Give me guidance on my weakest area"** or **"what should I learn next about
hooks?"** → `get_guidance` picks your weakest/stalest topic, reports your tier,
teaches, and recommends the next step.

## 5. The progress dashboard (ranking / score / level / details)

Say: **"How am I doing?"** → Claude calls `get_dashboard` and renders:

```
🚀  vibe-hero — Your Progress
legend  ⬜ not started  🟥 100  🟧 200  🟨 300  🟩 400  🟢 500   ▲ graduated  ⚠ due  ▽ in review

  Topic                     General   claude-code   codex   kiro-cli   kiro-ide
  subagents                   —        🟥 337 ▲      ⬜ 000    —          —
  mcp-servers                 —        🟩 432        🟨 322   ⬜ 000     ⬜ 000
  debugging                 🟧 270 ⚠     —            —        —          —
  ...
  Summary: items answered · graduated · due · streak · strongest · weakest · next
  + a full-width ability-over-time graph per scope (General, claude-code, …)
```

- **Matrix**: rows = topics, columns = **General + each tool you've touched** (added
  dynamically). Each cell = tier colour + 3-digit ability (`000` not started, `—`
  not in that scope), with `▲`/`⚠`/`▽` markers.
- **Scoring is dual-scope**: `general|<topic>` and `tool:<tool>|<topic>` are tracked
  independently — your subagents score under claude-code, debugging under General.
- **History graphs**: a simple mean-ability line per scope, stacked, from recorded
  ability snapshots.

Also: **"list all vibe-hero topics"** (`list_topics`) shows the catalog (currently
**29 topics, ~2800 items** across claude-code 8 / general 5 / codex 4 / kiro-cli 6 /
kiro-ide 6).

## 6. Stop hook + offers (incl. due-for-review)

Finish a unit of work → the **Stop hook** fires and nudges Claude to call
`get_offer`. If your recent activity matches a topic, or a topic is **due for
review** (spaced repetition — ability decays over time), Claude offers a relevant
quiz. **Due topics are offered first.** It's advisory (never interrupts), and
honors your cadence — decline and it backs off.

## 7. Verify the remote question catalog

Default = **bundled** content (works offline). To pull an updated curriculum:

```bash
export VIBE_HERO_CONTENT_URL="https://your-host/content"   # serves manifest.json + topic YAMLs
```

- **Unset** → bundled only (offline).
- **Set** → fetch → validate → cache, with two checks:
  - **ETag** revalidation: a `304` reuses the cache (cheap "did it change?").
  - **sha256 integrity**: every fetched topic's bytes are checked against the
    manifest hash; a mismatch rejects the catalog (no corrupt/tampered content
    served). On first run / no ETag, per-topic hashes decide what to fetch —
    topics whose hash already matches the bundled copy are **not** re-downloaded.
- On any failure it **falls back** silently to cache, then bundled — no error.
- A fetched topic is **served to the full loop**: it's listed *and* quizzable
  (this was a bug — remote topics used to list but not be quizzable — now fixed).

`content/manifest.json` (per-topic `id`, `class`, `file`, `itemCount`, `tiers`,
`sha256`) is generated at build/CI time by `packages/server/scripts/gen-manifest.mjs`.

**Local proof:**
```bash
cd a-dir-with/manifest.json+topic-yamls && python3 -m http.server 8899 &
export VIBE_HERO_CONTENT_URL="http://127.0.0.1:8899"
# in a Claude session: "list topics" → your remote topic appears;
#                       "quiz me on <remote topic>" → you get its questions.
```

## 8. Inspect your profile (optional)

```bash
cat ~/.vibe-hero/profile.json     # or $VIBE_HERO_HOME/profile.json
```
`config`, `abilities` (per scope×topic Elo), `graduations`, `reviewSchedule`,
`quizHistory`, `abilitySnapshots` (the dashboard time series), `offers`. Only
derived scores — **no prompts, code, or tool I/O** (privacy by design).

## Troubleshooting

- **"Run vibe-hero setup first"** — configure once (step 2).
- **`UNSUPPORTED_TOOL`** — your host isn't one of the four supported tools.
- **No quiz offered** — expected if cadence is `off`, already offered this session,
  or recent activity matched no topic. Just ask "quiz me on X".
