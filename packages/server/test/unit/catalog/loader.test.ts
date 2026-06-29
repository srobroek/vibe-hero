/**
 * @file Unit tests for the catalog loader + bundled snapshot (T015/T016).
 *
 * Covers: bundled snapshot loads ≥1 topic with no errors (FR-025);
 * path-qualified diagnostics on invalid topics (FR-004); per-file error
 * collection without aborting the whole load.
 */

import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  buildManifest,
  loadCatalogFromDir,
  loadTopicFromYaml,
  PLACEHOLDER_CATALOG_VERSION,
} from "../../../src/catalog/loader.js";
import { loadBundledCatalog } from "../../../src/catalog/bundled/index.js";

describe("loadBundledCatalog (T016, FR-025)", () => {
  it("loads at least one topic with no errors", () => {
    const { topics, errors } = loadBundledCatalog();
    expect(errors).toEqual([]);
    expect(topics.length).toBeGreaterThanOrEqual(1);
  });

  it("builds a valid manifest from the bundled topics", () => {
    const { topics } = loadBundledCatalog();
    const manifest = buildManifest(topics);
    expect(manifest.version).toBe(PLACEHOLDER_CATALOG_VERSION);
    expect(manifest.topics.length).toBe(topics.length);
    for (const entry of manifest.topics) {
      expect(entry.itemCount).toBeGreaterThanOrEqual(0);
    }
  });
});

describe("loadTopicFromYaml (T015, FR-004)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibe-hero-loader-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("throws a path-qualified diagnostic for a schema violation", () => {
    const file = join(dir, "bad.yaml");
    // multiple_choice with only one choice + missing answerKey.
    writeFileSync(
      file,
      [
        "id: bad",
        "class: { kind: general }",
        "title: Bad",
        "summary: bad",
        "triggerSignals: []",
        "items:",
        "  - id: q1",
        "    tier: 100",
        "    bloom: remember",
        "    difficulty: 200",
        "    type: multiple_choice",
        "    prompt: q?",
        "    choices:",
        "      - { id: a, text: only one }",
        "    guidance: g",
      ].join("\n"),
      "utf8",
    );
    expect(() => loadTopicFromYaml(file)).toThrowError(/bad\.yaml/);
    expect(() => loadTopicFromYaml(file)).toThrowError(/choices/);
  });

  it("throws a path-qualified diagnostic for invalid YAML", () => {
    const file = join(dir, "broken.yaml");
    writeFileSync(file, "id: [unterminated", "utf8");
    expect(() => loadTopicFromYaml(file)).toThrowError(/broken\.yaml/);
  });
});

describe("loadCatalogFromDir (T015, FR-004)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vibe-hero-catalog-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("collects valid topics and per-file errors without aborting", () => {
    mkdirSync(join(dir, "general"), { recursive: true });
    // One valid topic.
    writeFileSync(
      join(dir, "general", "good.yaml"),
      [
        "id: good",
        "class: { kind: general }",
        "title: Good",
        "summary: good topic",
        "triggerSignals: []",
        "items:",
        "  - id: q1",
        "    tier: 100",
        "    bloom: remember",
        "    difficulty: 200",
        "    type: short_answer",
        "    prompt: q?",
        "    answerKey: { kind: keyword, anyOf: [yes] }",
        "    guidance: g",
      ].join("\n"),
      "utf8",
    );
    // One invalid topic (free_form without rubric).
    writeFileSync(
      join(dir, "general", "bad.yaml"),
      [
        "id: bad",
        "class: { kind: general }",
        "title: Bad",
        "summary: bad",
        "triggerSignals: []",
        "items:",
        "  - id: q1",
        "    tier: 100",
        "    bloom: create",
        "    difficulty: 400",
        "    type: free_form",
        "    prompt: q?",
        "    guidance: g",
      ].join("\n"),
      "utf8",
    );

    const { topics, errors } = loadCatalogFromDir(dir);
    expect(topics.map((t) => t.id)).toEqual(["good"]);
    expect(errors).toHaveLength(1);
    expect(errors[0]?.message).toMatch(/bad\.yaml/);
    expect(errors[0]?.message).toMatch(/rubric/);
  });

  it("returns empty result for an empty directory", () => {
    const { topics, errors } = loadCatalogFromDir(dir);
    expect(topics).toEqual([]);
    expect(errors).toEqual([]);
  });
});
