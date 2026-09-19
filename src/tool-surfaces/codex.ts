import * as z from "zod/v4";
import { applyPatch } from "../apply-patch.js";
import {
  MAX_PROCESS_YIELD_MS,
  type ProcessSnapshot,
} from "../process-sessions.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolLogFields,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  resultOutputSchema,
  runLoggedToolOperation,
  textBlock,
} from "./shared.js";

type CodexRegistration = (context: ToolRegistrationContext) => void;

const CODEX_INSTRUCTIONS = `Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function codexInstructions(): string {
  return CODEX_INSTRUCTIONS;
}

export function registerCodexTools(context: ToolRegistrationContext): void {
  for (const register of CODEX_REGISTRATIONS) {
    register(context);
  }
}

const CODEX_REGISTRATIONS: readonly CodexRegistration[] = [
  registerApplyPatchTool,
  registerCodexProcessTools,
];

function processResult(snapshot: ProcessSnapshot): string {
  const status = snapshot.running
    ? `Process running with session ID ${snapshot.sessionId}.`
    : snapshot.signal
      ? `Process exited after signal ${snapshot.signal}.`
      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
  return [
    `Wall time: ${snapshot.wallTimeSeconds.toFixed(4)} seconds`,
    status,
    snapshot.originalTokenCount !== undefined
      ? `Original token count: ${snapshot.originalTokenCount}`
      : undefined,
    "Output:",
    snapshot.output.replace(/\n$/, ""),
  ].filter((line) => line !== undefined).join("\n");
}

function processOutputSchema(): z.ZodRawShape {
  return {
    output: z.string().describe("Command output text, with truncation noted inline when needed."),
    wall_time_seconds: z
      .number()
      .nonnegative()
      .describe("Elapsed wall time spent on this tool call in seconds."),
    session_id: z.number().optional(),
    exit_code: z.number().int().optional(),
    signal: z.string().optional(),
    original_token_count: z
      .number()
      .int()
      .nonnegative()
      .optional()
      .describe("Approximate original token count when output was truncated."),
  };
}

function processToolResponse(snapshot: ProcessSnapshot) {
  const result = processResult(snapshot);
  const content = [textBlock(result)];
  return {
    content,
    structuredContent: {
      output: snapshot.output,
      wall_time_seconds: snapshot.wallTimeSeconds,
      ...(snapshot.sessionId !== undefined ? { session_id: snapshot.sessionId } : {}),
      ...(snapshot.exitCode !== undefined ? { exit_code: snapshot.exitCode } : {}),
      ...(snapshot.signal !== undefined ? { signal: snapshot.signal } : {}),
      ...(snapshot.originalTokenCount !== undefined
        ? { original_token_count: snapshot.originalTokenCount }
        : {}),
    },
  };
}

function registerApplyPatchTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    "apply_patch",
    {
      title: "Apply patch",
      description:
        "Apply one Codex-style patch to add, overwrite, update, delete, or move workspace files. Paths must be relative to the workspace.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        patch: z
          .string()
          .describe(
            "Patch text enclosed by *** Begin Patch and *** End Patch markers.",
          ),
      },
      outputSchema: resultOutputSchema(),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspace_id, patch }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const applied = await runLoggedToolOperation(
        config,
        { tool: "apply_patch", workspaceId },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          return applyPatch(workspace.root, patch);
        },
      );
      const changes = applied.files.map((file) => {
        if (file.operation === "move") {
          return `R ${file.previousPath ?? "?"} -> ${file.path}`;
        }
        const prefix = file.operation === "add"
          ? "A"
          : file.operation === "delete"
            ? "D"
            : "M";
        return `${prefix} ${file.path}`;
      }).join("\n");
      const result = `Success. Updated the following files:\n${changes}`;
      const content = [textBlock(result)];

      return {
        content,
        structuredContent: {
          result,
        },
      };
    },
  );
}

function registerCodexProcessTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces, processSessions } = context;

  server.registerTool(
    "exec_command",
    {
      title: "Execute command",
      description:
        "Run a shell command in a workspace with the user's local permissions. Returns the result when it exits during the yield window, otherwise returns a session_id for write_stdin.",
      inputSchema: {
        workspace_id: z.string().describe(workspaceIdDescription),
        cmd: z.string().min(1).describe("Shell command to execute."),
        tty: z
          .boolean()
          .optional()
          .describe(
            "Allocate a pseudo-terminal for interactive commands. Defaults to false.",
          ),
        workdir: z
          .string()
          .optional()
          .describe(
            "Working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait before returning a running session. Defaults to 10000, maximum 12000. Use write_stdin for work that runs longer.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      cmd,
      tty,
      workdir,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const workingDirectory = workdir;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        {
          tool: "exec_command",
          workspaceId,
          workingDirectory: workingDirectory ?? ".",
          command: cmd,
          commandLength: cmd.length,
        },
        startedAt,
        async () => {
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = await workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          return processSessions.start({
            workspaceId,
            command: cmd,
            cwd,
            workspaceRoot: workspace.root,
            tty,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
        processLogFields,
      );

      return processToolResponse(snapshot);
    },
  );

  server.registerTool(
    "write_stdin",
    {
      title: "Write to process",
      description:
        "Poll or write characters to a process returned by exec_command. Omit chars or pass an empty string to poll. Pass \\u0003 to send Ctrl-C.",
      inputSchema: {
        workspace_id: z
          .string()
          .describe("Workspace identifier used to start the process."),
        session_id: z
          .number()
          .describe("Process session identifier returned by exec_command."),
        chars: z
          .string()
          .optional()
          .describe(
            "Characters to write. Omit or pass an empty string to poll.",
          ),
        yield_time_ms: z
          .number()
          .int()
          .min(0)
          .max(MAX_PROCESS_YIELD_MS)
          .optional()
          .describe(
            "Milliseconds to wait for process output or completion. Maximum 12000; polling defaults to 5000 and interactive writes to 250.",
          ),
        max_output_tokens: z
          .number()
          .int()
          .positive()
          .max(100_000)
          .optional()
          .describe("Approximate output token budget. Defaults to 10000."),
      },
      outputSchema: processOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({
      workspace_id,
      session_id,
      chars,
      yield_time_ms,
      max_output_tokens,
    }) => {
      const startedAt = performance.now();
      const workspaceId = workspace_id;
      const sessionId = session_id;
      const yieldTimeMs = yield_time_ms;
      const maxOutputTokens = max_output_tokens;
      const snapshot = await runLoggedToolOperation(
        config,
        { tool: "write_stdin", workspaceId },
        startedAt,
        async () => {
          await workspaces.getWorkspace(workspaceId);
          return processSessions.write({
            workspaceId,
            sessionId,
            chars,
            yieldTimeMs,
            maxOutputTokens,
          });
        },
        processLogFields,
      );

      return processToolResponse(snapshot);
    },
  );
}

export function processLogFields(result: ProcessSnapshot): Partial<ToolLogFields> {
  const success = result.running || (!result.signal && result.exitCode === 0);
  const termination = result.signal
    ? `Process terminated by signal ${result.signal}.`
    : `Process exited with code ${result.exitCode ?? "unknown"}.`;
  return {
    sessionId: result.sessionId,
    running: result.running,
    exitCode: result.exitCode,
    success,
    ...(success ? {} : { error: termination }),
  };
}
