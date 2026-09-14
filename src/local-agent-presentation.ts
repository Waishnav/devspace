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

export interface AgentCommandErrorOutput {
  code: string;
  message: string;
  retryable?: boolean;
  agentId?: string;
}

export type AgentObservationOutput =
  | { id: string; status: "running"; wait?: "timeout" }
  | { id: string; status: "completed"; response?: string }
  | { id: string; status: "failed"; error: AgentFailureOutput }
  | { id: string; status: "stopped"; error?: AgentFailureOutput };

export function presentAgentTargetCatalog(catalog: LocalAgentCatalog): AgentTargetCatalogOutput {
  return {
    targets: [
      ...catalog.providers.flatMap((provider): AgentTargetOutput[] => {
        if (!provider.usable) return [];

        const target: AgentTargetOutput = {
          name: provider.id,
          kind: "provider",
        };

        if (provider.model) target.model = provider.model;

        if (provider.effort) target.effort = provider.effort;

        return [target];
      }),
      ...catalog.profiles.map((profile): AgentTargetOutput => {
        const target: AgentTargetOutput = {
          name: profile.name,
          kind: "profile",
          provider: profile.provider,
          description: profile.description,
        };

        if (profile.model) target.model = profile.model;

        if (profile.effort) target.effort = profile.effort;

        return target;
      }),
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
      if (record.latestResponse === undefined) {
        return { id: receipt.id, status: "completed" };
      }

      return {
        id: receipt.id,
        status: "completed",
        response: record.latestResponse,
      };
    case "failed":
      return { ...receipt, status: "failed", error: presentAgentFailure(record) };
    case "stopped":
      if (!hasAgentFailure(record)) {
        return { id: receipt.id, status: "stopped" };
      }

      return {
        id: receipt.id,
        status: "stopped",
        error: presentAgentFailure(record),
      };
    case "running":
      return { id: receipt.id, status: "running" };
  }
}

export function formatAgentTargetCatalog(catalog: AgentTargetCatalogOutput): string {
  return catalog.targets.map((target) => {
    const settings = xmlAttributes({ model: target.model, effort: target.effort });

    if (target.kind === "provider") {
      return `<provider name="${escapeXmlAttribute(target.name)}"${settings}/>`;
    }

    return `<profile name="${escapeXmlAttribute(target.name)}" provider="${escapeXmlAttribute(target.provider)}"${settings}>${escapeXmlText(target.description)}</profile>`;
  }).join("\n");
}

export function formatAgentReceipt(receipt: AgentReceiptOutput): string {
  return `<agent id="${escapeXmlAttribute(receipt.id)}" status="${receipt.status}"/>`;
}

export function formatAgentSummary(summary: AgentSummaryOutput): string {
  return `<agent id="${escapeXmlAttribute(summary.id)}" status="${summary.status}" target="${escapeXmlAttribute(summary.target)}"/>`;
}

export function formatAgentObservation(observation: AgentObservationOutput): string {
  if (observation.status === "running" && observation.wait) {
    return `<agent id="${escapeXmlAttribute(observation.id)}" status="running" wait="${observation.wait}"/>`;
  }

  if (observation.status === "completed" && observation.response !== undefined) {
    return `<agent id="${escapeXmlAttribute(observation.id)}" status="completed">${escapeXmlText(observation.response)}</agent>`;
  }

  if ((observation.status === "failed" || observation.status === "stopped") && observation.error) {
    return `<agent id="${escapeXmlAttribute(observation.id)}" status="${observation.status}" code="${escapeXmlAttribute(observation.error.code)}" retryable="${observation.error.retryable}">${escapeXmlText(observation.error.message)}</agent>`;
  }

  return formatAgentReceipt(observation);
}

export function formatAgentCommandError(error: AgentCommandErrorOutput): string {
  const agentId = error.agentId ? ` agent-id="${escapeXmlAttribute(error.agentId)}"` : "";

  return `<error code="${escapeXmlAttribute(error.code)}" retryable="${error.retryable ?? false}"${agentId}>${escapeXmlText(error.message)}</error>`;
}

function xmlAttributes(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .flatMap(([name, value]) => value === undefined
      ? []
      : [` ${name}="${escapeXmlAttribute(value)}"`])
    .join("");
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeXmlText(value: string): string {
  return escapeXml(value);
}

function escapeXml(value: string): string {
  return replaceInvalidXmlCharacters(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function replaceInvalidXmlCharacters(value: string): string {
  let sanitized = "";

  for (const character of value) {
    const codePoint = character.codePointAt(0);
    sanitized += codePoint !== undefined && isInvalidXmlCodePoint(codePoint)
      ? "\uFFFD"
      : character;
  }

  return sanitized;
}

function isInvalidXmlCodePoint(codePoint: number): boolean {
  return codePoint <= 0x08
    || codePoint === 0x0B
    || codePoint === 0x0C
    || (codePoint >= 0x0E && codePoint <= 0x1F)
    || codePoint === 0xFFFE
    || codePoint === 0xFFFF;
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
