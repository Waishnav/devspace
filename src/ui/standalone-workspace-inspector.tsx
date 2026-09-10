import { createHttpInspectorTransport } from "./inspector/http-transport.js";
import { mountWorkspaceInspector } from "./inspector/workspace-inspector.js";
import "./workspace-app.css";

interface WorkspaceInspectorBootstrap {
  workspaceId: string;
  root: string;
  mode?: "checkout" | "worktree";
}

const root = document.querySelector<HTMLElement>("#app");
if (!root) throw new Error("Missing #app root element.");

const bootstrapElement = document.querySelector<HTMLScriptElement>("#devspace-workspace-bootstrap");
if (!bootstrapElement?.textContent) throw new Error("Missing workspace inspector bootstrap data.");

const bootstrap = JSON.parse(bootstrapElement.textContent) as WorkspaceInspectorBootstrap;
mountWorkspaceInspector(root, {
  workspaceId: bootstrap.workspaceId,
  root: bootstrap.root,
  mode: bootstrap.mode,
  transport: createHttpInspectorTransport(),
  browserBasepath: `/ws/${encodeURIComponent(bootstrap.workspaceId)}`,
});
