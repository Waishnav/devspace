import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type { LocalAgentProviderInstanceId } from "./local-agent-provider.js";
import type { SubagentProviderConfig } from "./local-agent-config.js";
import { validateAgentId } from "./local-agent-id.js";
import type { LocalAgentWriteMode } from "./local-agent-runtime.js";

export interface ParsedLocalAgentContinueArgs {
  agentId: string;
  prompt: string;
  model?: string;
  effort?: string;
  writeMode?: LocalAgentWriteMode;
  wait: boolean;
  timeoutMs?: number;
}

export interface ParsedLocalAgentRunArgs extends Omit<ParsedLocalAgentContinueArgs, "agentId"> {
  target: string;
  /** Caller-supplied idempotency key; becomes the agent id. */
  requestId?: string;
  /** `--worktree [--branch <name>]`: run in a new git worktree instead of the current checkout. */
  worktree?: { branch?: string };
}

export type LocalAgentTarget =
  | {
      kind: "profile";
      name: string;
      provider: LocalAgentProviderInstanceId;
      model?: string;
      effort?: string;
      profile: LocalAgentProfile;
    }
  | {
      kind: "provider";
      name: LocalAgentProviderInstanceId;
      provider: LocalAgentProviderInstanceId;
      model?: string;
      effort?: string;
    };

const WRITE_MODES: readonly LocalAgentWriteMode[] = ["read_only", "allowed", "full_access"];
const VALUE_OPTIONS = ["--model", "--effort", "--write-mode", "--request-id", "--branch", "--timeout"] as const;
const RUN_ONLY_OPTIONS: readonly string[] = ["--request-id", "--branch"];

type ValueOption = typeof VALUE_OPTIONS[number];

export function parseLocalAgentRunArgs(args: string[]): ParsedLocalAgentRunArgs {
  return parseAgentPromptArgs(
    args,
    'Usage: devspace agents run <profile-or-provider> [--model <model>] [--effort <level>] [--write-mode <read_only|allowed|full_access>] [--request-id <key>] [--worktree [--branch <name>]] [--wait [--timeout <seconds>]] "<prompt>"',
    true,
  );
}

export function parseLocalAgentContinueArgs(args: string[]): ParsedLocalAgentContinueArgs {
  const { target, requestId: _requestId, ...parsed } = parseAgentPromptArgs(
    args,
    'Usage: devspace agents continue <id> [--model <model>] [--effort <level>] [--write-mode <read_only|allowed|full_access>] [--wait [--timeout <seconds>]] "<prompt>"',
    false,
  );

  return { agentId: target, ...parsed };
}

function parseAgentPromptArgs(
  args: string[],
  usage: string,
  isRun: boolean,
): ParsedLocalAgentRunArgs {
  const [target, ...rest] = args;

  if (!target) {
    throw new Error(usage);
  }

  const values: Partial<Record<ValueOption, string>> = {};
  let wait = false;
  let worktree = false;
  const promptParts: string[] = [];
  let optionsEnded = false;

  for (let index = 0; index < rest.length; index += 1) {
    const part = rest[index]!;

    if (!optionsEnded && part === "--") {
      optionsEnded = true;
      continue;
    }

    if (optionsEnded || !part.startsWith("-")) {
      promptParts.push(part);
      continue;
    }

    if (part === "--wait") {
      wait = true;
      continue;
    }

    if (isRun && part === "--worktree") {
      worktree = true;
      continue;
    }

    const option = VALUE_OPTIONS.find((name) => part === name || part.startsWith(`${name}=`));

    if (!option || (!isRun && RUN_ONLY_OPTIONS.includes(option))) throw unknownOptionError(part);

    if (part === option) {
      values[option] = parseOptionValue(rest[index + 1], option);
      index += 1;
    } else {
      values[option] = parseOptionValue(part.slice(option.length + 1), option);
    }
  }

  const prompt = promptParts.join(" ").trim();

  if (!prompt) {
    throw new Error(usage);
  }

  if (values["--timeout"] !== undefined && !wait) throw new Error("--timeout requires --wait.");

  if (values["--branch"] !== undefined && !worktree) throw new Error("--branch requires --worktree.");

  return {
    target,
    prompt,
    model: values["--model"],
    effort: values["--effort"],
    writeMode: parseWriteMode(values["--write-mode"]),
    requestId: values["--request-id"] === undefined ? undefined : validateAgentId(values["--request-id"], "Request id"),
    ...(worktree ? { worktree: { branch: values["--branch"] } } : {}),
    wait,
    timeoutMs: values["--timeout"] === undefined ? undefined : parseAgentWaitTimeout(values["--timeout"]),
  };
}

function parseWriteMode(value: string | undefined): LocalAgentWriteMode | undefined {
  if (value === undefined) return undefined;
  const mode = WRITE_MODES.find((candidate) => candidate === value);

  if (!mode) throw new Error(`Invalid --write-mode ${value}. Use ${WRITE_MODES.join(", ")}.`);

  return mode;
}

export function parseAgentWaitTimeout(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) {
    throw new Error("Agent wait timeout must be a non-negative integer number of seconds.");
  }

  const timeoutMs = Number(value) * 1_000;

  if (!Number.isSafeInteger(timeoutMs) || timeoutMs > 2_147_483_647) {
    throw new Error("Agent wait timeout is too large.");
  }

  return timeoutMs;
}

function parseOptionValue(value: string | undefined, option: string): string {
  const trimmed = value?.trim();

  if (!trimmed) throw new Error(`Missing value for ${option}.`);

  if (trimmed.startsWith("-")) throw unknownOptionError(trimmed);

  return trimmed;
}

function unknownOptionError(option: string): Error {
  return new Error(`Unknown option: ${option}. Use -- before prompt text that starts with a dash.`);
}

export function resolveLocalAgentTarget(
  target: string,
  profiles: LocalAgentProfile[],
  modelOverride?: string,
  effortOverride?: string,
  providerConfigs: readonly SubagentProviderConfig[] = [],
): LocalAgentTarget | undefined {
  const profile = profiles.find((candidate) => candidate.name === target);

  if (profile) {
    const providerConfig = providerConfigs.find((entry) => entry.id === profile.provider);

    return {
      kind: "profile",
      name: profile.name,
      provider: profile.provider,
      model: modelOverride ?? profile.model ?? providerConfig?.model,
      effort: effortOverride ?? profile.effort ?? providerConfig?.effort,
      profile,
    };
  }

  const providerConfig = providerConfigs.find((entry) => entry.id === target);

  if (providerConfig) {
    return {
      kind: "provider",
      name: target,
      provider: target,
      model: modelOverride ?? providerConfig?.model,
      effort: effortOverride ?? providerConfig?.effort,
    };
  }

  return undefined;
}
