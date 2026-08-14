import type { CodexMcpClient, CodexMcpToolResult } from "./codex-mcp-client.js";
import {
  codexTurnMetadataForComputerUse,
  type CodexExecutionContext,
} from "./codex-request-context.js";
import type { CodexRuntimeHost } from "./codex-runtime-host.js";

const EXPECTED_COMPUTER_USE_TOOLS = new Set([
  "list_apps",
  "get_app_state",
  "click",
  "perform_secondary_action",
  "set_value",
  "select_text",
  "scroll",
  "drag",
  "press_key",
  "type_text",
]);

export type CodexComputerUseAction =
  | "list_apps"
  | "get_app_state"
  | "click"
  | "perform_secondary_action"
  | "set_value"
  | "select_text"
  | "scroll"
  | "drag"
  | "press_key"
  | "type_text";

export interface CodexComputerUseInput {
  action: CodexComputerUseAction;
  app?: string;
  elementIndex?: string;
  x?: number;
  y?: number;
  clickCount?: number;
  mouseButton?: "left" | "right" | "middle";
  secondaryAction?: string;
  value?: string;
  text?: string;
  prefix?: string;
  suffix?: string;
  selection?: "text" | "cursor_before" | "cursor_after";
  direction?: "up" | "down" | "left" | "right";
  pages?: number;
  fromX?: number;
  fromY?: number;
  toX?: number;
  toY?: number;
  key?: string;
}

export class CodexComputerUseAdapterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexComputerUseAdapterError";
  }
}

export class CodexComputerUseAdapter {
  private clientPromise?: Promise<CodexMcpClient>;
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly host: CodexRuntimeHost) {}

  async invoke(
    input: CodexComputerUseInput,
    context: CodexExecutionContext,
  ): Promise<CodexMcpToolResult> {
    this.assertOpen();
    const invocation = normalizeComputerUseInvocation(input);
    const metadata = await codexTurnMetadataForComputerUse(context);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const client = await this.client();
        return await client.callTool(invocation.tool, invocation.arguments, {
          meta: {
            "x-codex-turn-metadata": metadata,
          },
          onElicitation: context.onElicitation,
        });
      } catch (error) {
        if (attempt > 0 || !isRecoverableCodexRuntimeError(error)) throw error;
        await this.resetRuntime();
      }
    }
    throw new CodexComputerUseAdapterError(
      "Codex Computer Use recovery exhausted.",
      "codex_computer_use_recovery_exhausted",
    );
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async client(): Promise<CodexMcpClient> {
    this.assertOpen();
    this.clientPromise ??= (async () => {
      const paths = await this.host.paths();
      const client = await this.host.spawnMcpClient({
        command: [paths.computerUseClientExecutable, "mcp"],
        cwd: paths.codexHome,
        clientName: "devspace-computer-use",
        outputBytesCap: 64 * 1024 * 1024,
      });
      const tools = await client.listTools();
      const names = new Set(tools.map((tool) => tool.name).filter((name): name is string => typeof name === "string"));
      const missing = Array.from(EXPECTED_COMPUTER_USE_TOOLS).filter((name) => !names.has(name));
      if (missing.length > 0) {
        await client.close();
        throw new CodexComputerUseAdapterError(
          `Codex Computer Use MCP is missing required tools: ${missing.join(", ")}`,
          "codex_computer_use_tools_incompatible",
        );
      }
      return client;
    })();
    return this.clientPromise;
  }

  private async resetRuntime(): Promise<void> {
    const client = await this.clientPromise?.catch(() => undefined);
    this.clientPromise = undefined;
    await client?.close().catch(() => undefined);
    await this.host.invalidate();
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const client = await this.clientPromise?.catch(() => undefined);
    await client?.close().catch(() => undefined);
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new CodexComputerUseAdapterError(
        "Codex Computer Use adapter is closed.",
        "codex_computer_use_closed",
      );
    }
  }
}

function normalizeComputerUseInvocation(
  input: CodexComputerUseInput,
): { tool: CodexComputerUseAction; arguments: Record<string, unknown> } {
  switch (input.action) {
    case "list_apps":
      return { tool: input.action, arguments: {} };
    case "get_app_state":
      return {
        tool: input.action,
        arguments: { app: requiredString(input.app, "app") },
      };
    case "click": {
      const target = pointerTarget(input);
      return {
        tool: input.action,
        arguments: compact({
          app: requiredString(input.app, "app"),
          ...target,
          click_count: optionalInteger(input.clickCount, "clickCount", 1, 3),
          mouse_button: input.mouseButton,
        }),
      };
    }
    case "perform_secondary_action":
      return {
        tool: input.action,
        arguments: {
          app: requiredString(input.app, "app"),
          element_index: requiredString(input.elementIndex, "elementIndex"),
          action: requiredString(input.secondaryAction, "secondaryAction"),
        },
      };
    case "set_value":
      return {
        tool: input.action,
        arguments: {
          app: requiredString(input.app, "app"),
          element_index: requiredString(input.elementIndex, "elementIndex"),
          value: requiredString(input.value, "value", { allowEmpty: true }),
        },
      };
    case "select_text":
      return {
        tool: input.action,
        arguments: compact({
          app: requiredString(input.app, "app"),
          element_index: requiredString(input.elementIndex, "elementIndex"),
          text: requiredString(input.text, "text"),
          prefix: optionalString(input.prefix, "prefix"),
          suffix: optionalString(input.suffix, "suffix"),
          selection: input.selection,
        }),
      };
    case "scroll":
      return {
        tool: input.action,
        arguments: compact({
          app: requiredString(input.app, "app"),
          element_index: requiredString(input.elementIndex, "elementIndex"),
          direction: requiredString(input.direction, "direction"),
          pages: optionalPositiveNumber(input.pages, "pages"),
        }),
      };
    case "drag":
      return {
        tool: input.action,
        arguments: {
          app: requiredString(input.app, "app"),
          from_x: finiteNumber(input.fromX, "fromX"),
          from_y: finiteNumber(input.fromY, "fromY"),
          to_x: finiteNumber(input.toX, "toX"),
          to_y: finiteNumber(input.toY, "toY"),
        },
      };
    case "press_key":
      return {
        tool: input.action,
        arguments: {
          app: requiredString(input.app, "app"),
          key: requiredString(input.key, "key"),
        },
      };
    case "type_text":
      return {
        tool: input.action,
        arguments: {
          app: requiredString(input.app, "app"),
          text: requiredString(input.text, "text", { allowEmpty: true }),
        },
      };
  }
}

function pointerTarget(input: CodexComputerUseInput): Record<string, unknown> {
  if (input.elementIndex !== undefined) {
    if (input.x !== undefined || input.y !== undefined) {
      throw invalidInput("click accepts either elementIndex or x/y coordinates, not both.");
    }
    return { element_index: requiredString(input.elementIndex, "elementIndex") };
  }
  return {
    x: finiteNumber(input.x, "x"),
    y: finiteNumber(input.y, "y"),
  };
}

function requiredString(
  value: unknown,
  name: string,
  options: { allowEmpty?: boolean } = {},
): string {
  if (typeof value !== "string") throw invalidInput(`${name} is required.`);
  if (!options.allowEmpty && value.trim().length === 0) throw invalidInput(`${name} must not be empty.`);
  if (value.length > 100_000) throw invalidInput(`${name} is too large.`);
  return value;
}

function optionalString(value: unknown, name: string): string | undefined {
  if (value === undefined) return undefined;
  return requiredString(value, name, { allowEmpty: true });
}

function finiteNumber(value: unknown, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw invalidInput(`${name} must be a finite number.`);
  }
  return value;
}

function optionalPositiveNumber(value: unknown, name: string): number | undefined {
  if (value === undefined) return undefined;
  const number = finiteNumber(value, name);
  if (number <= 0 || number > 100) throw invalidInput(`${name} must be greater than 0 and at most 100.`);
  return number;
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalidInput(`${name} must be an integer between ${minimum} and ${maximum}.`);
  }
  return value as number;
}

function compact(value: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== undefined));
}

function isRecoverableCodexRuntimeError(error: unknown): boolean {
  if (typeof error !== "object" || error === null || !("code" in error)) return false;
  return new Set([
    "codex_app_server_closed",
    "codex_app_server_exited",
    "codex_app_server_not_running",
    "codex_app_server_request_timeout",
    "codex_child_not_running",
    "codex_mcp_client_closed",
    "codex_mcp_process_exited",
    "codex_mcp_request_timeout",
    "codex_mcp_write_failed",
  ]).has(String(error.code));
}

function invalidInput(message: string): CodexComputerUseAdapterError {
  return new CodexComputerUseAdapterError(message, "codex_computer_use_invalid_input");
}
