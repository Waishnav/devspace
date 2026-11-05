import { optionalFields, jsonKind } from "./json-value.js";
import { unsafeNarrow } from "./unsafe-narrow.js";
import type { JsonObject, WireInput } from "./json-value.js";
import {
  McpServer,
  type ServerContext,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import type { McpServer as LegacyMcpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { Implementation as LegacyImplementation } from "@modelcontextprotocol/sdk/types.js";

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
  handler: (input: WireInput, context: ServerContext) => WireInput,
) => WireInput;

type ModernRegisterResource = (...args: WireInput[]) => WireInput;

export function createModernMcpServerAdapter(
  serverInfo: LegacyImplementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, options);
  const registerModernTool = unsafeNarrow<ModernRegisterTool>(server.registerTool.bind(server));
  const registerModernResource = unsafeNarrow<ModernRegisterResource>(server.registerResource.bind(server));

  const registrationTarget: McpRegistrationTarget = {
    // SAFETY: The surrounding checks or construction already match this type.
    registerTool: unsafeNarrow<LegacyMcpServer["registerTool"]>((
      name: string,
      definition: JsonObject,
      handler: (input: WireInput, extra: JsonObject) => WireInput,
    ) => registerModernTool(
      name,
      definition,
      async (input, context) => handler(input, legacyToolHandlerExtra(context)),
    )),
    // SAFETY: The surrounding checks or construction already match this type.
    registerResource: unsafeNarrow<LegacyMcpServer["registerResource"]>((...args: WireInput[]) => {
      // SAFETY: The surrounding checks or construction already match this type.
      const callback = args.at(-1) as (...callbackArgs: WireInput[]) => WireInput;

      return registerModernResource(
        ...args.slice(0, -1),
        (...callbackArgs: WireInput[]) => {
          // SAFETY: The surrounding checks or construction already match this type.
          const context = callbackArgs.at(-1) as ServerContext;

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
    // SAFETY: The surrounding checks or construction already match this type.
    registerTool: unsafeNarrow<McpRegistrationTarget["registerTool"]>((...args: WireInput[]) => {
      registrations.push((target) => {
        // SAFETY: The surrounding checks or construction already match this type.
        (target.registerTool as (...callArgs: WireInput[]) => WireInput)(...args);
      });
    }),
    registerResource: unsafeNarrow<McpRegistrationTarget["registerResource"]>((...args: WireInput[]) => {
      registrations.push((target) => {
        // SAFETY: The surrounding checks or construction already match this type.
        (target.registerResource as (...callArgs: WireInput[]) => WireInput)(...args);
      });
    }),
  };

  registerSurface(recordingTarget);
  const compiled = Object.freeze(registrations.slice());

  return (target) => {
    for (const replay of compiled) replay(target);
  };
}

export function modernMcpAdapterErrorLogFields(error: Error): JsonObject {
  const cause = error.cause;

  return {
    error: error.message,
    errorName: error.name,
    ...optionalFields(cause === undefined ? undefined : {
      cause: cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : { name: jsonKind(cause), message: String(cause) },
    }),
  };
}

function legacyToolHandlerExtra(context: ServerContext): JsonObject {
  return {
    signal: context.mcpReq.signal,
    authInfo: context.http?.authInfo,
    sessionId: context.sessionId,
    _meta: context.mcpReq._meta,
    requestId: context.mcpReq.id,
    requestInfo: context.http?.req,
    sendNotification: context.mcpReq.notify,
    sendRequest: context.mcpReq.send,
  };
}
