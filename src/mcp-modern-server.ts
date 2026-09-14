import {
  McpServer,
  ResourceTemplate as ModernResourceTemplate,
  type CompleteResourceTemplateCallback as ModernCompleteResourceTemplateCallback,
  type ListResourcesCallback as ModernListResourcesCallback,
  type ReadResourceCallback as ModernReadResourceCallback,
  type ReadResourceTemplateCallback as ModernReadResourceTemplateCallback,
  type RegisteredResource as ModernRegisteredResource,
  type RegisteredResourceTemplate as ModernRegisteredResourceTemplate,
  type RegisteredTool as ModernRegisteredTool,
  type ResourceMetadata as ModernResourceMetadata,
  type ServerContext,
  type ServerOptions,
} from "@modelcontextprotocol/server";
import {
  McpServer as LegacyMcpServer,
  ResourceTemplate as LegacyResourceTemplate,
} from "@modelcontextprotocol/sdk/server/mcp.js";
import type { RequestHandlerExtra as LegacyRequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type {
  Implementation as LegacyImplementation,
  ServerNotification as LegacyServerNotification,
  ServerRequest as LegacyServerRequest,
} from "@modelcontextprotocol/sdk/types.js";
import type {
  ReadResourceCallback as LegacyReadResourceCallback,
  ReadResourceTemplateCallback as LegacyReadResourceTemplateCallback,
  RegisteredResource as LegacyRegisteredResource,
  RegisteredResourceTemplate as LegacyRegisteredResourceTemplate,
  ResourceMetadata as LegacyResourceMetadata,
} from "@modelcontextprotocol/sdk/server/mcp.js";

export type McpRegistrationTarget = Pick<LegacyMcpServer, "registerTool" | "registerResource">;

export interface ModernMcpServerAdapter {
  server: McpServer;
  registrationTarget: McpRegistrationTarget;
}

type RegistrationReplay = (target: McpRegistrationTarget) => void;

type LegacyHandlerExtra = LegacyRequestHandlerExtra<LegacyServerRequest, LegacyServerNotification>;

type LegacyToolRegistration = LegacyMcpServer["registerTool"];

type LegacyStaticResourceRegistration = (
  name: string,
  uri: string,
  config: LegacyResourceMetadata,
  callback: LegacyReadResourceCallback,
) => LegacyRegisteredResource;

type LegacyTemplateResourceRegistration = (
  name: string,
  template: LegacyResourceTemplate,
  config: LegacyResourceMetadata,
  callback: LegacyReadResourceTemplateCallback,
) => LegacyRegisteredResourceTemplate;

type LegacyStaticResourceCall = [
  name: string,
  uri: string,
  config: LegacyResourceMetadata,
  callback: LegacyReadResourceCallback,
];

type LegacyTemplateResourceCall = [
  name: string,
  template: LegacyResourceTemplate,
  config: LegacyResourceMetadata,
  callback: LegacyReadResourceTemplateCallback,
];

type LegacyResourceRegistrationCall = LegacyStaticResourceCall | LegacyTemplateResourceCall;

function isLegacyTemplateResourceCall(
  call: LegacyResourceRegistrationCall,
): call is LegacyTemplateResourceCall {
  return call[1] instanceof LegacyResourceTemplate;
}

type ModernToolRegistration = McpServer["registerTool"];

type ModernToolDefinition = Parameters<ModernToolRegistration>[1];

type ModernToolHandler = Parameters<ModernToolRegistration>[2];

type ModernToolInput = Parameters<ModernToolHandler>[0];

type ModernToolResult = Awaited<ReturnType<ModernToolHandler>>;

type ModernStaticResourceRegistration = (
  name: string,
  uri: string,
  config: ModernResourceMetadata,
  callback: ModernReadResourceCallback,
) => ModernRegisteredResource;

type ModernTemplateResourceRegistration = (
  name: string,
  template: ModernResourceTemplate,
  config: ModernResourceMetadata,
  callback: ModernReadResourceTemplateCallback,
) => ModernRegisteredResourceTemplate;

type ModernResourceRegistration = ModernStaticResourceRegistration & ModernTemplateResourceRegistration;

type AdapterToolHandler = (
  inputOrExtra: ModernToolInput | LegacyHandlerExtra,
  extra?: LegacyHandlerExtra,
) => ModernToolResult | Promise<ModernToolResult>;

type ModernCompletionCallbacks = {
  [variable: string]: ModernCompleteResourceTemplateCallback;
};

export function createModernMcpServerAdapter(
  serverInfo: LegacyImplementation,
  options?: ServerOptions,
): ModernMcpServerAdapter {
  const server = new McpServer(serverInfo, options);
  const registerModernResource: ModernResourceRegistration = server.registerResource.bind(server);

  const registerTool = (
    name: string,
    definition: ModernToolDefinition,
    handler: AdapterToolHandler,
  ): ModernRegisteredTool => {
    if (definition.inputSchema === undefined) {
      return server.registerTool(
        name,
        { ...definition, inputSchema: {} },
        async (_input: ModernToolInput, context: ServerContext) => handler(legacyToolHandlerExtra(context)),
      );
    }

    return server.registerTool(
      name,
      definition,
      async (input: ModernToolInput, context: ServerContext) => handler(input, legacyToolHandlerExtra(context)),
    );
  };

  const registerStaticResource = (
    name: string,
    uri: string,
    config: LegacyResourceMetadata,
    callback: LegacyReadResourceCallback,
  ): ModernRegisteredResource => registerModernResource(
    name,
    uri,
    config,
    (resourceUri, context) => callback(resourceUri, legacyToolHandlerExtra(context)),
  );

  const registerTemplateResource = (
    name: string,
    template: LegacyResourceTemplate,
    config: LegacyResourceMetadata,
    callback: LegacyReadResourceTemplateCallback,
  ): ModernRegisteredResourceTemplate => registerModernResource(
    name,
    modernResourceTemplate(template),
    config,
    (resourceUri, variables, context) => callback(
      resourceUri,
      variables,
      legacyToolHandlerExtra(context),
    ),
  );

  function registerResource(
    name: string,
    uri: string,
    config: LegacyResourceMetadata,
    callback: LegacyReadResourceCallback,
  ): ModernRegisteredResource;
  function registerResource(
    name: string,
    template: LegacyResourceTemplate,
    config: LegacyResourceMetadata,
    callback: LegacyReadResourceTemplateCallback,
  ): ModernRegisteredResourceTemplate;
  function registerResource(...args: LegacyResourceRegistrationCall): ModernRegisteredResource | ModernRegisteredResourceTemplate {
    if (isLegacyTemplateResourceCall(args)) {
      const [name, template, config, callback] = args;

      return registerTemplateResource(name, template, config, callback);
    }

    const [name, uri, config, callback] = args;

    return registerStaticResource(name, uri, config, callback);
  }

  type RegistrationTargetCompatibility = McpRegistrationTarget & {
    registerTool: typeof registerTool;
    registerResource: typeof registerResource;
  };

  // SAFETY: The v1 and v2 SDKs expose the same registration operations, but their
  // returned handles carry private callback/context types from different
  // packages. The adapter preserves the legacy surface while forwarding the
  // operations to v2; this is the single compatibility boundary.
  const registrationTarget = {
    registerTool,
    registerResource,
  } as RegistrationTargetCompatibility;

  return { server, registrationTarget };
}

function modernResourceTemplate(template: LegacyResourceTemplate): ModernResourceTemplate {
  const complete: ModernCompletionCallbacks = {};

  for (const variable of template.uriTemplate.variableNames) {
    const callback = template.completeCallback(variable);

    if (callback !== undefined) complete[variable] = callback;
  }

  const listCallback = template.listCallback;

  const list: ModernListResourcesCallback | undefined = listCallback === undefined
    ? undefined
    : (context) => listCallback(legacyToolHandlerExtra(context));

  return new ModernResourceTemplate(template.uriTemplate.toString(), { list, complete });
}

export function compileMcpRegistrationSurface(
  registerSurface: (target: McpRegistrationTarget) => void,
): (target: McpRegistrationTarget) => void {

  const registrations: RegistrationReplay[] = [];

  const recordingServer = new LegacyMcpServer({
    name: "registration-recorder",
    version: "1.0.0",
  });

  const recordToolRegistration: LegacyToolRegistration = (name, config, handler) => {
    registrations.push((target) => {
      target.registerTool(name, config, handler);
    });

    return recordingServer.registerTool(name, config, handler);
  };

  const recordStaticResource: LegacyStaticResourceRegistration = (name, uri, config, callback) => {
    registrations.push((target) => {
      target.registerResource(name, uri, config, callback);
    });

    return recordingServer.registerResource(name, uri, config, callback);
  };

  const recordTemplateResource: LegacyTemplateResourceRegistration = (name, template, config, callback) => {
    registrations.push((target) => {
      target.registerResource(name, template, config, callback);
    });

    return recordingServer.registerResource(name, template, config, callback);
  };

  function recordResource(
    name: string,
    uri: string,
    config: LegacyResourceMetadata,
    callback: LegacyReadResourceCallback,
  ): LegacyRegisteredResource;
  function recordResource(
    name: string,
    template: LegacyResourceTemplate,
    config: LegacyResourceMetadata,
    callback: LegacyReadResourceTemplateCallback,
  ): LegacyRegisteredResourceTemplate;
  function recordResource(...args: LegacyResourceRegistrationCall): LegacyRegisteredResource | LegacyRegisteredResourceTemplate {
    if (isLegacyTemplateResourceCall(args)) {
      const [name, template, config, callback] = args;

      return recordTemplateResource(name, template, config, callback);
    }

    const [name, uri, config, callback] = args;

    return recordStaticResource(name, uri, config, callback);
  }

  const recordingTarget: McpRegistrationTarget = {
    registerTool: recordToolRegistration,
    registerResource: recordResource,
  };

  registerSurface(recordingTarget);
  const compiled = Object.freeze(registrations.slice());

  return (target) => {
    for (const replay of compiled) replay(target);
  };
}

export type ModernMcpAdapterErrorLogFields = {
  error: string;
  errorName: string;
  cause?: { name: string; message: string };
};

export function modernMcpAdapterErrorLogFields(error: Error): ModernMcpAdapterErrorLogFields {
  const fields: ModernMcpAdapterErrorLogFields = {
    error: error.message,
    errorName: error.name,
  };

  const cause = error.cause;

  if (cause !== undefined) {
    fields.cause = cause instanceof Error
      ? { name: cause.name, message: cause.message }
      : { name: "non-error", message: String(cause) };
  }

  return fields;
}

function legacyToolHandlerExtra(context: ServerContext): LegacyHandlerExtra {
  const request = context.http?.req;

  const requestInfo = request === undefined
    ? undefined
    : {
      headers: Object.fromEntries(request.headers.entries()),
      url: new URL(request.url),
    };

  return {
    signal: context.mcpReq.signal,
    authInfo: context.http?.authInfo,
    sessionId: context.sessionId,
    _meta: context.mcpReq._meta,
    requestId: context.mcpReq.id,
    requestInfo,
    sendNotification: (notification) => context.mcpReq.notify(notification),
    sendRequest: (requestToSend, resultSchema, requestOptions) => context.mcpReq.send(
      requestToSend,
      resultSchema,
      requestOptions,
    ),
  };
}
