import type { CardActiveWorkflowSummary, ToolResultCard } from "./card-types.js";
import { renderIcon, toolIcons } from "./icons.js";

export interface DashboardDisplayOptions {
  canFullscreen: boolean;
  fullscreen: boolean;
  onToggleFullscreen(): void;
}

export function renderWorkspaceDashboard(
  container: HTMLElement,
  card: ToolResultCard,
  display: DashboardDisplayOptions,
): void {
  const root = node("div", {
    className: `workspace-dashboard ${display.fullscreen ? "fullscreen" : "inline"}`,
  });
  const runs = card.activeWorkflows ?? [];

  root.append(
    renderDashboardToolbar("Workspace overview", display),
    ...(card.activeWorkflows !== undefined
      ? [renderWorkflowSummarySection(runs)]
      : []),
    renderAccordion(
      "Workspace",
      true,
      renderKeyValues([
        ["Root", card.root ?? card.path ?? "Unknown"],
        ["Workspace", card.workspaceId ?? "Unknown"],
        ["Mode", card.mode ?? stringValue(card.summary?.mode) ?? "checkout"],
        ...(card.sourceRoot ? [["Source root", card.sourceRoot] as [string, string]] : []),
        ...(card.worktree?.baseRef ? [["Base ref", card.worktree.baseRef] as [string, string]] : []),
        ...(card.worktree?.baseSha ? [["Base SHA", card.worktree.baseSha] as [string, string]] : []),
      ]),
    ),
    renderAccordion(
      `Loaded skills · ${card.skills?.length ?? 0}`,
      false,
      renderList(
        card.skills?.map((skill) => ({
          title: skill.name ?? "Unnamed skill",
          description: skill.description ?? skill.path,
          meta: skill.path,
        })) ?? [],
        "No skills loaded.",
      ),
    ),
    renderAccordion(
      `Project instructions · ${card.agentsFiles?.length ?? 0}`,
      false,
      renderList(
        card.agentsFiles?.map((file) => ({
          title: file.path ?? "AGENTS.md",
          description: summarizeText(file.content),
        })) ?? [],
        "No project instructions loaded.",
      ),
    ),
    renderAccordion(
      `Nested instructions · ${card.availableAgentsFiles?.length ?? 0}`,
      false,
      renderList(
        card.availableAgentsFiles?.map((file) => ({ title: file.path ?? "Unknown path" })) ?? [],
        "No nested instruction files discovered.",
      ),
    ),
    ...(card.agentProviders !== undefined
      ? [renderAccordion(
          `Agent providers · ${card.agentProviders.length}`,
          false,
          renderProviderList(card),
        )]
      : []),
    ...(card.agents !== undefined
      ? [renderAccordion(
          `Agent profiles · ${card.agents.length}`,
          false,
          renderList(
            card.agents.map((agent) => ({
              title: agent.name ?? "Unnamed profile",
              description: agent.description,
            })),
            "No agent profiles loaded.",
          ),
        )]
      : []),
    renderAccordion(
      "Model handoff",
      false,
      node("div", { className: "workspace-handoff", text: card.instruction ?? "No handoff instruction." }),
    ),
  );

  container.replaceChildren(root);
}

function renderDashboardToolbar(
  title: string,
  display: DashboardDisplayOptions,
): HTMLElement {
  const toolbar = node("div", { className: "dashboard-toolbar" });
  toolbar.append(node("strong", { text: title }));
  if (display.canFullscreen || display.fullscreen) {
    const button = node("button", {
      className: "display-mode-button",
      type: "button",
      text: display.fullscreen ? "Exit fullscreen" : "Open dashboard",
    });
    button.prepend(renderIcon(display.fullscreen ? toolIcons.minimize : toolIcons.maximize));
    button.addEventListener("click", display.onToggleFullscreen);
    toolbar.append(button);
  }
  return toolbar;
}

function renderWorkflowSummarySection(
  runs: CardActiveWorkflowSummary[],
): HTMLElement {
  const section = node("section", { className: "active-workflows" });
  section.append(node("h3", { text: `Active workflows · ${runs.length}` }));
  if (runs.length === 0) {
    section.append(node("div", { className: "dashboard-empty", text: "No active workflows." }));
    return section;
  }
  for (const run of runs) {
    const summary = workflowSummaryText(run);
    const row = node("div", { className: "active-workflow-row" });
    row.append(
      node("span", { className: `workflow-status-dot ${summary.status}`, ariaHidden: "true" }),
      node("div", { className: "active-workflow-copy" }, [
        node("strong", { text: summary.name }),
        node("span", {
          text: `${summary.status} · ${summary.calls}`,
        }),
      ]),
    );
    section.append(row);
  }
  return section;
}

function renderAccordion(title: string, open: boolean, content: HTMLElement): HTMLElement {
  const details = node("details", { className: "workspace-accordion" }) as HTMLDetailsElement;
  details.open = open;
  details.append(node("summary", { text: title }), content);
  return details;
}

function renderKeyValues(entries: Array<[string, string]>): HTMLElement {
  const list = node("dl", { className: "workspace-key-values" });
  for (const [label, value] of entries) {
    list.append(node("dt", { text: label }), node("dd", { text: value, title: value }));
  }
  return list;
}

function renderProviderList(card: ToolResultCard): HTMLElement {
  return renderList(
    card.agentProviders?.map((provider) => ({ title: provider })) ?? [],
    "No subagent providers exposed.",
  );
}

function renderList(
  items: Array<{ title: string; description?: string; meta?: string }>,
  emptyText: string,
): HTMLElement {
  const list = node("div", { className: "workspace-list" });
  if (items.length === 0) {
    list.append(node("div", { className: "dashboard-empty", text: emptyText }));
    return list;
  }
  for (const item of items) {
    list.append(
      node("div", { className: "workspace-list-row" }, [
        node("strong", { text: item.title }),
        item.description ? node("span", { text: item.description }) : undefined,
        item.meta ? node("code", { text: item.meta, title: item.meta }) : undefined,
      ].filter((child): child is HTMLElement => Boolean(child))),
    );
  }
  return list;
}

function summaryCounts(calls: CardActiveWorkflowSummary["calls"]): string {
  const parts = [
    calls?.completed ? `${calls.completed} done` : undefined,
    calls?.running ? `${calls.running} running` : undefined,
    calls?.failed ? `${calls.failed} failed` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.join(" · ") || "no calls yet";
}

export function workflowSummaryText(run: CardActiveWorkflowSummary): {
  name: string;
  status: string;
  calls: string;
} {
  return {
    name: run.name ?? "Unnamed workflow",
    status: run.status ?? "unknown",
    calls: summaryCounts(run.calls),
  };
}

function summarizeText(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > 140 ? `${compact.slice(0, 139)}…` : compact;
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function node<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  options: {
    className?: string;
    text?: string;
    type?: string;
    title?: string;
    ariaHidden?: string;
  } = {},
  children: HTMLElement[] = [],
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tag);
  if (options.className) element.className = options.className;
  if (options.text !== undefined) element.textContent = options.text;
  if (options.type !== undefined) element.setAttribute("type", options.type);
  if (options.title !== undefined) element.title = options.title;
  if (options.ariaHidden !== undefined) element.setAttribute("aria-hidden", options.ariaHidden);
  element.append(...children);
  return element;
}
