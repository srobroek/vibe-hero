# GitHub Actions workflows (vibe-hero distribution, spec 002 / US2)

Three workflows implement the release pipeline. The design intent and the
machine-verifiable invariants are spelled out here and enforced by
`packages/server/test/integration/release-workflow.test.ts` (which reads these
YAML files and asserts the safety properties below).

## `ci.yml` — build, test, staleness gate

- Runs on every `pull_request` and on `push` to `main` (never on tags).
- Sets up pnpm + Node 20, `pnpm install --frozen-lockfile`.
- Builds and tests `@vibe-hero/server` (the full suite — spec-001 behavior +
  packaging + plugin-manifest + release-workflow tests).
- **Artifact staleness gate (FR-010/015, SC-008):** installs `apm`, regenerates
  the marketplace artifact with `apm pack --marketplace claude`, runs the
  `--check-versions` release gate, and then `git diff --exit-code` to fail the
  build if the committed generated artifacts (root
  `.claude-plugin/marketplace.json`) differ from what regenerates. `build/` and
  `packages/vibe-hero-plugin/build/` are gitignored, so the bundle staging output
  never dirties the tree — only the in-tree marketplace output is compared.

## `release-please.yml` — release-PR gate (single-package)

- Runs on `push` to `main`.
- `googleapis/release-please-action@v4` in **single-package mode**
  (`release-please-config.json` + `.release-please-manifest.json`, one component
  rooted at `packages/server`, simple `v{version}` tags — FR-017).
- Maintains the bot release PR; merging it cuts the GitHub release + tag (the
  single human approval point and single source of version truth — FR-013).
- Permissions: `contents: write`, `pull-requests: write`.

## `release.yml` — npm publish (OIDC) + marketplace pointer

- Runs **only** on `release: published` (the release release-please creates), not
  on arbitrary merges.
- Permissions: `id-token: write` (OIDC Trusted Publishers + provenance),
  `contents: write` (commit the regenerated marketplace pointer).
- **No long-lived npm token (FR-014 / SC-005):** authentication is
  `id-token`-based npm Trusted Publishers. This workflow references no
  `NPM_TOKEN`/`NODE_AUTH_TOKEN` secret and sets no `NODE_AUTH_TOKEN` env.
- Publishes with `pnpm --filter @vibe-hero/server publish --access public
  --provenance --no-git-checks`. `--provenance` emits the npm provenance
  attestation.
- **Atomic ordering (FR-016):** publish to npm **first**; only on success
  regenerate + commit the marketplace pointer. A failed publish fails the job
  before the marketplace advances, so npm stays the source of truth and the
  marketplace is never pointed at a version that does not exist. The pointer
  commit is idempotent (regenerating from the merged version yields the same
  pointer; a re-run or the next release reconciles).

## One-time maintainer bootstrap (out-of-band)

Because a Trusted Publisher can only be attached to an existing npm package, the
first publish of `@vibe-hero/server` is a one-time manual `npm publish`
(maintainer, 2FA). After that, the maintainer configures the npm Trusted
Publisher on npmjs.com (link the package to `srobroek/vibe-hero` + the
`release.yml` publish workflow). All subsequent releases publish via OIDC/CI —
no further manual publishes, no stored credential. See `RELEASING.md` and
`specs/002-distribution/spec.md` FR-014/014a.
