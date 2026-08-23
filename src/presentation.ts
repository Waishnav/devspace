import * as z from "zod/v4";

export const presentationConfigSchema = z.discriminatedUnion("mode", [
  z.object({ mode: z.literal("off") }),
  z.object({ mode: z.literal("inline") }),
  z.object({ mode: z.literal("change-review") }),
]);

export type PresentationConfig =
  | { mode: "off" }
  | { mode: "inline" }
  | { mode: "change-review" };

export type LegacyWidgetMode = "off" | "changes" | "full";

export type PresentationToolKind =
  | "workspace"
  | "read"
  | "write"
  | "edit"
  | "search"
  | "directory"
  | "shell"
  | "show_changes";

export type PresentationToolGroup = "change-review";
export type WorkspacePresentationBehavior = "initialize-review";

export interface CompiledPresentation {
  widgetKinds: readonly PresentationToolKind[];
  toolGroups: readonly PresentationToolGroup[];
  workspaceBehaviors: readonly WorkspacePresentationBehavior[];
  instructions: string;
}

const INLINE_WIDGET_KINDS: readonly PresentationToolKind[] = [
  "workspace",
  "read",
  "write",
  "edit",
  "search",
  "directory",
  "shell",
  "show_changes",
];

export function presentationFromLegacyWidgetMode(mode: LegacyWidgetMode): PresentationConfig {
  switch (mode) {
    case "off":
      return { mode: "off" };
    case "full":
      return { mode: "inline" };
    case "changes":
      return { mode: "change-review" };
  }
}

export function compilePresentation(config: PresentationConfig): CompiledPresentation {
  switch (config.mode) {
    case "off":
      return {
        widgetKinds: [],
        toolGroups: [],
        workspaceBehaviors: [],
        instructions: "",
      };
    case "inline":
      return {
        widgetKinds: INLINE_WIDGET_KINDS,
        toolGroups: [],
        workspaceBehaviors: [],
        instructions: "",
      };
    case "change-review":
      return {
        widgetKinds: ["workspace", "show_changes"],
        toolGroups: ["change-review"],
        workspaceBehaviors: ["initialize-review"],
        instructions:
          " If the turn successfully modifies files by creating, editing, overwriting, deleting, moving, or applying patches, call show_changes exactly once for that workspace after the final related file change and before your final response so the user can inspect the aggregate diff for that turn. Do not call it after every individual file change; do not skip it because individual file-change tools already returned diffs.",
      };
  }
}
