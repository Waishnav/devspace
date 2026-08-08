import { resolve } from "node:path";
import { emitKeypressEvents } from "node:readline";
import type { ServerConfig } from "./config.js";
import { createWorkflowStore } from "./workflow-store.js";
import {
  ACTIVE_WORKFLOW_STATUSES,
  loadWorkflowProjectView,
  type WorkflowCallView,
  type WorkflowPhaseView,
  type WorkflowProjectView,
  type WorkflowRunView,
} from "./workflow-view.js";

const REFRESH_MS = 750;
type TuiFocus = "runs" | "phases" | "calls" | "inspector";

export interface WorkflowTuiSelection {
  runIndex: number;
  phaseIndex: number;
  callIndex: number;
  focus: TuiFocus;
}

export async function runWorkflowTui(
  args: string[],
  config: ServerConfig,
): Promise<void> {
  const requestedRunId = args.find((arg) => !arg.startsWith("-"));
  const workspaceRoot = resolveWorkflowTuiWorkspaceRoot();
  const store = createWorkflowStore(config);

  const load = (): WorkflowProjectView =>
    loadWorkflowProjectView(store, workspaceRoot, {
      statuses: requestedRunId ? undefined : [...ACTIVE_WORKFLOW_STATUSES],
      limit: 50,
      eventLimit: 100,
      observationLimit: 100,
    });

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    try {
      const view = load();
      const selection = createSelection(view, findInitialSelection(view, requestedRunId));
      process.stdout.write(
        `${renderWorkflowTui(view, selection.runIndex, 100, 40, { ansi: false, selection })}\n`,
      );
      return;
    } finally {
      store.close();
    }
  }

  let project = load();
  let selection = createSelection(project, findInitialSelection(project, requestedRunId));
  let closed = false;
  let rendering = false;

  const render = (): void => {
    if (rendering || closed) return;
    rendering = true;
    try {
      project = load();
      selection = reconcileSelection(project, selection, requestedRunId);
      process.stdout.write(
        `\u001b[H\u001b[2J${renderWorkflowTui(
          project,
          selection.runIndex,
          process.stdout.columns || 100,
          process.stdout.rows || 40,
          { ansi: true, selection },
        )}`,
      );
    } finally {
      rendering = false;
    }
  };

  await new Promise<void>((done) => {
    let timer: NodeJS.Timeout;

    const finish = (): void => {
      if (closed) return;
      closed = true;
      clearInterval(timer);
      process.stdin.off("keypress", onKeypress);
      process.stdout.off("resize", render);
      process.off("SIGINT", finish);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\u001b[?25h\u001b[?1049l");
      store.close();
      done();
    };

    const onKeypress = (
      _input: string,
      key: { name?: string; ctrl?: boolean; shift?: boolean },
    ): void => {
      if ((key.ctrl && key.name === "c") || key.name === "q") {
        finish();
        return;
      }
      if (key.name === "escape") {
        if (selection.focus === "inspector") selection.focus = "calls";
        else if (selection.focus === "calls") selection.focus = "phases";
        else if (selection.focus === "phases") selection.focus = "runs";
        else finish();
        render();
        return;
      }
      if (key.name === "tab") {
        selection.focus = nextFocus(selection.focus);
        render();
        return;
      }
      if (key.name === "up" || key.name === "k") {
        moveSelection(project, selection, -1);
        render();
      } else if (key.name === "down" || key.name === "j") {
        moveSelection(project, selection, 1);
        render();
      } else if (key.name === "right" || key.name === "l" || key.name === "return") {
        selection.focus = selection.focus === "runs"
          ? "phases"
          : selection.focus === "phases"
            ? "calls"
            : selection.focus === "calls"
              ? "inspector"
              : "inspector";
        render();
      } else if (key.name === "left" || key.name === "h") {
        selection.focus = selection.focus === "inspector"
          ? "calls"
          : selection.focus === "calls"
            ? "phases"
            : selection.focus === "phases"
              ? "runs"
              : "runs";
        render();
      }
    };

    emitKeypressEvents(process.stdin);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.on("keypress", onKeypress);
    process.stdout.on("resize", render);
    process.on("SIGINT", finish);
    process.stdout.write("\u001b[?1049h\u001b[?25l");
    timer = setInterval(render, REFRESH_MS);
    render();
  });
}

export function resolveWorkflowTuiWorkspaceRoot(cwd = process.cwd()): string {
  return resolve(cwd);
}

export function renderWorkflowTui(
  project: WorkflowProjectView,
  selectedIndex: number,
  columns: number,
  rows: number,
  options: { ansi?: boolean; selection?: WorkflowTuiSelection } = {},
): string {
  const ansi = options.ansi !== false;
  const width = Math.max(56, columns);
  const selection = options.selection ?? createSelection(project, selectedIndex);
  const selected = project.runs[selection.runIndex];
  const lines: string[] = [];

  lines.push(style(truncate(`DevSpace workflows · ${project.workspaceRoot}`, width), "bold", ansi));
  lines.push(rule(width));

  if (project.runs.length === 0) {
    lines.push("No active workflows in the current directory.");
    lines.push("");
    lines.push(style("q quit", "muted", ansi));
    return fitRows(lines, rows).join("\n");
  }

  const maxRunRows = Math.max(3, Math.min(7, Math.floor(rows / 5)));
  lines.push(style("Workflows", "heading", ansi));
  for (const [index, run] of project.runs.slice(0, maxRunRows).entries()) {
    const marker = index === selection.runIndex ? "›" : " ";
    const phase = run.currentPhase ? ` · ${run.currentPhase}` : "";
    lines.push(
      truncate(
        `${marker} ${statusGlyph(run.status)} ${run.name}${phase} · ${callSummary(run)} · ${durationLabel(run.startedAt, run.completedAt)}`,
        width,
      ),
    );
  }
  if (project.runs.length > maxRunRows) {
    lines.push(style(`  +${project.runs.length - maxRunRows} more`, "muted", ansi));
  }

  lines.push(rule(width));
  if (selected) {
    if (selection.focus === "inspector") {
      renderCallInspector(lines, selected, selection, width, rows, ansi);
    } else {
      renderNavigator(lines, selected, selection, width, rows, ansi);
    }
  }
  lines.push(rule(width));
  lines.push(style("↑/↓ move · ←/→ or enter drill in · tab focus · esc back · q quit · refreshes automatically", "muted", ansi));
  return fitRows(lines, rows).join("\n");
}

function renderNavigator(
  lines: string[],
  run: WorkflowRunView,
  selection: WorkflowTuiSelection,
  width: number,
  rows: number,
  ansi: boolean,
): void {
  lines.push(
    truncate(
      `${run.name}  ${statusGlyph(run.status)} ${run.status} · ${callSummary(run)} · ${usageLabel(run.usage)} · ${durationLabel(run.startedAt, run.completedAt)}`,
      width,
    ),
  );
  if (run.error) lines.push(style(truncate(`${run.errorKind ?? "error"}: ${run.error}`, width), "error", ansi));

  const phase = selectedPhase(run, selection.phaseIndex);
  lines.push(style("\nNavigator · phases", "heading", ansi));
  if (run.phases.length === 0) {
    lines.push(style("  No phase markers yet.", "muted", ansi));
  } else {
    for (const [index, item] of run.phases.entries()) {
      const marker = index === selection.phaseIndex ? "›" : " ";
      lines.push(
        truncate(
          `${marker} ${phaseGlyph(item.status)} ${item.title} · ${item.calls.length} calls · ${usageLabel(item.usage)} · ${durationLabel(item.startedAt, item.completedAt)}`,
          width,
        ),
      );
    }
  }

  if (phase) {
    lines.push(style(`\n${phase.title} · ${phase.status}`, "heading", ansi));
    const calls = phase.calls;
    if (calls.length === 0) lines.push(style("  No agent calls in this phase.", "muted", ansi));
    for (const [index, call] of calls.entries()) {
      const marker = index === selection.callIndex && (selection.focus === "calls" || selection.focus === "phases") ? "›" : " ";
      lines.push(truncate(formatCall(call, marker), width));
    }
    renderActivityPreview(lines, calls, selection.callIndex, width, ansi);
  } else if (run.unphasedCalls.length > 0) {
    lines.push(style("\nOther calls", "heading", ansi));
    for (const call of run.unphasedCalls) lines.push(truncate(formatCall(call, " "), width));
  }

  if (run.recentActivity.length > 0 && rows > 18) {
    lines.push(style("\nRun activity", "heading", ansi));
    for (const event of run.recentActivity.slice(-3)) {
      const label = event.label ?? event.phase ?? event.type.replaceAll("_", " ");
      lines.push(truncate(`${shortTime(event.createdAt)}  ${label}${event.detail ? ` · ${event.detail}` : ""}`, width));
    }
  }
}

function renderCallInspector(
  lines: string[],
  run: WorkflowRunView,
  selection: WorkflowTuiSelection,
  width: number,
  rows: number,
  ansi: boolean,
): void {
  const call = selectedCall(run, selection.phaseIndex, selection.callIndex);
  if (!call) {
    lines.push(style("Call inspector · no call selected", "heading", ansi));
    return;
  }
  const label = call.label ?? `Agent #${call.callIndex}`;
  const target = call.model ? `${call.provider}/${call.model}` : call.provider;
  lines.push(style(`Call inspector · ${label}`, "heading", ansi));
  lines.push(truncate(`${statusGlyph(call.status)} ${target} · ${usageLabel(call.finalUsage ?? call.usage)} · ${durationLabel(call.startedAt, call.completedAt)}`, width));
  lines.push(truncate(`phase ${call.phase ?? "unphased"} · ${call.isolation}${call.profileName ? ` · profile ${call.profileName}` : ""}${call.providerSessionId ? ` · session ${call.providerSessionId}` : ""}`, width));
  lines.push(style("\nPrompt", "heading", ansi));
  lines.push(truncate(call.prompt, width));

  lines.push(style("\nActivity", "heading", ansi));
  const activity = call.observations.filter((entry) => entry.kind === "activity");
  if (activity.length === 0) lines.push(style("  No provider activity reported yet.", "muted", ansi));
  for (const entry of activity.slice(-Math.max(3, rows - 17))) {
    const tool = entry.toolName ? `${entry.toolName}${entry.toolStatus ? ` · ${entry.toolStatus}` : ""}` : "agent";
    const detail = entry.message ?? entry.detail;
    lines.push(truncate(`${shortTime(entry.createdAt)}  ${activityGlyph(entry.toolStatus)} ${tool}${detail ? ` · ${detail}` : ""}`, width));
  }

  if (call.error) lines.push(style(`\n${call.errorKind ?? "error"}: ${call.error}`, "error", ansi));
  if (call.responseText) {
    lines.push(style("\nResult", "heading", ansi));
    for (const line of call.responseText.split(/\r?\n/).slice(0, Math.max(2, rows - lines.length - 3))) {
      lines.push(truncate(line, width));
    }
  }
}

function renderActivityPreview(
  lines: string[],
  calls: WorkflowCallView[],
  selectedCallIndex: number,
  width: number,
  ansi: boolean,
): void {
  const call = calls[selectedCallIndex];
  if (!call) return;
  const activity = call.observations.filter((entry) => entry.kind === "activity").slice(-2);
  if (activity.length === 0) return;
  lines.push(style("\nSelected call activity", "heading", ansi));
  for (const entry of activity) {
    lines.push(truncate(`${shortTime(entry.createdAt)}  ${activityGlyph(entry.toolStatus)} ${entry.toolName ?? "agent"}${entry.message ? ` · ${entry.message}` : ""}`, width));
  }
}

function createSelection(project: WorkflowProjectView, runIndex: number): WorkflowTuiSelection {
  return {
    runIndex,
    phaseIndex: 0,
    callIndex: 0,
    focus: "runs",
  };
}

function reconcileSelection(
  project: WorkflowProjectView,
  selection: WorkflowTuiSelection,
  requestedRunId: string | undefined,
): WorkflowTuiSelection {
  const runIndex = requestedRunId
    ? findInitialSelection(project, requestedRunId)
    : Math.min(Math.max(0, selection.runIndex), Math.max(0, project.runs.length - 1));
  const run = project.runs[runIndex];
  const phaseIndex = run
    ? Math.min(Math.max(0, selection.phaseIndex), Math.max(0, run.phases.length - 1))
    : 0;
  const phase = run?.phases[phaseIndex];
  const callIndex = phase
    ? Math.min(Math.max(0, selection.callIndex), Math.max(0, phase.calls.length - 1))
    : 0;
  return { ...selection, runIndex, phaseIndex, callIndex };
}

function moveSelection(project: WorkflowProjectView, selection: WorkflowTuiSelection, delta: number): void {
  const run = project.runs[selection.runIndex];
  if (selection.focus === "runs") {
    selection.runIndex = Math.min(Math.max(0, selection.runIndex + delta), Math.max(0, project.runs.length - 1));
    selection.phaseIndex = 0;
    selection.callIndex = 0;
    return;
  }
  if (selection.focus === "phases") {
    selection.phaseIndex = Math.min(Math.max(0, selection.phaseIndex + delta), Math.max(0, (run?.phases.length ?? 1) - 1));
    selection.callIndex = 0;
    return;
  }
  const phase = run?.phases[selection.phaseIndex];
  selection.callIndex = Math.min(Math.max(0, selection.callIndex + delta), Math.max(0, (phase?.calls.length ?? 1) - 1));
}

function nextFocus(focus: TuiFocus): TuiFocus {
  if (focus === "runs") return "phases";
  if (focus === "phases") return "calls";
  if (focus === "calls") return "inspector";
  return "runs";
}

function findInitialSelection(project: WorkflowProjectView, requestedRunId: string | undefined): number {
  if (!requestedRunId) return 0;
  const index = project.runs.findIndex((run) => run.id === requestedRunId);
  if (index < 0) {
    throw new Error(`Workflow ${requestedRunId} does not belong to the current directory: ${project.workspaceRoot}`);
  }
  return index;
}

function selectedPhase(run: WorkflowRunView, index: number): WorkflowPhaseView | undefined {
  return run.phases[Math.min(Math.max(0, index), Math.max(0, run.phases.length - 1))];
}

function selectedCall(run: WorkflowRunView, phaseIndex: number, callIndex: number): WorkflowCallView | undefined {
  return selectedPhase(run, phaseIndex)?.calls[callIndex];
}

function formatCall(call: WorkflowCallView, marker: string): string {
  const label = call.label ?? `Agent #${call.callIndex}`;
  const provider = call.model ? `${call.provider}/${call.model}` : call.provider;
  const worktree = call.isolation === "worktree" ? " · worktree" : "";
  const replay = call.fromCache ? " · replayed" : "";
  const error = call.error ? ` · ${call.errorKind ?? "error"}: ${call.error}` : "";
  return `${marker} ${statusGlyph(call.status)} #${call.callIndex} ${label}  ${provider}${worktree}${replay} · ${usageLabel(call.finalUsage ?? call.usage)} · ${durationLabel(call.startedAt, call.completedAt)}${error}`;
}

function callSummary(run: WorkflowRunView): string {
  const parts = [
    run.calls.completed ? `${run.calls.completed} done` : undefined,
    run.calls.cached ? `${run.calls.cached} replayed` : undefined,
    run.calls.running ? `${run.calls.running} running` : undefined,
    run.calls.failed ? `${run.calls.failed} failed` : undefined,
    run.calls.cancelled ? `${run.calls.cancelled} cancelled` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length > 0 ? parts.join(" · ") : "no agent calls";
}

function usageLabel(usage: WorkflowRunView["usage"] | WorkflowCallView["usage"]): string {
  if (!usage) return "tokens n/a";
  if (usage.totalTokens !== undefined) return `${formatNumber(usage.totalTokens)} tok`;
  const input = usage.inputTokens ?? 0;
  const output = usage.outputTokens ?? 0;
  return `${formatNumber(input + output)} tok`;
}

function durationLabel(startedAt: string | undefined, completedAt: string | undefined): string {
  if (!startedAt) return "time n/a";
  const start = Date.parse(startedAt);
  const end = completedAt ? Date.parse(completedAt) : Date.now();
  if (!Number.isFinite(start) || !Number.isFinite(end)) return "time n/a";
  let seconds = Math.max(0, Math.floor((end - start) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  seconds %= 60;
  if (minutes < 60) return `${minutes}m ${seconds}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function shortTime(createdAt: string): string {
  const date = new Date(createdAt);
  return Number.isNaN(date.valueOf()) ? "--:--:--" : date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function formatNumber(value: number): string {
  return value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}m` : value >= 1_000 ? `${(value / 1_000).toFixed(1)}k` : String(value);
}

function statusGlyph(status: WorkflowRunView["status"] | WorkflowCallView["status"]): string {
  if (status === "completed" || status === "from_cache") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "−";
  if (status === "running") return "●";
  return "◌";
}

function phaseGlyph(status: WorkflowPhaseView["status"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "−";
  if (status === "running") return "●";
  return "○";
}

function activityGlyph(status: WorkflowCallView["observations"][number]["toolStatus"]): string {
  if (status === "completed") return "✓";
  if (status === "failed") return "✕";
  if (status === "started" || status === "updated") return "●";
  return "·";
}

function rule(width: number): string {
  return "─".repeat(width);
}

function truncate(value: string, width: number): string {
  if (value.length <= width) return value;
  return `${value.slice(0, Math.max(0, width - 1))}…`;
}

function fitRows(lines: string[], rows: number): string[] {
  if (rows <= 0 || lines.length <= rows) return lines;
  return lines.slice(0, Math.max(1, rows));
}

function style(value: string, tone: "bold" | "heading" | "muted" | "error", ansi: boolean): string {
  if (!ansi) return value;
  if (tone === "bold") return `\u001b[1m${value}\u001b[0m`;
  if (tone === "heading") return `\u001b[1;36m${value}\u001b[0m`;
  if (tone === "error") return `\u001b[31m${value}\u001b[0m`;
  return `\u001b[2m${value}\u001b[0m`;
}
