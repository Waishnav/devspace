export interface Project {
  id: string;
  sourceUrl: string;
  baseRepo: string;
  baseRemote: string;
  defaultBranch: string;
  createdAt: string;
}

export interface Task {
  id: string;
  projectId: string;
  prompt: string;
  forkRepo: string;
  forkRemote: string;
  baseCommit: string;
  status: "queued" | "running" | "completed" | "failed";
  result?: string;
  headCommit?: string;
  error?: string;
  integrationStatus?: "pending" | "merged" | "conflicted";
  integratedCommit?: string;
}

export interface ProposalDiff {
  taskId: string;
  files: string[];
  patch: string;
  truncated: boolean;
}

export function publicGitUrl(value: unknown): string {
  if (typeof value !== "string") throw new Error("sourceUrl must be a public HTTPS Git URL");
  const url = new URL(value);
  if (url.protocol !== "https:" || url.username || url.password || url.port || !url.hostname ||
    /^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.|169\.254\.|\[)/i.test(url.hostname)) {
    throw new Error("sourceUrl must be a public HTTPS Git URL");
  }
  // V0 intentionally supports GitHub public repositories only; no server-side arbitrary URL fetches.
  if (url.hostname !== "github.com" || !/^\/[\w.-]+\/[\w.-]+(?:\.git)?\/?$/.test(url.pathname)) {
    throw new Error("V0 accepts public github.com repository URLs only");
  }
  return url.toString();
}

export function repoName(id: string, suffix?: string): string {
  const raw = `dsa-${id}${suffix ? `-${suffix}` : ""}`.toLowerCase();
  if (!/^[a-z0-9-]{1,64}$/.test(raw)) throw new Error("Invalid repository identifier");
  return raw;
}

export function requirePrompt(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 2000) {
    throw new Error("Task must contain 1–2000 characters");
  }
  return value.trim();
}
