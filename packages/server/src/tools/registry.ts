/**
 * @file Tool registry — the single list of MCP tools `index.ts` registers.
 * (Renamed from placeholders.ts, a leftover scaffolding name — sniff 2026-07-07.)
 *
 * This wires every MCP tool into a single {@link TOOL_REGISTRY} that
 * `index.ts` iterates over to register them. Each module carries its real input
 * schema (from `schemas/tools.ts`) so the host-facing tool signatures are
 * correct. The list is the single source of which tools exist; the gate.ts
 * exemptions (`get_config` / `save_config`) key off the names registered here.
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
