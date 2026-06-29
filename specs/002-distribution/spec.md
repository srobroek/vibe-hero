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
- Q: What does `@vibe-hero/server`'s `bin` expose? → A: A SINGLE bin `vibe-hero` with subcommands — default (or `mcp`) starts the stdio MCP server; `get-offer` serves the Stop hook. (`npx -y @vibe-hero/server` and `npx -y @vibe-hero/server get-offer`.)
- Q: How does offline content get into the npm package? → A: The npm build COPIES the repo's real `content/` (claude-code + general topics) into the package as the bundled offline snapshot; runtime GitHub fetch (`VIBE_HERO_CONTENT_URL`) still layers updates on top.
- Q: How does CI authenticate to npm? → A: **npm Trusted Publishers (OIDC)** — NOT a long-lived `NPM_TOKEN` secret. GitHub Actions authenticates via a short-lived OIDC token tied to the repo + publish workflow (workflow needs `permissions: id-token: write`); the trusted publisher is configured once on npmjs.com linking the package to `srobroek/vibe-hero` + the workflow. No publish secret is created, stored, or at risk of leaking, and npm provenance attestation is emitted automatically.
- Q: What triggers a release in CI? → A: **Release-PR gate (release-please style)**, matching `agentic-packages`. Merges to main accumulate into a bot-maintained release PR; merging THAT PR cuts the version, publishes to npm (via OIDC), and regenerates/commits the marketplace + plugin artifacts. The release PR is the human approval point and the single version source-of-truth.
- Q: How does the plugin pin the npx-launched server version? → A: **Floating `latest`** — the plugin's `.mcp.json` and the Stop hook both invoke `npx -y @vibe-hero/server` with NO version, always resolving the newest published version. (Tradeoff accepted: installs aren't byte-reproducible and a server/hook version skew is possible only transiently across a publish; both float to the same `latest` and self-heal on next npx resolution. This supersedes the earlier "exact pin / no drift" framing — see FR-012/SC-007.)

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

### User Story 3 — Installed plugin stays consistent (server ↔ hook ↔ content) (Priority: P2)

Because the server is npx-launched (no plugin-local build), the Stop hook cannot call a local built file. The hook instead invokes the published package's `get-offer` subcommand, so the hook logic and the MCP server logic come from the SAME published package rather than from a separately-bundled script that could rot. (Both use the unpinned `npx -y @vibe-hero/server` reference per FR-012, so they track the same `latest`.)

**Why this priority**: The npx decision creates a real consistency hazard (the current Stop hook calls a local `dist/cli/getOffer.js` that won't exist in an npx-only install). Resolving it is required for US1 to actually work, but it is a focused sub-requirement of the packaging, so P2.

**Independent Test**: In an npx-style install (no plugin-local `dist/`), trigger the Stop hook; confirm it resolves an offer by invoking the published package (`npx … get-offer`) and never depends on a plugin-local build artifact.

**Acceptance Scenarios**:

1. **Given** an npx-only install, **When** the Stop hook runs, **Then** it obtains the offer via the published package's `get-offer` subcommand, not a plugin-local file.
2. **Given** a pinned plugin version, **When** the server and the hook both run, **Then** they resolve to the same published package version.

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
- **FR-002**: The package MUST expose a single `bin` named `vibe-hero` that, with no subcommand (or `mcp`), starts the MCP server over stdio, and with the `get-offer` subcommand serves the Stop-hook offer query. Both MUST be invocable via `npx -y @vibe-hero/server [get-offer]`.
- **FR-003**: The published package MUST include its built output and the offline content snapshot, and MUST NOT include test files, sources-only-needed-at-build, or development artifacts (control via `files`/`.npmignore`).
- **FR-004**: The package build MUST copy the repository's real `content/` curriculum (claude-code + general topics) into the package as the bundled offline snapshot, so npx users get real curriculum offline; runtime GitHub fetch (`VIBE_HERO_CONTENT_URL`) still layers updates on top.

**Claude Code plugin + marketplace**

- **FR-005**: A SINGLE Claude Code plugin MUST bundle: the four skills, the Stop hook (auto-registered), an `.mcp.json` that npx-launches the published server, and the offline content snapshot.
- **FR-006**: Installing the plugin MUST make the MCP server, skills, and Stop hook available WITHOUT the user manually editing settings, MCP config, or hook registration.
- **FR-007**: The Stop hook MUST be declared so it auto-registers on plugin install (a hooks manifest using the plugin-root path token the loader expects), replacing the current manual-install README.
- **FR-008**: The plugin's MCP declaration MUST launch the server via `npx` against the published package (no plugin-local build/toolchain required at install or run time).
- **FR-009**: An APM marketplace manifest MUST live at this repository's root so vibe-hero is its own Claude Code marketplace; the plugin MUST also be cross-publishable into the `srobroek/agentic-packages` marketplace without source duplication or version divergence.
- **FR-010**: Generated packaging artifacts (plugin manifest, marketplace manifest, MCP/hook manifests) MUST be produced by a generator from declared inputs — never hand-authored — and MUST use valid sourced dependency forms (not the name-only object form that breaks resolution).

**Server ↔ hook consistency (npx consequence)**

- **FR-011**: The Stop hook MUST resolve offers by invoking the published package's `get-offer` subcommand, NOT a plugin-local build artifact, so an npx-only install has no missing-file dependency.
- **FR-012**: The plugin's `.mcp.json` and the Stop hook MUST both invoke `npx -y @vibe-hero/server` with NO version pin (floating `latest`), so both resolve the newest published version. Because they use the identical unpinned reference, they resolve to the same version in steady state; a transient skew is possible only across a publish boundary and self-heals on the next `npx` resolution. (Reproducible pinning is explicitly NOT a requirement — see Clarifications.)

**Release automation (CI/CD)**

- **FR-013**: The release MUST be gated by a **release-PR (release-please style)**: merges to main accumulate into a bot-maintained release PR; merging that PR is the trigger that versions, publishes `@vibe-hero/server` to npm (via OIDC), and regenerates + commits/tags the marketplace and plugin artifacts — with no manual `npm publish` or hand-edited manifests. The release PR is the single human approval point.
- **FR-014**: npm authentication in CI MUST use **npm Trusted Publishers (OIDC)** — a short-lived, workflow-scoped OIDC token — NOT a long-lived `NPM_TOKEN` secret. The publish workflow MUST request `permissions: id-token: write`, and the npm package MUST be configured (once, on npm) to trust this repo + publish workflow. No long-lived publish credential is created or stored. Publishing MUST emit npm provenance attestation (`--provenance`, enabled by OIDC).
- **FR-014a**: BOOTSTRAP — because a trusted publisher can only be attached to a package that already exists on npm, the FIRST publish of `@vibe-hero/server` is a one-time MANUAL `npm publish` performed by the maintainer (logged in, ideally with 2FA), which creates the package and establishes ownership. The spec/plan MUST document this one-time step. AFTER it, the maintainer configures the trusted publisher (repo + publish workflow) on npm, and ALL subsequent releases publish via OIDC/CI per FR-014 — no further manual publishes.
- **FR-015**: CI MUST include a staleness gate that fails when generated packaging artifacts are out of date relative to their inputs (so drift can't ship).
- **FR-016**: A release that fails to publish to npm MUST fail atomically and MUST NOT advance the marketplace to a server version that was not actually published.
- **FR-017**: The release versioning MUST be automated and consistent across the npm package and the plugin/marketplace entry (a single source of version truth).

**Compatibility / non-regression**

- **FR-018**: This spec MUST NOT change any spec-001 learning behavior; the server's runtime behavior (tools, gate, grading, privacy) is unchanged — only how it is packaged and launched.
- **FR-019**: All spec-001 tests MUST continue to pass; packaging changes (build script, bin, files) MUST be verified to not break the existing build/test.

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
- **SC-006**: The Stop hook in an npx-only install resolves an offer with NO dependency on a plugin-local build file (100% of hook invocations use the published `get-offer`).
- **SC-007**: The plugin and the Stop hook use the IDENTICAL unpinned `npx -y @vibe-hero/server` reference (verifiable by inspection), so both resolve the same `latest` in steady state; any version skew is transient (only across a publish) and self-heals — there is no persistent divergence.
- **SC-008**: A hand-edit to a generated packaging artifact is caught by CI's staleness gate (build fails) rather than shipping.
- **SC-009**: All spec-001 tests continue to pass after the packaging changes.
- **SC-010**: The same plugin is installable from BOTH the vibe-hero root marketplace and the agentic-packages marketplace, at the same version, without source duplication.

## Open Design Decisions

Deferred to planning; do not block the spec.

- **OD-001 — Generator choice**: reuse agentic-packages' `build-native-plugins.py` (+ `apm pack`) generator pattern, or rely on plain `apm pack` (vibe-hero is ~1 plugin, not a 100-package monorepo). Decide in plan; FR-010's "generated, valid sourced deps" holds either way.
- ~~OD-002 — Version pin policy~~ **RESOLVED (clarify)**: floating `latest`, unpinned `npx -y @vibe-hero/server` (FR-012).
- ~~OD-003 — Release tooling~~ **RESOLVED (clarify)**: release-please-style release-PR gate, matching agentic-packages (tag pattern `{name}-v{version}`) (FR-013).
- **OD-004 — Cross-publish mechanism**: how the agentic-packages marketplace references this plugin (a package entry pointing at this repo, a submodule, or a copied/generated package) without version divergence (FR-009/SC-010).
- **OD-005 — npm org/scope**: confirm the `@vibe-hero` scope (org) on npm and 2FA policy. `@vibe-hero/server` is currently unregistered (name available). Scope creation + the one-time manual bootstrap publish (FR-014a) + trusted-publisher configuration are maintainer steps done out-of-band before CI-driven releases work.

## Assumptions

- **Spec 001 is merged/available**: this branch builds on the 001 implementation (server, skills, hook, content already exist).
- **npm publish rights + bootstrap**: the maintainer can create the `@vibe-hero` scope (or chosen name) on npm, perform the one-time manual first publish (FR-014a), and then configure the npm Trusted Publisher (linking the package to this repo + the publish workflow). No automation token / `NPM_TOKEN` is created or stored — CI publishes via OIDC. All of this is done out-of-band by the maintainer (no credential ever enters code or chat).
- **Claude Code plugin/marketplace mechanics** match the agentic-packages conventions verified during research: per-package `.claude-plugin/plugin.json` (generated), top-level `.mcp.json` for the server, `hooks/hooks.json` for auto-registered hooks using the `${PLUGIN_ROOT}` token, marketplace.json listing plugins by `source`.
- **npx availability**: target users have Node/npx available in the environment Claude Code runs in (required to launch an npx MCP server).
- **Public distribution**: the npm package and marketplace are public.

## Out of Scope

- Any change to spec-001 learning behavior, tools, scoring, or content model.
- Authoring new curriculum content (beyond packaging the existing topics).
- A Codex/Kiro-specific distribution channel (architecture-ready, but this spec targets the npm + Claude Code marketplace path; Codex marketplace parity is a later spec).
- A web installer, GUI, or hosted service.
- Telemetry/analytics on installs.
