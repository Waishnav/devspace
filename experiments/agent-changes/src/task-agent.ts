import { DurableObject } from "cloudflare:workers";
import { Workspace, WorkspaceProxy, WorkspaceServiceProxy, sh, type WorkspaceStub } from "@cloudflare/computer";
import { ContainerBackend, withWorkspaceContainer } from "@cloudflare/computer/backends/container";
import { WorkerShellBackend } from "@cloudflare/computer/backends/worker-shell";
import { createPiTools } from "@cloudflare/computer/tools/pi-ai";
import { createModels, type Message } from "@earendil-works/pi-ai";
import { WORKERS_AI_PROVIDER, workersAI } from "./workers-ai.js";

export { WorkspaceProxy, WorkspaceServiceProxy };

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const PROJECT_DIR = "/workspace/repo";

export interface AgentInput {
  id: string;
  projectId: string;
  prompt: string;
  forkRemote: string;
  token: string;
  branch: string;
}

class AgentBase extends DurableObject<Env> {}

/** Each agent owns its own DO-backed filesystem; Linux compute is replaceable. */
export class TaskAgent extends withWorkspaceContainer(AgentBase) {
  readonly #container = new ContainerBackend({
    id: "container",
    container: () => this,
    workspace: { binding: "RUNS", id: this.ctx.id.toString() },
    egress: { mode: "direct" },
    instance: "standard-2",
  });

  readonly workspace = new Workspace({
    storage: this.ctx.storage as unknown as ConstructorParameters<typeof Workspace>[0]["storage"],
    backends: [
      new WorkerShellBackend({
        id: "shell", loader: this.env.LOADER,
        workspace: { binding: "RUNS", id: this.ctx.id.toString() }, ctx: this.ctx,
      }),
      this.#container,
    ],
  });

  override async fetch(request: Request): Promise<Response> {
    if (new URL(request.url).pathname === "/api") return this.#container.handleFetch(request);
    return new Response("Not found", { status: 404 });
  }

  async __getWorkspaceStub(): Promise<WorkspaceStub> {
    await this.workspace.ready();
    return this.workspace.stub();
  }

  async start(input: AgentInput): Promise<void> {
    if (await this.ctx.storage.get("started")) throw new Error("Agent already started");
    await this.ctx.storage.put("started", true);
    this.ctx.waitUntil(this.execute(input));
  }

  /** Never expose command output from invocations carrying a Git credential. */
  private async git(command: string): Promise<string> {
    const execution = await this.workspace.runtime.exec(command, { backend: "shell", encoding: "utf8" });
    try {
      const result = await execution.result();
      if (result.exitCode !== 0) throw new Error("Git operation failed");
      return result.stdout.trim();
    } finally {
      execution[Symbol.dispose]?.();
    }
  }

  private async execute(input: AgentInput): Promise<void> {
    const coordinator = this.env.PROJECTS.get(this.env.PROJECTS.idFromName(input.projectId));
    try {
      await coordinator.updateTask(input.id, { status: "running" });
      const authorization = `http.extraHeader=Authorization: Bearer ${input.token}`;
      await this.git(sh`git -c ${authorization} clone ${input.forkRemote} ${PROJECT_DIR}`);

      const { tools, execute } = createPiTools({ workspace: this.workspace });
      const models = createModels();
      models.setProvider(workersAI(this.env.AI, MODEL));
      const model = models.getModel(WORKERS_AI_PROVIDER, MODEL);
      if (!model) throw new Error("Model unavailable");

      const messages: Message[] = [{ role: "user", content: input.prompt, timestamp: Date.now() }];
      let response = "";
      for (let turn = 0; turn < 8; turn++) {
        const reply = await models.complete(model, {
          systemPrompt: [
            `You are a coding agent working on a repository at ${PROJECT_DIR}.`,
            "Implement the requested change and verify it using the provided tools.",
            "Use shell for Git and searches, container for native Linux commands and tests.",
            "Keep all edits under /workspace/repo. Do not commit, push, or change remotes.",
            "Never seek or expose credentials.",
          ].join("\n"),
          messages, tools,
        });
        messages.push(reply);
        const calls = reply.content.filter((part) => part.type === "toolCall");
        if (!calls.length) {
          response = reply.content.filter((part) => part.type === "text").map((part) => part.text).join("");
          break;
        }
        for (const call of calls) {
          const result = await execute(call);
          messages.push({
            role: "toolResult", toolCallId: call.id, toolName: call.name,
            content: result.content, isError: result.isError, timestamp: Date.now(),
          });
        }
      }

      await this.git(sh`git -C ${PROJECT_DIR} add -A`);
      const status = await this.workspace.runtime.exec(sh`git -C ${PROJECT_DIR} diff --cached --quiet`, { backend: "shell" });
      const exitCode = (await status.result()).exitCode;
      status[Symbol.dispose]?.();
      if (exitCode !== 1) throw new Error(exitCode === 0 ? "Agent did not change files" : "Unable to inspect changes");
      await this.git(sh`git -C ${PROJECT_DIR} -c ${"user.name=DevSpace Agent"} -c ${"user.email=agent@devspace.invalid"} commit -m ${`Agent proposal ${input.id}`}`);
      const headCommit = await this.git(sh`git -C ${PROJECT_DIR} rev-parse HEAD`);
      await this.git(sh`git -C ${PROJECT_DIR} -c ${authorization} push origin ${`HEAD:${input.branch}`}`);
      await coordinator.updateTask(input.id, {
        status: "completed", headCommit, result: response.slice(0, 4000),
      });
    } catch (error) {
      await coordinator.updateTask(input.id, {
        status: "failed",
        // Avoid returning raw provider and shell errors: some may contain repo credentials.
        error: error instanceof Error && ["Git operation failed", "Agent did not change files", "Model unavailable", "Unable to inspect changes"].includes(error.message)
          ? error.message : "Agent execution failed; inspect Cloudflare logs",
      });
    }
  }
}
