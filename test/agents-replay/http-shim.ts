import { spawn } from "node:child_process";
import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from "node:http";
import { createServer as createNetServer } from "node:net";
import { parseFrame } from "./transcript.js";

/**
 * HTTP transport for providers that run `<command> serve --hostname=H --port=P`
 * and print `... listening on http://H:P` once ready (OpenCode). Frames use the
 * stdio transcript shape:
 *
 * - `in`: `{ id, method, path, body? }`, one per request, with `id` counting
 *   requests and `path` URL-decoded so paths in queries scrub;
 * - `out`: `{ id, status, type, body? }` for a complete response, or
 *   `{ id, status, type, stream: true }`, then one `{ id, event }` per SSE
 *   event and `{ id, end: true }`, for an event stream.
 *
 * Requests may overlap (a long poll stays open while a stop arrives), so the
 * counter `id` is what correlates a response with its request.
 */
export interface HttpRequestFrame {
  id: number;
  method: string;
  path: string;
  body?: unknown;
}

type Append = (dir: "in" | "out", frame: unknown) => void;

export function serveArgs(args: string[]): { hostname: string; port: number } | undefined {
  if (args[0] !== "serve") return undefined;
  const flag = (name: string) => args.find((arg) => arg.startsWith(`--${name}=`))?.slice(name.length + 3);
  const port = Number(flag("port"));
  return Number.isInteger(port) ? { hostname: flag("hostname") ?? "127.0.0.1", port } : undefined;
}

/** Runs the real server on a private port behind a recording reverse proxy on the expected port. */
export async function recordHttp(options: {
  command: string;
  args: string[];
  env: NodeJS.ProcessEnv;
  append: Append;
  fail(message: string): never;
}): Promise<void> {
  const { hostname, port } = serveArgs(options.args)!;
  const privatePort = await freePort(hostname);
  const childArgs = options.args.map((arg) => arg.startsWith("--port=") ? `--port=${privatePort}` : arg);
  const child = spawn(options.command, childArgs, { env: options.env, stdio: ["ignore", "pipe", "inherit"] });
  child.on("error", (error) => options.fail(`Could not start ${options.command}: ${error.message}`));
  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
  for (const signal of ["SIGTERM", "SIGINT"] as const) process.on(signal, () => child.kill(signal));
  const upstream = await new Promise<URL>((resolve) => {
    let output = "";
    child.stdout.on("data", (chunk) => {
      output += chunk.toString();
      const match = output.match(/listening on\s+(https?:\/\/\S+)/);
      if (match?.[1]) resolve(new URL(match[1]));
    });
  });

  let nextId = 0;
  const server = createServer(async (req, res) => {
    const id = ++nextId;
    const body = await readBody(req);
    options.append("in", requestFrame(id, req, body));
    // Uncompressed responses keep transcript bodies readable.
    const { "accept-encoding": _encoding, ...headers } = req.headers;
    const proxied = httpRequest(new URL(req.url ?? "/", upstream), { method: req.method, headers }, (response) => {
      const type = String(response.headers["content-type"] ?? "");
      res.writeHead(response.statusCode ?? 502, response.headers);
      if (type.includes("text/event-stream")) {
        options.append("out", { id, status: response.statusCode, type, stream: true });
        let buffer = "";
        response.on("data", (chunk: Buffer) => {
          res.write(chunk);
          buffer += chunk.toString();
          let boundary: number;
          while ((boundary = buffer.indexOf("\n\n")) >= 0) {
            const event = sseData(buffer.slice(0, boundary));
            buffer = buffer.slice(boundary + 2);
            if (event !== undefined) options.append("out", { id, event });
          }
        });
        response.on("end", () => {
          options.append("out", { id, end: true });
          res.end();
        });
        return;
      }
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => {
        const text = Buffer.concat(chunks);
        options.append("out", { id, status: response.statusCode, type, ...bodyField(text.toString()) });
        res.end(text);
      });
    });
    proxied.on("error", () => res.destroy());
    // A client that gives up on a long poll closes its socket; pass that on.
    res.on("close", () => { if (!res.writableFinished) proxied.destroy(); });
    proxied.end(body);
  });
  server.listen(port, hostname, () => {
    process.stdout.write(`opencode server listening on http://${hostname}:${port}\n`);
  });
}

/**
 * Serves a transcript. `receive` hands each live request frame to the
 * replayer; `respond` delivers the replayer's provider frames to the open
 * response with the same id.
 */
export function replayHttp(options: {
  args: string[];
  receive(frame: HttpRequestFrame): void;
}): { respond(frame: unknown): void } {
  const { hostname, port } = serveArgs(options.args)!;
  const open = new Map<number, ServerResponse>();
  let nextId = 0;
  const server = createServer(async (req, res) => {
    const id = ++nextId;
    open.set(id, res);
    res.on("close", () => open.delete(id));
    options.receive(requestFrame(id, req, await readBody(req)));
  });
  server.listen(port, hostname, () => {
    process.stdout.write(`opencode server listening on http://${hostname}:${port}\n`);
  });
  return {
    respond(frame) {
      const record = frame as { id?: number; status?: number; type?: string; body?: unknown; stream?: boolean; event?: unknown; end?: boolean };
      const res = open.get(Number(record.id));
      if (!res || res.writableEnded) return;
      if (record.status !== undefined) {
        res.writeHead(record.status, record.type ? { "content-type": record.type } : {});
        if (!record.stream) {
          res.end(record.body === undefined ? undefined : typeof record.body === "string" ? record.body : JSON.stringify(record.body));
        }
      } else if (record.event !== undefined) {
        res.write(`data: ${JSON.stringify(record.event)}\n\n`);
      } else if (record.end) {
        res.end();
      }
    },
  };
}

function requestFrame(id: number, req: IncomingMessage, body: Buffer): HttpRequestFrame {
  return { id, method: req.method ?? "GET", path: decodeURIComponent(req.url ?? "/"), ...bodyField(body.toString()) };
}

function bodyField(text: string): { body?: unknown } {
  if (!text) return {};
  const parsed = parseFrame(text);
  return { body: parsed !== null && typeof parsed === "object" && "raw" in parsed ? text : parsed };
}

/** The data of one SSE event, parsed as JSON when it is. */
function sseData(block: string): unknown {
  const data = block.split("\n").filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
  return data ? bodyField(data).body : undefined;
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function freePort(hostname: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createNetServer();
    server.once("error", reject);
    server.listen(0, hostname, () => {
      const address = server.address();
      server.close(() => typeof address === "object" && address ? resolve(address.port) : reject(new Error("no port")));
    });
  });
}
