// Type declarations for advanced-tools.js (local customization, no upstream TypeScript source)
// This file provides type information for the JavaScript module.

export interface AdvancedGuardStore {
  apply(workspaceId: string, root: string, input?: unknown): unknown;
  assertPathAllowed(workspaceId: string, path: string): void;
  assertCommandAllowed(workspaceId: string, command: string): void;
  assertReadAllowed?(workspaceId: string, path: string): void;
  summary(workspaceId: string): { protectedPaths: string[]; blockedCommandPatterns: string[] };
}

// Use `any` for registerAppTool to avoid SDK internal type conflicts.
// The actual function is provided by server.ts at runtime; this is only for type-checking.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type RegisterAppToolFn = (server: any, name: string, descriptor: any, handler: any) => void;

export interface AdvancedToolsDependencies {
  z: typeof import("zod/v4");
  registerAppTool: RegisterAppToolFn;
  workspaces: import("./workspaces.js").WorkspaceRegistry;
  processSessions: import("./process-sessions.js").ProcessSessionManager;
  guards: AdvancedGuardStore;
}

export function createAdvancedGuardStore(): AdvancedGuardStore;

export function registerAdvancedTools(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  server: any,
  dependencies: AdvancedToolsDependencies,
): void;