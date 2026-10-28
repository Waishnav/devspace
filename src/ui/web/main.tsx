import { unsafeNarrow } from "../../unsafe-narrow.js";
import { isObjectValue, isJsonString, optionalFields } from "../../json-value.js";
import type { WireInput, JsonObject } from "../../json-value.js";
import { useEffect, useMemo, useState, type MouseEvent, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import type { ActivityWorkspace, TurnDiff, WorkspaceToolCall, WorkspaceTurn } from "../../workspace-activity.js";
import type { WorkspaceDescription } from "../../workspaces.js";
import { parseReviewFiles, ReviewDiffFile, type ReviewThemeType } from "../review-diff.js";
import { buildDiffTree, type DiffTreeNode } from "./diff-tree.js";
import "../review-diff.css";
import "./web.css";

const BASE = "/web";

type Route =
  | { page: "workspaces" }
  | { page: "workspace"; workspaceId: string; turn?: number };

interface WorkspaceResponse {
  workspace: ActivityWorkspace;
  context: WorkspaceDescription;
  turns: WorkspaceTurn[];
}

interface TurnResponse {
  turn: WorkspaceTurn;
  toolCalls: WorkspaceToolCall[];
  diff: TurnDiff;
}

function parseRoute(pathname: string): Route {
  const match = pathname.match(/^\/web\/w\/([^/]+)(?:\/turns\/(\d+))?\/?$/);

  if (!match) return { page: "workspaces" };

  return {
    page: "workspace",
    workspaceId: decodeURIComponent(match[1]!),
    ...optionalFields(match[2] ? { turn: Number(match[2]) } : undefined),
  };
}

function workspacePath(workspaceId: string, turn?: number): string {
  const base = `${BASE}/w/${encodeURIComponent(workspaceId)}`;

  return turn === undefined ? base : `${base}/turns/${turn}`;
}

function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

function useRoute(): Route {
  const [route, setRoute] = useState(() => parseRoute(window.location.pathname));
  useEffect(() => {
    const update = () => {
      setRoute(parseRoute(window.location.pathname));
      window.scrollTo(0, 0);
    };

    window.addEventListener("popstate", update);

    return () => window.removeEventListener("popstate", update);
  }, []);

  return route;
}

type Loaded<T> = { status: "loading" } | { status: "ready"; data: T } | { status: "error"; message: string };

function useJson<T>(url: string): Loaded<T> {
  const [state, setState] = useState<Loaded<T>>({ status: "loading" });
  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    fetch(url, { headers: { Accept: "application/json" } })
      .then(async (response) => {
        if (response.status === 401) {
          window.location.assign(`${BASE}/login?next=${encodeURIComponent(window.location.pathname)}`);

          return;
        }

        // SAFETY: The surrounding checks or construction already match this type.
        const body = await response.json() as T & { error?: string };

        if (cancelled) return;

        if (!response.ok) setState({ status: "error", message: body.error ?? `Request failed (${response.status}).` });
        else setState({ status: "ready", data: body });
      })
      .catch((error: WireInput) => {
        if (!cancelled) setState({ status: "error", message: error instanceof Error ? error.message : String(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [url]);

  return state;
}

type ThemePreference = "system" | "light" | "dark";

function readThemePreference(): ThemePreference {
  try {
    const stored = window.localStorage.getItem("devspace-web-theme");

    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

function useTheme(): [ReviewThemeType, ThemePreference, (preference: ThemePreference) => void] {
  const [preference, setPreference] = useState(readThemePreference);
  const media = useMemo(() => window.matchMedia("(prefers-color-scheme: dark)"), []);
  const [systemDark, setSystemDark] = useState(media.matches);
  useEffect(() => {
    const update = () => setSystemDark(media.matches);
    media.addEventListener("change", update);

    return () => media.removeEventListener("change", update);
  }, [media]);

  const resolved: ReviewThemeType = preference === "system" ? (systemDark ? "dark" : "light") : preference;
  useEffect(() => {
    document.documentElement.dataset.theme = resolved;
  }, [resolved]);

  return [resolved, preference, (next) => {
    setPreference(next);

    try {
      if (next === "system") window.localStorage.removeItem("devspace-web-theme");
      else window.localStorage.setItem("devspace-web-theme", next);
    } catch {
      // The preference is a convenience; the page works without storage.
    }
  }];
}

function App() {
  const route = useRoute();
  const [theme, preference, setPreference] = useTheme();

  return (
    <div className="page">
      <header className="topbar">
        <nav className="crumbs" aria-label="Breadcrumb">
          <Link href={`${BASE}/`} className="brand">DevSpace</Link>
          {route.page === "workspace" ? (
            <>
              <span className="crumb-separator">/</span>
              <Link href={workspacePath(route.workspaceId)} className="crumb mono">{route.workspaceId}</Link>
            </>
          ) : null}
        </nav>
        <div className="topbar-actions">
          <label className="theme-picker">
            <span className="visually-hidden">Theme</span>
            <select
              value={preference}
              // SAFETY: The surrounding checks or construction already match this type.
              onChange={(event) => setPreference(event.target.value as ThemePreference)}
            >
              <option value="system">System</option>
              <option value="light">Light</option>
              <option value="dark">Dark</option>
            </select>
          </label>
          <form method="post" action={`${BASE}/logout`}>
            <button type="submit" className="ghost-button">Sign out</button>
          </form>
        </div>
      </header>
      <main className="content">
        {route.page === "workspaces"
          ? <WorkspacesPage />
          : <WorkspacePage workspaceId={route.workspaceId} turn={route.turn} theme={theme} />}
      </main>
    </div>
  );
}

function Link({ href, className, children }: { href: string; className?: string; children: ReactNode }) {
  const onClick = (event: MouseEvent<HTMLAnchorElement>) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
      return;
    }

    event.preventDefault();
    navigate(href);
  };

  return <a href={href} className={className} onClick={onClick}>{children}</a>;
}

function WorkspacesPage() {
  const state = useJson<{ workspaces: ActivityWorkspace[] }>(`${BASE}/api/workspaces`);

  if (state.status !== "ready") return <LoadState state={state} />;

  const { workspaces } = state.data;

  return (
    <section>
      <h1 className="page-title">Workspaces</h1>
      {workspaces.length === 0 ? (
        <p className="muted">No workspaces yet. Open one from your MCP host and its activity appears here.</p>
      ) : (
        <ul className="panel workspace-list">
          {workspaces.map((workspace) => (
            <li key={workspace.workspaceId}>
              <Link href={workspacePath(workspace.workspaceId)} className="workspace-row">
                <span className="workspace-row-main">
                  <span className="workspace-name">{basename(workspace.root)}</span>
                  <span className="workspace-root mono">{workspace.root}</span>
                </span>
                <span className="workspace-row-meta">
                  <Badge>{workspace.mode}</Badge>
                  {workspace.branch ? <span className="mono meta-item">{workspace.branch}</span> : null}
                  <StatusBadge status={workspace.status} />
                  <span className="meta-item">{plural(workspace.turns, "turn")}</span>
                  <span className="meta-item muted">
                    {relativeTime(workspace.lastActivityAt ?? workspace.lastUsedAt)}
                  </span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function WorkspacePage({ workspaceId, turn, theme }: { workspaceId: string; turn?: number; theme: ReviewThemeType }) {
  const state = useJson<WorkspaceResponse>(`${BASE}/api/workspaces/${encodeURIComponent(workspaceId)}`);

  if (state.status !== "ready") return <LoadState state={state} />;

  const { workspace, context, turns } = state.data;
  const latest = turns[0];
  const selected = turn === undefined ? latest : turns.find((entry) => entry.sequence === turn);

  return (
    <>
      <WorkspaceHeader workspace={workspace} context={context} />
      {turns.length === 0 ? (
        <p className="muted">No tool calls recorded for this workspace yet.</p>
      ) : (
        <div className="workspace-layout">
          <aside className="turn-sidebar">
            <h2 className="section-title">Turns</h2>
            <label className="turn-select">
              <span className="visually-hidden">Turn</span>
              <select
                value={selected?.sequence ?? ""}
                onChange={(event) => navigate(workspacePath(workspaceId, Number(event.target.value)))}
              >
                {turns.map((entry) => (
                  <option key={entry.sequence} value={entry.sequence}>
                    {turnLabel(entry, latest)}
                  </option>
                ))}
              </select>
            </label>
            <ol className="panel turn-list">
              {turns.map((entry) => (
                <li key={entry.sequence}>
                  <Link
                    href={workspacePath(workspaceId, entry.sequence)}
                    className={`turn-row${entry.sequence === selected?.sequence ? " selected" : ""}`}
                  >
                    <span className="turn-row-title">
                      {turnLabel(entry, latest)}
                      {entry.status === "open" ? <Badge tone="accent">open</Badge> : null}
                    </span>
                    <span className="turn-row-meta">
                      {plural(entry.toolCalls, "call")}
                      {entry.failedToolCalls > 0 ? <span className="danger"> · {entry.failedToolCalls} failed</span> : null}
                      <span> · {relativeTime(entry.closedAt ?? entry.startedAt)}</span>
                    </span>
                  </Link>
                </li>
              ))}
            </ol>
          </aside>
          <section className="turn-detail">
            {selected
              ? <TurnView key={selected.sequence} workspaceId={workspaceId} turn={selected} latest={latest} theme={theme} />
              : <p className="status error">Turn {turn} was not found.</p>}
          </section>
        </div>
      )}
    </>
  );
}

function WorkspaceHeader({ workspace, context }: { workspace: ActivityWorkspace; context: WorkspaceDescription }) {
  return (
    <section className="panel workspace-header">
      <div className="workspace-header-title">
        <h1 className="page-title">{basename(workspace.root)}</h1>
        <span className="workspace-row-meta">
          <Badge>{workspace.mode}</Badge>
          <StatusBadge status={workspace.status} />
        </span>
      </div>
      <dl className="details">
        <Detail label="Root"><span className="mono">{workspace.root}</span></Detail>
        {workspace.sourceRoot ? <Detail label="Source"><span className="mono">{workspace.sourceRoot}</span></Detail> : null}
        {workspace.branch ? <Detail label="Branch"><span className="mono">{workspace.branch}</span></Detail> : null}
        <Detail label="Workspace"><span className="mono">{workspace.workspaceId}</span></Detail>
        {context.available ? (
          <>
            <Detail label="Instructions">
              {context.agentsFiles.length + context.availableAgentsFiles.length === 0 ? (
                <span className="muted">None</span>
              ) : (
                <span className="chips">
                  {context.agentsFiles.map((path) => <Badge key={path} tone="success" mono>{path}</Badge>)}
                  {context.availableAgentsFiles.map((path) => <Badge key={path} mono>{path}</Badge>)}
                </span>
              )}
            </Detail>
            <Detail label="Skills">
              {context.skills.length === 0 ? (
                <span className="muted">None</span>
              ) : (
                <span className="chips">
                  {context.skills.map((skill) => (
                    <span key={skill.name} className="badge" title={skill.description}>{skill.name}</span>
                  ))}
                </span>
              )}
            </Detail>
          </>
        ) : (
          <Detail label="Context"><span className="muted">{context.reason}</span></Detail>
        )}
      </dl>
    </section>
  );
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="detail">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function TurnView({ workspaceId, turn, latest, theme }: {
  workspaceId: string;
  turn: WorkspaceTurn;
  latest?: WorkspaceTurn;
  theme: ReviewThemeType;
}) {
  const state = useJson<TurnResponse>(
    `${BASE}/api/workspaces/${encodeURIComponent(workspaceId)}/turns/${turn.sequence}`,
  );

  return (
    <>
      <div className="turn-heading">
        <h2 className="turn-title">{turnLabel(turn, latest)}</h2>
        <span className="muted turn-time">
          {formatTime(turn.startedAt)}
          {turn.closedAt ? ` – ${formatEnd(turn.startedAt, turn.closedAt)}` : " · in progress"}
        </span>
      </div>
      {state.status !== "ready" ? <LoadState state={state} /> : (
        <>
          <TurnDiffSection diff={state.data.diff} theme={theme} />
          <ToolCallsSection toolCalls={state.data.toolCalls} />
        </>
      )}
    </>
  );
}

function TurnDiffSection({ diff, theme }: { diff: TurnDiff; theme: ReviewThemeType }) {
  const review = diff.status === "available" ? diff.review : undefined;
  const parsed = useMemo(() => parseReviewFiles(review?.patch), [review?.patch]);
  const [open, setOpen] = useState(() => new Set(parsed.length <= 6 ? parsed.map((file) => file.name) : []));

  const tree = useMemo(() => buildDiffTree(review?.files.map((file) => ({
    path: file.path,
    additions: file.additions,
    removals: file.removals,
  })) ?? []), [review?.files]);

  if (diff.status === "open") {
    return (
      <section className="turn-section">
        <h3 className="section-title">Changes</h3>
        <p className="panel status muted">This turn is still open. Its diff appears when show_changes records the next checkpoint.</p>
      </section>
    );
  }

  if (diff.status === "unavailable") {
    return (
      <section className="turn-section">
        <h3 className="section-title">Changes</h3>
        <p className="panel status error">{diff.reason}</p>
      </section>
    );
  }

  const reveal = (path: string) => {
    setOpen((current) => new Set(current).add(path));
    requestAnimationFrame(() => document.getElementById(fileAnchor(path))?.scrollIntoView({ block: "start" }));
  };

  return (
    <section className="turn-section">
      <h3 className="section-title">
        Changes
        <span className="section-summary">
          {plural(diff.review.summary.files, "file")}
          <span className="add"> +{diff.review.summary.additions}</span>
          <span className="remove"> -{diff.review.summary.removals}</span>
        </span>
      </h3>
      {parsed.length === 0 ? (
        <p className="panel status muted">No changes in this turn.</p>
      ) : (
        <div className="diff-layout">
          <nav className="panel diff-tree" aria-label="Changed files">
            <DiffTree nodes={tree} onSelect={reveal} />
          </nav>
          <div className="panel diff-files">
            {parsed.map((fileDiff, index) => (
              <ReviewDiffFile
                key={fileDiff.name}
                id={fileAnchor(fileDiff.name)}
                fileDiff={fileDiff}
                index={index}
                files={diff.review.files}
                themeType={theme}
                open={open.has(fileDiff.name)}
                onToggle={() => setOpen((current) => {
                  const next = new Set(current);

                  if (!next.delete(fileDiff.name)) next.add(fileDiff.name);

                  return next;
                })}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

function DiffTree({ nodes, onSelect, depth = 0 }: { nodes: DiffTreeNode[]; onSelect(path: string): void; depth?: number }) {
  return (
    <ul className="tree" role={depth === 0 ? "tree" : "group"}>
      {nodes.map((node) => (
        <li key={`${node.kind}:${node.path}`} role="treeitem" aria-expanded={node.kind === "directory" ? true : undefined}>
          {node.kind === "directory" ? (
            <>
              <span className="tree-row tree-directory" style={{ paddingLeft: 8 + depth * 12 }}>
                <span className="tree-name">{node.name}/</span>
              </span>
              <DiffTree nodes={node.children} onSelect={onSelect} depth={depth + 1} />
            </>
          ) : (
            <button
              type="button"
              className="tree-row tree-file"
              style={{ paddingLeft: 8 + depth * 12 }}
              onClick={() => onSelect(node.path)}
              title={node.path}
            >
              <span className="tree-name mono">{node.name}</span>
              <span className="tree-stats mono">
                <span className="add">+{node.additions}</span> <span className="remove">-{node.removals}</span>
              </span>
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}

function ToolCallsSection({ toolCalls }: { toolCalls: WorkspaceToolCall[] }) {
  return (
    <section className="turn-section">
      <h3 className="section-title">
        Tool calls
        <span className="section-summary">{toolCalls.length}</span>
      </h3>
      {toolCalls.length === 0 ? <p className="panel status muted">No tool calls in this turn.</p> : (
        <ol className="panel tool-calls">
          {toolCalls.map((call) => <ToolCallRow key={call.id} call={call} />)}
        </ol>
      )}
    </section>
  );
}

function ToolCallRow({ call }: { call: WorkspaceToolCall }) {
  const [expanded, setExpanded] = useState(false);
  const summary = call.error ? errorMessage(call.error) : resultSummary(call.result);

  return (
    <li className={`tool-call${call.isError ? " failed" : ""}`}>
      <button type="button" className="tool-call-header" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <span className={`tool-call-state${call.isError ? " failed" : ""}`} aria-label={call.isError ? "Failed" : "Succeeded"} />
        <span className="tool-call-main">
          <span className="tool-call-title">
            <span className="mono tool-name">{call.toolName}</span>
            {call.origin === "card" ? <Badge>card</Badge> : null}
            <span className="tool-call-args mono">{argumentSummary(call.arguments)}</span>
          </span>
          {summary ? <span className={`tool-call-summary${call.isError ? " danger" : ""}`}>{summary}</span> : null}
        </span>
        <span className="tool-call-duration mono">{formatDuration(call.durationMs)}</span>
        <span className="chevron" aria-hidden="true">{expanded ? "−" : "+"}</span>
      </button>
      {expanded ? (
        <div className="tool-call-body">
          <JsonBlock label="Arguments" value={call.arguments} />
          {call.error !== undefined ? <JsonBlock label="Error" value={call.error} /> : null}
          {call.result !== undefined ? <JsonBlock label="Result" value={call.result} /> : null}
          <p className="muted tool-call-meta">
            Started {formatTime(call.startedAt)}
            {call.conversationScopeId ? ` · conversation ${call.conversationScopeId}` : ""}
          </p>
        </div>
      ) : null}
    </li>
  );
}

function JsonBlock({ label, value }: { label: string; value: WireInput }) {
  const text = isObjectValue(value) && value !== null && "text" in value && Object.keys(value).length === 1
    // SAFETY: The surrounding checks or construction already match this type.
    ? String(unsafeNarrow<{ text: WireInput }>(value).text)
    : JSON.stringify(value, null, 2);

  return (
    <div className="json-block">
      <div className="json-label">{label}</div>
      <pre className="pretty-scrollbar">{text}</pre>
    </div>
  );
}

function LoadState({ state }: { state: Loaded<WireInput> }) {
  if (state.status === "error") return <p className="status error">{state.message}</p>;

  return <p className="status muted">Loading…</p>;
}

function Badge({ children, tone, mono }: { children: ReactNode; tone?: "accent" | "success"; mono?: boolean }) {
  return <span className={`badge${tone ? ` ${tone}` : ""}${mono ? " mono" : ""}`}>{children}</span>;
}

function StatusBadge({ status }: { status: ActivityWorkspace["status"] }) {
  return status === "active" ? <Badge tone="success">open</Badge> : <Badge>{status}</Badge>;
}

function turnLabel(turn: WorkspaceTurn, latest: WorkspaceTurn | undefined): string {
  return turn.sequence === latest?.sequence ? `Latest turn (${turn.sequence})` : `Turn ${turn.sequence}`;
}

function fileAnchor(path: string): string {
  return `file-${encodeURIComponent(path)}`;
}

function argumentSummary(args: WireInput): string {
  if (!isObjectValue(args) || args === null) return "";
  // SAFETY: The surrounding checks or construction already match this type.
  const record = args as JsonObject;

  if (isJsonString(record.patch)) {
    const files = [...record.patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm)].map((match) => match[1]);

    if (files.length > 0) return truncate(files.join(", "), 120);
  }

  for (const key of ["cmd", "command", "path", "task", "query"]) {
    // SAFETY: The surrounding checks or construction already match this type.
    if (isJsonString(record[key])) return truncate(record[key], 120);
  }

  const { workspace_id: _workspaceId, ...rest } = record;
  const json = JSON.stringify(rest);

  return json === "{}" ? "" : truncate(json, 120);
}

function resultSummary(result: WireInput): string {
  if (!isObjectValue(result) || result === null) return "";
  // SAFETY: The surrounding checks or construction already match this type.
  const text = (result as { text?: unknown }).text;

  if (!isJsonString(text)) return "";
  const line = text.split("\n").find((entry) => entry.trim().length > 0) ?? "";

  return truncate(line, 160);
}

function errorMessage(error: WireInput): string {
  // SAFETY: The surrounding checks or construction already match this type.
  const message = (error as { message?: unknown } | undefined)?.message;

  return isJsonString(message) ? truncate(message, 160) : "Failed";
}

function truncate(value: string, length: number): string {
  return value.length > length ? `${value.slice(0, length - 1)}…` : value;
}

function basename(path: string): string {
  return path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function formatDuration(ms: number): string {
  return ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
}

function formatTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
}

/** Omits the date from a range end on the same day as its start. */
function formatEnd(startIso: string, endIso: string): string {
  const sameDay = new Date(startIso).toDateString() === new Date(endIso).toDateString();

  return sameDay ? new Date(endIso).toLocaleTimeString(undefined, { timeStyle: "short" }) : formatTime(endIso);
}

function relativeTime(iso: string): string {
  const seconds = Math.round((Date.now() - Date.parse(iso)) / 1000);

  if (!Number.isFinite(seconds)) return "";

  if (seconds < 60) return "just now";
  const minutes = Math.round(seconds / 60);

  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);

  if (hours < 24) return `${hours} h ago`;

  return formatTime(iso);
}

createRoot(document.getElementById("root")!).render(<App />);
