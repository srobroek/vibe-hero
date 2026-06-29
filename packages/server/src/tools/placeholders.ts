/**
 * @file Placeholder tool modules + the tool registry (T020).
 *
 * This wires all 10 MCP tools into a single {@link TOOL_REGISTRY} that
 * `index.ts` iterates over to register them. Each module carries its real input
 * schema (from `schemas/tools.ts`) so the host-facing tool signatures are
 * already correct. `save_config` / `get_config` are now the real US-0
 * implementations (imported from `./config.js`, T022); the remaining 8 handlers
 * are still placeholders returning a structured "not implemented yet" result.
 *
 * Later tasks replace the rest in place (US-1 → start_quiz/submit_answer;
 * US-2 → get_status/list_topics/get_guidance; offers → record_observation/
 * get_offer/record_offer_response). The registration architecture and gate
 * wiring delivered here stay unchanged.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md.
 */

import { z } from "zod";

import {
  GetStatusInputSchema,
  ListTopicsInputSchema,
  GetGuidanceInputSchema,
  StartQuizInputSchema,
  RecordObservationInputSchema,
  GetOfferInputSchema,
  RecordOfferResponseInputSchema,
} from "../schemas/tools.js";
import { defineTool, type AnyToolModule, type ToolResult } from "./types.js";
import { saveConfigTool, getConfigTool } from "./config.js";

/**
 * `submit_answer`'s contract input is a *union* (deterministic answer XOR
 * free-form verdict), which has no single object `.shape` to hand the SDK. The
 * registry needs an object schema, so we present a permissive superset here:
 * `quizId` + `itemId` required, `answer`/`verdict` optional. The real
 * discriminated validation lands with the handler in a later task (T030+).
 */
const SubmitAnswerToolInputSchema = z.object({
  quizId: z.string(),
  itemId: z.string(),
  answer: z
    .object({
      choiceId: z.string().optional(),
      text: z.string().optional(),
    })
    .optional(),
  verdict: z
    .object({
      criteria: z.array(
        z.object({
          id: z.string(),
          met: z.boolean(),
          justification: z.string(),
        }),
      ),
    })
    .optional(),
});

/**
 * Build the placeholder result for a not-yet-implemented tool. Shaped so callers
 * (and tests) can distinguish it from a real result and from the gate sentinel.
 */
const notImplemented = (toolName: string): ToolResult => ({
  status: "NOT_IMPLEMENTED",
  tool: toolName,
  message: `vibe-hero tool "${toolName}" is registered but not implemented yet.`,
});

/**
 * Define a placeholder tool module from its name, description, and input schema,
 * erased into a registry entry via {@link defineTool}. The handler ignores its
 * (validated) input and returns {@link notImplemented}.
 */
const placeholder = <Schema extends z.ZodObject<z.ZodRawShape>>(
  name: string,
  description: string,
  inputSchema: Schema,
): AnyToolModule =>
  defineTool({
    name,
    description,
    inputSchema,
    handler: async (): Promise<ToolResult> => notImplemented(name),
  });

/**
 * All 10 vibe-hero MCP tools, in contract order. `index.ts` registers each one
 * (wrapping the handler with the setup gate). Replace individual `handler`s in
 * later tasks; this list is the single source of which tools exist.
 */
export const TOOL_REGISTRY: readonly AnyToolModule[] = [
  placeholder(
    "get_status",
    "Show the user's learning standing for a tool (or all). Read-only.",
    GetStatusInputSchema,
  ),
  placeholder(
    "list_topics",
    "Enumerate catalog topics, optionally filtered by tool or class. Read-only.",
    ListTopicsInputSchema,
  ),
  placeholder(
    "get_guidance",
    "Return teaching guidance and what to learn next for a topic or the weakest area. Read-only.",
    GetGuidanceInputSchema,
  ),
  placeholder(
    "start_quiz",
    "Begin a quiz session for a topic, selecting 3-5 difficulty-targeted items.",
    StartQuizInputSchema,
  ),
  placeholder(
    "submit_answer",
    "Grade one quiz item (deterministic answer or free-form host verdict) and update ability.",
    SubmitAnswerToolInputSchema,
  ),
  // Real US-0 implementations (T022); the other 8 remain placeholders.
  saveConfigTool,
  getConfigTool,
  placeholder(
    "record_observation",
    "Intake derived activity signals and map them to candidate offer topics. Never scores.",
    RecordObservationInputSchema,
  ),
  placeholder(
    "get_offer",
    "Resolve whether to surface an end-of-work learning offer for the session.",
    GetOfferInputSchema,
  ),
  placeholder(
    "record_offer_response",
    "Record an accept/decline/defer offer response so cadence and anti-nag are honored.",
    RecordOfferResponseInputSchema,
  ),
];
