import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = mkdtempSync(join(tmpdir(), "devspace-workflows-cli-test-"));
const project = join(root, "project");
const stateDir = join(root, "state");
const configDir = join(root, "config");
const agentsDir = join(configDir, "agents");
const cliPath = fileURLToPath(new URL("../cli.ts", import.meta.url));
const loaderPath = fileURLToPath(new URL("../../node_modules/tsx/dist/loader.mjs", import.meta.url));
mkdirSync(project, { recursive: true });
mkdirSync(stateDir, { recursive: true });
mkdirSync(agentsDir, { recursive: true });

const profilePath = join(agentsDir, "reviewer.md");
writeProfile(profilePath, "Original immutable profile.");

const baseEnv = {
  ...process.env,
  DEVSPACE_CONFIG_DIR: configDir,
  DEVSPACE_STATE_DIR: stateDir,
  DEVSPACE_ALLOWED_ROOTS: project,
  DEVSPACE_WORKSPACE_ID: "workspace-a",
  DEVSPACE_WORKSPACE_ROOT: project,
  DEVSPACE_SUBAGENTS: "1",
  DEVSPACE_WORKFLOW_FAKE_PROVIDER: "1",
  DEVSPACE_WORKFLOW_FAKE_DELAY_MS: "5000",
};

try {
  const submitted = runCli([
    "workflows", "run", "reviewer", "--prompt", "private task", "--json",
    "--idempotency-key", "shell-parent",
  ], baseEnv);
  assert.equal(submitted.status, 0, `${submitted.stderr}\n${submitted.stdout}`);
  assert.equal(submitted.stdout.trim().split("\n").length, 1, "run stdout must contain one JSON object");
  assert.equal(submitted.stderr, "");
  const runEnvelope = JSON.parse(submitted.stdout) as Envelope;
  assert.equal(runEnvelope.version, 1);
  assert.equal(runEnvelope.ok, true);
  const workflowId = runEnvelope.workflow!.id;
  const replay = runCli([
    "workflows", "run", "reviewer", "--prompt", "private task", "--json",
    "--idempotency-key", "shell-parent",
  ], baseEnv);
  assert.equal(replay.status, 0, replay.stderr);
  assert.equal((JSON.parse(replay.stdout) as Envelope).created, false);

  writeProfile(profilePath, "Mutated after durable submission.");
  const timed = runCli([
    "workflows", "wait", workflowId, "--timeout-ms", "0", "--json",
  ], baseEnv);
  assert.equal(timed.status, 0, timed.stderr);
  const timedEnvelope = JSON.parse(timed.stdout) as Envelope;
  assert.equal(timedEnvelope.timedOut, true, JSON.stringify(timedEnvelope));

  const waited = runCli([
    "workflows", "wait", workflowId, "--timeout-ms", "10000", "--after", "0", "--json",
  ], baseEnv);
  assert.equal(waited.status, 0, waited.stderr);
  const waitEnvelope = JSON.parse(waited.stdout) as Envelope;
  assert.equal(waitEnvelope.workflow!.status, "succeeded");
  assert.equal(
    waitEnvelope.workflow!.definition.nodes[0].config.profileBody,
    "Original immutable profile.",
  );
  assert.ok(waitEnvelope.events!.some((event) => event.type === "provider.session"));
  assert.ok(waitEnvelope.events!.some((event) => event.type === "provider.output"));
  assert.equal(waitEnvelope.cursor, waitEnvelope.events!.at(-1)!.sequence);

  const repeated = runCli([
    "workflows", "wait", workflowId, "--timeout-ms", "5000", "--json",
  ], baseEnv);
  assert.equal(repeated.status, 0, repeated.stderr);
  assert.equal((JSON.parse(repeated.stdout) as Envelope).workflow!.status, "succeeded");

  const denied = runCli([
    "workflows", "status", workflowId, "--json",
  ], { ...baseEnv, DEVSPACE_WORKSPACE_ID: "workspace-b" });
  assert.notEqual(denied.status, 0);
  const deniedEnvelope = JSON.parse(denied.stdout) as Envelope;
  assert.equal(deniedEnvelope.ok, false);
  assert.equal(deniedEnvelope.error!.code, "not_found");

  const invalid = runCli([
    "workflows", "run", "fake", "--json",
  ], baseEnv);
  assert.notEqual(invalid.status, 0);
  assert.equal((JSON.parse(invalid.stdout) as Envelope).error!.code, "invalid_input");
  assert.equal(invalid.stdout.trim().split("\n").length, 1);

  const optionValueAsPositional = runCli([
    "workflows", "run", "--prompt", "reviewer", "--json",
  ], baseEnv);
  assert.notEqual(optionValueAsPositional.status, 0);
  assert.equal((JSON.parse(optionValueAsPositional.stdout) as Envelope).error!.code, "invalid_input");

  const unknownOption = runCli([
    "workflows", "status", workflowId, "--unknown", "value", "--json",
  ], baseEnv);
  assert.notEqual(unknownOption.status, 0);
  assert.equal((JSON.parse(unknownOption.stdout) as Envelope).error!.code, "invalid_input");

  const extraPositional = runCli([
    "workflows", "cancel", workflowId, "extra", "--json",
  ], baseEnv);
  assert.notEqual(extraPositional.status, 0);
  assert.equal((JSON.parse(extraPositional.stdout) as Envelope).error!.code, "invalid_input");

  const conflict = runCli([
    "workflows", "run", "reviewer", "--prompt", "different task", "--json",
    "--idempotency-key", "shell-parent",
  ], baseEnv);
  assert.notEqual(conflict.status, 0);
  assert.equal((JSON.parse(conflict.stdout) as Envelope).error!.code, "idempotency_conflict");
} finally {
  rmSync(root, { recursive: true, force: true });
}

function runCli(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, ["--import", loaderPath, cliPath, ...args], {
    cwd: project,
    env,
    encoding: "utf8",
    timeout: 15_000,
  });
}

function writeProfile(path: string, body: string): void {
  writeFileSync(path, [
    "---",
    "name: reviewer",
    "description: Workflow test reviewer.",
    "provider: codex",
    "model: test-model",
    "thinking: high",
    "---",
    "",
    body,
    "",
  ].join("\n"));
}

interface Envelope {
  version: number;
  ok: boolean;
  created?: boolean;
  timedOut?: boolean;
  cursor?: number;
  workflow?: {
    id: string;
    status: string;
    definition: { nodes: Array<{ config: { profileBody: string } }> };
  };
  events?: Array<{ type: string; sequence: number }>;
  error?: { code: string; message: string };
}
