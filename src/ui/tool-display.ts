import {
  isEditTool,
  isPatchTool,
  isReviewTool,
  isShellTool,
  isWriteTool,
  summaryNumber,
  type ToolResultCard,
} from "./card-types.js";
import { toolIcons, type ToolIcon } from "./icons.js";
import { getPatchDisplayParts } from "./patch-display.js";

export interface ToolDisplay {
  icon: ToolIcon;
  title: string;
  label?: string;
  tone: string;
}

export type ToolHeaderSummary =
  | { kind: "diff"; additions: number; removals: number }
  | { kind: "text"; text: string }
  | { kind: "empty" };

export function getToolDisplay(card: ToolResultCard): ToolDisplay {
  switch (card.tool) {
    case "open_workspace":
      return {
        icon: toolIcons.folderOpen,
        title: "Opened workspace",
        label: card.root ?? card.path,
        tone: "workspace",
      };
    case "read":
      return {
        icon: toolIcons.readFile,
        title: "Read file",
        label: card.path,
        tone: "read",
      };
    case "write":
      return {
        icon: toolIcons.writeFile,
        title: "Wrote file",
        label: card.path,
        tone: "write",
      };
    case "edit":
      return {
        icon: toolIcons.editFile,
        title: "Edited file",
        label: card.path,
        tone: "edit",
      };
    case "apply_patch": {
      const display = getPatchDisplayParts(card);
      return {
        icon: patchIcon(display.iconOperation),
        title: display.title,
        label: singleFilePath(card),
        tone: display.tone,
      };
    }
    case "grep":
      return {
        icon: toolIcons.search,
        title: "Searched files",
        label: searchLabel(card),
        tone: "search",
      };
    case "glob": {
      return {
        icon: toolIcons.files,
        title: "Found files",
        label: searchLabel(card),
        tone: "search",
      };
    }
    case "ls":
      return {
        icon: toolIcons.folderTree,
        title: "Listed directory",
        label: card.path,
        tone: "directory",
      };
    case "bash":
    case "exec_command":
      return {
        icon: toolIcons.terminalSquare,
        title: processTitle(card, "command"),
        label: processLabel(card),
        tone: "shell",
      };
    case "write_stdin":
      return {
        icon: toolIcons.terminal,
        title: processTitle(card, "process"),
        label: processLabel(card),
        tone: "shell",
      };
    case "show_changes": {
      const display = getPatchDisplayParts(card);
      return {
        icon: toolIcons.diff,
        title: (card.files?.length ?? 0) > 0 ? display.title : "No changes",
        tone: "review",
      };
    }
  }
}

export function getToolHeaderSummary(card: ToolResultCard): ToolHeaderSummary {
  const summary = card.summary ?? {};

  if (isReviewTool(card.tool) || isPatchTool(card.tool) || isEditTool(card.tool) || isWriteTool(card.tool)) {
    return {
      kind: "diff",
      additions: summaryNumber(summary, "additions") ?? 0,
      removals: summaryNumber(summary, "removals") ?? 0,
    };
  }

  if (card.tool === "open_workspace") {
    const parts = [
      typeof summary.mode === "string" ? summary.mode : undefined,
      countLabel(summaryNumber(summary, "agentsFiles"), "instruction"),
      countLabel(summaryNumber(summary, "skills"), "skill"),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? { kind: "text", text: parts.join(" · ") } : { kind: "empty" };
  }

  if (isShellTool(card.tool)) {
    const parts = [
      countLabel(summaryNumber(summary, "lines"), "line"),
      durationLabel(summaryNumber(summary, "wallTimeMs")),
    ].filter((part): part is string => Boolean(part));
    return parts.length > 0 ? { kind: "text", text: parts.join(" · ") } : { kind: "empty" };
  }

  if (card.tool === "grep" || card.tool === "read" || card.tool === "ls") {
    const lines = countLabel(summaryNumber(summary, "lines"), "line");
    return lines ? { kind: "text", text: lines } : { kind: "empty" };
  }

  return { kind: "empty" };
}

function patchIcon(operation: ReturnType<typeof getPatchDisplayParts>["iconOperation"]): ToolIcon {
  if (operation === "add") return toolIcons.writeFile;
  if (operation === "delete") return toolIcons.deleteFile;
  if (operation === "move") return toolIcons.files;
  return toolIcons.editFile;
}

function singleFilePath(card: ToolResultCard): string | undefined {
  if (card.files?.length === 1) return card.files[0]?.path ?? card.path;
  return undefined;
}

function searchLabel(card: ToolResultCard): string | undefined {
  const pattern = card.summary?.pattern;
  const scope = card.summary?.scope;
  if (typeof pattern !== "string") return card.path;
  return typeof scope === "string" && scope !== "." ? `${pattern} in ${scope}` : pattern;
}

function processTitle(card: ToolResultCard, subject: "command" | "process"): string {
  if (card.summary?.running === true) {
    return subject === "command" ? "Command running" : "Process running";
  }

  const exitCode = summaryNumber(card.summary, "exitCode");
  if (exitCode !== undefined && exitCode !== 0) {
    return subject === "command" ? "Command failed" : "Process failed";
  }

  return subject === "command" ? "Ran command" : "Process finished";
}

function processLabel(card: ToolResultCard): string | undefined {
  const command = card.summary?.command;
  if (typeof command === "string") return command;
  const sessionId = card.summary?.sessionId;
  if (typeof sessionId === "number" || typeof sessionId === "string") {
    return `Session ${String(sessionId)}`;
  }
  return card.path;
}

function countLabel(count: number | undefined, noun: string): string | undefined {
  if (count === undefined) return undefined;
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function durationLabel(durationMs: number | undefined): string | undefined {
  if (durationMs === undefined) return undefined;
  if (durationMs < 1_000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1_000).toFixed(durationMs < 10_000 ? 1 : 0)}s`;
}

