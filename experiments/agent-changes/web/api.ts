import type { Project, Task, ProposalDiff } from "../src/domain.js";

export interface ProposalResponse {
  proposals: { task: Task; diff: ProposalDiff | null }[];
  overlappingFiles: string[];
}

export async function request<T>(token: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (!response.ok) {
    const error = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `Request failed (${response.status})`);
  }
  return response.json() as Promise<T>;
}

export const endpoints = {
  createProject: (token: string, sourceUrl: string) => request<Project>(token, "/api/projects", { sourceUrl }),
  project: (token: string, id: string) => request<Project>(token, `/api/projects/${id}`),
  compare: (token: string, id: string, prompts: string[]) =>
    request<{ tasks: Task[] }>(token, `/api/projects/${id}/compare`, { prompts }),
  tasks: (token: string, id: string) => request<{ tasks: Task[] }>(token, `/api/projects/${id}/tasks`),
  proposals: (token: string, id: string) => request<ProposalResponse>(token, `/api/projects/${id}/proposals`),
  accept: (token: string, id: string, taskId: string) =>
    request<{ status: "merged" | "conflicted"; commit?: string }>(token, `/api/projects/${id}/accept`, { taskId }),
};
