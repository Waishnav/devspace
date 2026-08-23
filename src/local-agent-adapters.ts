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
  claudeQueryFactory?: ClaudeQueryFactory;
  opencodeFactory?: OpencodeFactory;
  piSessionFactory?: PiSessionFactory;
}

export function createLocalAgentDrivers(
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver[] {
  return [
    new CodexLocalAgentDriver(options.env),
    new ClaudeLocalAgentDriver(options.claudeQueryFactory, options.env),
    new OpencodeLocalAgentDriver(options.opencodeFactory),
    new PiLocalAgentDriver(options.piSessionFactory),
    new AcpLocalAgentDriver("cursor", options.env),
    new AcpLocalAgentDriver("copilot", options.env),
    new AcpLocalAgentDriver("grok", options.env),
  ];
}

export function createLocalAgentAdapter(
  provider: LocalAgentProvider,
  options: LocalAgentDriverOptions = {},
): LocalAgentDriver {
  switch (provider) {
    case "codex": return new CodexLocalAgentDriver(options.env);
    case "claude": return new ClaudeLocalAgentDriver(options.claudeQueryFactory, options.env);
    case "opencode": return new OpencodeLocalAgentDriver(options.opencodeFactory);
    case "pi": return new PiLocalAgentDriver(options.piSessionFactory);
    case "cursor":
    case "copilot":
    case "grok":
      return new AcpLocalAgentDriver(provider, options.env);
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
