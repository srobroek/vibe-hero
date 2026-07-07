/**
 * @file Tool registry (T020).
 *
 * This wires all 11 MCP tools into a single {@link TOOL_REGISTRY} that
 * `index.ts` iterates over to register them. Each module carries its real input
 * schema (from `schemas/tools.ts`) so the host-facing tool signatures are
 * correct. `save_config` / `get_config` are the real US-0 implementations
 * (`./config.js`, T022); `get_status` / `list_topics` / `get_guidance` are the
 * real US-2 read tools (`./status.js`, `./listTopics.js`, `./guidance.js`,
 * T025–T027); `start_quiz` / `submit_answer` are the real US-1 core-loop tools
 * (`./startQuiz.js`, `./submitAnswer.js`, T031/T032); `record_observation` /
 * `get_offer` / `record_offer_response` are the real US-1 offer tools
 * (`./recordObservation.js`, `./offers.js`, T034/T036); `get_dashboard` is the
 * progress dashboard tool (`./dashboard.js`, tasks #18/#19). All 11 are real —
 * no placeholders remain.
 *
 * The registration architecture and gate wiring delivered here stay unchanged.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md.
 */

import { type AnyToolModule } from "./types.js";
import { saveConfigTool, getConfigTool } from "./config.js";
import { getStatusTool } from "./status.js";
import { listTopicsTool } from "./listTopics.js";
import { getGuidanceTool } from "./guidance.js";
import { startQuizTool } from "./startQuiz.js";
import { submitAnswerTool } from "./submitAnswer.js";
import { submitAnswersTool } from "./submitAnswers.js";
import { recordObservationTool } from "./recordObservation.js";
import { getOfferTool, recordOfferResponseTool } from "./offers.js";
import { getDashboardTool } from "./dashboard.js";

/**
 * All 11 vibe-hero MCP tools, in contract order. `index.ts` registers each one
 * (wrapping the handler with the setup gate). This list is the single source of
 * which tools exist.
 */
export const TOOL_REGISTRY: readonly AnyToolModule[] = [
  // Real US-2 read tools (T025–T027).
  getStatusTool,
  listTopicsTool,
  getGuidanceTool,
  // Real US-1 core-loop tools (T031/T032).
  startQuizTool,
  submitAnswerTool,
  // Batch form: all answers of one quiz in a single call.
  submitAnswersTool,
  // Real US-0 implementations (T022).
  saveConfigTool,
  getConfigTool,
  // Real US-1 observation/offer tools (T034/T036).
  recordObservationTool,
  getOfferTool,
  recordOfferResponseTool,
  // Dashboard (tasks #18/#19).
  getDashboardTool,
];
