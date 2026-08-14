import { homedir } from "node:os";
import {
  CodexAppServerClient,
  type CodexAppServerClientOptions,
} from "./codex-app-server.js";
import { CodexMcpClient } from "./codex-mcp-client.js";
import {
  discoverCodexRuntime,
  type CodexRuntimePaths,
  type DiscoverCodexRuntimeOptions,
} from "./codex-runtime-discovery.js";

export interface CodexRuntimeHostOptions {
  discovery?: DiscoverCodexRuntimeOptions;
  discover?: (options?: DiscoverCodexRuntimeOptions) => Promise<CodexRuntimePaths>;
  createAppServer?: (options: CodexAppServerClientOptions) => CodexAppServerClient;
  onAppServerMethod?: (method: string) => void;
}

export interface SpawnCodexMcpClientInput {
  command: string[];
  cwd?: string;
  env?: Record<string, string | null>;
  clientName: string;
  clientVersion?: string;
  timeoutMs?: number | null;
  outputBytesCap?: number | null;
}

export class CodexRuntimeHost {
  private pathsPromise?: Promise<CodexRuntimePaths>;
  private appServerPromise?: Promise<CodexAppServerClient>;
  private readonly clients = new Set<CodexMcpClient>();
  private closePromise?: Promise<void>;
  private closed = false;

  constructor(private readonly options: CodexRuntimeHostOptions = {}) {}

  async paths(): Promise<CodexRuntimePaths> {
    this.assertOpen();
    this.pathsPromise ??= (this.options.discover ?? discoverCodexRuntime)(
      this.options.discovery,
    );
    return this.pathsPromise;
  }

  async spawnMcpClient(input: SpawnCodexMcpClientInput): Promise<CodexMcpClient> {
    this.assertOpen();
    const [paths, appServer] = await Promise.all([this.paths(), this.appServer()]);
    const process = await appServer.spawnProcess({
      command: input.command,
      cwd: input.cwd ?? paths.codexHome ?? homedir(),
      env: input.env,
      timeoutMs: input.timeoutMs ?? null,
      outputBytesCap: input.outputBytesCap ?? null,
    });
    const client = new CodexMcpClient(process, {
      name: input.clientName,
      version: input.clientVersion ?? "0.1.0",
    });
    this.clients.add(client);
    try {
      await client.start();
      return client;
    } catch (error) {
      this.clients.delete(client);
      await client.close().catch(() => undefined);
      throw error;
    }
  }

  async invalidate(): Promise<void> {
    for (const client of this.clients) {
      await client.close().catch(() => undefined);
    }
    this.clients.clear();
    const appServer = await this.appServerPromise?.catch(() => undefined);
    await appServer?.close().catch(() => undefined);
    this.appServerPromise = undefined;
    this.pathsPromise = undefined;
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async appServer(): Promise<CodexAppServerClient> {
    this.assertOpen();
    this.appServerPromise ??= (async () => {
      const paths = await this.paths();
      const client = (this.options.createAppServer ?? ((options) => new CodexAppServerClient(options)))({
        executable: paths.codexExecutable,
        cwd: paths.codexHome,
        env: {
          CODEX_HOME: paths.codexHome,
        },
        clientName: "devspace",
        clientVersion: "0.1.0",
        onMethod: this.options.onAppServerMethod,
      });
      await client.start();
      return client;
    })();
    return this.appServerPromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    for (const client of this.clients) {
      await client.close().catch(() => undefined);
    }
    this.clients.clear();
    const appServer = await this.appServerPromise?.catch(() => undefined);
    await appServer?.close().catch(() => undefined);
  }

  private assertOpen(): void {
    if (this.closed) throw new Error("Codex runtime host is closed.");
  }
}
