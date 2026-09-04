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
  definition: Record<string, unknown>,
  handler: (input: unknown, context: ServerContext) => unknown,
) => unknown;

type ModernRegisterResource = (...args: unknown[]) => unknown;

export function createModernMcpServerAdapter(
  serverInfo: LegacyImplementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, options);
  const registerModernTool = server.registerTool.bind(server) as unknown as ModernRegisterTool;
  const registerModernResource = server.registerResource.bind(server) as unknown as ModernRegisterResource;
  const registrationTarget: McpRegistrationTarget = {
    registerTool: ((
      name: string,
      definition: Record<string, unknown>,
      handler: (input: unknown, extra: Record<string, unknown>) => unknown,
    ) => registerModernTool(
      name,
      definition,
      async (input, context) => handler(input, legacyToolHandlerExtra(context)),
    )) as LegacyMcpServer["registerTool"],
    registerResource: ((...args: unknown[]) => {
      const callback = args.at(-1) as (...callbackArgs: unknown[]) => unknown;
      return registerModernResource(
        ...args.slice(0, -1),
        (...callbackArgs: unknown[]) => {
          const context = callbackArgs.at(-1) as ServerContext;
          return callback(
            ...callbackArgs.slice(0, -1),
            legacyToolHandlerExtra(context),
          );
        },
      );
    }) as unknown as LegacyMcpServer["registerResource"],
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
    registerTool: ((...args: unknown[]) => {
      registrations.push((target) => {
        (target.registerTool as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerTool"],
    registerResource: ((...args: unknown[]) => {
      registrations.push((target) => {
        (target.registerResource as (...callArgs: unknown[]) => unknown)(...args);
      });
    }) as unknown as McpRegistrationTarget["registerResource"],
  };

  registerSurface(recordingTarget);
  const compiled = Object.freeze(registrations.slice());
  return (target) => {
    for (const replay of compiled) replay(target);
  };
}

export function modernMcpAdapterErrorLogFields(error: Error): Record<string, unknown> {
  const cause = error.cause;
  return {
    error: error.message,
    errorName: error.name,
    ...(cause === undefined ? {} : {
      cause: cause instanceof Error
        ? { name: cause.name, message: cause.message }
        : { name: typeof cause, message: String(cause) },
    }),
  };
}

function legacyToolHandlerExtra(context: ServerContext): Record<string, unknown> {
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
