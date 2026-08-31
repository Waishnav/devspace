import type { AgentCacheKeyInput, WorkflowAgentCallRecord } from "./workflow-types.js";
import type {
  WorkflowReplay,
  WorkflowReplayDecision,
  WorkflowReplayHit,
} from "./workflow-api.js";
import { parseJsonText } from "./json-types.js";

/**
 * Deterministic prefix replay inspired by Claude Code dynamic workflows.
 * Calls are reused only while the new execution matches the prior execution at
 * the same call index. The first mismatch closes replay for the remainder of
 * the run, even when a later cache key happens to match.
 */
export function createWorkflowReplay(
  priorCalls: WorkflowAgentCallRecord[],
): WorkflowReplay {
  const byIndex = new Map(priorCalls.map((call) => [call.callIndex, call]));
  let prefixOpen = true;

  return {
    decide(
      callIndex: number,
      cacheKey: string,
      input: AgentCacheKeyInput,
    ): WorkflowReplayDecision {
      if (!prefixOpen) return { miss: { reason: "prefix_diverged" } };

      const prior = byIndex.get(callIndex);
      if (!prior) return close({ miss: { reason: "no_compatible_call" } });
      if (prior.status !== "completed" && prior.status !== "from_cache") {
        return close({ miss: { reason: "prior_call_not_replayable" } });
      }
      if (prior.isolation === "worktree") {
        return close({ miss: { reason: "worktree_not_restored" } });
      }
      if (prior.cacheKey !== cacheKey) {
        return close({
          miss: {
            reason: "identity_changed",
            changedFields: changedIdentityFields(prior, input),
          },
        });
      }
      if (!prior.returnValueJson) {
        return close({ miss: { reason: "result_not_persisted" } });
      }

      try {
        return {
          hit: toHit(prior, parseJsonText(prior.returnValueJson)),
        };
      } catch {
        return close({ miss: { reason: "stored_result_invalid" } });
      }
    },
  };

  function close(decision: WorkflowReplayDecision): WorkflowReplayDecision {
    prefixOpen = false;
    return decision;
  }
}

function toHit(
  call: WorkflowAgentCallRecord,
  value: WorkflowReplayHit["value"],
): WorkflowReplayHit {
  return {
    value,
    responseText: call.responseText,
    structuredJson: call.structuredJson,
    returnValueJson: call.returnValueJson!,
    providerSessionId: call.providerSessionId,
    replayMatch: "same_index",
    replayedFromRunId: call.runId,
    replayedFromCallIndex: call.callIndex,
  };
}

function changedIdentityFields(
  prior: WorkflowAgentCallRecord,
  current: AgentCacheKeyInput,
): Array<keyof AgentCacheKeyInput> {
  const changed: Array<keyof AgentCacheKeyInput> = [];
  if (prior.prompt !== current.prompt) changed.push("prompt");
  if ((prior.profileName ?? null) !== current.profileName) changed.push("profileName");
  if ((prior.profileFingerprint ?? null) !== current.profileFingerprint) {
    changed.push("profileFingerprint");
  }
  if (prior.provider !== current.provider) changed.push("provider");
  if ((prior.model ?? null) !== current.model) changed.push("model");
  if ((prior.effort ?? null) !== current.effort) changed.push("effort");
  if (!schemasMatch(prior.schemaJson, current.schema)) changed.push("schema");
  if (prior.isolation !== current.isolation) changed.push("isolation");
  return changed.length > 0 ? changed : ["prompt"];
}

function schemasMatch(
  priorSchemaJson: string | undefined,
  currentSchema: AgentCacheKeyInput["schema"],
): boolean {
  try {
    const prior = priorSchemaJson ? JSON.stringify(parseJsonText(priorSchemaJson)) : null;
    const current = currentSchema === null ? null : JSON.stringify(currentSchema);
    return prior === current;
  } catch {
    return false;
  }
}
