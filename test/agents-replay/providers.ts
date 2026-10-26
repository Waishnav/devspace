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
  kind(frame: Record<string, unknown>): string;
  /** The id of a driver request whose response the provider sends later. */
  requestId(frame: Record<string, unknown>): unknown;
  /** The request id a provider frame answers, when it is a response. */
  responseTo(frame: Record<string, unknown>): unknown;
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
  redactFrame?(frame: Record<string, unknown>): unknown;
  /** Provider env for live and record runs, e.g. to isolate the provider from user config. */
  liveEnv?(): Record<string, string>;
  /** The real executable the record shim spawns; the driver's default resolution. */
  realCommand(): string;
}

const require = createRequire(import.meta.url);

const jsonRpc: ReplayProtocol = {
  kind: (frame) => typeof frame.method === "string"
    ? frame.method
    : "id" in frame ? "response" : "unknown",
  requestId: (frame) => typeof frame.method === "string" ? frame.id : undefined,
  responseTo: (frame) => typeof frame.method === "string" ? undefined : frame.id,
  volatileKeys: new Set(["id", "sessionId", "threadId", "turnId", "itemId", "timestamp"]),
  elasticKinds: new Set(),
};

export const PROVIDERS: Record<string, ProviderDefinition> = {
  claude: {
    id: "claude",
    model: "haiku",
    // Claude Agent SDK stream-json: user messages and control requests in, SDK messages out.
    protocol: {
      kind: (frame) => {
        const request = frame.request as Record<string, unknown> | undefined;
        return frame.type === "control_request" && typeof request?.subtype === "string"
          ? `control_request:${request.subtype}`
          : String(frame.type);
      },
      requestId: (frame) => frame.type === "control_request" ? frame.request_id : undefined,
      responseTo: (frame) => frame.type === "control_response"
        ? (frame.response as Record<string, unknown> | undefined)?.request_id
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
          tools: (frame.tools as string[]).filter((tool) => !tool.startsWith("mcp__")),
          ...emptied(frame, ["mcp_servers", "slash_commands", "agents", "skills", "plugins"]),
          memory_paths: {},
        };
      }
      const response = (frame.response as Record<string, unknown> | undefined)?.response as Record<string, unknown> | undefined;
      if (frame.type === "control_response" && response && "commands" in response) {
        return {
          ...frame,
          response: {
            ...(frame.response as Record<string, unknown>),
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
  codex: {
    id: "codex",
    // codex app-server JSON-RPC (not yet recorded).
    protocol: jsonRpc,
    realCommand: () => "codex",
  },
  // ACP agents speak JSON-RPC over stdio; DevSpace's AcpLocalAgentDriver is shared by all three.
  cursor: {
    id: "cursor",
    protocol: jsonRpc,
    realCommand: () => "cursor-agent",
  },
  copilot: {
    id: "copilot",
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
    protocol: jsonRpc,
    realCommand: () => "grok",
  },
};

function emptied(record: Record<string, unknown>, keys: string[]): Record<string, unknown[]> {
  return Object.fromEntries(keys.filter((key) => key in record).map((key) => [key, []]));
}

export function providerDefinition(name: string): ProviderDefinition {
  const definition = PROVIDERS[name];
  if (!definition) {
    throw new Error(`Unknown provider ${name}. Known providers: ${Object.keys(PROVIDERS).join(", ")}.`);
  }
  return definition;
}
