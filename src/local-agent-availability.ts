import { resolveExecutableCommand } from "./local-agent-command.js";
import {
  localAgentProviderEnvironment,
  subagentProviderConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";
import {
  defaultDriverForProviderId,
  isLocalAgentDriverKind,
  LOCAL_AGENT_DEFAULT_PROVIDER_IDS,
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
    ...LOCAL_AGENT_DEFAULT_PROVIDER_IDS.map((id) => configured.get(id) ?? { id, driver: defaultDriverForProviderId(id)! }),
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
      return commandAvailability(providerInstanceId, "opencode", providerEnv);
    case "pi":
      return providerEnv.PI_COMMAND
        ? commandAvailability(providerInstanceId, providerEnv.PI_COMMAND, providerEnv)
        : packageAvailability(providerInstanceId, "@earendil-works/pi-coding-agent");
    case "acp": {
      const configured = config ? subagentProviderConfig(config, providerInstanceId) : undefined;
      const command = configured?.command
        ?? (providerInstanceId === "cursor" ? providerEnv.CURSOR_COMMAND ?? "cursor-agent"
          : providerInstanceId === "copilot" ? providerEnv.COPILOT_COMMAND ?? "copilot"
            : providerInstanceId === "grok" ? providerEnv.GROK_COMMAND ?? "grok"
              : undefined);
      return command
        ? commandAvailability(providerInstanceId, command, providerEnv)
        : { name: providerInstanceId, available: false, reason: "ACP command is not configured" };
    }
  }
}

export function assertLocalAgentProviderAvailable(
  providerInstanceId: LocalAgentProviderInstanceId,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): void {
  const provider = config ? subagentProviderConfig(config, providerInstanceId) : undefined;
  const driver = provider?.driver
    ?? defaultDriverForProviderId(providerInstanceId);
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
