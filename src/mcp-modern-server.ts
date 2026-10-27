import {
  McpServer,
  type ServerContext,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import type { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation as LegacyImplementation } from "@modelcontextprotocol/sdk/types.js";
import { type JsonObject, type JsonValue } from "./json-value.js";
import { unsafeNarrow } from "./unsafe-narrow.js";

export type McpRegistrationTarget = Pick<
  LegacyMcpServer,
  "registerTool" | "registerResource"
>;

export interface ModernMcpServerAdapter {
  server: McpServer;
  registrationTarget: McpRegistrationTarget;
}

type RegistrationReplay = (target: McpRegistrationTarget) => void;

type ModernRegisterTool = (
  name: string,
  definition: JsonObject,
  handler: (input: JsonValue, context: ServerContext) => JsonValue | Promise<JsonValue>,
) => JsonValue;

type ModernRegisterResource = (...args: JsonValue[]) => JsonValue;

export function createModernMcpServerAdapter(
  serverInfo: LegacyImplementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, options);
  const registerModernTool = unsafeNarrow<ModernRegisterTool>(server.registerTool.bind(server));
  const registerModernResource = unsafeNarrow<ModernRegisterResource>(server.registerResource.bind(server));

  const registrationTarget: McpRegistrationTarget = {
    registerTool: unsafeNarrow<LegacyMcpServer["registerTool"]>((
      name: string,
      definition: JsonObject,
      handler: (input: JsonValue, extra: JsonObject) => JsonValue,
    ) => registerModernTool(
      name,
      definition,
      async (input, context) => handler(input, legacyToolHandlerExtra(context)),
    )),
    registerResource: unsafeNarrow<LegacyMcpServer["registerResource"]>((...args: JsonValue[]) => {
      const callback = unsafeNarrow<(...callbackArgs: JsonValue[]) => JsonValue>(args.at(-1));

      return registerModernResource(
        ...args.slice(0, -1),
        (...callbackArgs: JsonValue[]) => {
          const context = unsafeNarrow<ServerContext>(callbackArgs.at(-1));

          return callback(
            ...callbackArgs.slice(0, -1),
            legacyToolHandlerExtra(context),
          );
        },
      );
    }),
  };

  return {
    server,
    registrationTarget,
  };
}

export function compileMcpRegistrationSurface(
  registerSurface: (target: McpRegistrationTarget) => void,
): (target: McpRegistrationTarget) => void {
  const registrations: RegistrationReplay[] = [];

  const recordingTarget: McpRegistrationTarget = {
    registerTool: unsafeNarrow<McpRegistrationTarget["registerTool"]>((...args: JsonValue[]) => {
      registrations.push((target) => {
        unsafeNarrow<(...callArgs: JsonValue[]) => JsonValue>(target.registerTool)(...args);
      });
    }),
    registerResource: unsafeNarrow<McpRegistrationTarget["registerResource"]>((...args: JsonValue[]) => {
      registrations.push((target) => {
        unsafeNarrow<(...callArgs: JsonValue[]) => JsonValue>(target.registerResource)(...args);
      });
    }),
  };

  registerSurface(recordingTarget);
  const compiled = Object.freeze(registrations.slice());

  return (target) => {
    for (const replay of compiled) replay(target);
  };
}

interface AdapterErrorLogFields {
  error: string;
  errorName: string;
  cause?: { name: string; message: string };
}

export function modernMcpAdapterErrorLogFields(error: Error): AdapterErrorLogFields {
  const cause = error.cause;
  const fields: AdapterErrorLogFields = {
    error: error.message,
    errorName: error.name,
  };

  if (cause !== undefined) {
    fields.cause = cause instanceof Error
      ? { name: cause.name, message: cause.message }
      : { name: "Error", message: String(cause) };
  }

  return fields;
}

function legacyToolHandlerExtra(context: ServerContext): JsonObject {
  return unsafeNarrow<JsonObject>({
    signal: context.mcpReq.signal,
    authInfo: context.http?.authInfo,
    sessionId: context.sessionId,
    _meta: context.mcpReq._meta,
    requestId: context.mcpReq.id,
    requestInfo: context.http?.req,
    sendNotification: context.mcpReq.notify,
    sendRequest: context.mcpReq.send,
  });
}
