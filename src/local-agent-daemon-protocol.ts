import { z } from "zod";
import type {
  LocalAgentRecord,
  LocalAgentWorkspaceScope,
} from "./local-agent-store.js";
import type {
  LocalAgentWaitResult,
  RunOverrides,
  StartLocalAgentInput,
} from "./local-agent-manager.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";

export type LocalAgentDaemonMethod =
  | "hello"
  | "agent.start"
  | "agent.continue"
  | "agent.get"
  | "agent.list"
  | "agent.wait"
  | "daemon.status"
  | "daemon.stop"
  | "daemon.logs";

export type LocalAgentDaemonRequest =
  | (AgentDaemonRequestBase<"hello", Record<string, never>> & { configRevision?: string })
  | AgentDaemonRequestBase<"agent.start", StartLocalAgentInput>
  | AgentDaemonRequestBase<"agent.continue", { id: string; prompt: string; scope: LocalAgentWorkspaceScope; overrides?: RunOverrides }>
  | AgentDaemonRequestBase<"agent.get", { id: string; scope: LocalAgentWorkspaceScope }>
  | AgentDaemonRequestBase<"agent.list", LocalAgentWorkspaceScope>
  | AgentDaemonRequestBase<"agent.wait", {
      ids: string[];
      scope: LocalAgentWorkspaceScope;
      timeoutMs?: number;
    }>
  | AgentDaemonRequestBase<"daemon.status", Record<string, never>>
  | AgentDaemonRequestBase<"daemon.stop", { ifIdle?: boolean }>
  | AgentDaemonRequestBase<"daemon.logs", { lines?: number }>;

interface AgentDaemonRequestBase<M extends LocalAgentDaemonMethod, P> {
  requestId: string;
  protocolVersion: number;
  authToken: string;
  method: M;
  params: P;
}

export interface LocalAgentDaemonStatus {
  state: "ready" | "stopping";
  protocolVersion: number;
  pid: number;
  endpoint: string;
  startedAt: string;
  activeTurns: number;
  runtimeCount: number;
  clientConnections: number;
}

export interface LocalAgentDaemonHello {
  status: LocalAgentDaemonStatus;
  configMatches: boolean;
}

export interface LocalAgentDaemonErrorPayload {
  code: string;
  message: string;
  retryable?: boolean;
  provider?: string;
  agentId?: string;
  workspaceId?: string;
  operation?: string;
  target?: string;
}

export type LocalAgentDaemonResponse =
  | {
      requestId: string;
      protocolVersion: number;
      ok: true;
      result: unknown;
    }
  | {
      requestId: string;
      protocolVersion: number;
      ok: false;
      error: LocalAgentDaemonErrorPayload;
    };

const requiredTrimmedStringSchema = z.string().trim().min(1);

const requiredContentStringSchema = z.string().refine((text) => text.trim().length > 0);

const optionalTrimmedStringSchema = z.string().transform((text) => text.trim() || undefined).catch(undefined);

const optionalContentStringSchema = z.string().transform((text) => text.trim() ? text : undefined).catch(undefined);

const optionalBooleanSchema = z.boolean().optional().catch(undefined);

const integerSchema = z.number().int().safe();

const writeModeSchema = z.enum(["read_only", "allowed", "full_access"]).optional();

const emptyParamsSchema = z.record(z.string(), z.never());

const requestEnvelopeSchema = z.object({
  requestId: requiredTrimmedStringSchema,
  protocolVersion: integerSchema,
  authToken: requiredTrimmedStringSchema,
  method: requiredTrimmedStringSchema,
  params: z.unknown().optional(),
  configRevision: optionalTrimmedStringSchema,
});

const workspaceScopeSchema = z.object({
  workspaceId: optionalTrimmedStringSchema,
  workspaceRoot: requiredTrimmedStringSchema,
});

const startInputSchema = z.object({
  target: requiredTrimmedStringSchema,
  prompt: requiredContentStringSchema,
  workspaceRoot: requiredTrimmedStringSchema,
  workspaceId: optionalTrimmedStringSchema,
  model: optionalTrimmedStringSchema,
  effort: optionalTrimmedStringSchema,
  writeMode: writeModeSchema,
});

const runOverridesSchema = z.object({
  model: optionalTrimmedStringSchema,
  effort: optionalTrimmedStringSchema,
  writeMode: writeModeSchema,
});

const continueInputSchema = z.object({
  id: requiredTrimmedStringSchema,
  prompt: requiredContentStringSchema,
  scope: workspaceScopeSchema,
  overrides: runOverridesSchema.optional(),
});

const getInputSchema = z.object({
  id: requiredTrimmedStringSchema,
  scope: workspaceScopeSchema,
});

const waitParamsSchema = z.object({
  ids: z.array(requiredTrimmedStringSchema),
  scope: workspaceScopeSchema,
  timeoutMs: z.number().int().min(0).max(2_147_483_647).optional(),
});

const stopParamsSchema = z.object({ ifIdle: z.boolean().optional() });

const logsParamsSchema = z.object({ lines: z.number().int().min(1).max(10_000).optional() });

const daemonErrorSchema = z.object({
  code: requiredTrimmedStringSchema,
  message: requiredTrimmedStringSchema,
  retryable: optionalBooleanSchema,
  provider: optionalTrimmedStringSchema,
  agentId: optionalTrimmedStringSchema,
  workspaceId: optionalTrimmedStringSchema,
  operation: optionalTrimmedStringSchema,
  target: optionalTrimmedStringSchema,
});

const daemonResponseSchema = z.discriminatedUnion("ok", [
  z.object({
    requestId: requiredTrimmedStringSchema,
    protocolVersion: integerSchema,
    ok: z.literal(true),
    result: z.unknown(),
  }),
  z.object({
    requestId: requiredTrimmedStringSchema,
    protocolVersion: integerSchema,
    ok: z.literal(false),
    error: daemonErrorSchema,
  }),
]);

const agentStatusSchema = z.enum(["starting", "running", "idle", "error", "stopped"]);

const agentRecordSchema = z.object({
  id: requiredTrimmedStringSchema,
  workspaceId: optionalTrimmedStringSchema,
  workspaceRoot: requiredTrimmedStringSchema,
  profileName: requiredTrimmedStringSchema,
  provider: requiredTrimmedStringSchema,
  model: optionalTrimmedStringSchema,
  effort: optionalTrimmedStringSchema,
  providerSessionId: optionalTrimmedStringSchema,
  status: agentStatusSchema,
  latestResponse: z.string().optional(),
  error: optionalContentStringSchema,
  errorCode: optionalTrimmedStringSchema,
  errorRetryable: optionalBooleanSchema,
  createdAt: requiredTrimmedStringSchema,
  updatedAt: requiredTrimmedStringSchema,
});

const waitErrorSchema = z.object({
  code: requiredTrimmedStringSchema,
  message: requiredContentStringSchema,
  retryable: z.boolean().catch(false),
});

const waitResultSchema = z.discriminatedUnion("status", [
  z.object({
    id: requiredTrimmedStringSchema,
    status: z.literal("running"),
    wait: z.literal("timeout").optional(),
  }),
  z.object({
    id: requiredTrimmedStringSchema,
    status: z.literal("completed"),
    response: z.string().optional(),
  }),
  z.object({
    id: requiredTrimmedStringSchema,
    status: z.literal("failed"),
    error: waitErrorSchema,
  }),
  z.object({
    id: requiredTrimmedStringSchema,
    status: z.literal("stopped"),
    error: waitErrorSchema.optional(),
  }),
]);

const daemonStatusSchema = z.object({
  state: z.enum(["ready", "stopping"]),
  protocolVersion: integerSchema,
  pid: integerSchema,
  endpoint: requiredTrimmedStringSchema,
  startedAt: requiredTrimmedStringSchema,
  activeTurns: integerSchema,
  runtimeCount: integerSchema,
  clientConnections: integerSchema,
});

const daemonHelloSchema = z.object({
  status: daemonStatusSchema,
  configMatches: z.boolean(),
});

export function encodeLocalAgentDaemonRequest(request: LocalAgentDaemonRequest): string {
  return `${JSON.stringify(request)}\n`;
}

export function encodeLocalAgentDaemonResponse(response: LocalAgentDaemonResponse): string {
  return `${JSON.stringify(response)}\n`;
}

export function decodeLocalAgentDaemonRequest<T>(value: T): LocalAgentDaemonRequest {
  const envelope = parseProtocolValue(
    requestEnvelopeSchema,
    value,
    "INVALID_PARAMS",
    "Daemon request is malformed.",
  );

  const base = {
    requestId: envelope.requestId,
    protocolVersion: envelope.protocolVersion,
    authToken: envelope.authToken,
  };

  switch (envelope.method) {
    case "hello": {
      const request: LocalAgentDaemonRequest = {
        ...base,
        method: "hello",
        params: parseParams(emptyParamsSchema, envelope.params ?? {}),
      };

      if (envelope.configRevision) request.configRevision = envelope.configRevision;

      return request;
    }

    case "daemon.status":
      return {
        ...base,
        method: "daemon.status",
        params: parseParams(emptyParamsSchema, envelope.params ?? {}),
      };

    case "daemon.stop":
      return {
        ...base,
        method: "daemon.stop",
        params: parseParams(stopParamsSchema, envelope.params ?? {}),
      };

    case "agent.start":
      return {
        ...base,
        method: "agent.start",
        params: parseParams(startInputSchema, envelope.params),
      };

    case "agent.continue":
      return {
        ...base,
        method: "agent.continue",
        params: parseParams(continueInputSchema, envelope.params),
      };

    case "agent.get":
      return {
        ...base,
        method: "agent.get",
        params: parseParams(getInputSchema, envelope.params),
      };

    case "agent.list":
      return {
        ...base,
        method: "agent.list",
        params: parseParams(workspaceScopeSchema, envelope.params),
      };

    case "agent.wait":
      return {
        ...base,
        method: "agent.wait",
        params: parseParams(waitParamsSchema, envelope.params),
      };

    case "daemon.logs":
      return {
        ...base,
        method: "daemon.logs",
        params: parseParams(logsParamsSchema, envelope.params ?? {}),
      };

    default:
      throw new LocalAgentDaemonProtocolError(
        "UNKNOWN_METHOD",
        `Unknown daemon method: ${envelope.method}`,
      );
  }
}

export function decodeLocalAgentDaemonResponse<T>(value: T): LocalAgentDaemonResponse {
  return parseProtocolValue(
    daemonResponseSchema,
    value,
    "INVALID_RESPONSE",
    "Daemon returned an invalid response.",
  );
}

export function decodeAgentRecord<T>(value: T): LocalAgentRecord {
  return parseProtocolValue(
    agentRecordSchema,
    value,
    "INVALID_RECORD",
    "Daemon returned an invalid agent record.",
  );
}

export function decodeAgentRecordList<T>(value: T): LocalAgentRecord[] {
  return parseProtocolValue(
    z.array(agentRecordSchema),
    value,
    "INVALID_RESULT",
    "Daemon returned an invalid agent list.",
  );
}

export function decodeAgentWaitResults<T>(value: T): LocalAgentWaitResult[] {
  return parseProtocolValue(
    z.array(waitResultSchema),
    value,
    "INVALID_RESULT",
    "Daemon returned invalid agent wait results.",
  );
}

export function decodeDaemonStatus<T>(value: T): LocalAgentDaemonStatus {
  return parseProtocolValue(
    daemonStatusSchema,
    value,
    "INVALID_RESULT",
    "Daemon returned an invalid status.",
  );
}

export function decodeDaemonHello<T>(value: T): LocalAgentDaemonHello {
  return parseProtocolValue(
    daemonHelloSchema,
    value,
    "INVALID_RESULT",
    "Daemon returned an invalid hello response.",
  );
}

export function decodeDaemonLogs<T>(value: T): string {
  return parseProtocolValue(
    z.string(),
    value,
    "INVALID_RESULT",
    "Daemon returned invalid logs.",
  );
}

export class LocalAgentDaemonProtocolError extends Error {
  constructor(readonly code: string, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "LocalAgentDaemonProtocolError";
  }
}

function parseParams<TSchema extends z.ZodType, TValue>(schema: TSchema, value: TValue): z.output<TSchema> {
  return parseProtocolValue(schema, value, "INVALID_PARAMS", "Daemon request parameters are invalid.");
}

function parseProtocolValue<TSchema extends z.ZodType, TValue>(
  schema: TSchema,
  value: TValue,
  code: string,
  message: string,
): z.output<TSchema> {
  const parsed = schema.safeParse(value);

  if (!parsed.success) {
    throw new LocalAgentDaemonProtocolError(code, message, { cause: parsed.error });
  }

  return parsed.data;
}

export function supportedDaemonProtocolVersion(): number {
  return LOCAL_AGENT_DAEMON_PROTOCOL_VERSION;
}
