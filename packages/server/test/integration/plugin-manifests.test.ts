/**
 * @file Plugin/marketplace manifest validation (spec 002, T010).
 *
 * The vibe-hero Claude Code plugin is distributed via committed, generated
 * manifests at the repo root + the plugin package. This test asserts those
 * manifests have the shape Claude Code / APM expect (FR-005/008/009/010):
 *   - root `.claude-plugin/marketplace.json` lists the plugin by `source`
 *   - the plugin `.mcp.json` launches the published server via npx (FR-008/012)
 *   - the plugin `plugin.json` carries identity + `skills` and NO `mcpServers`
 *     (MCP is declared in `.mcp.json` only — FR-008) and NO name-only `{name}`
 *     dependency entries (the agentic-packages bug — FR-010)
 *
 * These are static-file assertions (no build needed); they guard against drift
 * in the committed distribution artifacts.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";

// repo root = up from packages/server/test/integration
const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, "..", "..", "..", "..");
const readJson = (rel: string): unknown =>
  JSON.parse(readFileSync(resolve(REPO_ROOT, rel), "utf8"));

describe("distribution manifests (spec 002)", () => {
  it("root marketplace.json lists the vibe-hero plugin by source", () => {
    const mkt = readJson(".claude-plugin/marketplace.json") as {
      name: string;
      owner: { name: string };
      plugins: Array<{ name: string; source: string; version?: string }>;
    };
    expect(mkt.owner?.name).toBe("srobroek");
    const plugin = mkt.plugins.find((p) => p.name === "vibe-hero");
    expect(plugin, "marketplace must list the vibe-hero plugin").toBeDefined();
    expect(plugin?.source).toBe("./packages/vibe-hero-plugin");
  });

  it("plugin .mcp.json launches @vibe-hero/server via npx, unpinned (FR-008/012)", () => {
    const mcp = readJson("packages/vibe-hero-plugin/.mcp.json") as {
      mcpServers: Record<string, { command: string; args: string[] }>;
    };
    const server = mcp.mcpServers["vibe-hero"];
    expect(server).toBeDefined();
    expect(server?.command).toBe("npx");
    expect(server?.args).toEqual(["-y", "@vibe-hero/server"]);
    // floating latest: no version pin in the package spec
    const pkgArg = server?.args.find((a) => a.includes("@vibe-hero/server"));
    expect(pkgArg).toBe("@vibe-hero/server");
    expect(pkgArg).not.toMatch(/@vibe-hero\/server@/);
  });

  it("plugin.json carries identity + skills, NO mcpServers, and NO name-only deps (FR-008/010)", () => {
    const plugin = readJson(
      "packages/vibe-hero-plugin/.claude-plugin/plugin.json",
    ) as Record<string, unknown>;
    expect(plugin.name).toBe("vibe-hero");
    expect(plugin.skills).toBe("./.apm/skills");
    // MCP must be declared in .mcp.json ONLY — a duplicate mcpServers block in
    // plugin.json causes a conflicting same-name registration and breaks the plugin.
    expect(plugin.mcpServers, "plugin.json must NOT carry mcpServers (use .mcp.json)").toBeUndefined();
    // The standalone plugin must not carry APM `dependencies` (the agentic-packages
    // name-only `{name:...}` bug only affects bundle packages with first-party deps).
    expect(plugin.dependencies).toBeUndefined();
    // Defensive: if a `dependencies` array ever appears, every entry must carry a
    // real source field (git/path/registry), never the bare `{name}` form that
    // apm's parse_from_dict rejects. (`author.{name}` is fine — only deps matter.)
    const deps = (plugin as { dependencies?: unknown }).dependencies;
    if (Array.isArray(deps)) {
      for (const d of deps as Array<Record<string, unknown>>) {
        const keys = Object.keys(d);
        const hasSource = "git" in d || "path" in d || "registry" in d;
        expect(
          keys.length === 1 && keys[0] === "name",
          "dependency must not be a bare {name} entry (needs git/path/registry)",
        ).toBe(false);
        expect(hasSource, "dependency must declare a source").toBe(true);
      }
    }
  });

  it("ships a Claude-discoverable hooks/hooks.json that uses ${CLAUDE_PLUGIN_ROOT} (FR-007)", () => {
    // Claude Code discovers plugin hooks at `hooks/hooks.json` (NOT APM's
    // `.apm/hooks/` source). The command MUST use `${CLAUDE_PLUGIN_ROOT}` — the
    // token the NATIVE Claude Code plugin loader substitutes for the install
    // path. (`${PLUGIN_ROOT}` is the APM-only token; under `claude plugin
    // install` it stays unexpanded, so the command resolves to `/hooks/...` and
    // the UserPromptSubmit hook fails with a non-blocking error — observed in
    // the wild with the old Stop hook.)
    const hooks = readJson("packages/vibe-hero-plugin/hooks/hooks.json") as {
      hooks: {
        UserPromptSubmit?: Array<{ hooks: Array<{ type: string; command: string }> }>;
      };
    };
    const hookEntry = hooks.hooks?.UserPromptSubmit?.[0]?.hooks?.[0];
    expect(hookEntry, "hooks/hooks.json must register a UserPromptSubmit hook").toBeDefined();
    expect(hookEntry?.type).toBe("command");
    expect(hookEntry?.command).toContain("${CLAUDE_PLUGIN_ROOT}");
    expect(hookEntry?.command).toContain("hooks/claude-code/prompt-offer.sh");
    // the referenced script must actually ship + be non-empty
    const script = resolve(
      REPO_ROOT,
      "packages/vibe-hero-plugin/hooks/claude-code/prompt-offer.sh",
    );
    expect(readFileSync(script, "utf8").length).toBeGreaterThan(0);
  });

  it("the four skills are present under the plugin's .apm/skills", () => {
    for (const skill of [
      "vibe-hero-setup",
      "vibe-hero-quiz",
      "vibe-hero-status",
      "vibe-hero-learn",
    ]) {
      const md = readFileSync(
        resolve(
          REPO_ROOT,
          "packages/vibe-hero-plugin/.apm/skills",
          skill,
          "SKILL.md",
        ),
        "utf8",
      );
      expect(md.length, `${skill}/SKILL.md should be non-empty`).toBeGreaterThan(0);
    }
  });
});
