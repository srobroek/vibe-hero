/**
 * @file vibe-hero MCP server entry point (T020).
 *
 * Bootstraps a stdio MCP server (`@modelcontextprotocol/sdk`) named `vibe-hero`
 * with a `tools` capability, then registers all 10 tools from
 * {@link TOOL_REGISTRY}. Each tool's handler is wrapped with the first-run setup
 * gate (T021, {@link withSetupGate}) and adapted from its plain-JSON result into
 * the SDK's `CallToolResult` shape ({@link toCallToolResult}).
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

import { fileURLToPath } from "node:url";
import { argv } from "node:process";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { TOOL_REGISTRY } from "./tools/placeholders.js";
import { withSetupGate } from "./tools/gate.js";
import { toCallToolResult, type AnyToolModule } from "./tools/types.js";

/** Server name advertised to MCP hosts. Matches the product/skill namespace. */
export const SERVER_NAME = "vibe-hero";

/** Server version advertised to MCP hosts. */
export const SERVER_VERSION = "0.1.0";

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
  const gated = withSetupGate(tool.name, tool.handler, dirOverride);
  server.registerTool(
    tool.name,
    {
      description: tool.description,
      // `registerTool` wants a raw Zod shape, not a wrapped object schema.
      inputSchema: tool.inputSchema.shape,
    },
    async (args: unknown) => toCallToolResult(await gated(args)),
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
 * Start the server over stdio. Connects a {@link StdioServerTransport} and
 * resolves once connected; the process then stays alive serving tool calls.
 */
export const main = async (): Promise<void> => {
  const server = createServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
};

/**
 * Entrypoint guard: only auto-start when this module is the process entrypoint
 * (`node .../index.js`), not when imported by tests. Compares the resolved
 * module path to `argv[1]`.
 */
const isEntrypoint = (): boolean => {
  const entry = argv[1];
  if (entry === undefined) return false;
  return fileURLToPath(import.meta.url) === entry;
};

if (isEntrypoint()) {
  main().catch((err: unknown) => {
    process.stderr.write(
      `vibe-hero: fatal error starting MCP server: ${String(err)}\n`,
    );
    process.exitCode = 1;
  });
}
