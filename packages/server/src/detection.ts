/**
 * @file Client tool auto-detection state.
 *
 * Holds the MCP-handshake-derived {@link ToolId} and the raw client name so
 * tool handlers can resolve the active tool or surface a clear error when the
 * host is unsupported. Extracted into its own module to avoid a circular
 * dependency on `index.ts` (which imports `tools/placeholders.ts` → every tool).
 *
 * Usage:
 *  - `index.ts` calls {@link setDetectedTool} and {@link setRawClientName} after
 *    `server.connect()`.
 *  - The tool gate reads {@link getDetectedTool} and {@link getRawClientName} to
 *    decide whether to allow the call or return UNSUPPORTED_TOOL.
 *  - Tests call the setters to inject or reset detection state between runs.
 *
 * Supported tools: claude-code, codex, kiro-cli, kiro-ide.
 * Unknown/unmatched host names → {@link detectToolFromClientName} returns
 * `undefined`. The gate treats this as an unsupported host and returns
 * UNSUPPORTED_TOOL rather than silently defaulting to claude-code.
 */

import { type ToolId, ToolIdSchema } from "./schemas/common.js";

/**
 * Module-level reference to the auto-detected host tool, populated after
 * the first successful MCP handshake. `undefined` until {@link setDetectedTool}
 * is called or when the client name does not map to a supported {@link ToolId}.
 */
let _detectedTool: ToolId | undefined = undefined;

/**
 * Raw `clientInfo.name` string from the MCP initialize handshake. Stored
 * separately from the mapped ToolId so the gate can surface it in the
 * UNSUPPORTED_TOOL error message even when the name did not map to any ToolId.
 * `undefined` until {@link setRawClientName} is called.
 */
let _rawClientName: string | undefined = undefined;

/**
 * Return the auto-detected host tool, or `undefined` if detection has not
 * run or could not map the client name to a known {@link ToolId}.
 *
 * Safe to call at any time — returns `undefined` before the handshake
 * completes (the tool gate checks this and returns UNSUPPORTED_TOOL when
 * no supported tool can be resolved).
 */
export const getDetectedTool = (): ToolId | undefined => _detectedTool;

/**
 * Set (or clear) the auto-detected tool. Called by `index.ts` after
 * `server.connect()` and by tests to inject or reset the detection state.
 *
 * @param tool - The detected {@link ToolId}, or `undefined` to clear.
 */
export const setDetectedTool = (tool: ToolId | undefined): void => {
  _detectedTool = tool;
};

/**
 * Return the raw `clientInfo.name` from the MCP handshake, or `undefined`
 * before the handshake completes or when the client did not supply a name.
 */
export const getRawClientName = (): string | undefined => _rawClientName;

/**
 * Set (or clear) the raw client name. Called by `index.ts` alongside
 * {@link setDetectedTool} and by tests.
 *
 * @param name - The raw `clientInfo.name`, or `undefined` to clear.
 */
export const setRawClientName = (name: string | undefined): void => {
  _rawClientName = name;
};

/**
 * Map a raw `clientInfo.name` string (from the MCP initialize handshake) to
 * a known {@link ToolId}, or return `undefined` when no mapping is found.
 *
 * Matching is case-insensitive and substring-based to accommodate client
 * name variations (e.g. "Claude Code", "claude-code", "claude_code" all map
 * to `"claude-code"`). The "kiro" heuristic checks for "ide" in the name to
 * distinguish kiro-ide from kiro-cli; absent that suffix it defaults to
 * `"kiro-cli"`.
 *
 * Supported tool names: claude-code, codex, kiro-cli, kiro-ide.
 * Returns `undefined` for any unrecognised name — callers must treat this as
 * an unsupported host, NOT silently fall back to claude-code.
 *
 * @param name - The raw `clientInfo.name` string from the initialize request.
 * @returns A {@link ToolId} or `undefined` if unmapped.
 */
export const detectToolFromClientName = (name: string): ToolId | undefined => {
  const n = name.toLowerCase();
  if (n.includes("claude")) return "claude-code";
  if (n.includes("codex")) return "codex";
  if (n.includes("kiro")) {
    if (n.includes("ide")) return "kiro-ide";
    return "kiro-cli";
  }
  // Validate against the schema for any exact match (future-proof).
  const parsed = ToolIdSchema.safeParse(n.trim());
  if (parsed.success) return parsed.data;
  return undefined;
};
