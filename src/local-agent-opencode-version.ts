import { createRequire } from "node:module";
import { terminateProcessTree } from "./process-platform.js";
import {
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
} from "./local-agent-errors.js";

const OPENCODE_VERSION_PROBE_TIMEOUT_MS = 4_000;
const require = createRequire(import.meta.url);

// SAFETY: The surrounding checks or construction already match this type.
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;

export type OpenCodeGeneration = "v1" | "v2";

export interface ProbedOpenCodeRuntime {
  generation: OpenCodeGeneration;
  version: string;
}

export type OpenCodeRuntimeProbeFunction = () => Promise<ProbedOpenCodeRuntime>;

const OPENCODE_V2_SESSION_PREFIX = "opencode:v2:";

/** The executable for the version probe, `opencode serve`, and availability; OPENCODE_COMMAND overrides it. */
export function resolveOpenCodeCommand(env: NodeJS.ProcessEnv): string {
  return env.OPENCODE_COMMAND?.trim() || "opencode";
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
    const child = spawn(resolveOpenCodeCommand(env), ["--version"], {
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
        // SAFETY: The surrounding checks or construction already match this type.
        message: (cause as NodeJS.ErrnoException).code === "ENOENT"
          ? "OpenCode executable is unavailable."
          : `OpenCode version probe failed to start: ${cause.message}`,
      }));
    });
    // `close` waits for stdout/stderr to drain; `exit` can fire before the version is read.
    child.once("close", (code) => {
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

const OPENCODE_MODELS_TIMEOUT_MS = 60_000;
const OPENCODE_MODELS_MAX_BYTES = 4 * 1024 * 1024;
const OPENCODE_MODELS_KILL_GRACE_MS = 2_000;

/** Runs `opencode models` through cross-spawn, so a Windows `.cmd` shim launches like the server does. */
export function runOpenCodeModels(env: NodeJS.ProcessEnv, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    // Its own process group, so a stop reaches anything `opencode models` started, not just the command itself.
    const detached = process.platform !== "win32";
    const child = spawn(resolveOpenCodeCommand(env), ["models"], { cwd, env, detached, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let bytes = 0;
    let settled = false;
    let stopError: Error | undefined;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.off("SIGINT", interrupt);
      process.off("SIGTERM", interrupt);

      if (error) reject(error);
      else resolve(stdout);
    };

    // A child that ignores SIGTERM is killed outright, and the command reports the failure only once the child is
    // gone (or, if it never closes, after the kill), so a stuck listing never outlives the command.
    const stop = (error: Error) => {
      if (stopError || settled) return;
      stopError = error;
      terminateProcessTree(child, "SIGTERM", detached);
      // Kept referenced: the escalation must run even if nothing else holds the process open.
      setTimeout(() => {
        terminateProcessTree(child, "SIGKILL", detached);
        setTimeout(() => finish(error), OPENCODE_MODELS_KILL_GRACE_MS);
      }, OPENCODE_MODELS_KILL_GRACE_MS);
    };

    // The listing has its own process group, so a terminal Ctrl-C does not reach it: forward it while it runs.
    const interrupt = (signal: NodeJS.Signals) => stop(new Error(`opencode models was interrupted by ${signal}.`));

    process.once("SIGINT", interrupt);
    process.once("SIGTERM", interrupt);

    const timer = setTimeout(() => {
      stop(new Error(`opencode models did not finish within ${OPENCODE_MODELS_TIMEOUT_MS / 1000}s.`));
    }, OPENCODE_MODELS_TIMEOUT_MS);

    const collect = (chunk: Buffer | string, into: "stdout" | "stderr") => {
      bytes += Buffer.byteLength(chunk);

      if (stopError) return;

      if (bytes > OPENCODE_MODELS_MAX_BYTES) {
        stop(new Error(`opencode models printed more than ${OPENCODE_MODELS_MAX_BYTES / 1024 / 1024} MiB.`));

        return;
      }

      if (into === "stdout") stdout += chunk.toString();
      else stderr += chunk.toString();
    };

    timer.unref();
    // Decode across chunk boundaries so a multibyte character split between chunks stays intact in model ids.
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: Buffer | string) => collect(chunk, "stdout"));
    child.stderr?.on("data", (chunk: Buffer | string) => collect(chunk, "stderr"));
    child.once("error", (cause) => finish(cause));
    // `close` waits for stdout/stderr to drain; `exit` can fire before the list is read.
    child.once("close", (code) => finish(
      stopError ?? (code === 0 ? undefined : new Error(stderr.trim() || `opencode models exited with code ${code ?? 1}.`)),
    ));
  });
}
