import { createRequire } from "node:module";
import {
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
} from "./local-agent-errors.js";

const OPENCODE_VERSION_PROBE_TIMEOUT_MS = 4_000;
const require = createRequire(import.meta.url);
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;

export type OpenCodeGeneration = "v1" | "v2";

export interface ProbedOpenCodeRuntime {
  generation: OpenCodeGeneration;
  version: string;
}

export type OpenCodeRuntimeProbeFunction = () => Promise<ProbedOpenCodeRuntime>;

const OPENCODE_V2_SESSION_PREFIX = "opencode:v2:";

export class OpenCodeRuntimeProbe {
  private lastSuccessfulProbe?: ProbedOpenCodeRuntime;

  constructor(private readonly probe: OpenCodeRuntimeProbeFunction) {}

  async get(): Promise<ProbedOpenCodeRuntime> {
    if (this.lastSuccessfulProbe) return this.lastSuccessfulProbe;
    return this.refresh();
  }

  async refresh(): Promise<ProbedOpenCodeRuntime> {
    const result = await this.probe();
    this.lastSuccessfulProbe = result;
    return result;
  }

  lastSuccess(): ProbedOpenCodeRuntime | undefined {
    return this.lastSuccessfulProbe;
  }
}

export function createOpenCodeRuntimeProbe(
  env: NodeJS.ProcessEnv = process.env,
): OpenCodeRuntimeProbe {
  return new OpenCodeRuntimeProbe(() => probeOpenCodeBinary(env));
}

export function classifyOpenCodeCliVersion(output: string): ProbedOpenCodeRuntime | undefined {
  const match = output.trim().match(/(?:^|\s)v?((\d+)\.\d+\.\d+(?:[-+][^\s]+)?)(?:$|\s)/);
  if (!match?.[1] || !match[2]) return undefined;
  const major = Number(match[2]);
  const version = match[1];
  return {
    generation: major >= 2 ? "v2" : "v1",
    version,
  };
}

export function encodeOpenCodeV2SessionId(nativeSessionId: string): string {
  return `${OPENCODE_V2_SESSION_PREFIX}${nativeSessionId}`;
}

export function requireOpenCodeV2NativeSessionId(providerSessionId: string): string {
  if (providerSessionId.startsWith(OPENCODE_V2_SESSION_PREFIX)) {
    const nativeSessionId = providerSessionId.slice(OPENCODE_V2_SESSION_PREFIX.length);
    if (nativeSessionId) return nativeSessionId;
  }
  throw incompatibleOpenCodeSession("v2", providerSessionId);
}

export function requireOpenCodeV1NativeSessionId(providerSessionId: string): string {
  if (!providerSessionId.startsWith(OPENCODE_V2_SESSION_PREFIX)) return providerSessionId;
  throw incompatibleOpenCodeSession("v1", providerSessionId);
}

function incompatibleOpenCodeSession(
  generation: OpenCodeGeneration,
  providerSessionId: string,
): AgentProviderProtocolError {
  return new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "opencode",
    operation: "resume_session",
    retryable: false,
    message: `OpenCode ${generation} cannot resume session ${providerSessionId}; the session belongs to a different OpenCode protocol generation. Start a new agent after changing OpenCode major versions.`,
  });
}

export async function probeOpenCodeBinary(
  env: NodeJS.ProcessEnv = process.env,
): Promise<ProbedOpenCodeRuntime> {
  const output = await runOpenCodeVersion(env);
  const result = classifyOpenCodeCliVersion(output);
  if (result) return result;
  throw new AgentProviderProtocolError({
    code: "PROVIDER_PROTOCOL_ERROR",
    provider: "opencode",
    operation: "probe_version",
    retryable: false,
    message: "Unable to determine the installed OpenCode version from `opencode --version`.",
  });
}

function runOpenCodeVersion(env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("opencode", ["--version"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let output = "";
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill("SIGTERM");
      reject(new AgentProviderUnavailableError({
        code: "PROVIDER_UNAVAILABLE",
        provider: "opencode",
        operation: "probe_version",
        retryable: true,
        message: `OpenCode version probe timed out after ${OPENCODE_VERSION_PROBE_TIMEOUT_MS}ms.`,
      }));
    }, OPENCODE_VERSION_PROBE_TIMEOUT_MS);
    timer.unref();
    child.stdout?.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
    child.stderr?.on("data", (chunk: Buffer | string) => { output += chunk.toString(); });
    child.once("error", (cause) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(new AgentProviderUnavailableError({
        code: "PROVIDER_UNAVAILABLE",
        provider: "opencode",
        operation: "probe_version",
        retryable: true,
        cause,
        message: "OpenCode executable is unavailable.",
      }));
    });
    child.once("exit", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (code === 0) resolve(output);
      else reject(new AgentProviderUnavailableError({
        code: "PROVIDER_UNAVAILABLE",
        provider: "opencode",
        operation: "probe_version",
        retryable: true,
        message: `OpenCode version probe exited with code ${code}${output.trim() ? `: ${output.trim()}` : "."}`,
      }));
    });
  });
}
