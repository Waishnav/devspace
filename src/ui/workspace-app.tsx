import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ReactNode } from "react";
import { createRoot } from "react-dom/client";
import { File, PatchDiff } from "@pierre/diffs/react";
import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
} from "@modelcontextprotocol/ext-apps/app-with-deps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./workspace-app.css";

type ToolName =
  | "open_workspace"
  | "read_file"
  | "write_file"
  | "edit_file"
  | "grep_files"
  | "find_files"
  | "list_directory"
  | "run_shell";

type LoadState = "idle" | "loading" | "loaded" | "error";
type HostContext = NonNullable<ReturnType<App["getHostContext"]>>;

interface ToolResultCard {
  tool: ToolName;
  resultId: string;
  workspaceId?: string;
  path?: string;
  label?: string;
  root?: string;
  status?: string;
  summary?: Record<string, unknown>;
  ui?: {
    card?: string;
    expandable?: boolean;
  };
}

interface ToolContent {
  type: "text" | "image";
  text?: string;
  data?: string;
  mimeType?: string;
}

interface ToolPayload {
  content?: ToolContent[];
  diff?: string;
  patch?: string;
}

interface PayloadResult {
  payload?: ToolPayload;
}

function isToolResultCard(value: unknown): value is ToolResultCard {
  if (!value || typeof value !== "object") return false;

  const candidate = value as Partial<ToolResultCard>;
  return typeof candidate.tool === "string" && typeof candidate.resultId === "string";
}

function getStructuredContent<T>(result: CallToolResult): T | undefined {
  return result.structuredContent as T | undefined;
}

function AppRoot() {
  const appRef = useRef<App | null>(null);
  const [app, setApp] = useState<App | null>(null);
  const [connected, setConnected] = useState(false);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [hostContext, setHostContext] = useState<HostContext | undefined>();
  const [card, setCard] = useState<ToolResultCard | null>(null);
  const [payload, setPayload] = useState<ToolPayload | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [loadState, setLoadState] = useState<LoadState>("idle");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  useEffect(() => {
    if (appRef.current) return;

    const createdApp = new App(
      { name: "pi-on-mcp-tool-cards", version: "0.3.0" },
      {},
    );
    appRef.current = createdApp;

    createdApp.ontoolresult = (result) => {
      const structured = result.structuredContent;
      if (!isToolResultCard(structured)) {
        setCard(null);
        setPayload(null);
        setExpanded(false);
        setLoadState("idle");
        setErrorMessage("No result card is available for this tool result.");
        return;
      }

      setCard(structured);
      setPayload(null);
      setExpanded(false);
      setLoadState("idle");
      setErrorMessage(null);
    };

    createdApp.onhostcontextchanged = (ctx) => {
      setHostContext((current: HostContext | undefined) => ({
        ...current,
        ...ctx,
      }));
    };

    createdApp.onteardown = async () => ({});

    void createdApp
      .connect()
      .then(() => {
        const initialContext = createdApp.getHostContext();
        if (initialContext) setHostContext(initialContext);
        setApp(createdApp);
        setConnected(true);
      })
      .catch((connectError: unknown) => {
        setConnectionError(
          connectError instanceof Error
            ? connectError.message
            : String(connectError),
        );
      });
  }, []);

  useEffect(() => {
    if (hostContext?.theme) applyDocumentTheme(hostContext.theme);
    if (hostContext?.styles?.variables) {
      applyHostStyleVariables(hostContext.styles.variables);
    }
    if (hostContext?.styles?.css?.fonts) {
      applyHostFonts(hostContext.styles.css.fonts);
    }

    const insets = hostContext?.safeAreaInsets;
    if (!insets) return;

    document.body.style.padding = `${insets.top}px ${insets.right}px ${insets.bottom}px ${insets.left}px`;
  }, [hostContext]);

  const themeType: "light" | "dark" =
    hostContext?.theme === "light" ? "light" : "dark";

  const fileOptions = useMemo(
    () => ({
      theme: {
        light: "pierre-light",
        dark: "pierre-dark",
      },
      themeType,
      overflow: "scroll" as const,
      disableFileHeader: true,
    }),
    [themeType],
  );

  const diffOptions = useMemo(
    () => ({
      theme: {
        light: "pierre-light",
        dark: "pierre-dark",
      },
      themeType,
      diffStyle: "unified" as const,
      diffIndicators: "bars" as const,
      hunkSeparators: "line-info" as const,
      lineDiffType: "word-alt" as const,
      overflow: "scroll" as const,
      collapsedContextThreshold: 4,
      expansionLineCount: 20,
      stickyHeader: true,
    }),
    [themeType],
  );

  const loadPayload = useCallback(async () => {
    if (!app || !card || payload || loadState === "loading") return;

    setLoadState("loading");
    setErrorMessage(null);

    try {
      const result = await app.callServerTool({
        name: "get_tool_result_payload",
        arguments: {
          workspaceId: card.workspaceId,
          resultId: card.resultId,
        },
      });
      const structured = getStructuredContent<PayloadResult>(result);
      setPayload(structured?.payload ?? {});
      setLoadState("loaded");
    } catch (payloadError) {
      setErrorMessage(
        payloadError instanceof Error
          ? payloadError.message
          : String(payloadError),
      );
      setLoadState("error");
    }
  }, [app, card, loadState, payload]);

  const toggleExpanded = useCallback(() => {
    setExpanded((nextExpanded) => {
      const shouldExpand = !nextExpanded;
      if (shouldExpand) void loadPayload();
      return shouldExpand;
    });
  }, [loadPayload]);

  if (connectionError) return <EmptyState message={connectionError} tone="error" />;
  if (!connected) return <EmptyState message="Connecting to host..." />;
  if (!card) {
    return (
      <EmptyState
        message={errorMessage ?? "Waiting for a tool result."}
        tone={errorMessage ? "error" : "muted"}
      />
    );
  }

  const display = getToolDisplay(card);
  const expandable = card.ui?.expandable !== false;

  return (
    <main className="shell">
      <section className={`tool-card ${display.tone}`}>
        <button
          className="tool-header"
          type="button"
          aria-expanded={expanded}
          disabled={!expandable}
          onClick={toggleExpanded}
        >
          <span className="tool-icon" aria-hidden="true">
            {display.icon}
          </span>
          <span className="tool-main">
            <span className="tool-title">{display.title}</span>
            <span className="tool-label" title={display.label}>
              {display.label}
            </span>
          </span>
          <SummaryBadges card={card} />
          <ChevronIcon expanded={expanded} visible={expandable} />
        </button>

        {expanded ? (
          <div className="tool-body">
            <ToolPayloadView
              card={card}
              payload={payload}
              loadState={loadState}
              errorMessage={errorMessage}
              fileOptions={fileOptions}
              diffOptions={diffOptions}
            />
          </div>
        ) : null}
      </section>
    </main>
  );
}

function ToolPayloadView({
  card,
  payload,
  loadState,
  errorMessage,
  fileOptions,
  diffOptions,
}: {
  card: ToolResultCard;
  payload: ToolPayload | null;
  loadState: LoadState;
  errorMessage: string | null;
  fileOptions: React.ComponentProps<typeof File>["options"];
  diffOptions: React.ComponentProps<typeof PatchDiff>["options"];
}) {
  if (loadState === "loading") return <StatusLine message="Loading details..." />;
  if (loadState === "error") {
    return <StatusLine message={errorMessage ?? "Unable to load details."} tone="error" />;
  }

  if (card.tool === "edit_file" || card.tool === "write_file") {
    const patch = payload?.patch || payload?.diff;
    if (!patch) return <StatusLine message="Diff payload is not available." />;

    return <DiffPayload patch={patch} diffOptions={diffOptions} />;
  }

  const text = payloadText(payload);
  if (!text) return <StatusLine message="No details available." />;

  if (card.tool === "read_file") {
    return (
      <FilePayload
        path={card.path ?? card.label ?? "file"}
        resultId={card.resultId}
        text={text}
        fileOptions={fileOptions}
      />
    );
  }

  return <pre className={`text-payload ${card.tool}`}>{text}</pre>;
}

function FilePayload({
  path,
  resultId,
  text,
  fileOptions,
}: {
  path: string;
  resultId: string;
  text: string;
  fileOptions: React.ComponentProps<typeof File>["options"];
}) {
  return (
    <File
      file={{
        name: path,
        contents: text,
        cacheKey: `${resultId}:${path}`,
      }}
      options={fileOptions}
      className="pierre-file"
      disableWorkerPool
    />
  );
}

function DiffPayload({
  patch,
  diffOptions,
}: {
  patch: string;
  diffOptions: React.ComponentProps<typeof PatchDiff>["options"];
}) {
  return (
    <PatchDiff
      patch={patch}
      options={diffOptions}
      className="pierre-diff"
      disableWorkerPool
    />
  );
}

function SummaryBadges({ card }: { card: ToolResultCard }) {
  const summary = card.summary ?? {};

  if (card.tool === "edit_file") {
    return (
      <span className="stats" aria-label="Diff statistics">
        <span className="add">+{String(summary.additions ?? 0)}</span>
        <span className="remove">-{String(summary.removals ?? 0)}</span>
      </span>
    );
  }

  if (card.tool === "open_workspace") {
    return <span className="badge">{String(summary.agentsFiles ?? 0)} AGENTS</span>;
  }

  if (card.tool === "run_shell") {
    return <span className="badge">{String(summary.lines ?? 0)} lines</span>;
  }

  if (card.tool === "grep_files" || card.tool === "find_files") {
    return <span className="badge">{String(summary.lines ?? 0)} lines</span>;
  }

  if (card.tool === "write_file") {
    return <span className="badge">{String(summary.lines ?? 0)} lines</span>;
  }

  return <span className="badge">{String(summary.lines ?? 0)} lines</span>;
}

function getToolDisplay(card: ToolResultCard): {
  icon: ReactNode;
  title: string;
  label: string;
  tone: string;
} {
  const label = card.label ?? card.path ?? card.root ?? card.tool;

  switch (card.tool) {
    case "open_workspace":
      return { icon: <FolderIcon />, title: "Workspace", label, tone: "workspace" };
    case "read_file":
      return { icon: <FileIcon />, title: "Read File", label, tone: "read" };
    case "write_file":
      return { icon: <FilePlusIcon />, title: "Write File", label, tone: "write" };
    case "edit_file":
      return { icon: <EditIcon />, title: "Edit File", label, tone: "edit" };
    case "grep_files":
      return { icon: <SearchIcon />, title: "Grep Files", label, tone: "search" };
    case "find_files":
      return { icon: <FilesIcon />, title: "Find Files", label, tone: "search" };
    case "list_directory":
      return { icon: <ListIcon />, title: "List Directory", label, tone: "directory" };
    case "run_shell":
      return { icon: <TerminalIcon />, title: "Run Shell", label, tone: "shell" };
  }
}

function IconSvg({
  children,
}: {
  children: ReactNode;
}) {
  return (
    <svg
      aria-hidden="true"
      className="icon-svg"
      fill="none"
      viewBox="0 0 24 24"
      stroke="currentColor"
      strokeLinecap="round"
      strokeLinejoin="round"
      strokeWidth="1.8"
    >
      {children}
    </svg>
  );
}

function ChevronIcon({
  expanded,
  visible,
}: {
  expanded: boolean;
  visible: boolean;
}) {
  if (!visible) return <span className="chevron" aria-hidden="true" />;

  return (
    <span className={`chevron ${expanded ? "expanded" : ""}`} aria-hidden="true">
      <IconSvg>
        <path d="m6 9 6 6 6-6" />
      </IconSvg>
    </span>
  );
}

function FolderIcon() {
  return (
    <IconSvg>
      <path d="M3 7.5h6l2 2h10" />
      <path d="M3 7.5v10A2.5 2.5 0 0 0 5.5 20h13a2.5 2.5 0 0 0 2.5-2.5v-8H3" />
    </IconSvg>
  );
}

function FileIcon() {
  return (
    <IconSvg>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M9 13h6" />
      <path d="M9 17h4" />
    </IconSvg>
  );
}

function FilePlusIcon() {
  return (
    <IconSvg>
      <path d="M14 3v5h5" />
      <path d="M6 3h8l5 5v13H6z" />
      <path d="M12 12v6" />
      <path d="M9 15h6" />
    </IconSvg>
  );
}

function EditIcon() {
  return (
    <IconSvg>
      <path d="M4 20h4l11-11a2.8 2.8 0 0 0-4-4L4 16z" />
      <path d="m13.5 6.5 4 4" />
    </IconSvg>
  );
}

function SearchIcon() {
  return (
    <IconSvg>
      <circle cx="11" cy="11" r="6" />
      <path d="m16 16 4 4" />
    </IconSvg>
  );
}

function FilesIcon() {
  return (
    <IconSvg>
      <path d="M8 7V4h9l4 4v10h-3" />
      <path d="M12 4v5h5" />
      <path d="M4 7h9l4 4v10H4z" />
      <path d="M13 7v5h4" />
    </IconSvg>
  );
}

function ListIcon() {
  return (
    <IconSvg>
      <path d="M8 6h12" />
      <path d="M8 12h12" />
      <path d="M8 18h12" />
      <path d="M4 6h.01" />
      <path d="M4 12h.01" />
      <path d="M4 18h.01" />
    </IconSvg>
  );
}

function TerminalIcon() {
  return (
    <IconSvg>
      <path d="m5 7 5 5-5 5" />
      <path d="M12 17h7" />
    </IconSvg>
  );
}

function payloadText(payload: ToolPayload | null): string {
  return (
    payload?.content
      ?.map((item) => {
        if (item.type === "text") return item.text ?? "";
        return `[${item.mimeType ?? "image"} image payload]`;
      })
      .filter(Boolean)
      .join("\n\n") ?? ""
  );
}

function EmptyState({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return (
    <main className="shell">
      <section className={`empty ${tone}`}>{message}</section>
    </main>
  );
}

function StatusLine({
  message,
  tone = "muted",
}: {
  message: string;
  tone?: "muted" | "error";
}) {
  return <div className={`status ${tone}`}>{message}</div>;
}

createRoot(document.querySelector("#app")!).render(<AppRoot />);
