/**
 * @file Release workflow safety invariants (spec 002, US2 / T020).
 *
 * Makes the OIDC / no-token / atomic-ordering guarantees of the release pipeline
 * MACHINE-VERIFIABLE (SC-005) rather than relying on workflow review. These are
 * static-text assertions over the committed GitHub Actions YAML — no build, no
 * network, no YAML parser dependency (we read the raw text so even a malformed
 * edit that smuggles a token in a comment or string is caught).
 *
 * Asserts:
 *   - release.yml authenticates via OIDC (`id-token: write`), publishes with
 *     `--provenance`, and references NO `NPM_TOKEN`/`NODE_AUTH_TOKEN` secret
 *     (FR-014 / SC-005).
 *   - release.yml triggers ONLY on a published release, not arbitrary push.
 *   - release.yml publishes to npm BEFORE committing the marketplace pointer
 *     (FR-016 atomic ordering).
 *   - ci.yml runs the test suite AND a staleness/diff gate (FR-015 / SC-008).
 *   - NO workflow anywhere references a long-lived npm token (SC-005).
 */
import { readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// repo root = up from packages/server/test/integration
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const WORKFLOWS_DIR = resolve(REPO_ROOT, ".github", "workflows");

const readWorkflow = (name: string): string =>
  readFileSync(resolve(WORKFLOWS_DIR, name), "utf8");

describe("release pipeline workflows (spec 002, US2)", () => {
  // The publish steps live in release-please.yml (single-workflow design): a
  // GITHUB_TOKEN-created release cannot trigger a separate `on: release`
  // workflow, so publishing runs in the same job gated on the action's
  // `release_created` output.
  describe("release-please.yml — OIDC publish, no token, atomic ordering", () => {
    const release = readWorkflow("release-please.yml");

    it("requests OIDC id-token: write (Trusted Publishers + provenance)", () => {
      expect(release).toMatch(/id-token:\s*write/);
    });

    it("publishes with --provenance", () => {
      expect(release).toContain("--provenance");
    });

    it("publishes with --access public", () => {
      expect(release).toContain("--access public");
    });

    it("references NO long-lived npm token (FR-014 / SC-005)", () => {
      expect(release).not.toMatch(/NPM_TOKEN/);
      expect(release).not.toMatch(/NODE_AUTH_TOKEN/);
    });

    it("gates publish on release-please's release_created output (not on:release)", () => {
      // A GITHUB_TOKEN-created release does not fire `on: release: published`,
      // so publishing must be gated on the action output in the same job. In
      // manifest/component mode the output is path-prefixed
      // (`packages/server--release_created`), accessed via JS property syntax.
      expect(release).toMatch(/steps\.release\.outputs\['packages\/server--release_created'\]/);
      // Must NOT depend on a separate on:release trigger.
      expect(release).not.toMatch(/release:\s*\n\s*types:\s*\[\s*published\s*\]/);
    });

    it("requests contents: write to commit the marketplace pointer", () => {
      expect(release).toMatch(/contents:\s*write/);
    });

    it("publishes to npm BEFORE committing the marketplace pointer (FR-016)", () => {
      const publishIdx = release.indexOf("publish --access public");
      const commitIdx = release.search(/git\s+commit/);
      expect(publishIdx, "publish step must exist").toBeGreaterThan(-1);
      expect(commitIdx, "marketplace commit step must exist").toBeGreaterThan(-1);
      expect(
        publishIdx,
        "npm publish must precede the marketplace-pointer commit (atomic ordering)",
      ).toBeLessThan(commitIdx);
    });

    it("F3: checks out the release tag (not main) for the build+publish steps", () => {
      // The build checkout must use the release-please tag_name output, not
      // 'main', so the built+attested artifact is exactly the tagged commit.
      expect(release).toMatch(/ref:\s*\$\{\{\s*steps\.release\.outputs\['packages\/server--tag_name'\]\s*\}\}/);
      // 'ref: main' must NOT appear as a checkout ref (the safe push step uses
      // 'git checkout -B main origin/main' in a shell script, not a checkout action).
      expect(release).not.toMatch(/ref:\s*main/);
    });

    it("F4: marketplace push retries on non-fast-forward (safe push)", () => {
      // The commit-back step must fetch + rebase/reset onto origin/main and retry
      // so a transient push race does not fail the job after a successful publish.
      expect(release).toMatch(/git fetch origin main/);
      expect(release).toMatch(/git rebase origin\/main/);
      // At least 3 attempts.
      expect(release).toMatch(/for attempt in 1 2 3/);
    });

    it("F7: publish is gated on the canonical repo and non-prerelease", () => {
      expect(release).toMatch(/github\.repository\s*==\s*['"]srobroek\/vibe-hero['"]/);
      expect(release).toMatch(/!steps\.release\.outputs\['packages\/server--prerelease'\]/);
    });
  });

  describe("ci.yml — tests + staleness gate", () => {
    const ci = readWorkflow("ci.yml");

    it("runs the @vibe-hero/server test suite", () => {
      expect(ci).toContain("pnpm --filter @vibe-hero/server test");
    });

    it("tests across the Node range the package supports (engines.node floor)", () => {
      // Regression guard: the server is published and launched via `npx` on
      // arbitrary machines, and declares `engines.node: >=18`. CI must exercise
      // the floor (18) plus current LTS lines so a runtime dependency on a
      // newer Node API (e.g. fs.globSync, Node 22+) cannot slip through a
      // single-version build. See loader.ts walkYamlFiles.
      expect(ci).toMatch(/matrix:\s*\n\s*node:\s*\[18,\s*20,\s*22\]/);
    });

    it("regenerates artifacts and enforces a staleness/diff gate (FR-015)", () => {
      expect(ci).toContain("apm pack");
      expect(ci).toMatch(/git diff --exit-code/);
    });

    it("runs on pull_request and push to main, not on tag-push triggers", () => {
      expect(ci).toMatch(/pull_request/);
      expect(ci).toMatch(/push:\s*\n\s*branches:\s*\[main\]/);
      // Must NOT have a `tags:` trigger under the `on:` block.
      // Use a negative lookahead that excludes `fetch-tags:` (a checkout option)
      // so that F6's `fetch-tags: true` doesn't trip this assertion.
      expect(ci).not.toMatch(/(?<!fetch-)tags:/);
    });

    it("F6: checkout uses fetch-depth: 0 and fetch-tags: true for reproducible version resolution", () => {
      expect(ci).toMatch(/fetch-depth:\s*0/);
      expect(ci).toMatch(/fetch-tags:\s*true/);
    });
  });

  describe("release-please.yml — single-package release-PR gate", () => {
    const rp = readWorkflow("release-please.yml");

    it("uses release-please-action v5", () => {
      expect(rp).toMatch(/googleapis\/release-please-action@v5/);
    });

    it("uses the single-package config + manifest files", () => {
      expect(rp).toContain("release-please-config.json");
      expect(rp).toContain(".release-please-manifest.json");
    });

    it("has the permissions release-please needs", () => {
      expect(rp).toMatch(/contents:\s*write/);
      expect(rp).toMatch(/pull-requests:\s*write/);
    });
  });

  describe("no workflow references a long-lived npm token (SC-005)", () => {
    it("no .github/workflows/*.yml mentions NPM_TOKEN or NODE_AUTH_TOKEN", () => {
      const yamls = readdirSync(WORKFLOWS_DIR).filter(
        (f) => f.endsWith(".yml") || f.endsWith(".yaml"),
      );
      expect(yamls.length).toBeGreaterThan(0);
      for (const f of yamls) {
        const text = readWorkflow(f);
        expect(text, `${f} must not reference NPM_TOKEN`).not.toMatch(/NPM_TOKEN/);
        expect(text, `${f} must not reference NODE_AUTH_TOKEN`).not.toMatch(
          /NODE_AUTH_TOKEN/,
        );
      }
    });
  });
});
