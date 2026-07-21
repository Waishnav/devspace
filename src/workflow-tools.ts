import { fileURLToPath } from "node:url";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAppTool } from "@modelcontextprotocol/ext-apps/server";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import {
  persistWorkflowScript,
  resolveNamedWorkflowScript,
  readWorkflowScriptFile,
} from "./workflow-files.js";
import { parseWorkflowScript } from "./workflow-script.js";
import { createWorkflowStore } from "./workflow-store.js";
import {
  WORKFLOW_MCP_YIELD_MS,
  WORKFLOW_LIMITS,
  type AgentProvidersConfig,
  type WorkflowEventRecord,
  type WorkflowRunRecord,
} from "./workflow-types.js";
import { resolveWorkspaceHead } from "./workflow-worktrees.js";
import { spawnWorkflowWorkerFromCli } from "./workflow-cli.js";
import { getLocalAgentProviderAvailabilitySnapshot } from "./local-agent-availability.js";
import {
  isLocalAgentProvider,
  LOCAL_AGENT_PROVIDERS,
  type LocalAgentProvider,
} from "./local-agent-profiles.js";

const WORKFLOW_API_CHEATSHEET = `
Workflow scripts (JS only):
  export const meta = { name, description, phases?, defaultProvider?, concurrency? }
  agent(prompt, { label?, phase?, schema?, model?, effort?, provider?, isolation?: 'worktree' })
  parallel(thunks) → Array<T|null>   // barrier; throw → null
  pipeline(items, ...stages)        // no cross-item barrier
  phase(title); log(msg); args; budget (stub)
  workflow(name | { scriptPath }, args?)  // nest depth 1
Bans: Date.now(), Math.random(), new Date() without args.
No writeMode — teach RO vs write in prompts; isolation contains writes.
`.trim();

export function registerWorkflowTools(
  server: McpServer,
  config: ServerConfig,
  workspaces: WorkspaceRegistry,
): void {
  if (!config.subagents) return;

  registerAppTool(
    server,
    "run_workflow",
    {
      title: "Run workflow",
      description:
        `Start a DevSpace Dynamic Workflow in an open workspace. Prefer named scripts or short inline scripts. ` +
        `Poll with workflow_status until terminal. Cancel with workflow_cancel. ${WORKFLOW_API_CHEATSHEET}`,
      inputSchema: {
        workspaceId: z.string().describe("Workspace id from open_workspace."),
        script: z
          .string()
          .optional()
          .describe("Inline workflow script source (export const meta = …)."),
        name: z.string().optional().describe("Named workflow under .devspace/workflows/<name>.js"),
        resumeFromRunId: z.string().optional().describe("Prior run id to resume (new run + cache)."),
        args: z.unknown().optional().describe("Args object/array passed to script as `args`."),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(WORKFLOW_MCP_YIELD_MS)
          .optional()
          .describe(`Ms to wait for early completion (default 2000, max ${WORKFLOW_MCP_YIELD_MS}).`),
      },
      annotations: { readOnlyHint: false },
      _meta: {},
    },
    async ({ workspaceId, script, name, resumeFromRunId, args, yieldTimeMs }) => {
      const workspace = workspaces.getWorkspace(workspaceId);
      const store = createWorkflowStore(config);
      try {
        const provided = [script, name, resumeFromRunId].filter((v) => v !== undefined);
        if (provided.length !== 1) {
          throw new Error("Provide exactly one of script, name, or resumeFromRunId");
        }

        let source: string;
        let scriptHash: string;
        let nameHint: string;
        let priorRunId: string | undefined;
        let priorScriptPath: string | undefined;
        let runSource: "inline" | "named" | "resume" = "inline";

        if (resumeFromRunId) {
          const prior = store.getRun(resumeFromRunId);
          if (!prior) throw new Error(`Unknown run: ${resumeFromRunId}`);
          priorRunId = prior.id;
          priorScriptPath = prior.scriptPath;
          const resolved = await readWorkflowScriptFile(prior.scriptPath);
          source = resolved.source;
          scriptHash = prior.scriptHash;
          nameHint = prior.name;
          runSource = "resume";
          if (args === undefined && prior.argsJson && prior.argsJson !== "null") {
            try {
              args = JSON.parse(prior.argsJson);
            } catch {
              // keep undefined
            }
          }
        } else if (name) {
          const resolved = await resolveNamedWorkflowScript({
            name,
            workspaceRoot: workspace.root,
            stateDir: config.stateDir,
          });
          source = resolved.source;
          scriptHash = resolved.scriptHash;
          nameHint = resolved.nameHint;
          runSource = "named";
        } else {
          source = script!;
          const parsed = parseWorkflowScript(source);
          scriptHash = parsed.scriptHash;
          nameHint = parsed.meta.name;
          runSource = "inline";
        }

        const parsed = parseWorkflowScript(source);
        const baseSha = await resolveWorkspaceHead(workspace.root);
        const run = store.createRun({
          name: parsed.meta.name || nameHint,
          source: runSource,
          scriptPath: priorScriptPath ?? "pending",
          scriptHash,
          workspaceRoot: workspace.root,
          workspaceId,
          argsJson: JSON.stringify(args ?? null),
          resumedFromRunId: priorRunId,
          baseSha,
        });

        const persisted =
          priorScriptPath ??
          (await persistWorkflowScript({
            stateDir: config.stateDir,
            runId: run.id,
            source,
            preferredName: parsed.meta.name || nameHint,
          }));
        if (!priorScriptPath) store.setScriptPath(run.id, persisted);

        const cliEntry = fileURLToPath(
          import.meta.url.replace(/workflow-tools\.(ts|js)$/, "cli.$1"),
        );
        spawnWorkflowWorkerFromCli(run.id, cliEntry);

        const yieldMs = yieldTimeMs ?? 2_000;
        const page = await yieldEvents(store, run.id, 0, yieldMs);
        return toolResult(page);
      } finally {
        store.close();
      }
    },
  );

  registerAppTool(
    server,
    "workflow_status",
    {
      title: "Workflow status",
      description: "Drain events for a workflow run; optional long-poll yield.",
      inputSchema: {
        runId: z.string(),
        sinceSeq: z.number().int().min(0).optional(),
        yieldTimeMs: z
          .number()
          .int()
          .min(0)
          .max(WORKFLOW_MCP_YIELD_MS)
          .optional()
          .describe(`Long-poll ms (default 0, max ${WORKFLOW_MCP_YIELD_MS}).`),
      },
      annotations: { readOnlyHint: true },
      _meta: {},
    },
    async ({ runId, sinceSeq, yieldTimeMs }) => {
      const store = createWorkflowStore(config);
      try {
        if (!store.getRun(runId)) throw new Error(`Unknown workflow run: ${runId}`);
        const page = await yieldEvents(store, runId, sinceSeq ?? 0, yieldTimeMs ?? 0);
        return toolResult(page);
      } finally {
        store.close();
      }
    },
  );

  registerAppTool(
    server,
    "workflow_cancel",
    {
      title: "Cancel workflow",
      description: "Request cooperative cancel of a running workflow.",
      inputSchema: {
        runId: z.string(),
      },
      annotations: { readOnlyHint: false },
      _meta: {},
    },
    async ({ runId }) => {
      const store = createWorkflowStore(config);
      try {
        const run = store.requestCancel(runId);
        if (run.pid && (run.status === "running" || run.status === "starting")) {
          try {
            process.kill(run.pid, "SIGTERM");
          } catch {
            // already gone
          }
        }
        const latest = store.getRun(runId)!;
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ runId, status: latest.status }) }],
          structuredContent: { runId, status: latest.status },
        };
      } finally {
        store.close();
      }
    },
  );

  }

async function yieldEvents(
  store: ReturnType<typeof createWorkflowStore>,
  runId: string,
  sinceSeq: number,
  yieldMs: number,
): Promise<{
  run: WorkflowRunRecord;
  events: WorkflowEventRecord[];
  nextSeq: number;
  terminal: boolean;
}> {
  const deadline = Date.now() + Math.min(yieldMs, WORKFLOW_MCP_YIELD_MS);
  let cursor = sinceSeq;
  let events: WorkflowEventRecord[] = [];
  let terminal = false;
  let run = store.getRun(runId)!;

  for (;;) {
    const page = store.drainEvents(runId, cursor, WORKFLOW_LIMITS.eventDrainDefault);
    events = events.concat(page.events);
    cursor = page.nextSeq;
    terminal = page.terminal;
    run = page.run;
    if (terminal || Date.now() >= deadline) break;
    await sleep(250);
  }

  return { run, events, nextSeq: cursor, terminal };
}

function toolResult(page: {
  run: WorkflowRunRecord;
  events: WorkflowEventRecord[];
  nextSeq: number;
  terminal: boolean;
}) {
  const payload = {
    runId: page.run.id,
    status: page.run.status,
    events: page.events.map((e) => ({
      seq: e.seq,
      type: e.type,
      phase: e.phase,
      label: e.label,
      dataJson: e.dataJson,
    })),
    nextSeq: page.nextSeq,
    result: page.run.resultJson ? safeJson(page.run.resultJson) : undefined,
    error: page.run.error,
    errorKind: page.run.errorKind,
  };
  return {
    content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }],
    structuredContent: payload,
  };
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** Resolve enabled ∩ live providers for workflows. */
export function resolveWorkflowEnabledProviders(
  agentProviders: AgentProvidersConfig | undefined,
): LocalAgentProvider[] {
  const snapshot = getLocalAgentProviderAvailabilitySnapshot();
  const live = new Set(
    snapshot.filter((row) => row.available).map((row) => row.name),
  );
  if (!agentProviders) {
    return LOCAL_AGENT_PROVIDERS.filter((id) => live.has(id));
  }
  return agentProviders.enabled.filter(
    (id): id is LocalAgentProvider => isLocalAgentProvider(id) && live.has(id),
  );
}
