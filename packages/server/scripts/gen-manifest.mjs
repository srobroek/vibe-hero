/**
 * @file gen-manifest.mjs — CI manifest generator (STEP 3 / issue #15).
 *
 * Walks repo-root content/<class>/<topic>.yaml, parses+validates each file
 * with the same TopicSchema the runtime uses, computes a sha256 digest of
 * each file's raw bytes, and writes content/manifest.json.
 *
 * Output shape:
 *   {
 *     version: <package version from packages/server/package.json>,
 *     publishedAt: <ISO from PUBLISHED_AT env var or new Date()>,
 *     topics: [{ id, class, file, itemCount, tiers, sha256 }]
 *   }
 *
 * Run via: node scripts/gen-manifest.mjs
 * (called from the build script before copy-assets so manifest.json ships in
 * the bundle).
 *
 * Node >=18 is sufficient — we use only built-ins (node:fs, node:path,
 * node:crypto) plus js-yaml which is already a runtime dependency.
 */

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import yaml from "js-yaml";

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
/** packages/server/ */
const pkgDir = resolve(__dirname, "..");
/** repo root */
const repoRoot = resolve(pkgDir, "../..");
const contentRoot = join(repoRoot, "content");
const outputPath = join(contentRoot, "manifest.json");

// ---------------------------------------------------------------------------
// Load server package.json for the version field
// ---------------------------------------------------------------------------

const pkgJson = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));
const version = pkgJson.version;
if (typeof version !== "string" || !version) {
  throw new Error("gen-manifest: could not read version from packages/server/package.json");
}

// ---------------------------------------------------------------------------
// publishedAt: env var wins so CI can stamp an authoritative time
// ---------------------------------------------------------------------------

const publishedAt = process.env["PUBLISHED_AT"] ?? new Date().toISOString();

// ---------------------------------------------------------------------------
// Collect YAML files: content/<class>/<topic>.yaml
// ---------------------------------------------------------------------------

/**
 * Walk a directory recursively and return absolute paths of all .yaml/.yml
 * files, sorted for deterministic output.
 */
const walkYaml = (dir) => {
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err.code === "ENOENT") return [];
    throw err;
  }
  const out = [];
  for (const e of entries) {
    const full = join(dir, e.name);
    if (e.isDirectory()) {
      out.push(...walkYaml(full));
    } else if (e.isFile() && /\.ya?ml$/i.test(e.name)) {
      out.push(full);
    }
  }
  return out.sort((a, b) => a.localeCompare(b));
};

// ---------------------------------------------------------------------------
// Inline ContentClass serializer (mirrors schemas/common.ts classToken)
// ---------------------------------------------------------------------------

/**
 * Convert a parsed ContentClass object to a stable string token.
 * Matches the abilityKey logic in the runtime.
 */
const classToken = (cls) => {
  if (cls.kind === "general") return "general";
  return cls.tool; // "claude-code" | "codex" | "kiro-cli" | "kiro-ide"
};

// ---------------------------------------------------------------------------
// Inline TopicSchema validation (subset — validates required fields)
// ---------------------------------------------------------------------------

const VALID_TIERS = new Set([100, 200, 300, 400, 500]);

/**
 * Minimal structural validation that mirrors what TopicSchema enforces.
 * We can't import the Zod schema here (ESM in CJS devDeps gap), so we do a
 * light hand-rolled check. The full Zod validation runs at server startup.
 */
const validateTopic = (raw, sourceLabel) => {
  if (typeof raw !== "object" || raw === null)
    throw new Error(`${sourceLabel}: expected an object at root`);
  if (typeof raw.id !== "string" || !raw.id)
    throw new Error(`${sourceLabel}: missing or empty 'id'`);
  if (typeof raw.class !== "object" || raw.class === null)
    throw new Error(`${sourceLabel}: missing 'class'`);
  const kind = raw.class.kind;
  if (kind !== "general" && kind !== "tool")
    throw new Error(`${sourceLabel}: class.kind must be 'general' or 'tool'`);
  if (kind === "tool" && typeof raw.class.tool !== "string")
    throw new Error(`${sourceLabel}: class.tool must be a string when kind=tool`);
  if (!Array.isArray(raw.items))
    throw new Error(`${sourceLabel}: 'items' must be an array`);
  return raw;
};

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const allYaml = walkYaml(contentRoot).filter(
  // Exclude manifest.json itself if it somehow got a .yaml extension, and
  // also guard against picking up the output file.
  (f) => !f.endsWith("manifest.json") && !f.endsWith("manifest.yaml"),
);

const topics = [];

for (const absPath of allYaml) {
  const rawBytes = readFileSync(absPath);
  const rawText = rawBytes.toString("utf8");

  // Relative path from repo root, e.g. "content/claude-code/subagents.yaml"
  const relPath = relative(repoRoot, absPath).replace(/\\/g, "/");

  let parsed;
  try {
    parsed = yaml.load(rawText, { filename: absPath });
  } catch (err) {
    process.stderr.write(`gen-manifest: YAML parse error in ${relPath}: ${err.message}\n`);
    process.exit(1);
  }

  try {
    validateTopic(parsed, relPath);
  } catch (err) {
    process.stderr.write(`gen-manifest: validation error: ${err.message}\n`);
    process.exit(1);
  }

  // Compute sha256 of raw file bytes (not parsed text, so encoding is stable)
  const sha256 = createHash("sha256").update(rawBytes).digest("hex");

  // Distinct sorted tiers present in items
  const tiers = [
    ...new Set(
      (parsed.items ?? [])
        .map((item) => item.tier)
        .filter((t) => VALID_TIERS.has(t)),
    ),
  ].sort((a, b) => a - b);

  // Relative path from content root, e.g. "claude-code/subagents.yaml"
  const fileRel = relative(contentRoot, absPath).replace(/\\/g, "/");

  topics.push({
    id: parsed.id,
    class: parsed.class,
    file: fileRel,
    itemCount: (parsed.items ?? []).length,
    tiers,
    sha256,
  });
}

const manifest = {
  version,
  publishedAt,
  topics,
};

writeFileSync(outputPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

const count = topics.length;
process.stdout.write(
  `gen-manifest: wrote ${outputPath} (${count} topic${count === 1 ? "" : "s"}, version ${version})\n`,
);
