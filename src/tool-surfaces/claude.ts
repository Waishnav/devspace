import * as z from "zod/v4";
import {
  editFileTool,
  runShellTool,
  writeFileTool,
} from "../pi-tools.js";
import {
  OPERATION_ID_DESCRIPTION,
  OPERATION_ID_PATTERN,
  recoverableStructuredContent,
  runRecoverableOperation,
} from "../operation-receipts.js";
import {
  EDIT_TOOL_ANNOTATIONS,
  SHELL_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  toolNames,
  workspaceIdDescription,
  type ToolContent,
  type ToolInstructionContext,
  type ToolRegistrationContext,
} from "./types.js";
import {
  contentText,
  countDiffStats,
  logFailedToolResponse,
  logToolCall,
  resultOutputSchema,
  textBlock,
} from "./shared.js";

const CLAUDE_INSTRUCTIONS = `Use ${toolNames.read} for direct file reads, ${toolNames.edit} for targeted modifications, ${toolNames.write} only for new files or complete rewrites, and ${toolNames.shell} for inspection, tests, builds, and other commands. For each side-effecting call, choose a fresh operationId and reuse that same ID only for an exact retry after an unknown or lost response. Shell commands run with the local user's authority and are not sandboxed; workspace validation only selects their initial working directory. Follow instructions returned by ${toolNames.openWorkspace}; read applicable instruction and skill files before working in their scope.`;

export function claudeInstructions({
  agents,
  skills,
}: ToolInstructionContext): string {
  return `${agents}${skills}${CLAUDE_INSTRUCTIONS}`;
}

export function registerClaudeTools(context: ToolRegistrationContext): void {
  registerClaudeMutationTools(context);
  registerShellTool(context);
}

const CLAUDE_SHELL_DESCRIPTION = `Run a shell command with the local user's authority. Commands are not sandboxed; workspace validation only selects the initial working directory. Use this for file inspection, tests, builds, package scripts, and other commands.`;

interface RecoverableToolResponse {
  content: ToolContent[];
  details?: unknown;
  isError?: boolean;
  structuredContent?: Record<string, unknown>;
}

const operationIdSchema = z
  .string()
  .regex(OPERATION_ID_PATTERN)
  .describe(OPERATION_ID_DESCRIPTION);

function recoverableOutputSchema(extra: z.ZodRawShape = {}): z.ZodRawShape {
  return resultOutputSchema({
    operationId: z.string(),
    operationReplayed: z
      .boolean()
      .describe(
        "True when DevSpace returned the stored result of an earlier identical operation instead of repeating its local side effect.",
      ),
    ...extra,
  });
}

function attachRecoveryMetadata(
  response: RecoverableToolResponse,
  operationId: string,
  replayed: boolean,
): RecoverableToolResponse {
  if (!response.structuredContent) return response;
  return {
    ...response,
    structuredContent: recoverableStructuredContent(
      response.structuredContent,
      operationId,
      replayed,
    ),
  };
}

function registerClaudeMutationTools(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    toolNames.write,
    {
      title: "Write file",
      description: `Create or completely overwrite a file in a workspace. Prefer ${toolNames.edit} for targeted changes to existing files.`,
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        operationId: operationIdSchema,
        path: z
          .string()
          .describe("File path to write, relative to the workspace root."),
        content: z.string().describe("Complete new file content."),
        expectedBeforeHash: z
          .union([
            z.string().regex(/^sha256:[0-9a-f]{64}$/),
            z.literal("missing"),
          ])
          .optional()
          .describe(
            "Optional precondition: sha256:<64 lowercase hex> for the current file contents, or 'missing' if the file must not exist.",
          ),
      },
      outputSchema: recoverableOutputSchema(),
      annotations: WRITE_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, operationId, expectedBeforeHash, ...input }) => {
      const recovered = await runRecoverableOperation<RecoverableToolResponse>({
        workspaceId,
        operationId,
        tool: toolNames.write,
        request: { ...input, expectedBeforeHash },
        execute: async () => {
          const startedAt = performance.now();
          const workspace = await workspaces.getWorkspace(workspaceId);
          workspaces.resolvePath(workspace, input.path);
          const response = await writeFileTool(input, {
            cwd: workspace.root,
            root: workspace.root,
            expectedBeforeHash,
          });

          if (response.isError) {
            logFailedToolResponse(
              config,
              {
                tool: toolNames.write,
                workspaceId,
                path: input.path,
              },
              response.content,
              startedAt,
            );
            return response;
          }

          logToolCall(config, {
            tool: toolNames.write,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            ...response,
            structuredContent: {
              result: contentText(response.content),
            },
          };
        },
      });

      return attachRecoveryMetadata(
        recovered.value,
        operationId,
        recovered.replayed,
      );
    },
  );

  server.registerTool(
    toolNames.edit,
    {
      title: "Edit file",
      description: `Edit one file in a workspace by replacing exact text blocks. Prefer this over ${toolNames.write} for targeted changes. Each oldText must match a unique, non-overlapping region of the original file; merge nearby changes into one edit and keep oldText as small as possible while still unique.`,
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        operationId: operationIdSchema,
        path: z
          .string()
          .describe("File path to edit, relative to the workspace root."),
        edits: z
          .array(
            z.object({
              oldText: z
                .string()
                .describe(
                  "Exact text to replace. Must match uniquely in the original file.",
                ),
              newText: z.string().describe("Replacement text."),
            }),
          )
          .min(1),
        expectedBeforeHash: z
          .string()
          .regex(/^sha256:[0-9a-f]{64}$/)
          .optional()
          .describe(
            "Optional precondition: sha256:<64 lowercase hex> for the current file contents.",
          ),
      },
      outputSchema: recoverableOutputSchema({
        status: z.literal("applied"),
      }),
      annotations: EDIT_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, operationId, expectedBeforeHash, ...input }) => {
      const recovered = await runRecoverableOperation<RecoverableToolResponse>({
        workspaceId,
        operationId,
        tool: toolNames.edit,
        request: { ...input, expectedBeforeHash },
        execute: async () => {
          const startedAt = performance.now();
          const workspace = await workspaces.getWorkspace(workspaceId);
          workspaces.resolvePath(workspace, input.path);
          const response = await editFileTool(input, {
            cwd: workspace.root,
            root: workspace.root,
            expectedBeforeHash,
          });

          if (response.isError) {
            logFailedToolResponse(
              config,
              {
                tool: toolNames.edit,
                workspaceId,
                path: input.path,
              },
              response.content,
              startedAt,
            );
            return response;
          }

          const stats = countDiffStats(
            response.details?.patch ?? response.details?.diff,
          );
          const editResultText = `Edited ${input.path} (+${stats.additions} -${stats.removals}).`;
          const editContent = [textBlock(editResultText)];
          logToolCall(config, {
            tool: toolNames.edit,
            workspaceId,
            path: input.path,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            content: editContent,
            structuredContent: {
              status: "applied",
              result: contentText(editContent),
            },
          };
        },
      });

      return attachRecoveryMetadata(
        recovered.value,
        operationId,
        recovered.replayed,
      );
    },
  );
}

function registerShellTool(context: ToolRegistrationContext): void {
  const { server, config, workspaces } = context;

  server.registerTool(
    toolNames.shell,
    {
      title: "Bash",
      description: CLAUDE_SHELL_DESCRIPTION,
      inputSchema: {
        workspaceId: z.string().describe(workspaceIdDescription),
        operationId: operationIdSchema,
        command: z
          .string()
          .describe("Shell command to execute."),
        workingDirectory: z
          .string()
          .optional()
          .describe(
            "Optional working directory relative to the workspace root. Defaults to the workspace root.",
          ),
        timeout: z
          .number()
          .positive()
          .max(300)
          .optional()
          .describe("Timeout in seconds. Defaults to 30, max 300."),
      },
      outputSchema: recoverableOutputSchema(),
      annotations: SHELL_TOOL_ANNOTATIONS,
    },
    async ({ workspaceId, operationId, workingDirectory, ...input }) => {
      const recovered = await runRecoverableOperation<RecoverableToolResponse>({
        workspaceId,
        operationId,
        tool: toolNames.shell,
        request: { ...input, workingDirectory },
        execute: async () => {
          const startedAt = performance.now();
          const workspace = await workspaces.getWorkspace(workspaceId);
          const cwd = workspaces.resolveWorkingDirectory(
            workspace,
            workingDirectory,
          );
          const response = await runShellTool(input, {
            cwd,
            root: workspace.root,
          });

          if (response.isError) {
            logFailedToolResponse(
              config,
              {
                tool: toolNames.shell,
                workspaceId,
                workingDirectory: workingDirectory ?? ".",
                command: input.command,
                commandLength: input.command.length,
              },
              response.content,
              startedAt,
            );
            return response;
          }

          logToolCall(config, {
            tool: toolNames.shell,
            workspaceId,
            workingDirectory: workingDirectory ?? ".",
            command: input.command,
            commandLength: input.command.length,
            success: true,
            durationMs: Math.round(performance.now() - startedAt),
          });

          return {
            ...response,
            structuredContent: {
              result: contentText(response.content),
            },
          };
        },
      });

      return attachRecoveryMetadata(
        recovered.value,
        operationId,
        recovered.replayed,
      );
    },
  );
}
