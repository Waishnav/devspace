import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { databasePath } from "../src/db/client.js";
import { WorkflowStore } from "../src/workflow-store.js";
import type { WorkflowRunRecord } from "../src/workflow-types.js";

const FIXTURE_VERSION = "large-v1";
const WORKFLOW_NAME = "Ship multi-service authentication";

const fixtureNames = [
  "empty",
  "starting",
  "running",
  "phased-running",
  "replayed",
  "call-failed",
  "completed",
  "failed",
  "cancelled",
] as const;

type FixtureName = (typeof fixtureNames)[number];

interface FixtureResult {
  name: FixtureName;
  stateDir: string;
  run?: WorkflowRunRecord;
}

const { values } = parseArgs({
  options: {
    state: { type: "string", default: "all" },
    "state-dir": { type: "string" },
    "workspace-root": { type: "string" },
  },
  strict: true,
});

const requestedState = values.state;
const selectedFixtures = requestedState === "all"
  ? [...fixtureNames]
  : fixtureNames.includes(requestedState as FixtureName)
    ? [requestedState as FixtureName]
    : fail(`Unknown fixture state: ${requestedState}. Use all or one of: ${fixtureNames.join(", ")}`);
const fixtureRoot = resolve(
  values["state-dir"] ?? join(tmpdir(), "devspace-workflow-tui-fixtures"),
);
const workspaceRoot = resolve(values["workspace-root"] ?? process.cwd());

const results = selectedFixtures.map((name) => seedFixture(name, fixtureRoot, workspaceRoot));

console.log(`Workflow TUI fixtures for ${workspaceRoot}`);
console.log("");
for (const result of results) {
  console.log(`${result.name}:`);
  console.log(`  database: ${databasePath(result.stateDir)}`);
  if (result.run) console.log(`  run: ${result.run.id}`);
  const runArgument = result.run && !["starting", "running"].includes(result.run.status)
    ? ` ${result.run.id}`
    : "";
  console.log(
    `  DEVSPACE_STATE_DIR=${JSON.stringify(result.stateDir)} DEVSPACE_WORKFLOWS=1 devspace workflow tui${runArgument}`,
  );
  console.log("");
}

function seedFixture(
  name: FixtureName,
  root: string,
  workspace: string,
): FixtureResult {
  const stateDir = join(root, name);
  const store = new WorkflowStore(stateDir);
  try {
    if (name === "empty") return { name, stateDir };

    const scriptHash = `workflow-tui-fixture:${name}:${FIXTURE_VERSION}`;
    const existing = store
      .listRunsForWorkspace(workspace)
      .find((run) => run.scriptHash === scriptHash);
    if (existing) return { name, stateDir, run: existing };

    const run = store.createRun({
      name: WORKFLOW_NAME,
      source: name === "replayed" ? "resume" : "inline",
      scriptPath: join(stateDir, "fixtures", `${name}.js`),
      scriptHash,
      workspaceRoot: workspace,
      resumedFromRunId: name === "replayed" ? "wfr_previous_fixture" : undefined,
    });

    if (name === "starting") return { name, stateDir, run };

    store.claimRun(run.id, process.pid);
    store.appendEvent({
      runId: run.id,
      type: "run_started",
      data: { name: run.name, scriptHash, concurrency: 2 },
    });

    if (name === "running") {
      startPhase(store, run.id, "Discovery");
      addCompletedCall(store, run.id, 0, "Discovery", "Map authentication services", "codex");
      addCompletedCall(store, run.id, 1, "Discovery", "Audit token storage", "claude");
      startCall(store, run.id, 2, "Trace client login flows", "codex", "Discovery");
      startCall(store, run.id, 3, "Inventory migration risks", "claude", "Discovery");
    } else if (name === "phased-running") {
      addCompletedPhase(store, run.id, "Discovery", 0, [
        ["Map authentication services", "codex"],
        ["Audit token storage", "claude"],
        ["Trace client login flows", "codex"],
      ]);
      addCompletedPhase(store, run.id, "Architecture", 3, [
        ["Design session boundaries", "claude"],
        ["Plan database migration", "codex"],
      ]);
      startPhase(store, run.id, "Backend implementation");
      startCall(store, run.id, 5, "Implement OAuth store", "codex", "Backend implementation", true);
      startCall(store, run.id, 6, "Add session rotation", "claude", "Backend implementation");
      startCall(store, run.id, 7, "Migrate authentication API", "codex", "Backend implementation", true);
      store.appendEvent({
        runId: run.id,
        type: "log",
        phase: "Backend implementation",
        data: { message: "Running service-level authentication tests" },
      });
    } else if (name === "replayed") {
      startPhase(store, run.id, "Discovery");
      addCachedCall(store, run.id, 0, "Discovery", "Map authentication services", "codex");
      addCachedCall(store, run.id, 1, "Discovery", "Audit token storage", "claude");
      addCachedCall(store, run.id, 2, "Discovery", "Trace client login flows", "codex");
      startPhase(store, run.id, "Architecture");
      addCachedCall(store, run.id, 3, "Architecture", "Design session boundaries", "claude");
      addCachedCall(store, run.id, 4, "Architecture", "Plan database migration", "codex");
      startPhase(store, run.id, "Backend implementation");
      startCall(store, run.id, 5, "Implement OAuth store", "codex", "Backend implementation", true);
      startCall(store, run.id, 6, "Add session rotation", "claude", "Backend implementation");
    } else if (name === "call-failed") {
      addCompletedPhase(store, run.id, "Discovery", 0, [
        ["Map authentication services", "codex"],
        ["Audit token storage", "claude"],
        ["Trace client login flows", "codex"],
      ]);
      addCompletedPhase(store, run.id, "Architecture", 3, [
        ["Design session boundaries", "claude"],
        ["Plan database migration", "codex"],
      ]);
      startPhase(store, run.id, "Backend implementation");
      startCall(store, run.id, 5, "Migrate authentication API", "codex", "Backend implementation", true);
      store.failAgentCall({
        runId: run.id,
        callIndex: 5,
        error: "Provider process exited while updating the API",
        errorKind: "provider",
      });
      startCall(store, run.id, 6, "Implement OAuth store", "claude", "Backend implementation");
      startCall(store, run.id, 7, "Inspect client impact", "codex", "Backend implementation");
    } else if (name === "completed") {
      seedCompletedWorkflow(store, run.id);
      store.completeRun(run.id, { resultJson: JSON.stringify({ ok: true }), callCount: 12 });
    } else if (name === "failed") {
      addCompletedPhase(store, run.id, "Discovery", 0, [
        ["Map authentication services", "codex"],
        ["Audit token storage", "claude"],
      ]);
      addCompletedPhase(store, run.id, "Architecture", 2, [
        ["Design session boundaries", "claude"],
        ["Plan database migration", "codex"],
      ]);
      addCompletedPhase(store, run.id, "Backend implementation", 4, [
        ["Implement OAuth store", "codex"],
        ["Add session rotation", "claude"],
        ["Migrate authentication API", "codex"],
      ]);
      addCompletedPhase(store, run.id, "Frontend integration", 7, [
        ["Update login experience", "claude"],
        ["Handle session expiry", "codex"],
      ]);
      startPhase(store, run.id, "Verification");
      startCall(store, run.id, 9, "Run cross-service integration tests", "claude", "Verification");
      store.failAgentCall({
        runId: run.id,
        callIndex: 9,
        error: "Cross-service integration tests failed",
        errorKind: "internal",
      });
      store.failRun(run.id, {
        error: "Workflow stopped because cross-service integration tests failed",
        errorKind: "internal",
      });
    } else if (name === "cancelled") {
      addCompletedPhase(store, run.id, "Discovery", 0, [
        ["Map authentication services", "codex"],
        ["Audit token storage", "claude"],
        ["Trace client login flows", "codex"],
      ]);
      addCompletedPhase(store, run.id, "Architecture", 3, [
        ["Design session boundaries", "claude"],
        ["Plan database migration", "codex"],
      ]);
      startPhase(store, run.id, "Backend implementation");
      store.cancelRun(run.id, "Cancelled by user");
    }

    return { name, stateDir, run: store.getRun(run.id) ?? run };
  } finally {
    store.close();
  }
}

function startCall(
  store: WorkflowStore,
  runId: string,
  callIndex: number,
  label: string,
  provider: "codex" | "claude",
  phase?: string,
  worktree = false,
): void {
  store.startAgentCall({
    runId,
    callIndex,
    cacheKey: `fixture-${callIndex}`,
    prompt: label,
    provider,
    model: provider === "codex" ? "gpt-5.4" : "sonnet",
    label,
    phase,
    isolation: worktree ? "worktree" : "shared",
    worktreePath: worktree ? `/tmp/devspace-fixture-worktree-${callIndex}` : undefined,
  });
}

function startPhase(store: WorkflowStore, runId: string, phase: string): void {
  store.appendEvent({
    runId,
    type: "phase_started",
    phase,
    data: { title: phase },
  });
}

function addCompletedCall(
  store: WorkflowStore,
  runId: string,
  callIndex: number,
  phase: string,
  label: string,
  provider: "codex" | "claude",
  worktree = false,
): void {
  startCall(store, runId, callIndex, label, provider, phase, worktree);
  store.completeAgentCall({ runId, callIndex, responseText: `${label} completed` });
}

function addCompletedPhase(
  store: WorkflowStore,
  runId: string,
  phase: string,
  firstCallIndex: number,
  calls: ReadonlyArray<readonly [string, "codex" | "claude"]>,
): void {
  startPhase(store, runId, phase);
  calls.forEach(([label, provider], offset) => {
    addCompletedCall(store, runId, firstCallIndex + offset, phase, label, provider, offset % 3 === 2);
  });
}

function addCachedCall(
  store: WorkflowStore,
  runId: string,
  callIndex: number,
  phase: string,
  label: string,
  provider: "codex" | "claude",
): void {
  store.cacheAgentCall({
    runId,
    callIndex,
    cacheKey: `fixture-replayed-${callIndex}`,
    prompt: label,
    provider,
    model: provider === "codex" ? "gpt-5.4" : "sonnet",
    label,
    phase,
    replayMatch: "same_index",
    replayedFromRunId: "wfr_previous_fixture",
    replayedFromCallIndex: callIndex,
    responseText: `${label} reused from the previous run`,
  });
}

function seedCompletedWorkflow(store: WorkflowStore, runId: string): void {
  addCompletedPhase(store, runId, "Discovery", 0, [
    ["Map authentication services", "codex"],
    ["Audit token storage", "claude"],
    ["Trace client login flows", "codex"],
  ]);
  addCompletedPhase(store, runId, "Architecture", 3, [
    ["Design session boundaries", "claude"],
    ["Plan database migration", "codex"],
  ]);
  addCompletedPhase(store, runId, "Backend implementation", 5, [
    ["Implement OAuth store", "codex"],
    ["Add session rotation", "claude"],
    ["Migrate authentication API", "codex"],
  ]);
  addCompletedPhase(store, runId, "Frontend integration", 8, [
    ["Update login experience", "claude"],
    ["Handle session expiry", "codex"],
  ]);
  addCompletedPhase(store, runId, "Verification", 10, [
    ["Run cross-service integration tests", "claude"],
    ["Review security boundaries", "codex"],
  ]);
  startPhase(store, runId, "Release");
  store.appendEvent({
    runId,
    type: "log",
    phase: "Release",
    data: { message: "Authentication rollout is ready" },
  });
}

function fail(message: string): never {
  throw new Error(message);
}
