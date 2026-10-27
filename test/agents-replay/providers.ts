import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { optionalFields, isJsonString } from "../../src/json-value.js";
import type { JsonObject } from "../../src/json-value.js";

/**
 * How the replayer reads one provider's stdio protocol. Everything else in the
 * harness is provider-neutral, so adding a stdio provider means adding one
 * entry here and recording its transcripts.
 */
export interface ReplayProtocol {
  /** Groups frames that must match one another, e.g. a request method. */
  kind(frame: JsonObject): string;
  /** The id of a driver request whose response the provider sends later. */
  requestId(frame: JsonObject): unknown;
  /** The request id a provider frame answers, when it is a response. */
  responseTo(frame: JsonObject): unknown;
  /**
   * Keys whose values are allocated at run time (request, session, and thread
   * ids, timestamps). They are compared by type only, and a recorded value
   * seen in a driver frame is rewritten to the live value in later replies.
   */
  volatileKeys: ReadonlySet<string>;
  /**
   // SAFETY: Boundary value already validated or constructed to match this type.
   * Driver requests whose count depends on timing, such as state polls while
   * waiting for a turn. Replay answers extra ones with the nearest recorded
   * response and skips recorded ones the driver did not send.
   */
  elasticKinds: ReadonlySet<string>;
}

export interface ProviderDefinition {
  /** The default provider instance id and driver for this provider. */
  id: string;
  protocol: ReplayProtocol;
  /** Model pinned for recordings, when the provider's default is not cheap. */
  model?: string;
  /**
   * Record-time redaction of the user's environment that drivers never read,
   // SAFETY: Boundary value already validated or constructed to match this type.
   * such as installed skills or hooks. Returning undefined drops the frame.
   */
  redactFrame?(frame: JsonObject): unknown;
  /** Provider env for live and record runs, e.g. to isolate the provider from user config. */
  liveEnv?(): Record<string, string>;
  /** The real executable the record shim spawns; the driver's default resolution. */
  realCommand(): string;
  /** The provider runs `<command> serve --port=P` and speaks HTTP instead of stdio (see http-shim.ts). */
  http?: boolean;
}

const require = createRequire(import.meta.url);

/**
 * ACP agents announce the user's installed skills and commands, and list every model the account
 * can use. DevSpace reads neither, so recordings drop the first and keep only the current model.
 */
function redactAcpFrame(frame: JsonObject): unknown {
  const update = (frame.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;

  if (frame.method === "session/update" && update?.sessionUpdate === "available_commands_update") return undefined;
  // SAFETY: Boundary value already validated or constructed to match this type.
  const result = frame.result as JsonObject | undefined;

  if (!result || !("sessionId" in result)) return frame;
  const models = result.models as { currentModelId?: unknown; availableModels?: unknown[] } | undefined;

  return {
    ...frame,
    result: {
      ...result,
      ...optionalFields(models && Array.isArray(models.availableModels) ? {
        models: {
          ...models,
          availableModels: models.availableModels.filter((model) => (model as { modelId?: unknown }).modelId === models.currentModelId),
        },
      } : undefined),
      ...optionalFields(Array.isArray(result.configOptions) ? {
        configOptions: result.configOptions.map((option: { category?: unknown; currentValue?: unknown; options?: unknown[] }) => (
          option.category === "model" && Array.isArray(option.options) ? { ...option, options: option.options.filter((entry) => (entry as { value?: unknown }).value === option.currentValue) }
            : option
        )),
      } : undefined),
    },
  };
}

/**
 * Grok also streams its own `_x.ai/` notifications (hooks, announcements, settings, workspace
 * paths) and describes the host in `_meta`. The driver only reads the prompt-completion ones.
 */
function redactGrokFrame(frame: JsonObject): unknown {
  if (isJsonString(frame.method) && /^_?x\.ai\//.test(frame.method) && !frame.method.endsWith("/session/prompt_complete")) {
    return undefined;
  }

  // SAFETY: Boundary value already validated or constructed to match this type.
  const redacted = redactAcpFrame(frame) as JsonObject | undefined;
  const result = redacted?.result as JsonObject | undefined;

  return redacted && result && "_meta" in result ? { ...redacted, result: { ...result, _meta: {} } } : redacted;
}

const jsonRpc: ReplayProtocol = {
  kind: (frame) => isJsonString(frame.method)
    ? frame.method
    : "id" in frame ? "response" : "unknown",
  requestId: (frame) => isJsonString(frame.method) ? frame.id : undefined,
  responseTo: (frame) => isJsonString(frame.method) ? undefined : frame.id,
  volatileKeys: new Set(["id", "sessionId", "threadId", "turnId", "itemId", "timestamp"]),
  elasticKinds: new Set(),
};

/** Codex notifications about the user's own hosts, account, MCP servers, hooks, and config. The driver ignores them. */
const CODEX_USER_ENVIRONMENT_METHODS: ReadonlySet<string> = new Set([
  "account/rateLimits/updated",
  "account/updated",
  "configWarning",
  "hook/completed",
  "hook/started",
  "mcpServer/startupStatus/updated",
  "remoteControl/status/changed",
  "warning",
]);

export const PROVIDERS: Record<string, ProviderDefinition> = {
  claude: {
    id: "claude",
    model: "haiku",
    // Claude Agent SDK stream-json: user messages and control requests in, SDK messages out.
    protocol: {
      kind: (frame) => {
        // SAFETY: Boundary value already validated or constructed to match this type.
        const request = frame.request as JsonObject | undefined;

        return frame.type === "control_request" && isJsonString(request?.subtype)
          ? `control_request:${request.subtype}`
          : String(frame.type);
      },
      requestId: (frame) => frame.type === "control_request" ? frame.request_id : undefined,
      responseTo: (frame) => frame.type === "control_response"
        // SAFETY: Boundary value already validated or constructed to match this type.
        ? (frame.response as JsonObject | undefined)?.request_id
        : undefined,
      volatileKeys: new Set(["request_id", "session_id", "uuid", "timestamp"]),
      elasticKinds: new Set(),
    },
    redactFrame: (frame) => {
      // SessionStart and other hooks report the user's own hook commands and output.
      if (frame.type === "system" && String(frame.subtype).startsWith("hook_")) return undefined;

      if (frame.type === "system" && frame.subtype === "init") {
        return {
          ...frame,
          // SAFETY: Boundary value already validated or constructed to match this type.
          tools: (frame.tools as string[]).filter((tool) => !tool.startsWith("mcp__")),
          ...emptied(frame, ["mcp_servers", "slash_commands", "agents", "skills", "plugins"]),
          memory_paths: {},
        };
      }

      // SAFETY: Boundary value already validated or constructed to match this type.
      const response = (frame.response as JsonObject | undefined)?.response as JsonObject | undefined;

      if (frame.type === "control_response" && response && "commands" in response) {
        return {
          ...frame,
          response: {
            // SAFETY: Boundary value already validated or constructed to match this type.
            ...(frame.response as JsonObject),
            response: { ...response, ...emptied(response, ["commands", "agents"]), account: {}, pid: 0 },
          },
        };
      }

      return frame;
    },
    realCommand: () => {
      // The SDK runs its bundled native CLI unless CLAUDE_COMMAND is set.
      const sdk = dirname(require.resolve("@anthropic-ai/claude-agent-sdk"));
      const platform = `${process.platform}-${process.arch}`;

      return createRequire(join(sdk, "package.json"))
        .resolve(`@anthropic-ai/claude-agent-sdk-${platform}/claude${process.platform === "win32" ? ".exe" : ""}`);
    },
  },
  pi: {
    id: "pi",
    // Pi RPC: `{ type, id }` commands in, `{ type: "response", id }` and events out.
    protocol: {
      kind: (frame) => String(frame.type),
      requestId: (frame) => frame.type === "response" ? undefined : frame.id,
      responseTo: (frame) => frame.type === "response" ? frame.id : undefined,
      volatileKeys: new Set(["id", "sessionId", "toolCallId", "timestamp"]),
      // The driver polls get_state whenever Pi is quiet for 200ms.
      elasticKinds: new Set(["get_state"]),
    },
    // User extensions that override built-in tools conflict with DevSpace's sandbox extension,
    // so recordings may point Pi at an isolated agent dir (see README).
    liveEnv: (): Record<string, string> => {
      const agentDir = process.env.DEVSPACE_QA_PI_AGENT_DIR;

      return agentDir ? { PI_CODING_AGENT_DIR: agentDir } : {};
    },
    realCommand: () => "pi",
  },
  opencode: {
    id: "opencode",
    model: "openai/gpt-5.6-luna",
    http: true,
    // HTTP frames from http-shim.ts: requests in, responses and SSE events out, correlated by request counter.
    protocol: {
      kind: (frame) => isJsonString(frame.method)
        ? `${frame.method} ${String(frame.path).split("?")[0]!.replace(/\/[a-z]+_[A-Za-z0-9]+/g, "/{id}")}`
        : "response",
      requestId: (frame) => isJsonString(frame.method) ? frame.id : undefined,
      responseTo: (frame) => isJsonString(frame.method) ? undefined : frame.id,
      volatileKeys: new Set(["id"]),
      elasticKinds: new Set(),
    },
    realCommand: () => "opencode",
  },
  codex: {
    id: "codex",
    model: "gpt-6-luna",
    // codex app-server JSON-RPC.
    protocol: jsonRpc,
    redactFrame: (frame) => {
      if (isJsonString(frame.method)) return CODEX_USER_ENVIRONMENT_METHODS.has(frame.method) ? undefined : frame;
      // SAFETY: Boundary value already validated or constructed to match this type.
      const result = frame.result as JsonObject | undefined;

      // The initialize reply names the OS; thread replies list the user's instruction files.
      if (result && "userAgent" in result) return { ...frame, result: { ...result, userAgent: "codex" } };

      if (result && "instructionSources" in result) return { ...frame, result: { ...result, instructionSources: [] } };

      return frame;
    },
    realCommand: () => "codex",
  },
  // ACP agents speak JSON-RPC over stdio; DevSpace's AcpLocalAgentDriver is shared by all three.
  cursor: {
    id: "cursor",
    redactFrame: redactAcpFrame,
    // SAFETY: Boundary value already validated or constructed to match this type.
    // Recorded with the account's default (Auto): cheaper models such as gpt-5.4-nano need a paid plan.
    protocol: jsonRpc,
    realCommand: () => "cursor-agent",
  },
  copilot: {
    id: "copilot",
    redactFrame: redactAcpFrame,
    protocol: jsonRpc,
    // The user's Copilot hooks run in Copilot's tool sandbox and can fail a turn, and they would
    // be recorded. A separate config dir keeps the login (it is not stored there) and drops them.
    liveEnv: (): Record<string, string> => {
      const home = join(tmpdir(), "devspace-agents-qa-copilot-home");
      mkdirSync(home, { recursive: true });

      return { COPILOT_HOME: home };
    },
    realCommand: () => "copilot",
  },
  grok: {
    id: "grok",
    redactFrame: redactGrokFrame,
    protocol: jsonRpc,
    realCommand: () => "grok",
  },
};

function emptied(record: JsonObject, keys: string[]): Record<string, unknown[]> {
  return Object.fromEntries(keys.values().filter((key) => key in record).map((key) => [key, []]));
}

export function providerDefinition(name: string): ProviderDefinition {
  const definition = PROVIDERS[name];

  if (!definition) {
    throw new Error(`Unknown provider ${name}. Known providers: ${Object.keys(PROVIDERS).join(", ")}.`);
  }

  return definition;
}
