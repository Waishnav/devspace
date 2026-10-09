import { ProjectCoordinator } from "./project.js";
import { publicGitUrl, repoName, requirePrompt, type Project, type Task } from "./domain.js";
import { TaskAgent, WorkspaceProxy, WorkspaceServiceProxy } from "./task-agent.js";

export { ProjectCoordinator, TaskAgent, WorkspaceProxy, WorkspaceServiceProxy };

type AppEnv = Env & { DEMO_TOKEN: string };
type ProjectStub = DurableObjectStub<ProjectCoordinator>;

function jsonError(error: unknown, status = 400): Response {
  return Response.json({ error: error instanceof Error ? error.message : "Unexpected error" }, { status });
}

function authorized(request: Request, env: AppEnv): boolean {
  const provided = request.headers.get("Authorization");
  return Boolean(env.DEMO_TOKEN && provided === `Bearer ${env.DEMO_TOKEN}`);
}

function projectStub(env: AppEnv, id: string): ProjectStub {
  return env.PROJECTS.get(env.PROJECTS.idFromName(id));
}

async function createProject(request: Request, env: AppEnv): Promise<Response> {
  const body = (await request.json()) as { sourceUrl?: unknown };
  const sourceUrl = publicGitUrl(body.sourceUrl);
  const id = crypto.randomUUID().replaceAll("-", "").slice(0, 16);
  const baseRepo = repoName(id);
  const created = await env.ARTIFACTS.import({
    source: { url: sourceUrl, depth: 1 },
    target: { name: baseRepo, opts: { description: "DevSpace agent changes demo" } },
  });
  // Never return/store credentials in our project metadata; get short-lived tokens per task.
  const project: Project = {
    id, sourceUrl, baseRepo,
    baseRemote: created.remote,
    defaultBranch: created.defaultBranch || "main",
    createdAt: new Date().toISOString(),
  };
  try {
    await projectStub(env, id).create(project);
  } catch (error) {
    await env.ARTIFACTS.delete(baseRepo);
    throw error;
  }
  return Response.json(project, { status: 201 });
}

async function compare(request: Request, env: AppEnv, projectId: string): Promise<Response> {
  const stub = projectStub(env, projectId);
  const project = await stub.load();
  if (!project) return jsonError("Project not found", 404);
  if ((await stub.tasks()).length) return jsonError("V0 supports one comparison per project", 409);

  const body = (await request.json()) as { prompts?: unknown };
  if (!Array.isArray(body.prompts) || body.prompts.length !== 2) {
    return jsonError("Provide exactly two prompts", 400);
  }
  const prompts = body.prompts.map(requirePrompt);

  using source = await env.ARTIFACTS.get(project.baseRepo);
  const baseCommit = (await source.log({ ref: project.defaultBranch, limit: 1 }))[0]?.hash;
  if (!baseCommit) return jsonError("Source repository has no initial commit", 409);

  const tasks: Task[] = [];
  for (const prompt of prompts) {
    const id = crypto.randomUUID().replaceAll("-", "").slice(0, 12);
    const forkRepo = repoName(projectId, id);
    const fork = await source.fork(forkRepo, { defaultBranchOnly: true });
    const task: Task = {
      id, projectId, prompt, forkRepo, forkRemote: fork.remote,
      baseCommit, status: "queued",
    };
    await stub.addTask(task);
    tasks.push(task);
    // The initial token is passed internally to the run DO, never to the browser.
    await env.RUNS.get(env.RUNS.idFromName(id)).start({
      id, projectId, prompt, forkRemote: fork.remote,
      token: fork.token, branch: project.defaultBranch,
    });
  }
  return Response.json({ tasks }, { status: 202 });
}

export default {
  async fetch(request: Request, env: AppEnv): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/health") return Response.json({ ok: true });
    if (url.pathname.startsWith("/api/") && !authorized(request, env)) return jsonError("Unauthorized", 401);
    try {
      if (url.pathname === "/api/projects" && request.method === "POST") return await createProject(request, env);
      const match = /^\/api\/projects\/([a-f0-9]{16})$/.exec(url.pathname);
      if (match && request.method === "GET") {
        const project = await projectStub(env, match[1]).load();
        return project ? Response.json(project) : jsonError("Project not found", 404);
      }
      const comparison = /^\/api\/projects\/([a-f0-9]{16})\/compare$/.exec(url.pathname);
      if (comparison && request.method === "POST") return await compare(request, env, comparison[1]);
      const tasks = /^\/api\/projects\/([a-f0-9]{16})\/tasks$/.exec(url.pathname);
      if (tasks && request.method === "GET") return Response.json({ tasks: await projectStub(env, tasks[1]).tasks() });
      return jsonError("Not found", 404);
    } catch (error) {
      return jsonError(error, error instanceof SyntaxError ? 400 : 502);
    }
  },
} satisfies ExportedHandler<AppEnv>;
