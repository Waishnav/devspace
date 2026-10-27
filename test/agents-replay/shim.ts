import { spawn, spawnSync } from "node:child_process";
import { appendFileSync, closeSync, existsSync, mkdirSync, openSync, readdirSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { recordHttp, replayHttp, serveArgs } from "./http-shim.js";
import { providerDefinition } from "./providers.js";
import { Replayer } from "./replayer.js";
import { parseFrame, readTranscript, scrub, type ScrubContext, type TranscriptMeta } from "./transcript.js";
import { optionalFields, isJsonObject } from "../../src/json-value.js";
import type { JsonObject, JsonValue } from "../../src/json-value.js";

/**
 * A fake provider executable. The conformance runner points a provider's
 * command override at a wrapper that runs this file with:
 *
 * - DEVSPACE_AGENT_SHIM_MODE: `record` (spawn the real provider and tee its
 *   stdio into a transcript) or `replay` (serve the transcript instead);
 * - DEVSPACE_AGENT_SHIM_PROVIDER and DEVSPACE_AGENT_SHIM_SCENARIO;
 * - DEVSPACE_AGENT_SHIM_TRANSCRIPT: transcript path without `.jsonl`;
 * - DEVSPACE_AGENT_SHIM_RUN_DIR: scratch directory for spawn claims and the
 *   failure report the runner prints;
 * - DEVSPACE_AGENT_SHIM_WORKSPACE: the workspace root to scrub and restore;
 * - DEVSPACE_AGENT_SHIM_WORKTREE_ROOT: where `--worktree` checkouts are created.
 *   The provider starts after its worktree exists, so the single entry found
 *   there is scrubbed like the workspace (its name has a random suffix).
 *
 * HTTP providers launched as `<command> serve --port=P` are recorded and
 * replayed over HTTP instead of stdio (see http-shim.ts).
 */
const SHIM_ENV_PREFIX = "DEVSPACE_AGENT_SHIM_";
const MISMATCH_EXIT_CODE = 70;

const env = process.env;
const mode = requiredEnv("MODE");
const provider = providerDefinition(requiredEnv("PROVIDER"));
const scenario = requiredEnv("SCENARIO");
const transcriptBase = requiredEnv("TRANSCRIPT");
const runDir = requiredEnv("RUN_DIR");

const context: ScrubContext = {
  workspace: requiredEnv("WORKSPACE"),
  worktree: findWorktree(env[`${SHIM_ENV_PREFIX}WORKTREE_ROOT`]),
  home: homedir(),
  tmp: tmpdir(),
};

const args = process.argv.slice(2);
const http = provider.http === true && serveArgs(args) !== undefined;

if (args.length === 1 && args[0] === "--version") {
  printVersion();
} else if (mode === "record") {
  record(claimTranscript());
} else if (mode === "replay") {
  replay(claimTranscript());
} else {
  fail(`Unknown shim mode ${mode}.`);
}

function record(path: string): void {
  const command = provider.realCommand();
  const append = startTranscript(path, command);
  const childEnv = Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith(SHIM_ENV_PREFIX)));

  if (http) {
    void recordHttp({ command, args, env: childEnv, append, fail });

    return;
  }

  const appendLine = (dir: "in" | "out", line: string) => {
    if (line.trim()) append(dir, parseFrame(line));
  };

  const child = spawn(command, args, { env: childEnv, stdio: ["pipe", "pipe", "inherit"] });
  child.on("error", (error) => fail(`Could not start ${command}: ${error.message}`));
  // Bytes pass through unchanged; the transcript gets a parsed copy of each line.
  process.stdin.on("data", (chunk) => child.stdin.write(chunk));
  process.stdin.on("end", () => child.stdin.end());
  child.stdin.on("error", () => undefined);
  child.stdout.on("data", (chunk) => process.stdout.write(chunk));
  createInterface({ input: process.stdin }).on("line", (line) => appendLine("in", line));
  createInterface({ input: child.stdout }).on("line", (line) => appendLine("out", line));

  for (const signal of ["SIGTERM", "SIGINT"] as const) {
    process.on(signal, () => child.kill(signal));
  }

  child.on("exit", (code, signal) => process.exit(code ?? (signal ? 128 : 1)));
}

/** Writes the meta line and returns an appender that redacts and scrubs each frame. */
function startTranscript(path: string, command: string): (dir: "in" | "out", frame: JsonValue) => void {
  mkdirSync(dirname(path), { recursive: true });
  const startedAt = Date.now();
  const version = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 10_000 }).stdout?.trim();

  const meta: TranscriptMeta = {
    type: "meta",
    provider: provider.id,
    scenario,
    // SAFETY: Boundary value already validated or constructed to match this type.
    args: scrub(args, context) as string[],
    cwd: scrub(process.cwd(), context) as string,
    ...optionalFields(version ? { version } : undefined),
    recordedAt: new Date().toISOString(),
  };

  writeFileSync(path, `${JSON.stringify(meta)}\n`);

  return (dir, parsed) => {
    const frame = dir === "out" && provider.redactFrame && isRecord(parsed) ? provider.redactFrame(parsed) : parsed;

    if (frame === undefined) return;
    const entry = { dir, ms: Date.now() - startedAt, frame: scrub(frame, context) };
    appendFileSync(path, `${JSON.stringify(entry)}\n`);
  };
}

function replay(path: string): void {
  if (!existsSync(path)) fail(`No recorded transcript at ${path}. Record it with pnpm qa:agents ${provider.id} --record.`);
  const transcript = readTranscript(path);
  const recordedArgs = normalizeArgs(transcript.meta.args);
  // SAFETY: Boundary value already validated or constructed to match this type.
  const liveArgs = normalizeArgs(scrub(args, context) as string[]);

  if (JSON.stringify(recordedArgs) !== JSON.stringify(liveArgs)) {
    fail([
      `${provider.id} was launched with different arguments than recorded in ${path}:`,
      `  expected: ${JSON.stringify(recordedArgs)}`,
      `  actual:   ${JSON.stringify(liveArgs)}`,
    ].join("\n"));
  }

  // SAFETY: Boundary value already validated or constructed to match this type.
  const liveCwd = scrub(process.cwd(), context) as string;

  if (transcript.meta.cwd !== undefined && transcript.meta.cwd !== liveCwd) {
    fail(`${provider.id} was started in a different directory than recorded in ${path}:\n  expected: ${transcript.meta.cwd}\n  actual:   ${liveCwd}`);
  }

  let respond = (frame: JsonValue) => { process.stdout.write(`${JSON.stringify(frame)}\n`); };

  const replayer = new Replayer({
    transcript,
    protocol: provider.protocol,
    context,
    emit: (frame) => {
      trace("out", frame);
      respond(frame);
    },
    fail: (report) => fail(`${path}\n${report}`),
  });

  if (http) {
    respond = replayHttp({
      args,
      receive: (frame) => {
        trace("in", frame);
        replayer.receive(frame);
      },
    }).respond;
    replayer.start();

    return;
  }

  createInterface({ input: process.stdin })
    .on("line", (line) => {
      if (!line.trim()) return;
      trace("in", parseFrame(line));
      replayer.receive(parseFrame(line));
    })
    .on("close", () => {
      replayer.close();
      process.exit(0);
    });
  replayer.start();
}

/** DEVSPACE_AGENT_SHIM_TRACE=1 logs replayed traffic to replay-trace.log in the run directory. */
function trace(dir: "in" | "out", frame: JsonValue): void {
  if (!env[`${SHIM_ENV_PREFIX}TRACE`]) return;
  appendFileSync(join(runDir, "replay-trace.log"), `${new Date().toISOString()} ${dir} ${JSON.stringify(frame).slice(0, 200)}\n`);
}

function printVersion(): void {
  if (mode === "record") {
    const result = spawnSync(provider.realCommand(), ["--version"], { stdio: "inherit" });
    process.exit(result.status ?? 1);
  }

  const path = `${transcriptBase}.jsonl`;
  const version = existsSync(path) ? readTranscript(path).meta.version : undefined;

  if (!version) fail(`${path} has no recorded --version output.`);
  process.stdout.write(`${version}\n`);
  process.exit(0);
}

/** Each provider process in a scenario gets its own transcript, in spawn order. */
function claimTranscript(): string {
  mkdirSync(runDir, { recursive: true });

  for (let index = 1; ; index += 1) {
    try {
      closeSync(openSync(join(runDir, `spawn-${index}`), "wx"));
    } catch (error) {
      // SAFETY: Boundary value already validated or constructed to match this type.
      if ((error as NodeJS.ErrnoException).code === "EEXIST") continue;
      throw error;
    }

    return index === 1 ? `${transcriptBase}.jsonl` : `${transcriptBase}.${index}.jsonl`;
  }
}

function findWorktree(root: string | undefined): string | undefined {
  if (!root || !existsSync(root)) return undefined;
  const [entry] = readdirSync(root);

  return entry ? join(root, entry) : undefined;
}

/** Temporary directories (Pi's sandbox extension) and server ports differ every run. */
function normalizeArgs(values: string[]): string[] {
  return values.map((value) => value.replace(/\$TMP\/[^/\s"]+/g, "$TMP/*").replace(/^--port=\d+$/, "--port=*"));
}

function isRecord(value: unknown): value is JsonObject {
  return value !== null && isJsonObject(value) && !Array.isArray(value);
}

function requiredEnv(name: string): string {
  const value = env[`${SHIM_ENV_PREFIX}${name}`];

  if (!value) fail(`${SHIM_ENV_PREFIX}${name} is not set.`);

  return value!;
}

function fail(message: string): never {
  process.stderr.write(`agents-replay: ${message}\n`);

  try {
    appendFileSync(join(env[`${SHIM_ENV_PREFIX}RUN_DIR`] ?? tmpdir(), "replay-failures.log"), `${message}\n\n`);
  } catch {
    // The report file is best effort; stderr already has the message.
  }

  process.exit(MISMATCH_EXIT_CODE);
}
