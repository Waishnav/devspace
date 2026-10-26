import { resolveExecutableCommand } from "./local-agent-command.js";
import { resolveAcpCommand } from "./local-agent-acp.js";
import { resolvePiCommand } from "./local-agent-pi.js";
import {
  localAgentProviderEnvironment,
  subagentAcpFlavor,
  subagentProviderConfig,
  type SubagentsConfig,
} from "./local-agent-config.js";
import {
  defaultDriverForProviderId,
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
  const defaultIds = new Set<string>(LOCAL_AGENT_DEFAULT_PROVIDER_IDS);
  const instances = [
    ...LOCAL_AGENT_DEFAULT_PROVIDER_IDS.map((id) => configured.get(id) ?? { id, driver: defaultDriverForProviderId(id)! }),
    ...(config?.providers.filter((provider) => !defaultIds.has(provider.id)) ?? []),
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
      // Same resolution as the runtime: PI_COMMAND, then `pi` on PATH, then the bundled package.
      try {
        resolvePiCommand(providerEnv);
        return { name: providerInstanceId, available: true };
      } catch (cause) {
        return {
          name: providerInstanceId,
          available: false,
          reason: cause instanceof Error ? cause.message : "Pi executable not found",
        };
      }
    case "acp": {
      // Resolve exactly as the driver does, so preflight and startup agree on the executable.
      const configured = config ? subagentProviderConfig(config, providerInstanceId) : undefined;
      const flavor = subagentAcpFlavor({ id: providerInstanceId, config: configured?.config });
      if (resolveAcpCommand(flavor ?? "generic", providerEnv, configured?.command)) {
        return { name: providerInstanceId, available: true };
      }
      return {
        name: providerInstanceId,
        available: false,
        reason: configured?.command
          ? `${configured.command} executable not found`
          : flavor
            ? `${flavor} executable not found`
            : "ACP command is not configured",
      };
    }
  }
}

/** Resolves a provider's executable exactly as its driver will, without starting it. */
export function localAgentProviderAvailability(
  providerInstanceId: LocalAgentProviderInstanceId,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): LocalAgentProviderAvailability {
  const provider = config ? subagentProviderConfig(config, providerInstanceId) : undefined;
  const driver = provider?.driver
    ?? defaultDriverForProviderId(providerInstanceId);
  if (!driver) return { name: providerInstanceId, available: false, reason: "provider is not configured" };
  return checkLocalAgentProviderAvailability(providerInstanceId, driver, env, config);
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
