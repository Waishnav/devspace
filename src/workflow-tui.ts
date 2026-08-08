import { emitKeypressEvents } from "node:readline";
import type { ServerConfig } from "./config.js";
import { resolveCliWorkspaceContext } from "./cli-workspace.js";
import { createWorkflowStore } from "./workflow-store.js";
import type { WorkflowAgentActivityRecord } from "./workflow-types.js";
import {
  ACTIVE_WORKFLOW_STATUSES,
  loadWorkflowProjectView,
  type WorkflowCallView,
  type WorkflowPhaseView,
  type WorkflowProjectView,
  type WorkflowRunView,
} from "./workflow-view.js";

const REFRESH_MS = 750;
const INSPECTOR_TABS = ["activity", "prompt", "result", "files", "metadata"] as const;
type InspectorTab = (typeof INSPECTOR_TABS)[number];

export type WorkflowTuiState =
  | { screen: "workflows"; runIndex: number }
  | {
      screen: "workflow";
      runIndex: number;
      phaseIndex: number;
      callIndex: number;
      focus: "phases" | "calls";
    }
  | {
      screen: "call";
      runIndex: number;
      phaseIndex: number;
      callIndex: number;
      tab: InspectorTab;
      scroll: number;
    };

export async function runWorkflowTui(args: string[], config: ServerConfig): Promise<void> {
  const requestedRunId = args.find((arg) => !arg.startsWith("-"));
  const workspaceRoot = resolveWorkflowTuiWorkspaceRoot();
  const store = createWorkflowStore(config);
  const load = (includeTerminal = false): WorkflowProjectView =>
    loadWorkflowProjectView(store, workspaceRoot, {
      statuses: requestedRunId || includeTerminal ? undefined : [...ACTIVE_WORKFLOW_STATUSES],
      limit: 50,
      eventLimit: 100,
    });

  let project = load();
  let state = createWorkflowTuiState(project, requestedRunId);

  const activityForState = (): WorkflowAgentActivityRecord[] => {
    if (state.screen !== "call") return [];
    const call = selectedCall(project, state);
    const run = project.runs[state.runIndex];
    return run && call ? store.listAgentActivity(run.id, call.callIndex) : [];
  };

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    try {
      process.stdout.write(
        `${renderWorkflowTui(project, state, 100, 40, { ansi: false, activity: activityForState() })}\n`,
      );
      return;
    } finally {
      store.close();
    }
  }

  let closed = false;
  let rendering = false;
  const render = (): void => {
    if (rendering || closed) return;
    rendering = true;
    try {
      const previousProject = project;
      project = load(state.screen !== "workflows");
      state = reconcileWorkflowTuiState(previousProject, project, state);
      process.stdout.write(
        `\u001b[H\u001b[2J${renderWorkflowTui(
          project,
          state,
          process.stdout.columns || 100,
          process.stdout.rows || 40,
          { ansi: true, activity: activityForState() },
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
    const onKeypress = (_input: string, key: { name?: string; ctrl?: boolean }): void => {
      if ((key.ctrl && key.name === "c") || key.name === "q") return finish();
      state = reduceWorkflowTuiState(project, state, key.name ?? "");
      render();
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
  return resolveCliWorkspaceContext(process.env, cwd).workspaceRoot;
}

export function createWorkflowTuiState(
  project: WorkflowProjectView,
  requestedRunId?: string,
): WorkflowTuiState {
  if (!requestedRunId) return { screen: "workflows", runIndex: 0 };
  const runIndex = project.runs.findIndex((run) => run.id === requestedRunId);
  if (runIndex < 0) {
    throw new Error(`Workflow ${requestedRunId} does not belong to the current project: ${project.workspaceRoot}`);
  }
  return {
    screen: "workflow",
    runIndex,
    phaseIndex: initialPhaseIndex(project.runs[runIndex]!),
    callIndex: 0,
    focus: "phases",
  };
}

export function reduceWorkflowTuiState(
  project: WorkflowProjectView,
  state: WorkflowTuiState,
  key: string,
): WorkflowTuiState {
  const run = project.runs[state.runIndex];
  if (state.screen === "workflows") {
    if (key === "up" || key === "k") return { ...state, runIndex: Math.max(0, state.runIndex - 1) };
    if (key === "down" || key === "j") {
      return { ...state, runIndex: Math.min(Math.max(0, project.runs.length - 1), state.runIndex + 1) };
    }
    if ((key === "return" || key === "right") && run) {
      return {
        screen: "workflow",
        runIndex: state.runIndex,
        phaseIndex: initialPhaseIndex(run),
        callIndex: 0,
        focus: "phases",
      };
    }
    return state;
  }
  if (state.screen === "workflow") {
    if (key === "escape" || key === "left") return { screen: "workflows", runIndex: state.runIndex };
    if (key === "tab") return { ...state, focus: state.focus === "phases" ? "calls" : "phases" };
    if (!run) return state;
    if (state.focus === "phases") {
      if (key === "up" || key === "k") return { ...state, phaseIndex: Math.max(0, state.phaseIndex - 1), callIndex: 0 };
      if (key === "down" || key === "j") {
        return { ...state, phaseIndex: Math.min(Math.max(0, navigatorPhases(run).length - 1), state.phaseIndex + 1), callIndex: 0 };
      }
      if (key === "return" || key === "right") return { ...state, focus: "calls" };
    } else {
      const calls = callsForPhase(run, state.phaseIndex);
      if (key === "up" || key === "k") return { ...state, callIndex: Math.max(0, state.callIndex - 1) };
      if (key === "down" || key === "j") {
        return { ...state, callIndex: Math.min(Math.max(0, calls.length - 1), state.callIndex + 1) };
      }
      if ((key === "return" || key === "right") && calls[state.callIndex]) {
        return { screen: "call", runIndex: state.runIndex, phaseIndex: state.phaseIndex, callIndex: state.callIndex, tab: "activity", scroll: 0 };
      }
    }
    return state;
  }
  if (key === "escape" || key === "left") {
    return { screen: "workflow", runIndex: state.runIndex, phaseIndex: state.phaseIndex, callIndex: state.callIndex, focus: "calls" };
  }
  if (key === "tab" || key === "right") {
    const index = INSPECTOR_TABS.indexOf(state.tab);
    return { ...state, tab: INSPECTOR_TABS[(index + 1) % INSPECTOR_TABS.length]!, scroll: 0 };
  }
  if (key === "up" || key === "k") return { ...state, scroll: Math.max(0, state.scroll - 1) };
  if (key === "down" || key === "j") return { ...state, scroll: state.scroll + 1 };
  return state;
}

export function renderWorkflowTui(
  project: WorkflowProjectView,
  state: WorkflowTuiState,
  columns: number,
  rows: number,
  options: { ansi?: boolean; activity?: WorkflowAgentActivityRecord[] } = {},
): string {
  project = sanitizeTerminalValue(project);
  const activity = sanitizeTerminalValue(options.activity ?? []);
  const width = Math.max(48, columns);
  const ansi = options.ansi !== false;
  const lines = state.screen === "workflows"
    ? renderWorkflowList(project, state, width, ansi)
    : state.screen === "workflow"
      ? renderNavigator(project, state, width, ansi)
      : renderCallInspector(project, state, width, ansi, activity);
  return fitRows(lines, rows).join("\n");
}

function renderWorkflowList(
  project: WorkflowProjectView,
  state: Extract<WorkflowTuiState, { screen: "workflows" }>,
  width: number,
  ansi: boolean,
): string[] {
  const lines = [style(`Workflows · ${project.workspaceRoot}`, "bold", ansi), rule(width)];
  if (project.runs.length === 0) {
    lines.push("No active workflows in this project.", "", style("q quit", "muted", ansi));
    return lines;
  }
  for (const [index, run] of project.runs.entries()) {
    const phase = run.currentPhase ? `  ${run.currentPhase}` : "";
    lines.push(truncate(`${index === state.runIndex ? "›" : " "} ${statusGlyph(run.status)} ${run.name}${phase}  ${callSummary(run)}  ${elapsedLabel(run)}`, width));
  }
  lines.push(rule(width), style("↑/↓ select · Enter open · q quit", "muted", ansi));
  return lines;
}

function renderNavigator(
  project: WorkflowProjectView,
  state: Extract<WorkflowTuiState, { screen: "workflow" }>,
  width: number,
  ansi: boolean,
): string[] {
  const run = project.runs[state.runIndex];
  if (!run) return ["Workflow is no longer available."];
  const lines = [
    style(`Workflow › ${run.name}`, "bold", ansi),
    truncate(`${statusGlyph(run.status)} ${run.status.toUpperCase()}  ${elapsedLabel(run)}  ·  ${callSummary(run)}${run.totalTokens ? `  ·  ${formatTokens(run.totalTokens)} tokens observed` : ""}`, width),
    rule(width),
  ];
  const phases = navigatorPhases(run);
  const phase = phases[state.phaseIndex];
  const calls = callsForPhase(run, state.phaseIndex);
  if (width < 80) {
    lines.push(style(state.focus === "phases" ? "PHASES" : `AGENTS · ${phase?.title ?? "Other"}`, "heading", ansi));
    if (state.focus === "phases") appendPhaseLines(lines, phases, state.phaseIndex, width);
    else appendCallLines(lines, calls, state.callIndex, width);
  } else {
    const leftWidth = Math.min(32, Math.floor(width * 0.35));
    const rightWidth = width - leftWidth - 3;
    lines.push(`${style("PHASES".padEnd(leftWidth), "heading", ansi)} │ ${style(`AGENTS · ${phase?.title ?? "Other"}`, "heading", ansi)}`);
    const left = phaseRows(phases, state.phaseIndex, leftWidth);
    const right = callRows(calls, state.callIndex, rightWidth);
    const count = Math.max(left.length, right.length, 1);
    for (let index = 0; index < count; index += 1) {
      lines.push(`${(left[index] ?? "").padEnd(leftWidth)} │ ${right[index] ?? ""}`);
    }
  }
  lines.push(rule(width), style("↑/↓ select · Tab switch pane · Enter inspect · Esc back · q quit", "muted", ansi));
  return lines;
}

function renderCallInspector(
  project: WorkflowProjectView,
  state: Extract<WorkflowTuiState, { screen: "call" }>,
  width: number,
  ansi: boolean,
  activity: WorkflowAgentActivityRecord[],
): string[] {
  const run = project.runs[state.runIndex];
  const call = run ? selectedCall(project, state) : undefined;
  if (!run || !call) return ["Agent call is no longer available."];
  const label = call.label ?? `Agent #${call.callIndex}`;
  const target = call.model ? `${call.provider}/${call.model}` : call.provider;
  const lines = [
    style(`Workflow › ${call.phase ?? "Other"} › ${label}`, "bold", ansi),
    truncate(`${statusGlyph(call.status)} ${call.status}  ·  ${target}  ·  ${callElapsedLabel(call)}${call.usage ? `  ·  ${formatTokens(call.usage.totalTokens)} tokens ${call.usage.state}` : ""}`, width),
    "",
    INSPECTOR_TABS.map((tab) => tab === state.tab ? `[${capitalize(tab)}]` : capitalize(tab)).join("  "),
    rule(width),
  ];
  const body = inspectorBody(state.tab, call, activity).slice(state.scroll);
  lines.push(...body.map((line) => truncate(line, width)));
  lines.push(rule(width), style("Tab next section · ↑/↓ scroll · Esc back · q quit", "muted", ansi));
  return lines;
}

function inspectorBody(tab: InspectorTab, call: WorkflowCallView, activity: WorkflowAgentActivityRecord[]): string[] {
  if (tab === "activity") {
    if (activity.length === 0) return ["No agent activity has been observed yet."];
    return activity.map((event) => `${timeLabel(event.createdAt)}  ${statusGlyph(event.status)} ${event.kind.padEnd(7)}  ${event.label}${event.detail ? ` · ${event.detail}` : ""}`);
  }
  if (tab === "prompt") return call.prompt.split("\n");
  if (tab === "result") {
    if (call.error) return [`${call.errorKind ?? "error"}: ${call.error}`];
    return (call.responseText ?? call.structuredJson ?? call.returnValueJson ?? "No result yet.").split("\n");
  }
  if (tab === "files") {
    return [
      `Isolation  ${call.isolation}`,
      `Worktree   ${call.worktreePath ?? "shared checkout"}`,
      `Dirty      ${call.dirty === undefined ? "unknown" : call.dirty ? "yes" : "no"}`,
    ];
  }
  return [
    `Call        #${call.callIndex}`,
    `Provider    ${call.provider}`,
    `Model       ${call.model ?? "default"}`,
    `Effort      ${call.effort ?? "default"}`,
    `Session     ${call.providerSessionId ?? "unavailable"}`,
    `Started     ${call.startedAt ?? "not recorded"}`,
    `Completed   ${call.completedAt ?? "running"}`,
    `Tokens      ${call.usage ? `${call.usage.totalTokens} (${call.usage.state})` : "unavailable"}`,
    `Replay      ${call.replayedFromRunId ? `${call.replayedFromRunId}#${call.replayedFromCallIndex}` : "no"}`,
  ];
}

export function reconcileWorkflowTuiState(
  previousProject: WorkflowProjectView,
  project: WorkflowProjectView,
  state: WorkflowTuiState,
): WorkflowTuiState {
  const previousRunId = previousProject.runs[state.runIndex]?.id;
  const matchingRunIndex = previousRunId
    ? project.runs.findIndex((run) => run.id === previousRunId)
    : -1;
  const runIndex = matchingRunIndex >= 0
    ? matchingRunIndex
    : Math.min(Math.max(0, state.runIndex), Math.max(0, project.runs.length - 1));
  if (state.screen === "workflows") return { ...state, runIndex };
  const run = project.runs[runIndex];
  const phaseIndex = Math.min(
    Math.max(0, state.phaseIndex),
    Math.max(0, (run ? navigatorPhases(run).length : 1) - 1),
  );
  const calls = run ? callsForPhase(run, phaseIndex) : [];
  const callIndex = Math.min(Math.max(0, state.callIndex), Math.max(0, calls.length - 1));
  return { ...state, runIndex, phaseIndex, callIndex };
}

function selectedCall(project: WorkflowProjectView, state: { runIndex: number; phaseIndex: number; callIndex: number }): WorkflowCallView | undefined {
  const run = project.runs[state.runIndex];
  return run ? callsForPhase(run, state.phaseIndex)[state.callIndex] : undefined;
}

function callsForPhase(run: WorkflowRunView, phaseIndex: number): WorkflowCallView[] {
  return navigatorPhases(run)[phaseIndex]?.calls ?? [];
}

function initialPhaseIndex(run: WorkflowRunView): number {
  const index = run.currentPhase
    ? run.phases.findIndex((phase) => phase.title === run.currentPhase)
    : -1;
  return index < 0 ? 0 : index;
}

function navigatorPhases(run: WorkflowRunView): WorkflowPhaseView[] {
  if (run.unphasedCalls.length === 0) return run.phases;
  const calls = run.unphasedCalls;
  const status: WorkflowPhaseView["status"] = calls.some((call) => call.status === "failed")
    ? "failed"
    : calls.some((call) => call.status === "running")
      ? "running"
      : calls.every((call) => call.status === "cancelled")
        ? "cancelled"
        : "completed";
  return [...run.phases, { title: "Other", status, calls }];
}

function appendPhaseLines(lines: string[], phases: WorkflowPhaseView[], selected: number, width: number): void {
  lines.push(...phaseRows(phases, selected, width));
}

function appendCallLines(lines: string[], calls: WorkflowCallView[], selected: number, width: number): void {
  lines.push(...callRows(calls, selected, width));
}

function phaseRows(phases: WorkflowPhaseView[], selected: number, width: number): string[] {
  if (phases.length === 0) return ["No phases observed yet."];
  return phases.map((phase, index) => truncate(`${index === selected ? "›" : " "} ${statusGlyph(phase.status)} ${phase.title}  ${phaseProgress(phase)}`, width));
}

function callRows(calls: WorkflowCallView[], selected: number, width: number): string[] {
  if (calls.length === 0) return ["No agent calls in this phase yet."];
  return calls.map((call, index) => {
    const tokens = call.usage ? formatTokens(call.usage.totalTokens) : "—";
    return truncate(`${index === selected ? "›" : " "} ${statusGlyph(call.status)} ${call.label ?? `Agent #${call.callIndex}`}  ${call.provider}  ${tokens}  ${callElapsedLabel(call)}`, width);
  });
}

function phaseProgress(phase: WorkflowPhaseView): string {
  if (phase.calls.length === 0) return "—";
  const done = phase.calls.filter((call) => call.status === "completed" || call.status === "from_cache").length;
  return `${done}/${phase.calls.length}`;
}

function callSummary(run: WorkflowRunView): string {
  const parts = [
    run.calls.completed ? `${run.calls.completed} done` : undefined,
    run.calls.cached ? `${run.calls.cached} replayed` : undefined,
    run.calls.running ? `${run.calls.running} running` : undefined,
    run.calls.failed ? `${run.calls.failed} failed` : undefined,
  ].filter((part): part is string => Boolean(part));
  return parts.length ? parts.join(" · ") : "no agent calls yet";
}

function elapsedLabel(run: WorkflowRunView): string {
  return durationLabel(run.startedAt ?? run.createdAt, run.completedAt);
}

function callElapsedLabel(call: WorkflowCallView): string {
  return call.fromCache ? "replayed" : durationLabel(call.startedAt ?? call.updatedAt, call.completedAt);
}

function durationLabel(startValue: string, endValue?: string): string {
  const seconds = Math.max(0, Math.floor(((endValue ? Date.parse(endValue) : Date.now()) - Date.parse(startValue)) / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

function statusGlyph(status: string): string {
  if (status === "completed" || status === "from_cache") return "✓";
  if (status === "failed") return "✕";
  if (status === "cancelled") return "−";
  if (status === "running") return "●";
  return "○";
}

function formatTokens(tokens: number): string {
  if (tokens < 1_000) return String(tokens);
  if (tokens < 1_000_000) return `${(tokens / 1_000).toFixed(tokens < 10_000 ? 1 : 0)}k`;
  return `${(tokens / 1_000_000).toFixed(1)}m`;
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
}

function capitalize(value: string): string {
  return `${value[0]!.toUpperCase()}${value.slice(1)}`;
}

function rule(width: number): string { return "─".repeat(width); }
function truncate(value: string, width: number): string {
  return value.length <= width ? value : `${value.slice(0, Math.max(0, width - 1))}…`;
}
function fitRows(lines: string[], rows: number): string[] {
  return rows > 0 && lines.length > rows ? lines.slice(0, Math.max(1, rows)) : lines;
}
function style(value: string, tone: "bold" | "heading" | "muted", ansi: boolean): string {
  if (!ansi) return value;
  if (tone === "bold") return `\u001b[1m${value}\u001b[0m`;
  if (tone === "heading") return `\u001b[1;36m${value}\u001b[0m`;
  return `\u001b[2m${value}\u001b[0m`;
}

function sanitizeTerminalValue<T>(value: T): T {
  if (typeof value === "string") {
    return value.replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, (character) =>
      `\\x${character.charCodeAt(0).toString(16).padStart(2, "0")}`,
    ) as T;
  }
  if (Array.isArray(value)) return value.map(sanitizeTerminalValue) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, child]) => [key, sanitizeTerminalValue(child)]),
    ) as T;
  }
  return value;
}
