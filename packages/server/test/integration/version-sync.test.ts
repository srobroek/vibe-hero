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

  it("SERVER_VERSION (src/version.ts, advertised in the MCP handshake) matches package.json", async () => {
    const serverPkg = readJson<{ version: string }>(
      "packages/server/package.json",
    );
    const { SERVER_VERSION } = await import("../../src/version.js");
    expect(
      SERVER_VERSION,
      "src/version.ts must match packages/server/package.json — release-please rewrites it via the x-release-please-version marker",
    ).toBe(serverPkg.version);
  });

  it("every release-please extra-file path resolves to a real file (F1)", () => {
    // Mirror release-please's actual path resolution (src/strategies/base.ts
    // `addPath`) so a misconfigured extra-file fails CI instead of silently
    // no-op'ing a version bump:
    //   - A path WITH a leading "/" (or when the package is the repo root ".")
    //     is repo-root-relative: the leading slash is stripped and the package
    //     dir is NOT prepended.
    //   - Otherwise the path is STRING-CONCATENATED onto the package dir (NOT
    //     path.join — so "../" is NOT normalized).
    //   - release-please then REJECTS any "." / ".." segment ("illegal pathing
    //     characters"), so "../" escapes do not work — they throw at release
    //     time. plugin.json + apm.yml live outside packages/server, so they MUST
    //     use leading-slash repo-root paths.
    //
    // Which files are (and are NOT) in extra-files:
    //   - apm.yml + plugin.json ARE bumped by release-please — nothing else
    //     touches their version.
    //   - marketplace.json is deliberately NOT here: `apm pack` regenerates its
    //     plugin version FROM apm.yml and the CI staleness gate enforces it.
    //     Adding it would create two writers for one value. The "all artifacts
    //     agree" test above still covers marketplace.json.
    const config = readJson<{
      packages: Record<
        string,
        { "extra-files"?: Array<{ path: string }> }
      >;
    }>("release-please-config.json");

    // The escape guard from release-please's addPath (base.ts) — rejects any
    // "."/".."/"~" segment or absolute-after-join path.
    const ILLEGAL = /((^|\/)\.{1,2}|^~|^\/*)+\//;

    // Faithful port of addPath: returns the repo-root-relative path release-
    // please will fetch, or throws the same "illegal pathing" error it would.
    const addPath = (pkgDir: string, file: string): string => {
      let f: string;
      if (!pkgDir || pkgDir === "." || file.startsWith("/")) {
        f = file.replace(/^\/+/, "");
      } else {
        f = `${pkgDir.replace(/\/+$/, "")}/${file}`;
      }
      if (ILLEGAL.test(f)) {
        throw new Error(`illegal pathing characters in path: ${f}`);
      }
      return f.replace(/\/+$/, "");
    };

    for (const [pkgDir, pkgCfg] of Object.entries(config.packages)) {
      for (const entry of pkgCfg["extra-files"] ?? []) {
        // addPath throws on an illegal ("../") path exactly as release-please
        // would — surfacing the misconfig instead of a silent no-op.
        const repoRelative = addPath(pkgDir, entry.path);
        const resolved = resolve(REPO_ROOT, repoRelative);
        expect(
          () => readFileSync(resolved, "utf8"),
          `extra-file '${entry.path}' (package '${pkgDir}') must resolve to a real file at ${resolved}`,
        ).not.toThrow();
      }
    }
  });
});
