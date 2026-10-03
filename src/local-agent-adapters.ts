import {
  localAgentProviderEnvironment,
  localAgentProviderEnvironmentOverrides,
  type SubagentProviderConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";
import {
  LOCAL_AGENT_DRIVER_KINDS,
  type LocalAgentDriverKind,
  type LocalAgentProviderInstanceId,
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
  type PiSessionFactory,
} from "./local-agent-pi.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";

export type LocalAgentAdapter = LocalAgentDriver;

export interface LocalAgentDriverOptions {
  env?: NodeJS.ProcessEnv;
  subagents?: SubagentsConfig;
  claudeQueryFactory?: ClaudeQueryFactory;
  opencodeFactory?: OpencodeFactory;
  piSessionFactory?: PiSessionFactory;
}

export function createLocalAgentDrivers(
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver[] {
  const env = options.env ?? process.env;
  const instances = options.subagents?.providers ?? LOCAL_AGENT_DRIVER_KINDS.map((driver) => ({
    id: driver,
    driver,
    enabled: true,
  } satisfies SubagentProviderConfig));
  return instances.map((instance) => new ProviderInstanceDriver(
    instance.id,
    createDriver(instance, options, env),
  ));
}

function createDriver(
  instance: SubagentProviderConfig,
  options: LocalAgentDriverOptions,
  inheritedEnv: NodeJS.ProcessEnv,
): LocalAgentDriver {
  const env = options.subagents
    ? localAgentProviderEnvironment(options.subagents, instance.id, inheritedEnv)
    : inheritedEnv;
  const envOverrides = options.subagents
    ? localAgentProviderEnvironmentOverrides(options.subagents, instance.id)
    : {};
  switch (instance.driver) {
    case "codex":
      return new CodexLocalAgentDriver(env);
    case "claude":
      return new ClaudeLocalAgentDriver(options.claudeQueryFactory, env);
    case "opencode":
      return new OpencodeLocalAgentDriver(options.opencodeFactory, env);
    case "pi":
      return new PiLocalAgentDriver(options.piSessionFactory, envOverrides);
    case "cursor":
    case "copilot":
    case "grok":
      return new AcpLocalAgentDriver(instance.driver, env);
  }
}

class ProviderInstanceDriver implements LocalAgentDriver {
  readonly provider: LocalAgentDriverKind;
  readonly idleTimeoutMs?: number;

  constructor(
    readonly providerInstanceId: LocalAgentProviderInstanceId,
    private readonly driver: LocalAgentDriver,
  ) {
    this.provider = driver.provider;
    this.idleTimeoutMs = driver.idleTimeoutMs;
  }

  runtimeKey(context: Parameters<LocalAgentDriver["runtimeKey"]>[0]): string {
    return JSON.stringify([this.providerInstanceId, this.driver.runtimeKey(context)]);
  }

  createRuntime(context: Parameters<LocalAgentDriver["createRuntime"]>[0]) {
    return this.driver.createRuntime(context);
  }
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
