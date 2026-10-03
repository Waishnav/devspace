import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Unsafe } from "typebox";
import type { LocalAgentMcpLaunch } from "./local-agent-mcp-launch.js";

export function createPiMcpBridgeExtension(launch: LocalAgentMcpLaunch): ExtensionFactory {
  return async (pi) => {
    let client: Client | undefined;
    let started: Promise<void> | undefined;

    const ensureStarted = (): Promise<void> => {
      if (started) return started;
      const attempt = (async () => {
        const transport = new StdioClientTransport({
          command: launch.command,
          args: launch.args,
          cwd: process.cwd(),
          env: stringEnvironment({ ...process.env, ...launch.env }),
          stderr: "pipe",
        });
        const nextClient = new Client({ name: launch.name, version: "1" });
        await nextClient.connect(transport);
        const listed = await nextClient.listTools();
        for (const tool of listed.tools) {
          const registeredName = `mcp__${launch.name}__${tool.name}`;
          const description = tool.description ?? tool.name;
          pi.registerTool({
            name: registeredName,
            label: tool.name,
            description,
            promptSnippet: description.split("\n")[0] ?? tool.name,
            promptGuidelines: [
              `Use ${registeredName} for bounded DevSpace subagent delegation when separate context or specialization materially helps.`,
            ],
            parameters: Unsafe(tool.inputSchema),
            async execute(_toolCallId, params, signal) {
              const result = await nextClient.callTool(
                { name: tool.name, arguments: (params ?? {}) as Record<string, unknown> },
                undefined,
                { signal },
              );
              return {
                content: [{ type: "text", text: formatMcpResult(result.content) }],
                details: { server: launch.name, tool: tool.name },
                ...(result.isError === true ? { isError: true } : {}),
              };
            },
          });
        }
        client = nextClient;
      })();
      started = attempt;
      void attempt.catch(() => {
        if (started === attempt) started = undefined;
      });
      return attempt;
    };

    await ensureStarted().catch(() => undefined);
    pi.on("session_start", async (_event, context) => {
      try {
        await ensureStarted();
      } catch (error) {
        context.ui.notify(
          `DevSpace agent tools unavailable: ${error instanceof Error ? error.message : String(error)}`,
          "warning",
        );
      }
    });
    pi.on("session_shutdown", async () => {
      await client?.close().catch(() => undefined);
      client = undefined;
      started = undefined;
    });
    pi.on("before_agent_start", (event) => ({
      systemPrompt: `${event.systemPrompt}\n\nUse the DevSpace agent tools for bounded delegation when it materially helps. Discover targets before spawning, prefer waiting over polling, and never delegate more write authority than your current mode.`,
    }));

    void client;
  };
}

function stringEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}

function formatMcpResult(content: unknown): string {
  if (!Array.isArray(content)) return JSON.stringify(content ?? null);
  const text = content
    .filter((item): item is { type: "text"; text: string } => (
      Boolean(item)
      && typeof item === "object"
      && (item as { type?: unknown }).type === "text"
      && typeof (item as { text?: unknown }).text === "string"
    ))
    .map((item) => item.text)
    .join("\n\n")
    .trim();
  return text || JSON.stringify(content);
}
