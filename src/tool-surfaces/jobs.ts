import { z } from "zod/v4";
import { DurableJobManager } from "../durable-jobs.js";
import { getRuntimeDiagnostics, resolveProjectEnvironment } from "../runtime-env.js";
import { type ToolRegistrationContext, workspaceIdDescription } from "./types.js";

let jobManagerInstance: DurableJobManager | null = null;

function getJobManager(stateDir: string): DurableJobManager {
  if (!jobManagerInstance) {
    jobManagerInstance = new DurableJobManager(stateDir);
  }
  return jobManagerInstance;
}

export function registerDurableJobTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;
  const jobManager = getJobManager(config.stateDir);

  // 1. devspace_info
  server.registerTool(
    "devspace_info",
    {
      title: "DevSpace Diagnostics Info",
      description:
        "Return read-only runtime diagnostics, DevSpace server version, MCP capabilities, allowed roots, and background job counts. Fast and safe with no secret leakage.",
      inputSchema: {
        workspace_id: z
          .string()
          .optional()
          .describe("Optional workspace_id to inspect project-specific runtime environment."),
      },
      outputSchema: {
        result: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ workspace_id }) => {
      let workspaceRoot: string | undefined;
      if (workspace_id) {
        try {
          const ws = await workspaces.getWorkspace(workspace_id);
          workspaceRoot = ws?.root;
        } catch {}
      }

      const diag = getRuntimeDiagnostics(workspaceRoot);
      const jobs = jobManager.listJobs(workspace_id, 100);
      const activeJobs = jobs.filter((j) => j.status === "running").length;
      const completedJobs = jobs.filter((j) => j.status !== "running").length;

      const safeAllowedRoots = config.allowedRoots || [];
      const info = {
        server: {
          name: "devspace",
          version: "1.1.0",
          protocolVersion: "2024-11-05",
          oauthEnabled: Boolean(config.oauth),
          uptimeSeconds: Math.floor(process.uptime()),
        },
        jobsSubsystem: {
          status: "active",
          activeJobs,
          completedJobs,
          totalTrackedJobs: jobs.length,
          storage: "sqlite",
        },
        workspaces: {
          allowedRoots: safeAllowedRoots,
          inspectedWorkspaceRoot: workspaceRoot || null,
        },
        runtime: diag,
      };

      return {
        content: [{ type: "text", text: JSON.stringify(info, null, 2) }],
        structuredContent: { result: JSON.stringify(info, null, 2) },
      };
    },
  );

  // 2. job_start
  server.registerTool(
    "job_start",
    {
      title: "Start Durable Background Job",
      description:
        "Start an asynchronous, durable background job that runs detached from the HTTP/MCP request lifecycle. Use for long-running commands, tests, builds, and coding agent runs. Survives client disconnects and MCP request timeouts. Returns immediately with a job ID.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        command: z.string().describe("Shell command or coding agent command to run."),
        working_directory: z
          .string()
          .optional()
          .describe("Optional directory relative to the workspace root. Defaults to workspace root."),
        max_runtime_seconds: z
          .number()
          .positive()
          .optional()
          .describe("Maximum allowed execution time in seconds. Defaults to 86400 (24h)."),
      },
      outputSchema: {
        result: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: true,
      },
    },
    async ({ workspace_id, command, working_directory, max_runtime_seconds }) => {
      const workspace = await workspaces.getWorkspace(workspace_id);
      const cwd = workspaces.resolveWorkingDirectory(workspace, working_directory);
      const projectEnv = resolveProjectEnvironment(workspace.root);

      const record = jobManager.startJob({
        workspaceId: workspace_id,
        workspaceRoot: workspace.root,
        command,
        workingDirectory: cwd,
        maxRuntimeSeconds: max_runtime_seconds,
        env: projectEnv,
      });

      const responseText = `Started durable job ${record.id} (PID: ${record.pid}). Status: ${record.status}. Use job_status or job_logs to monitor.`;

      return {
        content: [{ type: "text", text: responseText }],
        structuredContent: { result: JSON.stringify(record, null, 2) },
      };
    },
  );

  // 3. job_status
  server.registerTool(
    "job_status",
    {
      title: "Get Durable Job Status",
      description:
        "Check the current execution status, exit code, termination signal, duration, and error of a durable background job.",
      inputSchema: {
        job_id: z.string().describe("Durable job ID returned by job_start."),
      },
      outputSchema: {
        result: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      const record = jobManager.getJob(job_id);
      if (!record) {
        return {
          isError: true,
          content: [{ type: "text", text: `Error: Job ${job_id} not found.` }],
          structuredContent: { result: `Error: Job ${job_id} not found.` },
        };
      }

      return {
        content: [{ type: "text", text: JSON.stringify(record, null, 2) }],
        structuredContent: { result: JSON.stringify(record, null, 2) },
      };
    },
  );

  // 4. job_logs
  server.registerTool(
    "job_logs",
    {
      title: "Get Durable Job Logs",
      description:
        "Read paginated or tail output logs from a durable background job safely without exceeding MCP response size limits.",
      inputSchema: {
        job_id: z.string().describe("Durable job ID returned by job_start."),
        offset: z.number().nonnegative().optional().describe("Byte offset to start reading from. Defaults to 0."),
        max_bytes: z
          .number()
          .positive()
          .max(524288)
          .optional()
          .describe("Maximum bytes to read. Defaults to 65536, max 524288."),
        tail: z.boolean().optional().describe("If true and offset is 0, read the last maxBytes of the log."),
        max_lines: z.number().positive().optional().describe("Optional limit on number of lines returned."),
      },
      outputSchema: {
        result: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id, offset, max_bytes, tail, max_lines }) => {
      const logs = jobManager.readLogs(job_id, {
        offset,
        maxBytes: max_bytes,
        tail,
        maxLines: max_lines,
      });
      return {
        content: [
          {
            type: "text",
            text: `[Job Logs for ${job_id} (bytes ${offset || 0}-${logs.nextOffset} of ${logs.totalBytes}) hasMore: ${logs.hasMore}]\n\n${logs.content}`,
          },
        ],
        structuredContent: { result: JSON.stringify(logs, null, 2) },
      };
    },
  );

  // 5. job_cancel
  server.registerTool(
    "job_cancel",
    {
      title: "Cancel Durable Job",
      description:
        "Cancel a running durable background job, terminating its full process group / process tree safely.",
      inputSchema: {
        job_id: z.string().describe("Durable job ID returned by job_start."),
      },
      outputSchema: {
        result: z.string(),
      },
      annotations: {
        readOnlyHint: false,
        destructiveHint: true,
        idempotentHint: false,
        openWorldHint: false,
      },
    },
    async ({ job_id }) => {
      const res = jobManager.cancelJob(job_id);
      return {
        isError: !res.success,
        content: [{ type: "text", text: res.message }],
        structuredContent: { result: JSON.stringify(res, null, 2) },
      };
    },
  );

  // 6. job_wait
  server.registerTool(
    "job_wait",
    {
      title: "Wait for Durable Job",
      description:
        "Wait up to a short bounded timeout (default 25 seconds, max 45 seconds) for a durable job to complete. If the job completes within the timeout, returns the final status along with tail logs (verdict / summary) in one turn; otherwise returns the running status so the client can continue polling without timing out the MCP request.",
      inputSchema: {
        job_id: z.string().describe("Durable job ID returned by job_start."),
        timeout_seconds: z
          .number()
          .positive()
          .max(45)
          .optional()
          .describe("Seconds to wait before returning. Defaults to 25, max 45 to prevent client HTTP/SSE timeout dropouts."),
      },
      outputSchema: {
        result: z.string(),
      },
      annotations: {
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
        openWorldHint: false,
      },
    },
    async ({ job_id, timeout_seconds = 25 }) => {
      const maxWaitMs = Math.min(Math.max(1, timeout_seconds), 45) * 1000;
      const pollIntervalMs = 500;
      const startTime = Date.now();

      while (Date.now() - startTime < maxWaitMs) {
        const record = jobManager.getJob(job_id);
        if (!record) {
          return {
            isError: true,
            content: [{ type: "text", text: `Error: Job ${job_id} not found.` }],
            structuredContent: { result: `Error: Job ${job_id} not found.` },
          };
        }
        if (record.status !== "running") {
          const logs = jobManager.readLogs(job_id, { tail: true, maxBytes: 8192 });
          const summary = `Job ${job_id} finished with status: ${record.status}${record.exitCode !== null ? ` (exit code: ${record.exitCode})` : ""}.\n\n--- Output Tail ---\n${logs.content || "(no output)"}`;
          return {
            content: [{ type: "text", text: summary }],
            structuredContent: { result: JSON.stringify({ ...record, tailLogs: logs.content }, null, 2) },
          };
        }
        await new Promise((r) => setTimeout(r, pollIntervalMs));
      }

      const currentRecord = jobManager.getJob(job_id);
      return {
        content: [
          {
            type: "text",
            text: `Wait timed out after ${timeout_seconds}s. Job ${job_id} is still running (PID: ${currentRecord?.pid}). Continue with job_status or job_wait.`,
          },
        ],
        structuredContent: { result: JSON.stringify(currentRecord, null, 2) },
      };
    },
  );
}
