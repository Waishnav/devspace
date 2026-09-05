import {
  localAgentProviderEnvironment,
  type SubagentsConfig,
} from "./local-agent-config.js";
import type { LocalAgentProvider } from "./local-agent-profiles.js";
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
  const providerEnv = (provider: LocalAgentProvider) => options.subagents
    ? localAgentProviderEnvironment(options.subagents, provider, env)
    : env;
  return [
    new CodexLocalAgentDriver(providerEnv("codex")),
    new ClaudeLocalAgentDriver(options.claudeQueryFactory, providerEnv("claude")),
    new OpencodeLocalAgentDriver(options.opencodeFactory),
    new PiLocalAgentDriver(options.piSessionFactory),
    new AcpLocalAgentDriver("cursor", providerEnv("cursor")),
    new AcpLocalAgentDriver("copilot", providerEnv("copilot")),
    new AcpLocalAgentDriver("grok", providerEnv("grok")),
  ];
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
