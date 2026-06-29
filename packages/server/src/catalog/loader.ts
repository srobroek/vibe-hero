/**
 * @file Content catalog loader (T015).
 *
 * Reads YAML topic files from disk, parses them with `js-yaml`, and validates
 * each against {@link TopicSchema}. Authoring format is YAML (research OD-004):
 * one file per `(topic × class)` carrying every tier and trigger signal
 * (FR-004a). Validation is the load-time gate that prevents malformed content
 * from ever being served (FR-004) — a bad file is reported, never silently
 * served incorrectly.
 *
 * IO is intentionally thin (read file, list directory); the logic that matters
 * is parse + Zod validation + path-qualified diagnostics.
 *
 * Source of truth: specs/001-vibe-hero-mvp/data-model.md (§ Content Catalog),
 * spec FR-001/003a/004/004a/025, research.md OD-004.
 */

import { globSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { load as parseYaml } from "js-yaml";
import { z } from "zod";
import {
  CatalogManifestSchema,
  TopicSchema,
  type CatalogManifest,
  type Topic,
} from "../schemas/content.js";

/**
 * Placeholder catalog version used by {@link buildManifest} when no explicit
 * version is supplied and no manifest file is present. The fetch/publish layer
 * (later tasks) overwrites this with a real semver; until then a stable,
 * obviously-non-real sentinel keeps the manifest valid and self-documenting.
 */
export const PLACEHOLDER_CATALOG_VERSION = "0.0.0-bundled";

/** A per-file load failure: which file failed and a human-readable reason. */
export interface CatalogLoadError {
  /** Absolute or caller-relative path of the file that failed to load. */
  readonly file: string;
  /** Path-qualified, human-readable diagnostic (FR-004). */
  readonly message: string;
}

/** Outcome of loading a directory of topic files. */
export interface CatalogLoadResult {
  /** Every topic that parsed and validated cleanly. */
  readonly topics: Topic[];
  /** One entry per file that failed to parse or validate. */
  readonly errors: CatalogLoadError[];
}

/**
 * Format a Zod error into a multi-line, path-qualified diagnostic that names
 * the offending file and each failing field path (FR-004). Example:
 *
 * ```
 * Invalid topic in /catalog/general/subagents.yaml:
 *   - items.0.choices: multiple_choice requires at least 2 choices
 *   - items.1.answerKey: short_answer requires an answerKey of kind "keyword"
 * ```
 */
const formatZodError = (filePath: string, error: z.ZodError): string => {
  const issues = error.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `  - ${path}: ${issue.message}`;
    })
    .join("\n");
  return `Invalid topic in ${filePath}:\n${issues}`;
};

/**
 * Parse + Zod-validate a single topic from in-memory YAML text into a
 * {@link Topic}. This is the shared content-validation core used by BOTH the
 * on-disk loader ({@link loadTopicFromYaml}) and the network fetcher
 * (`fetcher.ts`), so fetched content runs through the **exact same**
 * {@link TopicSchema} validation before it can ever be cached or served
 * (research E8, FR-004).
 *
 * @param raw - The YAML document text.
 * @param sourceLabel - A label for diagnostics (a file path or a URL); appears
 *   in the thrown error messages so failures stay path/source-qualified.
 * @returns The validated topic.
 * @throws {Error} with a source-qualified, human-readable diagnostic if the text
 *   is not valid YAML or fails {@link TopicSchema} validation (FR-004). A
 *   malformed topic is rejected outright — never partially returned.
 */
export const parseTopicYaml = (raw: string, sourceLabel: string): Topic => {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw, { filename: sourceLabel });
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Invalid YAML in ${sourceLabel}: ${reason}`, { cause });
  }

  const result = TopicSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(formatZodError(sourceLabel, result.error), {
      cause: result.error,
    });
  }
  return result.data;
};

/**
 * Read, parse, and validate a single topic YAML file into a {@link Topic}.
 *
 * Thin IO wrapper over {@link parseTopicYaml}: it only adds the file read; the
 * parse + validation (and thus all diagnostics) are shared with the fetcher.
 *
 * @param filePath - Path to a `.yaml`/`.yml` file describing one topic × class.
 * @returns The validated topic.
 * @throws {Error} with a path-qualified, human-readable diagnostic if the file
 *   cannot be read, is not valid YAML, or fails {@link TopicSchema} validation
 *   (FR-004). The error never partially returns — a malformed topic is rejected
 *   outright so it cannot be silently served incorrectly.
 */
export const loadTopicFromYaml = (filePath: string): Topic => {
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new Error(`Cannot read topic file ${filePath}: ${reason}`, {
      cause,
    });
  }
  return parseTopicYaml(raw, filePath);
};

/**
 * Recursively load every `.yaml`/`.yml` topic file under `dir`, validating each
 * independently. One bad file does NOT abort the load: valid topics are
 * collected and every failure is reported as a {@link CatalogLoadError} so the
 * caller can surface a clear diagnostic while still serving the good content
 * (FR-004). Files are sorted by path for deterministic ordering.
 *
 * Subdirectories (`general/`, `claude-code/`, etc.) are walked transparently —
 * the directory layout is an authoring convenience; the `(id, class)` identity
 * lives inside each file.
 *
 * @param dir - Directory root to scan for topic files.
 */
export const loadCatalogFromDir = (dir: string): CatalogLoadResult => {
  const matches = globSync("**/*.{yaml,yml}", { cwd: dir });
  // Resolve to absolute paths and sort for deterministic, reproducible loads.
  const files = matches
    .map((m) => `${dir}/${m}`)
    .sort((a, b) => a.localeCompare(b));

  const topics: Topic[] = [];
  const errors: CatalogLoadError[] = [];

  for (const file of files) {
    try {
      topics.push(loadTopicFromYaml(file));
    } catch (cause) {
      errors.push({
        file,
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }

  return { topics, errors };
};

/** Options for {@link buildManifest}. */
export interface BuildManifestOptions {
  /**
   * Catalog version (semver). Defaults to {@link PLACEHOLDER_CATALOG_VERSION}
   * when omitted and no `version` can be read from a manifest file. The real
   * version is supplied by the fetch/publish layer in a later task.
   */
  readonly version?: string;
  /**
   * `publishedAt` timestamp (ISO datetime). Defaults to "now" at call time.
   */
  readonly publishedAt?: string;
  /**
   * Root directory the topics were loaded from. When provided, each manifest
   * topic's `file` is recorded relative to this root for a portable index;
   * otherwise the synthesized `<class-token>/<id>.yaml` convention is used.
   */
  readonly sourceDir?: string;
}

/** Serialize a {@link Topic.class} into a stable directory/token prefix. */
const classToken = (cls: Topic["class"]): string =>
  cls.kind === "general" ? "general" : cls.tool;

/**
 * Derive a {@link CatalogManifest} (version + fast topic index) from a set of
 * validated topics. The manifest is the lightweight listing the runtime uses to
 * enumerate topics without re-reading every file.
 *
 * `version` resolution order: explicit `options.version` → otherwise the
 * documented {@link PLACEHOLDER_CATALOG_VERSION} sentinel. (A future task may
 * read it from a manifest file shipped alongside the catalog; the option hook
 * is in place for that.)
 *
 * @param topics - Topics that have already passed {@link TopicSchema}.
 * @param options - Version/timestamp/source-dir overrides.
 */
export const buildManifest = (
  topics: readonly Topic[],
  options: BuildManifestOptions = {},
): CatalogManifest => {
  const version = options.version ?? PLACEHOLDER_CATALOG_VERSION;
  const publishedAt = options.publishedAt ?? new Date().toISOString();
  const sourceDir = options.sourceDir;

  const manifest: CatalogManifest = {
    version,
    publishedAt,
    topics: topics.map((topic) => {
      // Distinct, sorted tiers present in this topic's items.
      const tiers = [...new Set(topic.items.map((item) => item.tier))].sort(
        (a, b) => a - b,
      );
      const file =
        sourceDir !== undefined
          ? relative(sourceDir, `${classToken(topic.class)}/${topic.id}.yaml`)
          : `${classToken(topic.class)}/${topic.id}.yaml`;
      return {
        id: topic.id,
        class: topic.class,
        file,
        itemCount: topic.items.length,
        tiers,
      };
    }),
  };

  // Validate the synthesized manifest so a programming error here surfaces the
  // same way a bad topic file would, rather than emitting a subtly-wrong index.
  return CatalogManifestSchema.parse(manifest);
};
