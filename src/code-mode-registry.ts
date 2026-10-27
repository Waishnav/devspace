import {
  renderDeclarations,
  type CodemodeTool,
} from "@earendil-works/pi-codemode";
import * as z from "zod/v4";
import type { McpRegistrationTarget } from "./mcp-modern-server.js";
import { contentText } from "./tool-surfaces/shared.js";
import type { ToolContent } from "./tool-surfaces/types.js";
import { isJsonObject, optionalFields, type JsonObject } from "./json-value.js";
import { unsafeNarrow } from "./unsafe-narrow.js";

type ZodObjectFields = ConstructorParameters<typeof z.object>[0];

type Handler = (input: JsonObject, extra: { signal: AbortSignal }) => Promise<{
  isError?: boolean;
  content?: ToolContent[];
  structuredContent?: JsonObject;
}>;

interface Entry {
  name: string;
  description: string;
  input: z.ZodObject<ZodObjectFields>;
  output: z.ZodObject<ZodObjectFields>;
  handler: Handler;
}

/** Records the real MCP registrations, so Code Mode never duplicates their handlers or schemas. */
export class CodeModeRegistry {
  private readonly entries = new Map<string, Entry>();

  readonly registrationTarget: McpRegistrationTarget = {
    registerTool: unsafeNarrow<McpRegistrationTarget["registerTool"]>((name: string, definition: JsonObject, handler: Handler) => {
      const input = z.object(unsafeNarrow<ZodObjectFields>(definition.inputSchema));
      const output = z.object(unsafeNarrow<ZodObjectFields>(definition.outputSchema));
      this.entries.set(name, {
        name,
        description: unsafeNarrow<string>(definition.description),
        input,
        output,
        handler,
      });

      // This target collects internal registrations; nothing is registered with the MCP host.
      return undefined;
    }),
    registerResource: unsafeNarrow<McpRegistrationTarget["registerResource"]>(() => undefined),
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
      execute: async (value: JsonObject | undefined, { signal }) => {
        if (signal.aborted) throw new Error("Code execution cancelled.");
        const parsed = entry.input.safeParse({ ...optionalFields(isJsonObject(value) ? value : undefined), workspace_id: workspaceId });

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
