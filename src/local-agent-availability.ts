import { accessSync, constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import {
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";
import {
  localAgentProviderEnvironment,
  type SubagentsConfig,
} from "./local-agent-config.js";

export interface LocalAgentProviderAvailability {
  name: LocalAgentProvider;
  available: boolean;
  reason?: string;
  note?: string;
}

export function getLocalAgentProviderAvailabilitySnapshot(
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): LocalAgentProviderAvailability[] {
  return LOCAL_AGENT_PROVIDERS.map((provider) => (
    checkLocalAgentProviderAvailability(provider, env, config)
  ));
}

function checkLocalAgentProviderAvailability(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): LocalAgentProviderAvailability {
  const providerEnv = config ? localAgentProviderEnvironment(config, provider, env) : env;
  switch (provider) {
    case "codex":
      return codexAvailability(providerEnv);
    case "claude":
      return providerEnv.CLAUDE_COMMAND
        ? commandAvailability(provider, providerEnv.CLAUDE_COMMAND, providerEnv)
        : packageAvailability(provider, "@anthropic-ai/claude-agent-sdk");
    case "opencode":
      return packageAvailability(provider, "@opencode-ai/sdk/v2");
    case "pi":
      return packageAvailability(provider, "@earendil-works/pi-coding-agent");
    case "cursor":
      return commandAvailability(provider, providerEnv.CURSOR_COMMAND ?? "cursor-agent", providerEnv);
    case "copilot":
      return commandAvailability(provider, providerEnv.COPILOT_COMMAND ?? "copilot", providerEnv);
    case "grok":
      return commandAvailability(provider, providerEnv.GROK_COMMAND ?? "grok", providerEnv);
  }
}

export function assertLocalAgentProviderAvailable(
  provider: LocalAgentProvider,
  env: NodeJS.ProcessEnv = process.env,
  config?: SubagentsConfig,
): void {
  const availability = checkLocalAgentProviderAvailability(provider, env, config);
  if (availability.available) return;
  throw new Error(
    `${provider} provider is not available: ${availability.reason ?? "provider preflight failed"}`,
  );
}

function packageAvailability(
  provider: LocalAgentProvider,
  packageName: string,
): LocalAgentProviderAvailability {
  try {
    import.meta.resolve(packageName);
    return { name: provider, available: true };
  } catch {
    return {
      name: provider,
      available: false,
      reason: `${packageName} package not found`,
    };
  }
}

function codexAvailability(env: NodeJS.ProcessEnv): LocalAgentProviderAvailability {
  const availability = commandAvailability("codex", env.CODEX_COMMAND ?? "codex", env);
  return availability.available
    ? {
        ...availability,
        note: "available",
      }
    : availability;
}

function commandAvailability(
  provider: LocalAgentProvider,
  command: string,
  env: NodeJS.ProcessEnv,
): LocalAgentProviderAvailability {
  if (resolveCommand(command, env)) return { name: provider, available: true };
  return {
    name: provider,
    available: false,
    reason: `${command} executable not found`,
  };
}

function resolveCommand(command: string, env: NodeJS.ProcessEnv): string | undefined {
  if (command.includes("/") || command.includes("\\")) {
    return executableExists(command) ? command : undefined;
  }
  const path = env.PATH;
  if (!path) return undefined;
  const extensions = process.platform === "win32"
    ? ["", ...(env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)]
    : [""];
  for (const directory of path.split(delimiter)) {
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = resolve(directory, `${command}${extension}`);
      if (executableExists(candidate)) return candidate;
    }
  }
  return undefined;
}

function executableExists(command: string): boolean {
  const mode = process.platform === "win32" ? constants.F_OK : constants.X_OK;
  try {
    accessSync(command, mode);
    return true;
  } catch {
    return false;
  }
}
