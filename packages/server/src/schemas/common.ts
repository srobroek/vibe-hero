/**
 * @file Shared primitive schemas, enums, and codec helpers for vibe-hero.
 *
 * Zod is the single source of truth: every entity exports both its schema and
 * the inferred type. This module is imported by `content.ts`, `profile.ts`, and
 * `tools.ts`; it must not import from any of them (no cycles).
 *
 * Source of truth: specs/001-vibe-hero-mvp/data-model.md (§ Identifiers & enums).
 */

import { z } from "zod";

/**
 * The set of host coding tools vibe-hero can teach. Extensible; v1 populates
 * `claude-code` content only, but all four ids are valid configuration values.
 */
export const ToolIdSchema = z.enum([
  "claude-code",
  "codex",
  "kiro-cli",
  "kiro-ide",
]);
/** A host coding tool identifier. */
export type ToolId = z.infer<typeof ToolIdSchema>;

/**
 * Classifies content as either tool-agnostic (`general`) or specific to one
 * {@link ToolId}. Modelled as a discriminated union on `kind` so downstream
 * code can switch exhaustively and the tool-specific branch carries its tool.
 *
 * Rationale: a tagged union (rather than `"general" | { tool }`) keeps the
 * serialized shape uniform (always an object with a `kind`), which makes the
 * {@link abilityKey} codec and JSON persistence straightforward and total.
 */
export const ContentClassSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("general") }),
  z.object({ kind: z.literal("tool"), tool: ToolIdSchema }),
]);
/** Whether content is general or scoped to a specific tool. */
export type ContentClass = z.infer<typeof ContentClassSchema>;

/** The course-numbering ladder. Higher tiers gate behind lower ones. */
export const TierSchema = z.union([
  z.literal(100),
  z.literal(200),
  z.literal(300),
  z.literal(400),
  z.literal(500),
]);
/** A mastery tier on the 100–500 ladder. */
export type Tier = z.infer<typeof TierSchema>;

/** Bloom's taxonomy depth tag for an item. */
export const BloomLevelSchema = z.enum([
  "remember",
  "understand",
  "apply",
  "analyze",
  "evaluate",
  "create",
]);
/** A Bloom's-taxonomy cognitive level. */
export type BloomLevel = z.infer<typeof BloomLevelSchema>;

/** The supported question formats. */
export const QuestionTypeSchema = z.enum([
  "multiple_choice",
  "short_answer",
  "free_form",
]);
/** A question format. */
export type QuestionType = z.infer<typeof QuestionTypeSchema>;

/**
 * The derived binary projection of a score persisted in history.
 * `Grade = score >= passThreshold ? "correct" : "incorrect"`.
 */
export const GradeSchema = z.enum(["correct", "incorrect"]);
/** A binary correctness verdict. */
export type Grade = z.infer<typeof GradeSchema>;

/**
 * Serialized `(class, topicId)` ability key, e.g. `claude-code|subagents` or
 * `general|planning`. Validated as a non-empty `class|topic` string; use
 * {@link abilityKey} / {@link parseAbilityKey} to build and read it safely.
 */
export const AbilityKeySchema = z
  .string()
  .regex(
    /^(general|tool:(claude-code|codex|kiro-cli|kiro-ide))\|.+$/,
    "AbilityKey must serialize as 'class|topic' (e.g. 'general|planning' or 'tool:claude-code|subagents')",
  );
/** A serialized ability key string. */
export type AbilityKey = z.infer<typeof AbilityKeySchema>;

/** Serialized class prefix used inside an {@link AbilityKey}. */
const classToken = (cls: ContentClass): string =>
  cls.kind === "general" ? "general" : `${cls.kind}:${cls.tool}`;

/**
 * Serialize a `(class, topicId)` pair into an {@link AbilityKey} string.
 *
 * The class prefix is `general` for general content or `tool:<toolId>` for
 * tool-specific content; the topic id follows after a single `|` separator.
 *
 * @example
 * abilityKey({ kind: "general" }, "planning"); // "general|planning"
 * abilityKey({ kind: "tool", tool: "claude-code" }, "subagents"); // "tool:claude-code|subagents"
 */
export const abilityKey = (cls: ContentClass, topicId: string): AbilityKey =>
  `${classToken(cls)}|${topicId}`;

/** Result of decoding an {@link AbilityKey}. */
export interface ParsedAbilityKey {
  readonly class: ContentClass;
  readonly topicId: string;
}

/**
 * Parse an {@link AbilityKey} string back into its `(class, topicId)` pair.
 * Inverse of {@link abilityKey}.
 *
 * @throws {Error} if the string is not a well-formed `class|topic` key.
 */
export const parseAbilityKey = (key: string): ParsedAbilityKey => {
  const sep = key.indexOf("|");
  if (sep <= 0 || sep === key.length - 1) {
    throw new Error(`Malformed AbilityKey: ${JSON.stringify(key)}`);
  }
  const classPart = key.slice(0, sep);
  const topicId = key.slice(sep + 1);
  if (classPart === "general") {
    return { class: { kind: "general" }, topicId };
  }
  const toolMatch = /^tool:(.+)$/.exec(classPart);
  if (toolMatch && toolMatch[1] !== undefined) {
    const tool = ToolIdSchema.parse(toolMatch[1]);
    return { class: { kind: "tool", tool }, topicId };
  }
  throw new Error(`Malformed AbilityKey class segment: ${JSON.stringify(key)}`);
};
