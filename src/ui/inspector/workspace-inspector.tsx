import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import {
  Link,
  Outlet,
  RouterProvider,
  createMemoryHistory,
  createBrowserHistory,
  createRootRoute,
  createRoute,
  createRouter,
  useNavigate,
} from "@tanstack/react-router";
import { createContext, useContext, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import type { HostContext, ToolResultCard } from "../card-types.js";
import { ReviewPayload } from "../review-payload.js";
import {
  workspaceActivityQuery,
  workspaceDiffQuery,
  workspaceRefsQuery,
  workspaceToolCallQuery,
} from "./queries.js";
import type {
  WorkspaceDiffScopeInput,
  WorkspaceInspectorTransport,
} from "./transport.js";
import { createMcpInspectorTransport } from "./transport.js";
import type { App } from "@modelcontextprotocol/ext-apps";

interface InspectorOptions {
  workspaceId: string;
  root: string;
  mode?: "checkout" | "worktree";
  hostContext?: HostContext;
  transport: WorkspaceInspectorTransport;
  initialReviewRef?: string;
  onExitFullscreen?: () => void;
  browserBasepath?: string;
}

interface MountedInspector {
  unmount(): void;
}

const InspectorContext = createContext<InspectorOptions | null>(null);

const rootRoute = createRootRoute({ component: InspectorLayout });
const activityRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/activity",
  validateSearch: (search: Record<string, unknown>) => ({
    ...(typeof search.review === "string" ? { review: search.review } : {}),
    ...(typeof search.group === "string" ? { group: search.group } : {}),
  }),
  component: ActivityView,
});
const changesRoute = createRoute({
  getParentRoute: () => rootRoute,
  path: "/changes",
  validateSearch: (search: Record<string, unknown>) => ({
    ...(search.scope === "review"
      || search.scope === "working-tree"
      || search.scope === "branch"
      || search.scope === "compare"
      ? { scope: search.scope }
      : {}),
    ...(typeof search.review === "string" ? { review: search.review } : {}),
    ...(typeof search.base === "string" ? { base: search.base } : {}),
    ...(typeof search.from === "string" ? { from: search.from } : {}),
    ...(typeof search.to === "string" ? { to: search.to } : {}),
  }),
  component: ChangesView,
});
const routeTree = rootRoute.addChildren([activityRoute, changesRoute]);

export function mountWorkspaceInspector(
  container: HTMLElement,
  options: InspectorOptions,
): MountedInspector {
  const root = createRoot(container);
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: 1, refetchOnWindowFocus: false },
    },
  });
  const initialPath = options.initialReviewRef
    ? `/activity?review=${encodeURIComponent(options.initialReviewRef)}`
    : "/activity";
  const history = options.browserBasepath
    ? createBrowserHistory()
    : createMemoryHistory({ initialEntries: [initialPath] });
  const router = createRouter({
    routeTree,
    history,
    ...(options.browserBasepath ? { basepath: options.browserBasepath } : {}),
  });

  root.render(
    <InspectorContext.Provider value={options}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </InspectorContext.Provider>,
  );

  return { unmount: () => root.unmount() };
}

export function mountMcpWorkspaceInspector(
  container: HTMLElement,
  options: Omit<InspectorOptions, "transport"> & { app: App },
): MountedInspector {
  const { app, ...inspectorOptions } = options;
  return mountWorkspaceInspector(container, {
    ...inspectorOptions,
    transport: createMcpInspectorTransport(app),
  });
}

function InspectorLayout() {
  const inspector = useInspector();
  const title = workspaceTitle(inspector.root);
  return (
    <main className="workspace-inspector">
      <header className="inspector-header">
        <div className="inspector-heading">
          <div className="inspector-title-row">
            <strong>{title}</strong>
            {inspector.mode ? <span className="inspector-badge">{inspector.mode}</span> : null}
          </div>
          <span className="inspector-root" title={inspector.root}>{inspector.root}</span>
        </div>
        {inspector.onExitFullscreen ? (
          <button className="inspector-exit" type="button" onClick={inspector.onExitFullscreen}>
            Exit fullscreen
          </button>
        ) : null}
      </header>
      <nav className="inspector-tabs" aria-label="Workspace inspector">
        <Link to="/activity" activeProps={{ className: "active" }}>Activity</Link>
        <Link to="/changes" activeProps={{ className: "active" }}>Changes</Link>
      </nav>
      <div className="inspector-content">
        <Outlet />
      </div>
    </main>
  );
}

function ActivityView() {
  const inspector = useInspector();
  const search = activityRoute.useSearch();
  const navigate = useNavigate({ from: "/activity" });
  const activity = useQuery(workspaceActivityQuery(inspector.transport, inspector.workspaceId));
  const groups = activity.data?.groups ?? [];
  const selected = groups.find((group) =>
    search.review ? group.review_ref === search.review : search.group ? group.id === search.group : false,
  ) ?? groups[0];

  if (activity.isPending) return <InspectorStatus>Loading workspace activity…</InspectorStatus>;
  if (activity.error) return <InspectorStatus tone="error">{activity.error.message}</InspectorStatus>;
  if (!selected) return <InspectorStatus>No persisted tool activity yet.</InspectorStatus>;

  return (
    <section className="inspector-view">
      <div className="inspector-toolbar">
        <select
          className="inspector-select"
          aria-label="Activity group"
          value={selected.id}
          onChange={(event) => {
            const next = groups.find((group) => group.id === event.target.value);
            if (!next) return;
            void navigate({
              to: "/activity",
              search: next.review_ref ? { review: next.review_ref } : { group: next.id },
            });
          }}
        >
          {groups.map((group, index) => (
            <option key={group.id} value={group.id}>
              {index === 0 ? "Latest activity" : activityGroupLabel(group)}
            </option>
          ))}
        </select>
        <span className="inspector-toolbar-meta">{selected.calls.length} calls</span>
        {selected.review_ref ? (
          <button
            className="inspector-link-button"
            type="button"
            onClick={() => void navigateToReviewChanges(selected.review_ref!)}
          >
            View changes
          </button>
        ) : null}
      </div>
      <div className="activity-list">
        {selected.calls.map((call) => (
          <ToolCallRow key={call.id} call={call} />
        ))}
      </div>
    </section>
  );

  function navigateToReviewChanges(reviewRef: string) {
    return navigate({
      to: "/changes",
      search: { scope: "review", review: reviewRef },
    });
  }
}

function ToolCallRow({
  call,
}: {
  call: {
    id: number;
    tool_name: string;
    started_at: string;
    completed_at?: string;
    duration_ms?: number;
  };
}) {
  const inspector = useInspector();
  const [expanded, setExpanded] = useState(false);
  const detail = useQuery({
    ...workspaceToolCallQuery(inspector.transport, inspector.workspaceId, call.id),
    enabled: expanded,
  });
  return (
    <div className={`activity-row ${expanded ? "expanded" : ""}`}>
      <button type="button" className="activity-row-header" onClick={() => setExpanded(!expanded)}>
        <span className="activity-tool">{toolLabel(call.tool_name)}</span>
        <span className="activity-tool-name">{call.tool_name}</span>
        <span className="activity-duration">{formatDuration(call.duration_ms)}</span>
        <span className="activity-disclosure" aria-hidden>{expanded ? "⌄" : "›"}</span>
      </button>
      {expanded ? (
        <div className="activity-detail">
          {detail.isPending ? <InspectorStatus>Loading raw call…</InspectorStatus> : null}
          {detail.error ? <InspectorStatus tone="error">{detail.error.message}</InspectorStatus> : null}
          {detail.data ? (
            <>
              <RawJsonBlock title="Input" value={detail.data.arguments} />
              {detail.data.error !== undefined
                ? <RawJsonBlock title="Error" value={detail.data.error} />
                : <RawJsonBlock title="Result" value={detail.data.result} />}
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function ChangesView() {
  const inspector = useInspector();
  const search = changesRoute.useSearch();
  const navigate = useNavigate({ from: "/changes" });
  const activity = useQuery(workspaceActivityQuery(inspector.transport, inspector.workspaceId));
  const refs = useQuery(workspaceRefsQuery(inspector.transport, inspector.workspaceId));
  const reviewedGroups = (activity.data?.groups ?? []).filter((group) => group.review_ref);
  const scope = useMemo<WorkspaceDiffScopeInput>(() => {
    if (search.scope === "review" && search.review) {
      return { kind: "review", review_ref: search.review };
    }
    if (search.scope === "branch") {
      return { kind: "branch", ...(search.base ? { base_ref: search.base } : {}) };
    }
    if (search.scope === "compare" && search.from && search.to) {
      return { kind: "compare", from_ref: search.from, to_ref: search.to };
    }
    if (search.scope === "working-tree") return { kind: "working-tree" };
    const latestReview = reviewedGroups[0]?.review_ref;
    return latestReview ? { kind: "review", review_ref: latestReview } : { kind: "working-tree" };
  }, [reviewedGroups, search.base, search.from, search.review, search.scope, search.to]);
  const diff = useQuery(workspaceDiffQuery(inspector.transport, inspector.workspaceId, scope));
  const scopeValue = scope.kind === "review"
    ? `review:${scope.review_ref}`
    : scope.kind;

  return (
    <section className="inspector-view">
      <div className="inspector-toolbar changes-toolbar">
        <select
          className="inspector-select"
          aria-label="Diff scope"
          value={scopeValue}
          onChange={(event) => {
            const value = event.target.value;
            if (value.startsWith("review:")) {
              void navigate({ to: "/changes", search: { scope: "review", review: value.slice(7) } });
            } else if (value === "working-tree") {
              void navigate({ to: "/changes", search: { scope: "working-tree" } });
            } else if (value === "branch") {
              void navigate({
                to: "/changes",
                search: { scope: "branch", ...(refs.data?.default_base_ref ? { base: refs.data.default_base_ref } : {}) },
              });
            } else if (value === "compare") {
              const from = refs.data?.default_base_ref ?? refs.data?.refs[0];
              const to = refs.data?.current_ref ?? refs.data?.refs[1] ?? from;
              if (from && to) void navigate({ to: "/changes", search: { scope: "compare", from, to } });
            }
          }}
        >
          {reviewedGroups.map((group, index) => (
            <option key={group.id} value={`review:${group.review_ref}`}>
              {index === 0 ? "Latest reviewed activity" : activityGroupLabel(group)}
            </option>
          ))}
          <option value="working-tree">Working tree</option>
          <option value="branch">Branch changes</option>
          <option value="compare">Compare refs…</option>
        </select>
        {scope.kind === "branch" ? (
          <RefSelect
            label="Base ref"
            refs={refs.data?.refs ?? []}
            value={scope.base_ref ?? refs.data?.default_base_ref ?? ""}
            onChange={(base) => void navigate({ to: "/changes", search: { scope: "branch", base } })}
          />
        ) : null}
        {scope.kind === "compare" ? (
          <div className="compare-refs">
            <RefSelect
              label="From ref"
              refs={refs.data?.refs ?? []}
              value={scope.from_ref}
              onChange={(from) => void navigate({ to: "/changes", search: { scope: "compare", from, to: scope.to_ref } })}
            />
            <span aria-hidden>→</span>
            <RefSelect
              label="To ref"
              refs={refs.data?.refs ?? []}
              value={scope.to_ref}
              onChange={(to) => void navigate({ to: "/changes", search: { scope: "compare", from: scope.from_ref, to } })}
            />
          </div>
        ) : null}
        {diff.data ? (
          <span className="inspector-diff-stat">
            <span className="add">+{diff.data.summary.additions}</span>{" "}
            <span className="remove">-{diff.data.summary.removals}</span>
          </span>
        ) : null}
        {scope.kind === "review" ? (
          <button
            className="inspector-link-button"
            type="button"
            onClick={() => void navigate({ to: "/activity", search: { review: scope.review_ref } })}
          >
            View activity
          </button>
        ) : null}
      </div>
      {diff.isPending ? <InspectorStatus>Loading diff…</InspectorStatus> : null}
      {diff.error ? <InspectorStatus tone="error">{diff.error.message}</InspectorStatus> : null}
      {diff.data ? (
        <div className="inspector-diff">
          <ReviewPayload
            card={{
              tool: "show_changes",
              summary: diff.data.summary,
              files: diff.data.files,
              payload: { patch: diff.data.patch },
            } satisfies ToolResultCard}
            hostContext={inspector.hostContext}
          />
        </div>
      ) : null}
    </section>
  );
}

function RefSelect(props: {
  label: string;
  refs: string[];
  value: string;
  onChange(value: string): void;
}) {
  return (
    <select
      className="inspector-ref-select"
      aria-label={props.label}
      value={props.value}
      onChange={(event) => props.onChange(event.target.value)}
    >
      {props.refs.map((ref) => <option key={ref} value={ref}>{ref}</option>)}
    </select>
  );
}

function RawJsonBlock({ title, value }: { title: string; value: unknown }) {
  return (
    <section className="raw-json-block">
      <div className="raw-json-title">{title}</div>
      <pre>{value === undefined ? "—" : JSON.stringify(value, null, 2)}</pre>
    </section>
  );
}

function InspectorStatus({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return <div className={`inspector-status ${tone}`}>{children}</div>;
}

function useInspector(): InspectorOptions {
  const value = useContext(InspectorContext);
  if (!value) throw new Error("Workspace inspector context is missing.");
  return value;
}

function activityGroupLabel(group: { kind: "review" | "inferred"; started_at: string }): string {
  const date = new Date(group.started_at);
  const time = Number.isNaN(date.getTime())
    ? group.started_at
    : date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return group.kind === "review" ? `Reviewed activity · ${time}` : `Activity · ${time}`;
}

function toolLabel(toolName: string): string {
  switch (toolName) {
    case "read": return "Read file";
    case "exec_command":
    case "bash": return "Run command";
    case "apply_patch":
    case "edit":
    case "write": return "Modify files";
    case "show_changes": return "Capture review";
    case "open_workspace": return "Open workspace";
    default: return "Tool call";
  }
}

function formatDuration(durationMs: number | undefined): string {
  if (durationMs === undefined) return "running";
  if (durationMs < 1_000) return `${durationMs} ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)} s`;
}

function workspaceTitle(root: string): string {
  const parts = root.replace(/[\\/]+$/, "").split(/[\\/]/);
  return parts.at(-1) || root;
}
