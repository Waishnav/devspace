import { ProjectCoordinator } from "./project.js";
import { publicGitUrl, repoName, type Project } from "./domain.js";

export { ProjectCoordinator };

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
      return jsonError("Not found", 404);
    } catch (error) {
      return jsonError(error, error instanceof SyntaxError ? 400 : 502);
    }
  },
} satisfies ExportedHandler<AppEnv>;
