/**
 * @file Cross-artifact version sync guard (spec 002, F2 / FR-017).
 *
 * Asserts that the four version-bearing artifacts that release-please manages
 * atomically are ALL at the same version. This is the durable catch for F1's
 * extra-files config: if the release-please config ever loses one of these
 * files, this test will fail on the first release that diverges.
 *
 * Files asserted:
 *   1. packages/server/package.json            — npm package version (source of truth)
 *   2. packages/vibe-hero-plugin/apm.yml        — plugin APM manifest version
 *   3. packages/vibe-hero-plugin/.claude-plugin/plugin.json — plugin manifest version
 *   4. .claude-plugin/marketplace.json          — marketplace entry version
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// repo root = four levels up from packages/server/test/integration
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");

const readJson = <T>(rel: string): T =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf8")) as T;

/** Extract the `version: X.Y.Z` value from a YAML file without a YAML parser. */
const readYamlVersion = (rel: string): string => {
  const text = readFileSync(resolve(REPO_ROOT, rel), "utf8");
  // Match lines like `version: 0.1.0` or `version: 0.1.0  # ...`
  const m = text.match(/^version:\s*([^\s#]+)/m);
  if (!m) throw new Error(`No 'version:' field found in ${rel}`);
  return m[1];
};

describe("cross-artifact version sync (spec 002, FR-017)", () => {
  it("all four version artifacts are at the same version", () => {
    const serverPkg = readJson<{ version: string }>(
      "packages/server/package.json",
    );
    const pluginJson = readJson<{ version: string }>(
      "packages/vibe-hero-plugin/.claude-plugin/plugin.json",
    );
    const marketplace = readJson<{
      plugins: Array<{ name: string; version: string }>;
    }>(".claude-plugin/marketplace.json");
    const apmVersion = readYamlVersion("packages/vibe-hero-plugin/apm.yml");

    const npmVersion = serverPkg.version;
    expect(npmVersion, "packages/server/package.json must have a version").toBeTruthy();

    const marketplacePlugin = marketplace.plugins.find(
      (p) => p.name === "vibe-hero",
    );
    expect(
      marketplacePlugin,
      ".claude-plugin/marketplace.json must list the vibe-hero plugin",
    ).toBeDefined();

    expect(
      pluginJson.version,
      "packages/vibe-hero-plugin/.claude-plugin/plugin.json version must match packages/server/package.json",
    ).toBe(npmVersion);

    expect(
      marketplacePlugin?.version,
      ".claude-plugin/marketplace.json vibe-hero entry version must match packages/server/package.json",
    ).toBe(npmVersion);

    expect(
      apmVersion,
      "packages/vibe-hero-plugin/apm.yml version must match packages/server/package.json",
    ).toBe(npmVersion);
  });

  it("every release-please extra-file path resolves to a real file (F1)", () => {
    // release-please resolves each package's `extra-files` path RELATIVE TO THE
    // PACKAGE DIR (it does path.join(packageDir, extraFilePath) before fetching
    // from the branch). A repo-root-relative path therefore gets the package dir
    // prepended and silently 404s — the version bump no-ops without failing the
    // run. This guard resolves each entry exactly as release-please does and
    // asserts the file exists, so a wrong (or non-traversing) path fails CI
    // instead of shipping a half-bumped release. See release-please-config.json.
    const config = readJson<{
      packages: Record<
        string,
        { "extra-files"?: Array<{ path: string }> }
      >;
    }>("release-please-config.json");

    for (const [pkgDir, pkgCfg] of Object.entries(config.packages)) {
      for (const entry of pkgCfg["extra-files"] ?? []) {
        // Mirror release-please: join(packageDir, entry.path), normalized.
        const resolved = resolve(REPO_ROOT, pkgDir, entry.path);
        expect(
          () => readFileSync(resolved, "utf8"),
          `extra-file '${entry.path}' (package '${pkgDir}') must resolve to a real file at ${resolved}`,
        ).not.toThrow();
      }
    }
  });
});
