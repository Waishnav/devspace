import { createRequire } from "node:module";
import { createServer as createNetServer } from "node:net";
import { terminateProcessTree } from "./process-platform.js";

const OPENCODE_SERVER_HOSTNAME = "127.0.0.1";
const OPENCODE_SERVER_START_TIMEOUT_MS = 5_000;
const OPENCODE_SERVER_START_ATTEMPTS = 3;
const require = createRequire(import.meta.url);
const spawn = require("cross-spawn") as typeof import("node:child_process").spawn;

export interface OpencodeServerLike {
  close(): void;
}

export interface StartedOpencodeServer extends OpencodeServerLike {
  url: string;
}

export async function startOpencodeServer(env: NodeJS.ProcessEnv): Promise<StartedOpencodeServer> {
  for (let attempt = 1; attempt <= OPENCODE_SERVER_START_ATTEMPTS; attempt += 1) {
    const port = await allocateOpencodePort();
    try {
      return await launchOpencodeServer(env, port);
    } catch (error) {
      if (attempt === OPENCODE_SERVER_START_ATTEMPTS || !await isOpencodePortInUse(port)) throw error;
    }
  }
  throw new Error("OpenCode server failed to start.");
}

async function launchOpencodeServer(env: NodeJS.ProcessEnv, port: number): Promise<StartedOpencodeServer> {
  const detached = process.platform !== "win32";
  const child = spawn("opencode", [
    "serve",
    `--hostname=${OPENCODE_SERVER_HOSTNAME}`,
    `--port=${port}`,
  ], {
    detached,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    terminateProcessTree(child, "SIGTERM", detached);
  };
  const url = await new Promise<string>((resolve, reject) => {
    let output = "";
    let ready = false;
    const timer = setTimeout(() => {
      if (ready) return;
      close();
      reject(new Error(`Timeout waiting for OpenCode server after ${OPENCODE_SERVER_START_TIMEOUT_MS}ms`));
    }, OPENCODE_SERVER_START_TIMEOUT_MS);
    timer.unref();
    const inspect = (chunk: Buffer | string) => {
      if (ready) return;
      output += chunk.toString();
      for (const line of output.split("\n")) {
        const match = line.match(/(?:opencode )?server listening on\s+(https?:\/\/[^\s]+)/);
        if (!match?.[1]) continue;
        ready = true;
        clearTimeout(timer);
        resolve(match[1]);
        return;
      }
    };
    child.stdout?.on("data", inspect);
    child.stderr?.on("data", inspect);
    child.once("error", (error) => {
      if (ready) return;
      clearTimeout(timer);
      close();
      reject(error);
    });
    child.once("exit", (code) => {
      if (ready) return;
      clearTimeout(timer);
      close();
      reject(new Error(`OpenCode server exited with code ${code}${output.trim() ? `\n${output.trim()}` : ""}`));
    });
  });
  return { url, close };
}

async function allocateOpencodePort(): Promise<number> {
  const server = createNetServer();
  server.unref();
  return new Promise<number>((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: OPENCODE_SERVER_HOSTNAME, port: 0, exclusive: true }, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        server.close();
        reject(new Error("Failed to allocate an OpenCode server port."));
        return;
      }
      server.close((error) => error ? reject(error) : resolve(address.port));
    });
  });
}

async function isOpencodePortInUse(port: number): Promise<boolean> {
  const server = createNetServer();
  server.unref();
  return new Promise<boolean>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") resolve(true);
      else reject(error);
    });
    server.listen({ host: OPENCODE_SERVER_HOSTNAME, port, exclusive: true }, () => {
      server.close((error) => error ? reject(error) : resolve(false));
    });
  });
}
