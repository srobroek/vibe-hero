/**
 * @file Tool-registry contract shared by every MCP tool module (T020).
 *
 * Each tool lives in its own module exporting a {@link ToolModule}: a name, a
 * human description, a Zod `inputSchema` (an *object* schema — `index.ts` passes
 * its `.shape` to the SDK's `registerTool`), and a `handler`. The handler is the
 * pure tool logic; `index.ts` wraps it with the setup gate and adapts its plain
 * JSON result into the SDK's `CallToolResult` shape.
 *
 * Keeping the handler return type a plain JSON object (not a `CallToolResult`)
 * means tool logic stays decoupled from the transport: tests call handlers
 * directly and assert on the JSON, and later tasks can replace placeholder
 * handlers without touching transport wiring.
 *
 * Source of truth: specs/001-vibe-hero-mvp/contracts/mcp-tools.md.
 */

import type { z } from "zod";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

/**
 * A tool's JSON result: any serializable object. Concrete tools narrow this to
 * their contract's output schema (e.g. `GetConfigResult`); the registry keeps it
 * open so all 10 modules share one shape.
 */
export type ToolResult = Record<string, unknown>;

/** A tool handler: parsed+validated input in, JSON result out. */
export type ToolHandler<Args> = (args: Args) => Promise<ToolResult>;

/**
 * One MCP tool definition. `inputSchema` is a Zod object schema; its `.shape`
 * (a raw Zod shape, i.e. `Record<string, ZodType>`) is what the SDK's
 * `registerTool` expects as `inputSchema`. The `Schema` generic ties the
 * handler's argument to the schema's inferred type, so per-tool modules are
 * fully typed at their definition site.
 */
export interface ToolModule<
  Schema extends z.ZodObject<z.ZodRawShape> = z.ZodObject<z.ZodRawShape>,
> {
  /** The tool's wire name (e.g. `"get_status"`). */
  readonly name: string;
  /** One-line description surfaced to the host agent. */
  readonly description: string;
  /** Zod object schema for the tool's input. */
  readonly inputSchema: Schema;
  /** Pure tool logic, operating on parsed input. */
  readonly handler: ToolHandler<z.infer<Schema>>;
}

/**
 * Schema-erased registry entry. The per-tool `Schema` generic makes precise
 * {@link ToolModule} types mutually unassignable (the handler arg is
 * contravariant), so the registry collection stores this widened form:
 * `inputSchema` is a generic object schema and `handler` accepts `unknown`. The
 * SDK validates input against the shape before our handler runs, so the handler
 * may parse/narrow as needed; `index.ts` passes `unknown` straight through the
 * gate to it.
 */
export interface AnyToolModule {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: z.ZodObject<z.ZodRawShape>;
  readonly handler: ToolHandler<unknown>;
}

/**
 * Adapt a typed {@link ToolModule} into a schema-erased {@link AnyToolModule}
 * for the registry. The returned handler parses raw input through the module's
 * `inputSchema` (so the typed handler always receives validated, narrowed args)
 * and delegates. Placeholder handlers that ignore their input pass through
 * unchanged.
 *
 * @param tool - A fully-typed tool module.
 * @returns The erased registry entry.
 */
export const defineTool = <Schema extends z.ZodObject<z.ZodRawShape>>(
  tool: ToolModule<Schema>,
): AnyToolModule => ({
  name: tool.name,
  description: tool.description,
  inputSchema: tool.inputSchema,
  handler: async (args: unknown): Promise<ToolResult> =>
    tool.handler(tool.inputSchema.parse(args) as z.infer<Schema>),
});

/**
 * Adapt a plain JSON {@link ToolResult} into the SDK's `CallToolResult`.
 *
 * We populate both `content` (a JSON text block, the universally-readable form
 * for hosts/tests with no output schema) and `structuredContent` (the same
 * object, machine-readable). This keeps results inspectable without registering
 * an output schema for every tool yet.
 *
 * @param result - The tool's JSON result.
 * @returns A well-formed `CallToolResult`.
 */
export const toCallToolResult = (result: ToolResult): CallToolResult => ({
  content: [{ type: "text", text: JSON.stringify(result) }],
  structuredContent: result,
});
