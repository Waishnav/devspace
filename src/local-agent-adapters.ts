import {
  type SubagentProviderConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";
import {
  LOCAL_AGENT_DEFAULT_PROVIDER_IDS,
  LOCAL_AGENT_DRIVER_KINDS,
} from "./local-agent-provider.js";
import {
  AcpLocalAgentDriver,
  resolveAcpCommand,
  resolveAcpModelConfigUpdate,
  resolveAcpEffortConfigUpdate,
} from "./local-agent-acp.js";
import {
  ClaudeLocalAgentDriver,
  claudeCommandEnvironment,
  type ClaudeQueryFactory,
} from "./local-agent-claude.js";
import { CodexLocalAgentDriver } from "./local-agent-codex.js";
import {
  OpencodeLocalAgentDriver,
  extractOpenCodeFinalResponse,
  type OpencodeFactory,
} from "./local-agent-opencode.js";
import {
  PiLocalAgentDriver,
  extractPiFinalResponse,
  extractPiProviderError,
  type PiRpcFactory,
} from "./local-agent-pi.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";
import { LocalAgentProviderRegistry } from "./local-agent-provider-registry.js";

export type LocalAgentAdapter = LocalAgentDriver;

export interface LocalAgentDriverOptions {
  env?: NodeJS.ProcessEnv;
  subagents?: SubagentsConfig;
  claudeQueryFactory?: ClaudeQueryFactory;
  opencodeFactory?: OpencodeFactory;
  piRpcFactory?: PiRpcFactory;
}

export function createLocalAgentDrivers(
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver[] {
  const env = options.env ?? process.env;
  const instances = options.subagents?.providers ?? LOCAL_AGENT_DEFAULT_PROVIDER_IDS.map((id) => ({
    id,
    driver: id === "cursor" || id === "copilot" || id === "grok" ? "acp" : id,
    enabled: true,
  } satisfies SubagentProviderConfig));
  const registry = createLocalAgentProviderRegistry(options);
  return instances.map((instance) => registry.create(instance, options.subagents, env));
}

export function createLocalAgentProviderRegistry(
  options: LocalAgentDriverOptions = {},
): LocalAgentProviderRegistry {
  return new LocalAgentProviderRegistry()
    .register("codex", ({ env }) => new CodexLocalAgentDriver(env))
    .register("claude", ({ env }) => new ClaudeLocalAgentDriver(options.claudeQueryFactory, env))
    .register("opencode", ({ env }) => new OpencodeLocalAgentDriver({ factory: options.opencodeFactory, env }))
    .register("pi", ({ env }) => new PiLocalAgentDriver(options.piRpcFactory, env))
    .register("acp", ({ instance, env }) => new AcpLocalAgentDriver({
      env,
      command: instance.command,
      args: instance.config?.args,
      flavor: instance.config?.flavor,
    }));
}

export function extractLocalAgentResponseText(value: unknown): string {
  return extractOpenCodeFinalResponse(value) || extractPiFinalResponse(value);
}

export {
  claudeCommandEnvironment,
  extractOpenCodeFinalResponse,
  extractPiFinalResponse,
  extractPiProviderError,
  resolveAcpCommand,
  resolveAcpModelConfigUpdate,
  resolveAcpEffortConfigUpdate,
};
