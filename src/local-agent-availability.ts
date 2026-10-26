import { resolveExecutableCommand } from "./local-agent-command.js";
import {
  localAgentProviderEnvironment,
  subagentProviderConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";
import {
  isLocalAgentDriverKind,
  LOCAL_AGENT_DRIVER_KINDS,
  type LocalAgentDriverKind,
  type LocalAgentProviderInstanceId,
} from "./local-agent-provider.js";

export interface LocalAgentProviderAvailability {
  name: LocalAgentProviderInstanceId;
  available: boolean;
  reason?: string;
  note?: string;
}

export function getLocalAgentProviderAvailabilitySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): LocalAgentProviderAvailability[] {
  const configured = new Map(config?.providers.map((provider) => [provider.id, provider]) ?? []);
  const instances = [
    ...LOCAL_AGENT_DRIVER_KINDS.map((driver) => configured.get(driver) ?? { id: driver, driver }),
    ...(config?.providers.filter((provider) => !isLocalAgentDriverKind(provider.id)) ?? []),
  ];
  return instances.map((instance) => checkLocalAgentProviderAvailability(
    instance.id,
    instance.driver,
    env,
    config,
  ));
}

function checkLocalAgentProviderAvailability(
  providerInstanceId: LocalAgentProviderInstanceId,
  driver: LocalAgentDriverKind,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): LocalAgentProviderAvailability {
  const providerEnv = config ? localAgentProviderEnvironment(config, providerInstanceId, env) : env;
  switch (driver) {
    case "codex":
      return codexAvailability(providerInstanceId, providerEnv);
    case "claude":
      return providerEnv.CLAUDE_COMMAND
        ? commandAvailability(providerInstanceId, providerEnv.CLAUDE_COMMAND, providerEnv)
        : packageAvailability(providerInstanceId, "@anthropic-ai/claude-agent-sdk");
    case "opencode":
      return packageAvailability(providerInstanceId, "@opencode-ai/sdk/v2");
    case "pi":
      return packageAvailability(providerInstanceId, "@earendil-works/pi-coding-agent");
    case "cursor":
      return commandAvailability(providerInstanceId, providerEnv.CURSOR_COMMAND ?? "cursor-agent", providerEnv);
    case "copilot":
      return commandAvailability(providerInstanceId, providerEnv.COPILOT_COMMAND ?? "copilot", providerEnv);
    case "grok":
      return commandAvailability(providerInstanceId, providerEnv.GROK_COMMAND ?? "grok", providerEnv);
  }
}

export function assertLocalAgentProviderAvailable(
  providerInstanceId: LocalAgentProviderInstanceId,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): void {
  const provider = config ? subagentProviderConfig(config, providerInstanceId) : undefined;
  const driver = provider?.driver
    ?? (isLocalAgentDriverKind(providerInstanceId) ? providerInstanceId : undefined);
  if (!driver) throw new Error(`${providerInstanceId} provider is not configured.`);
  const availability = checkLocalAgentProviderAvailability(providerInstanceId, driver, env, config);
  if (availability.available) return;
  throw new Error(
    `${providerInstanceId} provider is not available: ${availability.reason ?? "provider preflight failed"}`,
  );
}

function packageAvailability(
  providerInstanceId: LocalAgentProviderInstanceId,
  packageName: string,
): LocalAgentProviderAvailability {
  try {
    import.meta.resolve(packageName);
    return { name: providerInstanceId, available: true };
  } catch {
    return {
      name: providerInstanceId,
      available: false,
      reason: `${packageName} package not found`,
    };
  }
}

function codexAvailability(
  providerInstanceId: LocalAgentProviderInstanceId,
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  const availability = commandAvailability(providerInstanceId, env.CODEX_COMMAND ?? "codex", env);
  return availability.available
    ? {
        ...availability,
        note: "available",
      }
    : availability;
}

function commandAvailability(
  providerInstanceId: LocalAgentProviderInstanceId,
  command: string,
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  if (resolveExecutableCommand(command, env)) return { name: providerInstanceId, available: true };
  return {
    name: providerInstanceId,
    available: false,
    reason: `${command} executable not found`,
  };
}
