import { AgentProviderCancelledError } from "./local-agent-errors.js";
import type { LocalAgentDriverKind } from "./local-agent-provider.js";

export function localAgentCancelledError(
  provider: LocalAgentDriverKind,
  operation: string,
  cause?: unknown,
): AgentProviderCancelledError {
  return new AgentProviderCancelledError({
    code: "PROVIDER_CANCELLED",
    provider,
    operation,
    retryable: false,
    ...(cause === undefined ? {} : { cause }),
    message: `${provider} agent turn was stopped.`,
  });
}

export function bindLocalAgentAbort(
  signal: AbortSignal | undefined,
  interrupt: () => void | Promise<void>,
): () => void {
  if (!signal) return () => undefined;
  const onAbort = () => { void Promise.resolve(interrupt()).catch(() => undefined); };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}
