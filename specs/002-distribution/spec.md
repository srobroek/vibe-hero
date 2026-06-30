# Feature Specification: vibe-hero Distribution — npm + Claude Code Marketplace

**Feature Branch**: `002-distribution`

**Created**: 2026-06-29

**Status**: Draft

**Input**: Package and distribute the vibe-hero MVP (spec 001) so users can install it with one gesture instead of manual setup: publish the MCP server to npm, and bundle the skills + Stop hook + offline content as a Claude Code plugin served from an APM-managed marketplace, with a CI/CD release pipeline.

## Overview

Spec 001 produced a working system whose artifacts — the MCP server (`packages/server`), four skills (`skills/`), the Stop hook (`hooks/claude-code/`), and curriculum content (`content/`) — currently sit as separate pieces a user must wire up by hand. This spec makes vibe-hero **distributable**: a published npm package for the server and a single installable Claude Code plugin that bundles everything else, released automatically through CI.

Two delivery channels, one product:
1. **npm** — `@vibe-hero/server` is published to the public npm registry. It exposes a `bin` that both starts the MCP server (over stdio) and serves the Stop-hook query. The plugin launches it with `npx`, so installing users need no build step or toolchain.
2. **Claude Code marketplace** — a single plugin (sourced from this repo, with an APM marketplace manifest at the repo root) bundles the four skills, the Stop hook (auto-registered, no manual settings edit), an `.mcp.json` that npx-launches the published server, and an offline content snapshot. The plugin is also **cross-publishable** into the existing `srobroek/agentic-packages` marketplace.

Distribution decisions resolved with the user (2026-06-29): single combined plugin; one `vibe-hero` npm bin with subcommands (default → MCP server, `get-offer` → Stop hook); the npm build copies the real `content/` curriculum into the package as the offline snapshot; marketplace lives at this repo's root and may be cross-registered in agentic-packages.

This spec covers **packaging, publishing, and release automation only** — it does not change any learning behavior from spec 001.

## Clarifications

### Session 2026-06-29

- Q: Where does the marketplace live? → A: In THIS repo (`.claude-plugin/marketplace.json` + APM at root); ALSO cross-publishable into `srobroek/agentic-packages`.
- Q: Plugin packaging shape? → A: ONE combined Claude Code plugin (skills + Stop hook + `.mcp.json` npx-launching the server + offline content snapshot). The server is the only separately-published (npm) artifact.
- Q: What does `@vibe-hero/server`'s `bin` expose? → A: A SINGLE bin `vibe-hero` — default (or `mcp`) starts the stdio MCP server (the primary use, `npx -y @vibe-hero/server`); an OPTIONAL `get-offer` subcommand remains for non-Claude-Code hosts/debugging. (Note: post-critique, the Claude Code Stop hook is agent-mediated and does NOT call `get-offer` — see the Stop-hook clarification below.)
- Q: How does offline content get into the npm package? → A: The npm build COPIES the repo's real `content/` (claude-code + general topics) into the package as the bundled offline snapshot; runtime GitHub fetch (`VIBE_HERO_CONTENT_URL`) still layers updates on top.
- Q: How does CI authenticate to npm? → A: **npm Trusted Publishers (OIDC)** — NOT a long-lived `NPM_TOKEN` secret. GitHub Actions authenticates via a short-lived OIDC token tied to the repo + publish workflow (workflow needs `permissions: id-token: write`); the trusted publisher is configured once on npmjs.com linking the package to `srobroek/vibe-hero` + the workflow. No publish secret is created, stored, or at risk of leaking, and npm provenance attestation is emitted automatically.
- Q: What triggers a release in CI? → A: **Release-PR gate (release-please style)**, matching `agentic-packages`. Merges to main accumulate into a bot-maintained release PR; merging THAT PR cuts the version, publishes to npm (via OIDC), and regenerates/commits the marketplace + plugin artifacts. The release PR is the human approval point and the single version source-of-truth.
- Q: How does the plugin pin the npx-launched server version? → A: **Floating `latest`** — the plugin's `.mcp.json` invokes `npx -y @vibe-hero/server` with NO version, always resolving the newest published version (auto-distributes updates; no user-critical payload; users may pin themselves). A documented rollback procedure (deprecate / dist-tag) handles a bad publish (FR-012a). (Post-critique: the Stop hook no longer launches the server — see the agent-mediated decision below — so there is only ONE version reference, in `.mcp.json`.)
- Q: Should the Stop hook spawn a process to fetch the offer? → A: **No (post-critique E3)** — a hook cannot reach the running stdio MCP server, and spawning `npx … get-offer` every turn-end is a hot-path latency/hang risk. The hook is **agent-mediated**: it emits an `additionalContext` nudge and the agent calls the `get_offer` MCP tool on the already-running server. The `get-offer` bin subcommand stays only as an optional utility for non-Claude-Code hosts/debugging.
- Q: How is the plugin cross-published into agentic-packages? → A: **A direct remote-git marketplace `source` entry** (`source: srobroek/vibe-hero` + `ref:`) — APM core supports remote git marketplace sources first-class (corrects an earlier "impossible" critique note). No stub, no APM/npm dependency, no copy. Blocker is agentic-packages' LOCAL marketplace generators (they overwrite the packages block from local dirs only and would drop an external entry + fail the staleness gate); refactoring them to preserve external-source entries is in progress. So cross-publish is a fast-follow, not v1-critical.

## User Scenarios & Testing *(mandatory)*

### User Story 1 — One-gesture install of the whole product (Priority: P1)

A developer wants vibe-hero in their Claude Code. They add the vibe-hero marketplace and install the plugin. That single action gives them the MCP server (launched via npx — no clone, no build), the four skills, the auto-registered end-of-work Stop hook, and offline curriculum. They run setup and start learning — no manual file editing, no MCP config by hand, no hook registration.

**Why this priority**: This is the entire point of the spec — collapse the manual multi-step setup into one install. Without it, the product isn't shippable to anyone but its author.

**Independent Test**: From a clean machine with Claude Code, add the marketplace and install the plugin; confirm the MCP server tools are available, the skills are present, the Stop hook is registered, and a quiz works offline — all without manual configuration beyond the in-product setup Q&A.

**Acceptance Scenarios**:

1. **Given** a clean Claude Code environment, **When** the user installs the vibe-hero plugin from the marketplace, **Then** the MCP server, all four skills, and the Stop hook are available without any manual config-file edits.
2. **Given** the installed plugin, **When** the MCP server is invoked, **Then** it launches via `npx` against the published npm package (no local build/toolchain required).
3. **Given** the installed plugin with no network, **When** the user takes a quiz, **Then** the bundled offline curriculum is served.
4. **Given** the installed plugin, **When** a unit of work ends, **Then** the Stop hook offers a quiz (auto-registered) without the user having edited any settings.

---

### User Story 2 — Maintainer publishes a new version via CI (Priority: P1)

A maintainer merges a change. CI automatically versions the release, publishes the updated `@vibe-hero/server` to npm, and updates the marketplace artifacts so installed/new users pick up the new plugin and server — without any manual `npm publish` or hand-edited marketplace files.

**Why this priority**: Distribution that requires manual publishing rots immediately and is error-prone (the wrong artifact, a forgotten file, a secret in a log). Automated, repeatable release is what makes the channel trustworthy. Depends on US1's packaging existing.

**Independent Test**: Simulate a release (a version bump merged to the main branch); confirm CI publishes the npm package at the new version and regenerates/commits the marketplace + plugin manifests, with the npm credential supplied only via a repository secret (never printed).

**Acceptance Scenarios**:

1. **Given** a merge that warrants a release, **When** the release pipeline runs, **Then** `@vibe-hero/server` is published to npm at the new version using a repository secret for authentication.
2. **Given** a release, **When** the pipeline completes, **Then** the marketplace manifest and plugin manifest reflect the new version (generated, not hand-edited) and are committed/tagged.
3. **Given** any CI run, **When** logs are inspected, **Then** the npm token never appears in output.
4. **Given** generated packaging artifacts, **When** a PR changes inputs but not the regenerated outputs, **Then** CI fails with a clear "artifacts out of date" signal (staleness gate).

---

### User Story 3 — End-of-work offer works in an npx-only install (no process spawn) (Priority: P2)

Because the server is npx-launched (no plugin-local build) AND a hook cannot reach the running stdio MCP server (Claude Code owns its pipes), the Stop hook does NOT spawn any process or call a `get-offer` CLI. It emits a short `additionalContext` nudge; the AGENT — which already holds the live MCP connection — calls the `get_offer` MCP tool itself. The offer logic stays server-side, reached through the agent's existing connection, with zero per-turn-end process spawn.

**Why this priority**: The npx decision created a real hazard — the spec-001 Stop hook calls a local `dist/cli/getOffer.js` that won't exist in an npx-only install, and spawning `npx … get-offer` every turn-end would add latency/hang risk on a hot path. The agent-mediated pattern resolves both. It's required for US1's offer to work post-install, but is a focused packaging sub-requirement, so P2.

**Independent Test**: In an npx-style install (no plugin-local `dist/`), trigger the Stop hook; confirm it spawns NO process, emits an `additionalContext` nudge, and the agent then calls the `get_offer` MCP tool against the running server.

**Acceptance Scenarios**:

1. **Given** an npx-only install, **When** the Stop hook runs, **Then** it spawns no process and references no plugin-local build artifact — it only emits an `additionalContext` nudge.
2. **Given** the nudge is emitted while the agent is still in its loop, **When** the agent continues, **Then** it calls the `get_offer` MCP tool on the already-running server (no fresh npx spawn).
3. **Given** the agent has already fully stopped, **When** the nudge cannot trigger a follow-up call, **Then** the behavior degrades safely (no error; the offer is simply not shown that turn) and the quiz-skill steering still surfaces offers at end of work.

---

### Edge Cases

- **npm publish fails mid-release** (network, auth, registry outage): the release must fail atomically with a clear error and MUST NOT leave the marketplace pointing at an npm version that doesn't exist.
- **Plugin floats `latest` (decided)**: the plugin and hook both use unpinned `npx -y @vibe-hero/server`. A user who installed earlier picks up newer server versions automatically; the only divergence risk is a transient server/hook skew across a publish, which self-heals on next resolution. Accepted tradeoff (not reproducible) — see Clarifications/FR-012.
- **Offline first run**: with no network, `npx` of an already-cached package works, but a never-cached package cannot be fetched — the spec must state the offline expectation honestly (bundled content works offline; first-ever server launch needs the package present/cached).
- **Generated-artifact drift**: a hand-edit to a generated `plugin.json`/`marketplace.json` must be caught by the staleness gate, not silently shipped.
- **Cross-publish to agentic-packages**: registering the plugin in the second marketplace must not require duplicating the source or diverging versions.
- **npm scope/name unavailable or unauthorized**: the publish must fail clearly if the scope/name or token is wrong, rather than publishing to the wrong place.
- **The agentic-packages name-only plugin.json bug**: the marketplace generator MUST emit dependency entries in a valid sourced form (the `{git,path}` form), not the name-only `{name}` form that the upstream generator bug produced.

## Requirements *(mandatory)*

### Functional Requirements

**npm package**

- **FR-001**: `@vibe-hero/server` MUST be publishable to the public npm registry (drop `private: true`; add the public-publish metadata: `name`, `version`, `license`, `files`, `bin`, `repository`).
- **FR-002**: The package MUST expose a single `bin` named `vibe-hero` that, with no subcommand (or `mcp`), starts the MCP server over stdio. It MAY also accept a `get-offer` subcommand as an OPTIONAL utility (for non-Claude-Code hosts / debugging) — but the Claude Code Stop hook does NOT use it (FR-011 is agent-mediated). Primary invocation: `npx -y @vibe-hero/server`.
- **FR-003**: The published package MUST include its built output and the offline content snapshot, and MUST NOT include test files, sources-only-needed-at-build, or development artifacts (control via `files`/`.npmignore`).
- **FR-004**: The package build MUST copy the repository's real `content/` curriculum (claude-code + general topics) into the package as the bundled offline snapshot, so npx users get real curriculum offline; runtime GitHub fetch (`VIBE_HERO_CONTENT_URL`) still layers updates on top.

**Claude Code plugin + marketplace**

- **FR-005**: A SINGLE Claude Code plugin MUST bundle: the four skills, the Stop hook (auto-registered), an `.mcp.json` that npx-launches the published server, and the offline content snapshot.
- **FR-006**: Installing the plugin MUST make the MCP server, skills, and Stop hook available WITHOUT the user manually editing settings, MCP config, or hook registration.
- **FR-007**: The Stop hook MUST be declared so it auto-registers on plugin install (a hooks manifest using the plugin-root path token the loader expects), replacing the current manual-install README.
- **FR-008**: The plugin's MCP declaration MUST launch the server via `npx` against the published package (no plugin-local build/toolchain required at install or run time).
- **FR-009**: An APM marketplace manifest MUST live at this repository's root so vibe-hero is its own Claude Code marketplace (installable via `apm marketplace add srobroek/vibe-hero`) — the v1 distribution path. Cross-publishing into `srobroek/agentic-packages` MUST use a **direct remote-git marketplace `source` entry** there (`source: srobroek/vibe-hero` + `ref:`) — a first-class APM capability (remote git sources), needing no stub, no APM/npm dependency, and no source copy. This cross-publish is a **fast-follow** gated on refactoring agentic-packages' local marketplace generators to preserve external-source entries (today they overwrite the packages block from local dirs only), NOT part of vibe-hero's v1 critical path.
- **FR-010**: Generated packaging artifacts (plugin manifest, marketplace manifest, MCP/hook manifests) MUST be produced by a generator from declared inputs — never hand-authored — and MUST use valid sourced dependency forms (not the name-only object form that breaks resolution).

**Server ↔ hook consistency (npx consequence)**

- **FR-011**: The Stop hook MUST be **agent-mediated and spawn NO process**: it emits a Stop `additionalContext` nudge and the agent calls the `get_offer` MCP tool on the already-running server (a hook cannot reach the stdio server directly). It MUST NOT spawn `npx`/`node` or depend on any plugin-local build artifact. It MUST degrade safely when the nudge can't trigger a follow-up (no error). The bin's `get-offer` subcommand is retained only as an optional utility for non-Claude-Code hosts/debugging — not used by the Claude Code Stop hook.
- **FR-012**: The plugin's `.mcp.json` MUST invoke `npx -y @vibe-hero/server` with NO version pin (floating `latest`), so it resolves the newest published version (auto-distributes updates — the deciding factor, since there is no user-critical/security-sensitive payload). Reproducible pinning is explicitly NOT a requirement; users MAY pin themselves. (With FR-011 now agent-mediated, the hook no longer launches the server, so the server/hook version-skew concern is moot — only the single `.mcp.json` reference matters.)
- **FR-012a**: Because `latest` auto-distributes, the project MUST have a documented **rollback procedure** for a bad publish (e.g. `npm deprecate` the bad version + publish a fixed patch, or move the `latest` dist-tag back to the last-good version), since installed users pick up `latest` on next resolution.

**Release automation (CI/CD)**

- **FR-013**: The release MUST be gated by a **release-PR (release-please style)**: merges to main accumulate into a bot-maintained release PR; merging that PR is the trigger that versions, publishes `@vibe-hero/server` to npm (via OIDC), and regenerates + commits/tags the marketplace and plugin artifacts — with no manual `npm publish` or hand-edited manifests. The release PR is the single human approval point.
- **FR-014**: npm authentication in CI MUST use **npm Trusted Publishers (OIDC)** — a short-lived, workflow-scoped OIDC token — NOT a long-lived `NPM_TOKEN` secret. The publish workflow MUST request `permissions: id-token: write`, and the npm package MUST be configured (once, on npm) to trust this repo + publish workflow. No long-lived publish credential is created or stored. Publishing MUST emit npm provenance attestation (`--provenance`, enabled by OIDC).
- **FR-014a**: BOOTSTRAP — because a trusted publisher can only be attached to a package that already exists on npm, the FIRST publish of `@vibe-hero/server` is a one-time MANUAL `npm publish` performed by the maintainer (logged in, ideally with 2FA), which creates the package and establishes ownership. The spec/plan MUST document this one-time step. AFTER it, the maintainer configures the trusted publisher (repo + publish workflow) on npm, and ALL subsequent releases publish via OIDC/CI per FR-014 — no further manual publishes.
- **FR-015**: CI MUST include a staleness gate that fails when generated packaging artifacts are out of date relative to their inputs (so drift can't ship).
- **FR-016**: A release that fails to publish to npm MUST fail atomically and MUST NOT advance the marketplace to a server version that was not actually published. Concretely (npm publish and a git commit are not one transaction): publish to npm FIRST; only on success regenerate + commit the marketplace pointer; if the commit step fails, the next release reconciles idempotently. **npm is the source of truth; the marketplace is a derived pointer** (critique E4).
- **FR-017**: The release versioning MUST be automated and consistent across the npm package and the plugin/marketplace entry (a single source of version truth). Use release-please in **single-package mode** (a simple `v{version}` tag + one component), not the monorepo multi-package config (critique E5).
- **FR-017a**: There MUST be a documented rollback procedure for a bad `latest` publish (npm `deprecate` the bad version and/or move the `latest` dist-tag to the last-good version + publish a fixed patch), since floating-`latest` users pick it up on next resolution (critique P4; pairs with FR-012a).

**Compatibility / non-regression**

- **FR-018**: This spec MUST NOT change any spec-001 learning behavior; the server's runtime behavior (tools, gate, grading, privacy) is unchanged — only how it is packaged and launched.
- **FR-019**: All spec-001 tests MUST continue to pass; packaging changes (build script, bin, files) MUST be verified to not break the existing build/test.
- **FR-019a**: Packaging correctness MUST be verified against the BUILT/PACKED artifact, not only `src` — at least: `bin` dispatch works, `npm pack` includes `dist` (incl. bundled content) and excludes sources/tests, and the built server loads the bundled content offline (critique E8; quickstart V1–V3 automated in CI).
- **FR-019b**: The bundled offline content snapshot SHOULD be a deliberately MINIMAL baseline (enough for offline first use), with the full/updated catalog delivered via runtime fetch (`VIBE_HERO_CONTENT_URL`), so curriculum growth does not bloat the npm package or force a server republish per content change (critique E7).
- **FR-019c**: Install docs MUST state the npx reality honestly: bundled content works fully offline, but the first-ever server launch needs the `@vibe-hero/server` package present/cached (one network fetch), and SHOULD note an air-gapped escape hatch (pre-install the package) and that first use may incur a one-time npx cold-start (critique P2/P3).

### Key Entities *(include if feature involves data)*

- **npm package** (`@vibe-hero/server`): the publishable server artifact — built output + offline content snapshot + a `vibe-hero` bin (MCP server + `get-offer`).
- **Claude Code plugin** (`vibe-hero`): the single installable bundle — skills, Stop-hook manifest, `.mcp.json` (npx launch), offline content; described by a generated plugin manifest.
- **Marketplace manifest**: the catalog entry (name, description, version, source) at the repo root, listing the plugin; mirrored into agentic-packages.
- **Release pipeline**: the CI workflow(s) that version, publish to npm, and regenerate/commit packaging artifacts, authenticated by the `NPM_TOKEN` secret.
- **Version**: a single source-of-truth version shared by the npm package and the plugin/marketplace entry.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A user can install the entire product (server + skills + Stop hook + offline content) from the marketplace in a SINGLE install action with ZERO manual config-file edits.
- **SC-002**: The MCP server launches via `npx` with NO local clone/build/toolchain on the user's machine.
- **SC-003**: With no network, 100% of bundled-curriculum quiz requests still succeed after install (offline content shipped in the package).
- **SC-004**: A release is published end-to-end by CI with ZERO manual `npm publish` or hand-edited manifest steps.
- **SC-005**: No long-lived npm publish credential exists anywhere (no `NPM_TOKEN` secret in the repo); publish authenticates via OIDC and emits a provenance attestation — verifiable by the absence of a publish secret and the presence of provenance on the published version.
- **SC-006**: The Stop hook spawns ZERO processes and references NO plugin-local build file (100% of invocations only emit `additionalContext`); the offer is fetched by the agent calling the MCP tool on the already-running server.
- **SC-007**: There is exactly ONE place the server version is referenced — the plugin's `.mcp.json` (`npx -y @vibe-hero/server`, unpinned). The hook does not launch the server, so no server/hook version divergence is possible by construction.
- **SC-008**: A hand-edit to a generated packaging artifact is caught by CI's staleness gate (build fails) rather than shipping.
- **SC-009**: All spec-001 tests continue to pass after the packaging changes.
- **SC-010**: (fast-follow) When cross-publish ships, the same plugin is installable from BOTH the vibe-hero root marketplace and (via the stub's cross-repo APM dependency) the agentic-packages marketplace, at the same version, with NO source duplication. v1 ships the vibe-hero root marketplace alone.

## Open Design Decisions

Deferred to planning; do not block the spec.

- **OD-001 — Generator choice**: reuse agentic-packages' `build-native-plugins.py` (+ `apm pack`) generator pattern, or rely on plain `apm pack` (vibe-hero is ~1 plugin, not a 100-package monorepo). Decide in plan; FR-010's "generated, valid sourced deps" holds either way.
- ~~OD-002 — Version pin policy~~ **RESOLVED (clarify)**: floating `latest`, unpinned `npx -y @vibe-hero/server` (FR-012).
- ~~OD-003 — Release tooling~~ **RESOLVED (clarify)**: release-please-style release-PR gate, matching agentic-packages (tag pattern `{name}-v{version}`) (FR-013).
- ~~OD-004 — Cross-publish mechanism~~ **RESOLVED**: a **direct remote-git marketplace `source` entry** in agentic-packages (`source: srobroek/vibe-hero` + `ref:`) — first-class APM core support; no stub/dep/copy. Fast-follow, gated on refactoring agentic-packages' local marketplace generators to preserve external-source entries. (FR-009/SC-010.)
- **OD-005 — npm org/scope**: confirm the `@vibe-hero` scope (org) on npm and 2FA policy. `@vibe-hero/server` is currently unregistered (name available). Scope creation + the one-time manual bootstrap publish (FR-014a) + trusted-publisher configuration are maintainer steps done out-of-band before CI-driven releases work.

## Assumptions

- **Spec 001 is merged/available**: this branch builds on the 001 implementation (server, skills, hook, content already exist).
- **npm publish rights + bootstrap**: the maintainer can create the `@vibe-hero` scope (or chosen name) on npm, perform the one-time manual first publish (FR-014a), and then configure the npm Trusted Publisher (linking the package to this repo + the publish workflow). No automation token / `NPM_TOKEN` is created or stored — CI publishes via OIDC. All of this is done out-of-band by the maintainer (no credential ever enters code or chat).
- **Claude Code plugin/marketplace mechanics**: per-package `.claude-plugin/plugin.json` (generated, carries identity + skills path, NO `mcpServers`), top-level `.mcp.json` as the sole MCP declaration for the server, `hooks/hooks.json` for auto-registered hooks using the `${CLAUDE_PLUGIN_ROOT}` token (the variable Claude Code substitutes in hook commands), marketplace.json listing plugins by `source`.
- **npx availability**: target users have Node/npx available in the environment Claude Code runs in (required to launch an npx MCP server).
- **Public distribution**: the npm package and marketplace are public.

## Out of Scope

- Any change to spec-001 learning behavior, tools, scoring, or content model.
- Authoring new curriculum content (beyond packaging the existing topics).
- A Codex/Kiro-specific distribution channel (architecture-ready, but this spec targets the npm + Claude Code marketplace path; Codex marketplace parity is a later spec).
- A web installer, GUI, or hosted service.
- Telemetry/analytics on installs.
