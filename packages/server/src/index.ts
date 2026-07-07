/**
 * @file vibe-hero MCP server entry point (T020).
 *
 * Bootstraps a stdio MCP server (`@modelcontextprotocol/sdk`) named `vibe-hero`
 * with a `tools` capability, then registers all 10 tools from
 * {@link TOOL_REGISTRY}. Each tool's handler is wrapped with both gates
 * ({@link withGates}: setup gate + tool gate) and adapted from its plain-JSON
 * result into the SDK's `CallToolResult` shape ({@link toCallToolResult}).
 *
 * The SDK idiom (sdk 1.29.0): construct {@link McpServer}, then call
 * `registerTool(name, { description, inputSchema }, cb)`. `registerTool` expects
 * `inputSchema` as a *raw Zod shape* (`Record<string, ZodType>`), so we pass the
 * registry's `inputSchema.shape` and the SDK hands the callback the parsed,
 * validated args. Transport is {@link StdioServerTransport}.
 *
 * Importing this module never starts the server; only running it as the process
 * entrypoint does (see the `import.meta.url` guard at the bottom), so tests can
 * import {@link createServer} freely.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md, plan.md.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TOOL_REGISTRY } from "./tools/registry.js";
import { withGates } from "./tools/gate.js";
import { toCallToolResult, type AnyToolModule } from "./tools/types.js";
import {
  detectToolFromClientName,
  getDetectedTool,
  setDetectedTool,
  setRawClientName,
} from "./detection.js";
import { debug } from "./log.js";
import { isEntrypoint } from "./lib/isEntrypoint.js";
import { timed, logPerfSummary } from "./perf.js";
import { startDrainTimer } from "./observation/drain.js";
import { resolveCatalog } from "./catalog/resolve.js";

// Re-export detection helpers so callers that import from "index.ts" still work.
export { detectToolFromClientName, getDetectedTool } from "./detection.js";

/** Server name advertised to MCP hosts. Matches the product/skill namespace. */
export const SERVER_NAME = "vibe-hero";

export { SERVER_VERSION } from "./version.js";
import { SERVER_VERSION } from "./version.js";

/**
 * Register one tool module on an {@link McpServer}, gating its handler and
 * adapting the JSON result to a `CallToolResult`. Pulled out so both production
 * and tests register tools the same way; `dirOverride` flows to the gate's
 * profile lookup as a test seam.
 *
 * @param server - The MCP server to register onto.
 * @param tool - The tool module from {@link TOOL_REGISTRY}.
 * @param dirOverride - Profile-directory override (test seam) for the gate.
 */
export const registerToolModule = (
  server: McpServer,
  tool: AnyToolModule,
  dirOverride?: string,
): void => {
  const gated = withGates(tool.name, tool.handler, dirOverride);
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      // `registerTool` wants a raw Zod shape, not a wrapped object schema.
      inputSchema: tool.inputSchema.shape,
    },
    async (args: unknown) => {
      debug(`tool call: ${tool.name}`, args);
      const result = await timed(`tool:${tool.name}`, () => gated(args));
      const status =
        result && typeof result === "object" && "status" in result
          ? (result as { status?: unknown }).status
          : "ok";
      debug(`tool result: ${tool.name}`, { status });
      return toCallToolResult(result);
    },
  );
};

/**
 * Construct the vibe-hero MCP server with all tools registered (gated). Does not
 * connect a transport — call {@link main} (or wire your own transport) to start.
 *
 * @param dirOverride - Profile-directory override (test seam) for the gate.
 * @returns A configured, not-yet-connected {@link McpServer}.
 */
export const createServer = (dirOverride?: string): McpServer => {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { capabilities: { tools: {} } },
  );
  for (const tool of TOOL_REGISTRY) {
    registerToolModule(server, tool, dirOverride);
  }
  return server;
};

/**
 * Start the server over stdio. Connects a {@link StdioServerTransport},
 * resolves once connected, and then reads the client's `clientInfo.name`
 * from the completed MCP handshake to populate {@link _detectedTool}.
 *
 * Detection is best-effort: if the client provides no name or the name
 * does not map to a known {@link ToolId}, `_detectedTool` stays `undefined`
 * and tools degrade gracefully (no crash, no forced config).
 */
export const main = async (): Promise<void> => {
  debug(`starting MCP server ${SERVER_NAME} v${SERVER_VERSION}`, {
    node: process.version,
    argv: process.argv,
    tools: TOOL_REGISTRY.length,
  });
  const server = createServer();
  const transport = new StdioServerTransport();

  // Read clientInfo.name from the COMPLETED handshake to map it to a ToolId.
  // This MUST run in `oninitialized` (fires after the MCP `initialize` round-trip),
  // NOT immediately after `connect()` — over stdio `connect()` resolves before the
  // handshake completes, so reading `getClientVersion()` there races and returns
  // undefined (which would wrongly mark every host UNSUPPORTED_TOOL).
  // Both the raw name and the mapped ToolId are stored so the tool gate can surface
  // the raw name in UNSUPPORTED_TOOL messages even when it does not map. If the
  // client provides no name, both stay undefined and the tool gate returns
  // UNSUPPORTED_TOOL unless toolsLearning provides a valid configured tool.
  server.server.oninitialized = (): void => {
    const clientVersion = server.server.getClientVersion();
    if (clientVersion?.name !== undefined) {
      setRawClientName(clientVersion.name);
      const detected = detectToolFromClientName(clientVersion.name);
      setDetectedTool(detected);
      debug("handshake complete", {
        clientName: clientVersion.name,
        detectedTool: detected ?? "(unsupported — UNSUPPORTED_TOOL until configured)",
      });
    } else {
      debug("handshake complete but client sent no name", {});
    }
  };

  await server.connect(transport);
  debug("connected over stdio; awaiting tool calls");

  // Organic intake: start the spool-drain timer (observation/drain.ts). The
  // interval is unref()'d, so it never keeps the process alive once stdio
  // closes; stopping explicitly on transport close keeps shutdown tidy.
  const drain = startDrainTimer({
    loadTopics: async () => (await resolveCatalog()).topics,
    tool: getDetectedTool,
    now: () => new Date(),
  });
  transport.onclose = (): void => {
    drain.stop();
    logPerfSummary();
    debug("stdio transport closed; drain timer stopped");
  };
};

if (isEntrypoint(import.meta.url)) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `vibe-hero: fatal error starting MCP server: ${String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
