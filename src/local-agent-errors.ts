import { TaggedError } from "better-result";
import type { LocalAgentProvider } from "./local-agent-profiles.js";

export class ProviderUnavailableError extends TaggedError(
  "ProviderUnavailableError",
)<{
  provider: LocalAgentProvider;
  message: string;
}>() {
  constructor(provider: LocalAgentProvider, message?: string) {
    super({
      provider,
      message: message ?? `Agent provider is unavailable: ${provider}`,
    });
  }
}

export class ProviderSchemaUnsupportedError extends TaggedError(
  "ProviderSchemaUnsupportedError",
)<{
  provider: LocalAgentProvider;
  cause: unknown;
  message: string;
}>() {
  constructor(provider: LocalAgentProvider, cause: unknown) {
    super({
      provider,
      cause,
      message: `${provider} does not support the requested native output schema: ${errorMessage(cause)}`,
    });
  }
}

export class ProviderCancelledError extends TaggedError(
  "ProviderCancelledError",
)<{
  provider: LocalAgentProvider;
  cause: unknown;
  message: string;
}>() {
  constructor(provider: LocalAgentProvider, cause: unknown) {
    super({
      provider,
      cause,
      message: `Agent provider was cancelled: ${provider}`,
    });
  }
}

export class ProviderExecutionError extends TaggedError(
  "ProviderExecutionError",
)<{
  provider: LocalAgentProvider;
  retryable: boolean;
  cause: unknown;
  message: string;
}>() {
  constructor(input: {
    provider: LocalAgentProvider;
    cause: unknown;
    retryable?: boolean;
  }) {
    super({
      provider: input.provider,
      retryable: input.retryable ?? false,
      cause: input.cause,
      message: `${input.provider} agent execution failed: ${errorMessage(input.cause)}`,
    });
  }
}

export type AgentProviderError =
  | ProviderUnavailableError
  | ProviderSchemaUnsupportedError
  | ProviderCancelledError
  | ProviderExecutionError;

export function isAgentProviderError(error: unknown): error is AgentProviderError {
  return (
    ProviderUnavailableError.is(error) ||
    ProviderSchemaUnsupportedError.is(error) ||
    ProviderCancelledError.is(error) ||
    ProviderExecutionError.is(error)
  );
}

export function isProviderSchemaUnsupportedError(
  error: unknown,
): error is ProviderSchemaUnsupportedError {
  return ProviderSchemaUnsupportedError.is(error);
}

export function isNativeSchemaUnsupportedFailure(error: unknown): boolean {
  const message = errorMessage(error).toLowerCase();
  const mentionsSchema =
    /output[ _-]?schema/.test(message) ||
    /json[ _-]?schema/.test(message) ||
    /structured[ _-]?output/.test(message) ||
    /output[ _-]?format/.test(message);
  const unsupported =
    /not supported/.test(message) ||
    /unsupported/.test(message) ||
    /invalid (?:output|json )?schema/.test(message) ||
    /schema (?:is )?invalid/.test(message) ||
    /unknown (?:field|parameter|option)/.test(message) ||
    /not available/.test(message);
  return mentionsSchema && unsupported;
}

export function classifyAgentProviderError(
  provider: LocalAgentProvider,
  cause: unknown,
): AgentProviderError {
  if (isAgentProviderError(cause)) return cause;
  if (isCancellation(cause)) return new ProviderCancelledError(provider, cause);
  if (isNativeSchemaUnsupportedFailure(cause)) {
    return new ProviderSchemaUnsupportedError(provider, cause);
  }
  return new ProviderExecutionError({ provider, cause });
}

function isCancellation(error: unknown): boolean {
  return Boolean(
    error &&
      typeof error === "object" &&
      "name" in error &&
      String((error as { name?: unknown }).name) === "AbortError",
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
