import type { CodexProcessExit, CodexSpawnedProcess } from "./codex-app-server.js";

const DEFAULT_MCP_REQUEST_TIMEOUT_MS = 120_000;

export class CodexMcpClientError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexMcpClientError";
  }
}

export type CodexMcpTextContent = {
  type: "text";
  text: string;
};

export type CodexMcpImageContent = {
  type: "image";
  data: string;
  mimeType: string;
};

export type CodexMcpResourceContent = {
  type: "resource";
  resource: Record<string, unknown>;
};

export type CodexMcpContent =
  | CodexMcpTextContent
  | CodexMcpImageContent
  | CodexMcpResourceContent;

export interface CodexMcpToolResult {
  content: CodexMcpContent[];
  isError: boolean;
  structuredContent?: unknown;
  _meta?: unknown;
}

export interface CodexMcpCallOptions {
  meta?: Record<string, unknown>;
  timeoutMs?: number;
  onElicitation?: CodexMcpElicitationHandler;
}

export type CodexMcpElicitationHandler = (
  params: Record<string, unknown>,
) => Promise<Record<string, unknown>>;

interface JsonRpcPendingRequest {
  method: string;
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

interface ActiveCallContext {
  onElicitation?: CodexMcpElicitationHandler;
}

export class CodexMcpClient {
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextRequestId = 1;
  private pending = new Map<number, JsonRpcPendingRequest>();
  private activeCall?: ActiveCallContext;
  private serial = Promise.resolve();
  private startPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private closed = false;
  private removeOutputListener?: () => void;
  private removeExitListener?: () => void;

  constructor(
    private readonly process: CodexSpawnedProcess,
    private readonly clientInfo: { name: string; version: string },
  ) {
    this.removeOutputListener = process.onOutput((stream, data) => {
      if (stream === "stdout") this.ingestStdout(data.toString("utf8"));
      else this.stderrBuffer = tail(`${this.stderrBuffer}${data.toString("utf8")}`, 64 * 1024);
    });
    this.removeExitListener = process.onExit((exit) => this.handleProcessExit(exit));
  }

  async start(): Promise<void> {
    if (this.closed) {
      throw new CodexMcpClientError(
        "Codex MCP client is closed.",
        "codex_mcp_client_closed",
      );
    }
    this.startPromise ??= this.startInternal();
    return this.startPromise;
  }

  async listTools(): Promise<Array<Record<string, unknown>>> {
    const response = await this.request("tools/list", {}, DEFAULT_MCP_REQUEST_TIMEOUT_MS);
    if (!isRecord(response) || !Array.isArray(response.tools)) {
      throw new CodexMcpClientError(
        "Codex MCP server returned an invalid tools/list result.",
        "codex_mcp_invalid_tools_result",
      );
    }
    return response.tools.filter(isRecord);
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
    options: CodexMcpCallOptions = {},
  ): Promise<CodexMcpToolResult> {
    return this.runSerial(async () => {
      await this.start();
      this.activeCall = { onElicitation: options.onElicitation };
      try {
        const result = await this.request(
          "tools/call",
          {
            name,
            arguments: args,
            ...(options.meta ? { _meta: options.meta } : {}),
          },
          options.timeoutMs ?? DEFAULT_MCP_REQUEST_TIMEOUT_MS,
        );
        return normalizeToolResult(result);
      } finally {
        this.activeCall = undefined;
      }
    });
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async startInternal(): Promise<void> {
    await this.request(
      "initialize",
      {
        protocolVersion: "2025-06-18",
        capabilities: {
          elicitation: {
            form: {},
          },
        },
        clientInfo: this.clientInfo,
      },
      30_000,
    );
    await this.sendNotification("notifications/initialized", {});
  }

  private request(
    method: string,
    params: Record<string, unknown>,
    timeoutMs: number,
  ): Promise<unknown> {
    if (this.closed) {
      return Promise.reject(new CodexMcpClientError(
        "Codex MCP client is closed.",
        "codex_mcp_client_closed",
      ));
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexMcpClientError(
          `Codex MCP request timed out: ${method}`,
          "codex_mcp_request_timeout",
        ));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { method, resolve, reject, timer });
      void this.process
        .write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n")
        .catch((error) => {
          const pending = this.pending.get(id);
          if (!pending) return;
          this.pending.delete(id);
          clearTimeout(pending.timer);
          pending.reject(new CodexMcpClientError(
            `Unable to write Codex MCP request: ${method}`,
            "codex_mcp_write_failed",
            { cause: error },
          ));
        });
    });
  }

  private async sendNotification(
    method: string,
    params: Record<string, unknown>,
  ): Promise<void> {
    await this.process.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }

  private ingestStdout(chunk: string): void {
    this.stdoutBuffer += chunk;
    for (;;) {
      const newline = this.stdoutBuffer.indexOf("\n");
      if (newline < 0) return;
      const line = this.stdoutBuffer.slice(0, newline).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(newline + 1);
      if (!line) continue;
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        continue;
      }
      this.handleMessage(message);
    }
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    if (typeof message.id === "number" && ("result" in message || "error" in message)) {
      this.handleResponse(message);
      return;
    }
    if ((typeof message.id === "number" || typeof message.id === "string")
      && typeof message.method === "string") {
      void this.handleServerRequest(message);
    }
  }

  private handleResponse(message: Record<string, unknown>): void {
    const id = message.id;
    if (typeof id !== "number") return;
    const pending = this.pending.get(id);
    if (!pending) return;
    this.pending.delete(id);
    clearTimeout(pending.timer);
    if (isRecord(message.error)) {
      pending.reject(new CodexMcpClientError(
        typeof message.error.message === "string"
          ? message.error.message
          : `Codex MCP request failed: ${pending.method}`,
        "codex_mcp_request_failed",
      ));
      return;
    }
    pending.resolve(message.result);
  }

  private async handleServerRequest(message: Record<string, unknown>): Promise<void> {
    const id = message.id;
    const method = message.method;
    if ((typeof id !== "number" && typeof id !== "string") || typeof method !== "string") return;

    if (method !== "elicitation/create") {
      await this.writeServerError(id, -32601, `Unsupported nested MCP request: ${method}`);
      return;
    }

    const params = isRecord(message.params) ? message.params : {};
    const handler = this.activeCall?.onElicitation;
    if (!handler) {
      await this.writeServerResult(id, { action: "decline", content: {} });
      return;
    }

    try {
      const result = await handler(params);
      await this.writeServerResult(id, result);
    } catch (error) {
      await this.writeServerError(
        id,
        -32603,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private async writeServerResult(
    id: number | string,
    result: Record<string, unknown>,
  ): Promise<void> {
    await this.process.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\n");
  }

  private async writeServerError(
    id: number | string,
    code: number,
    message: string,
  ): Promise<void> {
    await this.process.write(JSON.stringify({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    }) + "\n");
  }

  private handleProcessExit(exit: CodexProcessExit): void {
    if (this.closed) return;
    this.closed = true;
    const stderr = this.stderrBuffer.trim();
    const error = new CodexMcpClientError(
      stderr
        ? `Codex MCP process exited with code ${exit.exitCode}: ${stderr}`
        : `Codex MCP process exited with code ${exit.exitCode}.`,
      "codex_mcp_process_exited",
    );
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
  }

  private runSerial<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.serial.then(operation, operation);
    this.serial = result.then(() => undefined, () => undefined);
    return result;
  }

  private async closeInternal(): Promise<void> {
    if (!this.closed) {
      this.closed = true;
      for (const pending of this.pending.values()) {
        clearTimeout(pending.timer);
        pending.reject(new CodexMcpClientError(
          "Codex MCP client closed before the request completed.",
          "codex_mcp_client_closed",
        ));
      }
      this.pending.clear();
      await this.process.kill();
    }
    this.removeOutputListener?.();
    this.removeExitListener?.();
    this.removeOutputListener = undefined;
    this.removeExitListener = undefined;
  }
}

function normalizeToolResult(value: unknown): CodexMcpToolResult {
  if (!isRecord(value)) {
    throw new CodexMcpClientError(
      "Codex MCP server returned a non-object tool result.",
      "codex_mcp_invalid_tool_result",
    );
  }
  const content = Array.isArray(value.content)
    ? value.content.map(normalizeContent).filter((item): item is CodexMcpContent => item !== undefined)
    : [];
  return {
    content,
    isError: value.isError === true,
    ...(value.structuredContent === undefined ? {} : { structuredContent: value.structuredContent }),
    ...(value._meta === undefined ? {} : { _meta: value._meta }),
  };
}

function normalizeContent(value: unknown): CodexMcpContent | undefined {
  if (!isRecord(value) || typeof value.type !== "string") return undefined;
  if (value.type === "text" && typeof value.text === "string") {
    return { type: "text", text: value.text };
  }
  if (
    value.type === "image"
    && typeof value.data === "string"
    && typeof value.mimeType === "string"
  ) {
    return { type: "image", data: value.data, mimeType: value.mimeType };
  }
  if (value.type === "resource" && isRecord(value.resource)) {
    return { type: "resource", resource: value.resource };
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function tail(value: string, maximum: number): string {
  return value.length <= maximum ? value : value.slice(value.length - maximum);
}
