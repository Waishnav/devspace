import {
  renderDeclarations,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import * as z from "zod/v4";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { contentText } from "./tool-surfaces/shared.js";
import type { ToolContent } from "./tool-surfaces/types.js";

type Handler = (input: Record<string, unknown>, extra: { signal: AbortSignal }) => Promise<{
  isError?: boolean;
  content?: ToolContent[];
  structuredContent?: Record<string, unknown>;
}>;

interface Entry {
  name: string;
  description: string;
  input: z.ZodObject<z.ZodRawShape>;
  output: z.ZodObject<z.ZodRawShape>;
  handler: Handler;
}

/** Records the real MCP registrations, so Code Mode never duplicates their handlers or schemas. */
export class CodeModeRegistry {
  private readonly entries = new Map<string, Entry>();

  readonly registrationTarget: McpRegistrationTarget = {
    registerTool: ((name: string, definition: Record<string, unknown>, handler: Handler) => {
      const input = z.object(definition.inputSchema as z.ZodRawShape);
      const output = z.object(definition.outputSchema as z.ZodRawShape);
      this.entries.set(name, {
        name,
        description: definition.description as string,
        input,
        output,
        handler,
      });
      // This target collects internal registrations; nothing is registered with the MCP host.
      return undefined;
    }) as unknown as McpRegistrationTarget["registerTool"],
    registerResource: (() => undefined) as unknown as McpRegistrationTarget["registerResource"],
  };

  signatures(): string {
    return renderDeclarations({ tools: [...this.entries.values()].map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: z.toJSONSchema(entry.input.omit({ workspace_id: true })),
      outputSchema: z.toJSONSchema(entry.output),
      execute: () => undefined,
    })) });
  }

  tools(workspaceId: string): CodemodeTool[] {
    return [...this.entries.values()].map((entry) => ({
      name: entry.name,
      description: entry.description,
      inputSchema: z.toJSONSchema(entry.input.omit({ workspace_id: true })),
      outputSchema: z.toJSONSchema(entry.output),
      execute: async (value: unknown, { signal }) => {
        if (signal.aborted) throw new Error("Code execution cancelled.");
        const parsed = entry.input.safeParse({ ...(typeof value === "object" && value !== null ? value : {}), workspace_id: workspaceId });
        if (!parsed.success) throw new Error(parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; "));
        const response = await entry.handler(parsed.data, { signal });
        if (response.isError) throw new Error(contentText(response.content ?? []) || `${entry.name} failed`);
        const result = response.structuredContent ?? { result: contentText(response.content ?? []) };
        const validated = entry.output.safeParse(result);
        if (!validated.success) throw new Error(`Invalid ${entry.name} response: ${validated.error.message}`);
        return result;
      },
    }));
  }
}
