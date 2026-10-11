import { DurableObject } from "cloudflare:workers";
import { InputError, type Project, type Task } from "./domain.js";

interface Comparison {
  prompts: [string, string];
  taskIds: [string, string];
  phase: "preparing" | "ready";
  leaseUntil: number;
}

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

  /** Stable task IDs make a failed second fork resumable without launching a third agent. */
  async beginComparison(prompts: [string, string], newTaskIds: [string, string]): Promise<
    { state: "busy" | "ready" | "claimed"; taskIds: [string, string] }
  > {
    return this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<Comparison>("comparison");
      if (current && current.prompts.some((p, index) => p !== prompts[index])) {
        throw new InputError("This project already has a different comparison");
      }
      if (current?.phase === "ready") return { state: "ready", taskIds: current.taskIds };
      if (current && current.leaseUntil > Date.now()) return { state: "busy", taskIds: current.taskIds };
      const taskIds = current?.taskIds ?? newTaskIds;
      await storage.put("comparison", {
        prompts, taskIds, phase: "preparing", leaseUntil: Date.now() + 120_000,
      } satisfies Comparison);
      return { state: "claimed", taskIds };
    });
  }

  async finishComparison(success: boolean): Promise<void> {
    await this.ctx.storage.transaction(async (storage) => {
      const current = await storage.get<Comparison>("comparison");
      if (!current) return;
      await storage.put("comparison", {
        ...current, phase: success ? "ready" : "preparing", leaseUntil: 0,
      } satisfies Comparison);
    });
  }

  async claimIntegration(): Promise<boolean> {
    return this.ctx.storage.transaction(async (storage) => {
      const lease = await storage.get<number>("integration:lease");
      if (lease && lease > Date.now()) return false;
      await storage.put("integration:lease", Date.now() + 10 * 60_000);
      return true;
    });
  }

  async releaseIntegration(): Promise<void> {
    await this.ctx.storage.delete("integration:lease");
  }

  async addTask(task: Task): Promise<void> {
    if (await this.ctx.storage.get(`task:${task.id}`)) return;
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
    const entries = await this.ctx.storage.list<Task>({ prefix: "task:", limit: 2 });
    return [...entries.values()];
  }

  async task(id: string): Promise<Task | null> {
    return (await this.ctx.storage.get<Task>(`task:${id}`)) ?? null;
  }
}
