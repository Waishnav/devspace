import { isJsonString, isJsonObject, optionalFields } from "../../src/json-value.js";
import type { JsonObject, WireInput } from "../../src/json-value.js";
import { mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/**
 * How the replayer reads one provider's stdio protocol. Everything else in the
 * harness is provider-neutral, so adding a stdio provider means adding one
 * entry here and recording its transcripts.
 */
export interface ReplayProtocol {
  /** Groups frames that must match one another, e.g. a request method. */
  kind(frame: JsonObject): string;
  /** The id of a driver request whose response the provider sends later. */
  requestId(frame: JsonObject): WireInput;
  /** The request id a provider frame answers, when it is a response. */
  responseTo(frame: JsonObject): WireInput;
  /**
   * Keys whose values are allocated at run time (request, session, and thread
   * ids, timestamps). They are compared by type only, and a recorded value
   * seen in a driver frame is rewritten to the live value in later replies.
   */
  volatileKeys: ReadonlySet<string>;
  /**
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
   * such as installed skills or hooks. Returning undefined drops the frame.
   */
  redactFrame?(frame: JsonObject): WireInput;
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
function redactAcpFrame(frame: JsonObject): WireInput {
  // SAFETY: The surrounding checks or construction already match this type.
  const update = (frame.params as { update?: { sessionUpdate?: unknown } } | undefined)?.update;

  if (frame.method === "session/update" && update?.sessionUpdate === "available_commands_update") return undefined;
  // SAFETY: The surrounding checks or construction already match this type.
  const result = frame.result as JsonObject | undefined;

  if (!result || !("sessionId" in result)) return frame;
  // SAFETY: The surrounding checks or construction already match this type.
  const models = result.models as { currentModelId?: unknown; availableModels?: unknown[] } | undefined;

  return {
    ...frame,
    result: {
      ...result,
      ...optionalFields(models && Array.isArray(models.availableModels) ? {
        models: {
          ...models,
          // SAFETY: The surrounding checks or construction already match this type.
          availableModels: models.availableModels.filter((model) => (model as { modelId?: unknown }).modelId === models.currentModelId),
        },
      } : undefined),
      ...optionalFields(Array.isArray(result.configOptions) ? {
        configOptions: result.configOptions.map((option) => (
          isJsonObject(option) && option.category === "model" && Array.isArray(option.options)
            ? { ...option, options: option.options.filter((entry: WireInput) => isJsonObject(entry) && entry.value === option.currentValue) }
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
function redactGrokFrame(frame: JsonObject): WireInput {
  if (isJsonString(frame.method) && /^_?x\.ai\//.test(frame.method) && !frame.method.endsWith("/session/prompt_complete")) {
    return undefined;
  }

  // SAFETY: The surrounding checks or construction already match this type.
  const redacted = redactAcpFrame(frame) as JsonObject | undefined;
  // SAFETY: The surrounding checks or construction already match this type.
  const result = redacted?.result as JsonObject | undefined;

  return redacted && result && "_meta" in result ? { ...redacted, result: { ...result, _meta: {} } } : redacted;
}

const jsonRpc: ReplayProtocol = {
  kind: (frame: JsonObject) => isJsonString(frame.method)
    ? frame.method
    : "id" in frame ? "response" : "unknown",
  requestId: (frame: JsonObject) => isJsonString(frame.method) ? frame.id : undefined,
  responseTo: (frame: JsonObject) => isJsonString(frame.method) ? undefined : frame.id,
  // `version` is DevSpace's own release in clientInfo (and the provider's in its reply): it changes every
  // release and says nothing about the protocol, so a version bump must not invalidate recordings.
  volatileKeys: new Set(["id", "sessionId", "threadId", "turnId", "itemId", "timestamp", "version"]),
  elasticKinds: new Set<string>(),
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

export const PROVIDERS = {
  claude: {
    id: "claude",
    model: "haiku",
    // Claude Agent SDK stream-json: user messages and control requests in, SDK messages out.
    protocol: {
      kind: (frame: JsonObject) => {
        // SAFETY: The surrounding checks or construction already match this type.
        const request = frame.request as JsonObject | undefined;

        return frame.type === "control_request" && isJsonString(request?.subtype)
          ? `control_request:${request.subtype}`
          : String(frame.type);
      },
      requestId: (frame: JsonObject) => frame.type === "control_request" ? frame.request_id : undefined,
      responseTo: (frame: JsonObject) => frame.type === "control_response"
        // SAFETY: The surrounding checks or construction already match this type.
        ? (isJsonObject(frame.response) ? frame.response.request_id : undefined)
        : undefined,
      volatileKeys: new Set(["request_id", "session_id", "uuid", "timestamp"]),
      elasticKinds: new Set<string>(),
    },
    redactFrame: (frame: JsonObject) => {
      // SessionStart and other hooks report the user's own hook commands and output.
      if (frame.type === "system" && String(frame.subtype).startsWith("hook_")) return undefined;

      if (frame.type === "system" && frame.subtype === "init") {
        return {
          ...frame,
          // SAFETY: The surrounding checks or construction already match this type.
          tools: (frame.tools as string[]).filter((tool) => !tool.startsWith("mcp__")),
          ...emptied(frame, ["mcp_servers", "slash_commands", "agents", "skills", "plugins"]),
          memory_paths: {},
        };
      }

      // SAFETY: The surrounding checks or construction already match this type.
      const response = (frame.response as JsonObject | undefined)?.response as JsonObject | undefined;

      if (frame.type === "control_response" && response && "commands" in response) {
        return {
          ...frame,
          response: {
            // SAFETY: The surrounding checks or construction already match this type.
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
      kind: (frame: JsonObject) => String(frame.type),
      requestId: (frame: JsonObject) => frame.type === "response" ? undefined : frame.id,
      responseTo: (frame: JsonObject) => frame.type === "response" ? frame.id : undefined,
      volatileKeys: new Set(["id", "sessionId", "toolCallId", "timestamp"]),
      // The driver polls get_state whenever Pi is quiet for 200ms.
      elasticKinds: new Set(["get_state"]),
    },
    // User extensions that override built-in tools conflict with DevSpace's sandbox extension,
    // so recordings may point Pi at an isolated agent dir (see README).
    liveEnv: () => {
      const env: Record<string, string> = {};
      const agentDir = process.env.DEVSPACE_QA_PI_AGENT_DIR;

      if (agentDir) env.PI_CODING_AGENT_DIR = agentDir;

      return env;
    },
    realCommand: () => "pi",
  },
  opencode: {
    id: "opencode",
    model: "openai/gpt-5.6-luna",
    http: true,
    // HTTP frames from http-shim.ts: requests in, responses and SSE events out, correlated by request counter.
    protocol: {
      kind: (frame: JsonObject) => isJsonString(frame.method)
        ? `${frame.method} ${String(frame.path).split("?")[0]!.replace(/\/[a-z]+_[A-Za-z0-9]+/g, "/{id}")}`
        : "response",
      requestId: (frame: JsonObject) => isJsonString(frame.method) ? frame.id : undefined,
      responseTo: (frame: JsonObject) => isJsonString(frame.method) ? undefined : frame.id,
      volatileKeys: new Set(["id"]),
      elasticKinds: new Set<string>(),
    },
    realCommand: () => "opencode",
  },
  codex: {
    id: "codex",
    model: "gpt-6-luna",
    // codex app-server JSON-RPC.
    protocol: jsonRpc,
    redactFrame: (frame: JsonObject) => {
      if (isJsonString(frame.method)) return CODEX_USER_ENVIRONMENT_METHODS.has(frame.method) ? undefined : frame;
      // SAFETY: The surrounding checks or construction already match this type.
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
    liveEnv: () => {
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

function emptied(record: JsonObject, keys: string[]): JsonObject {
  return Object.fromEntries(keys.flatMap((key) => (key in record ? [[key, []]] : [])));
}

function isProviderId(name: string): name is keyof typeof PROVIDERS {
  return Object.hasOwn(PROVIDERS, name);
}

export function providerDefinition(name: string): ProviderDefinition {
  if (!isProviderId(name)) {
    throw new Error(`Unknown provider ${name}. Known providers: ${Object.keys(PROVIDERS).join(", ")}.`);
  }

  return PROVIDERS[name];
}
