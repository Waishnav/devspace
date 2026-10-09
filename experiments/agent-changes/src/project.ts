import { DurableObject } from "cloudflare:workers";
import type { Project, Task } from "./domain.js";

/** The per-project Durable Object is the authority for task and proposal metadata. */
export class ProjectCoordinator extends DurableObject {

  async create(project: Project): Promise<Project> {
    const existing = await this.ctx.storage.get<Project>("project");
    if (existing) throw new Error("Project already exists");
    await this.ctx.storage.put("project", project);
    return project;
  }

  async load(): Promise<Project | null> {
    return (await this.ctx.storage.get<Project>("project")) ?? null;
  }

  async addTask(task: Task): Promise<void> {
    if (await this.ctx.storage.get(`task:${task.id}`)) throw new Error("Duplicate task");
    await this.ctx.storage.put(`task:${task.id}`, task);
  }

  async updateTask(id: string, patch: Partial<Task>): Promise<Task> {
    const current = await this.ctx.storage.get<Task>(`task:${id}`);
    if (!current) throw new Error("Unknown task");
    const updated = { ...current, ...patch, id: current.id, projectId: current.projectId };
    await this.ctx.storage.put(`task:${id}`, updated);
    return updated;
  }

  async tasks(): Promise<Task[]> {
    const entries = await this.ctx.storage.list<Task>({ prefix: "task:", limit: 20 });
    return [...entries.values()];
  }

  async task(id: string): Promise<Task | null> {
    return (await this.ctx.storage.get<Task>(`task:${id}`)) ?? null;
  }
}
