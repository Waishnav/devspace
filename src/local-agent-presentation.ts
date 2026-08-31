import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import type { LocalAgentRecord, LocalAgentStatus } from "./local-agent-store.js";

export type AgentCommandStatus = "running" | "completed" | "failed" | "stopped";

export type AgentTargetOutput =
  | {
      name: string;
      kind: "provider";
      model?: string;
      effort?: string;
    }
  | {
      name: string;
      kind: "profile";
      provider: string;
      description: string;
      model?: string;
      effort?: string;
    };

export interface AgentTargetCatalogOutput {
  targets: AgentTargetOutput[];
}

export interface AgentReceiptOutput {
  id: string;
  status: AgentCommandStatus;
}

export interface AgentSummaryOutput extends AgentReceiptOutput {
  target: string;
}

export interface AgentFailureOutput {
  code: string;
  message: string;
  retryable: boolean;
}

export type AgentObservationOutput =
  | { id: string; status: "running" }
  | { id: string; status: "completed"; response?: string }
  | { id: string; status: "failed"; error: AgentFailureOutput }
  | { id: string; status: "stopped"; error?: AgentFailureOutput };

export function presentAgentTargetCatalog(catalog: LocalAgentCatalog): AgentTargetCatalogOutput {
  return {
    targets: [
      ...catalog.providers
        .filter((provider) => provider.usable)
        .map((provider): AgentTargetOutput => ({
          name: provider.id,
          kind: "provider",
          ...(provider.model ? { model: provider.model } : {}),
          ...(provider.effort ? { effort: provider.effort } : {}),
        })),
      ...catalog.profiles.map((profile): AgentTargetOutput => ({
        name: profile.name,
        kind: "profile",
        provider: profile.provider,
        description: profile.description,
        ...(profile.model ? { model: profile.model } : {}),
        ...(profile.effort ? { effort: profile.effort } : {}),
      })),
    ],
  };
}

export function presentAgentReceipt(record: LocalAgentRecord): AgentReceiptOutput {
  return { id: record.id, status: presentAgentStatus(record.status) };
}

export function presentAgentSummary(record: LocalAgentRecord): AgentSummaryOutput {
  return { ...presentAgentReceipt(record), target: record.profileName };
}

export function presentAgentObservation(record: LocalAgentRecord): AgentObservationOutput {
  const receipt = presentAgentReceipt(record);
  switch (receipt.status) {
    case "completed":
      return {
        ...receipt,
        status: "completed",
        ...(record.latestResponse === undefined ? {} : { response: record.latestResponse }),
      };
    case "failed":
      return { ...receipt, status: "failed", error: presentAgentFailure(record) };
    case "stopped":
      return {
        ...receipt,
        status: "stopped",
        ...(hasAgentFailure(record) ? { error: presentAgentFailure(record) } : {}),
      };
    case "running":
      return { id: receipt.id, status: "running" };
  }
}

export function formatAgentTargetCatalog(catalog: AgentTargetCatalogOutput): string {
  if (catalog.targets.length === 0) return "No usable subagent targets.";
  return catalog.targets.map((target) => {
    const settings = [
      target.model ? `model=${target.model}` : undefined,
      target.effort ? `effort=${target.effort}` : undefined,
    ].filter(Boolean).join(" ");
    if (target.kind === "provider") {
      return `${target.name} [provider]${settings ? ` ${settings}` : ""}`;
    }
    return `${target.name} [profile, ${target.provider}]${settings ? ` ${settings}` : ""} - ${target.description}`;
  }).join("\n");
}

export function formatAgentReceipt(receipt: AgentReceiptOutput): string {
  return `${receipt.id} ${receipt.status}`;
}

export function formatAgentSummary(summary: AgentSummaryOutput): string {
  return `${formatAgentReceipt(summary)} ${summary.target}`;
}

export function formatAgentObservation(observation: AgentObservationOutput): string {
  const line = formatAgentReceipt(observation);
  if (observation.status === "completed" && observation.response !== undefined) {
    return `${line}\n\n${observation.response}`;
  }
  if ((observation.status === "failed" || observation.status === "stopped") && observation.error) {
    const retryable = observation.error.retryable ? " [retryable]" : "";
    return `${line} ${observation.error.code}: ${observation.error.message}${retryable}`;
  }
  return line;
}

function presentAgentStatus(status: LocalAgentStatus): AgentCommandStatus {
  switch (status) {
    case "starting":
    case "running":
      return "running";
    case "idle":
      return "completed";
    case "error":
      return "failed";
    case "stopped":
      return "stopped";
  }
}

function hasAgentFailure(record: LocalAgentRecord): boolean {
  return record.error !== undefined || record.errorCode !== undefined || record.errorRetryable !== undefined;
}

function presentAgentFailure(record: LocalAgentRecord): AgentFailureOutput {
  return {
    code: record.errorCode ?? "AGENT_FAILED",
    message: record.error ?? "Subagent failed without an error message.",
    retryable: record.errorRetryable ?? false,
  };
}
