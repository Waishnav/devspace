import type { LocalAgentCatalog } from "./local-agent-catalog.js";
import type { LocalAgentTurnEvent } from "./local-agent-events.js";
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
  /** False when config sets `subagents.enabled: false`; no target is usable then. */
  enabled: boolean;
  targets: AgentTargetOutput[];
  /** Enabled providers that cannot run, with the reason. */
  unavailable: Array<{ name: string; reason: string }>;
}

export interface AgentReceiptOutput {
  id: string;
  status: AgentCommandStatus;
  turnId?: string;
  /** `--worktree` agents only: the isolated checkout the agent works in, and its branch. */
  worktree?: string;
  branch?: string;
}

export interface AgentSummaryOutput extends AgentReceiptOutput {
  target: string;
}

export interface AgentFailureOutput {
  code: string;
  message: string;
  retryable: boolean;
  /** The provider's own explanation, redacted and bounded. */
  detail?: string;
}

export interface AgentCommandErrorOutput {
  code: string;
  message: string;
  retryable?: boolean;
  agentId?: string;
}

export type AgentObservationOutput = { turnId?: string; worktree?: string; branch?: string } & (
  | { id: string; status: "running"; wait?: "timeout" }
  | { id: string; status: "completed"; response?: string }
  | { id: string; status: "failed"; error: AgentFailureOutput }
  | { id: string; status: "stopped"; error?: AgentFailureOutput }
);

/**
 * Process exit codes for `agents wait` and `--wait`. 1 is reserved for command errors
 * (usage, unknown target, daemon failure) and is set where those are reported.
 */
export const AGENT_EXIT_CODES = { completed: 0, failed: 2, stopped: 3, timeout: 4 } as const;

/** With several agents, the most severe outcome wins: failed, then stopped, then timeout. */
export function agentObservationExitCode(observations: readonly AgentObservationOutput[]): number {
  if (observations.some((entry) => entry.status === "failed")) return AGENT_EXIT_CODES.failed;

  if (observations.some((entry) => entry.status === "stopped")) return AGENT_EXIT_CODES.stopped;

  if (observations.some((entry) => entry.status === "running")) return AGENT_EXIT_CODES.timeout;

  return AGENT_EXIT_CODES.completed;
}

export function presentAgentTargetCatalog(catalog: LocalAgentCatalog): AgentTargetCatalogOutput {
  return {
    enabled: catalog.enabled,
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
    unavailable: catalog.enabled
      ? catalog.providers
        .filter((provider) => !provider.available)
        .map((provider) => ({ name: provider.id, reason: provider.reason ?? "provider preflight failed" }))
      : [],
  };
}

export function presentAgentReceipt(record: LocalAgentRecord): AgentReceiptOutput {
  return {
    id: record.id,
    status: presentAgentStatus(record.status),
    ...(record.latestTurnId ? { turnId: record.latestTurnId } : {}),
    ...(record.worktreePath ? { worktree: record.worktreePath } : {}),
    ...(record.branch ? { branch: record.branch } : {}),
  };
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
      return { ...receipt, status: "running" };
  }
}

export function formatAgentTargetCatalog(catalog: AgentTargetCatalogOutput): string {
  if (!catalog.enabled) {
    return "<disabled>Subagents are disabled by subagents.enabled in config.jsonc. Remove the subagents key to detect installed agents, or set enabled to true.</disabled>";
  }

  const unavailable = catalog.unavailable.map((provider) => (
    `<unavailable name="${escapeXmlAttribute(provider.name)}">${escapeXmlText(provider.reason)}</unavailable>`
  ));

  const targets = catalog.targets.map((target) => {
    const settings = xmlAttributes({ model: target.model, effort: target.effort });

    if (target.kind === "provider") {
      return `<provider name="${escapeXmlAttribute(target.name)}"${settings}/>`;
    }

    return `<profile name="${escapeXmlAttribute(target.name)}" provider="${escapeXmlAttribute(target.provider)}"${settings}>${escapeXmlText(target.description)}</profile>`;
  });

  return [...targets, ...unavailable].join("\n");
}

export function formatAgentReceipt(receipt: AgentReceiptOutput): string {
  return `<agent${agentAttributes(receipt)}/>`;
}

export function formatAgentSummary(summary: AgentSummaryOutput): string {
  return `<agent${agentAttributes(summary, { target: summary.target })}/>`;
}

export function formatAgentObservation(observation: AgentObservationOutput): string {
  if (observation.status === "running" && observation.wait) {
    return `<agent${agentAttributes(observation, { wait: observation.wait })}/>`;
  }

  if (observation.status === "completed" && observation.response !== undefined) {
    return `<agent${agentAttributes(observation)}>${escapeXmlText(observation.response)}</agent>`;
  }

  if ((observation.status === "failed" || observation.status === "stopped") && observation.error) {
    const { code, retryable, message, detail } = observation.error;
    const cause = detail ? `<cause>${escapeXmlText(detail)}</cause>` : "";

    return `<agent${agentAttributes(observation, { code, retryable: String(retryable) })}>${escapeXmlText(message)}${cause}</agent>`;
  }

  return formatAgentReceipt(observation);
}

export function formatAgentTurnEvent(event: LocalAgentTurnEvent): string {
  const base = { seq: String(event.seq), type: event.type, turn: event.turnId };

  switch (event.type) {
    case "turn_started":
      return `<event${xmlAttributes({ ...base, at: event.at })}/>`;
    case "message":
      return `<event${xmlAttributes(base)}>${escapeXmlText(event.text)}</event>`;
    case "tool_started":
    case "tool_completed": {
      const attributes = xmlAttributes({
        ...base,
        tool: event.tool,
        status: event.type === "tool_completed" ? event.status : undefined,
      });

      return event.summary
        ? `<event${attributes}>${escapeXmlText(event.summary)}</event>`
        : `<event${attributes}/>`;
    }

    case "turn_completed":
      return `<event${xmlAttributes({
        ...base,
        status: event.status,
        code: event.errorCode,
        dropped: event.droppedEvents === undefined ? undefined : String(event.droppedEvents),
        at: event.at,
      })}/>`;
  }
}

export function formatAgentCommandError(error: AgentCommandErrorOutput): string {
  const agentId = error.agentId ? ` agent-id="${escapeXmlAttribute(error.agentId)}"` : "";

  return `<error code="${escapeXmlAttribute(error.code)}" retryable="${error.retryable ?? false}"${agentId}>${escapeXmlText(error.message)}</error>`;
}

function agentAttributes(
  agent: { id: string; status: string; turnId?: string; worktree?: string; branch?: string },
  extra: Record<string, string | undefined> = {},
): string {
  return xmlAttributes({
    id: agent.id,
    status: agent.status,
    turn: agent.turnId,
    worktree: agent.worktree,
    branch: agent.branch,
    ...extra,
  });
}

function xmlAttributes(values: Record<string, string | undefined>): string {
  return Object.entries(values)
    .filter((entry): entry is [string, string] => entry[1] !== undefined)
    .map(([name, value]) => ` ${name}="${escapeXmlAttribute(value)}"`)
    .join("");
}

function escapeXmlAttribute(value: string): string {
  return escapeXml(value).replaceAll('"', "&quot;").replaceAll("'", "&apos;");
}

function escapeXmlText(value: string): string {
  return escapeXml(value);
}

function escapeXml(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "\uFFFD")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
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
    ...(record.errorDetail ? { detail: record.errorDetail } : {}),
  };
}
