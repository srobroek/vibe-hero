# vibe-hero Distribution

Operational notes for publishing `@vibe-hero/server` to npm and managing the
Claude Code marketplace plugin. See `specs/002-distribution/` for the full spec
and plan.

## Installing vibe-hero (users)

vibe-hero ships as a single Claude Code plugin from this repo's marketplace.
Installing it wires up everything — the MCP server, the four skills, and the
end-of-work quiz hook — with no manual config-file edits.

```sh
# 1. Add the vibe-hero marketplace (this repo is its own marketplace)
apm marketplace add srobroek/vibe-hero

# 2. Install the plugin
apm install vibe-hero@srobroek/vibe-hero --target claude   # or your host's plugin-install gesture

# 3. In your agent, run the first-time setup (it gates everything until done)
#    e.g. ask the agent to "set up vibe-hero" → the vibe-hero-setup skill runs a short Q&A
```

What you get after install:
- **MCP server** — launched on demand via `npx -y @vibe-hero/server` (no clone, no
  build, no toolchain on your machine). First launch fetches the package once.
- **Skills** — `vibe-hero-setup`, `vibe-hero-quiz`, `vibe-hero-status`,
  `vibe-hero-learn` (talk to your agent naturally; they drive the MCP).
- **Stop hook** — auto-registered; at the end of a unit of work it may offer a
  quiz (it never interrupts mid-task, and the agent fetches the offer from the
  already-running server — no extra process is spawned).

Notes:
- **Offline**: a baseline curriculum is bundled in the package, so quizzes work
  offline. The full/updated catalog is fetched at runtime when online (set
  `VIBE_HERO_CONTENT_URL` to point at a published catalog; unset = bundled only).
- **First run needs the package cached**: the very first server launch needs
  network (or a pre-installed `@vibe-hero/server`) to fetch via npx. Air-gapped
  setups can `npm i -g @vibe-hero/server` ahead of time.
- **Version**: the plugin tracks the latest published server (`npx` floats to
  `@latest`); pin yourself if you need a fixed version.
- Your learning profile lives at `~/.vibe-hero/` (or `$VIBE_HERO_HOME`) and never
  leaves your machine.
