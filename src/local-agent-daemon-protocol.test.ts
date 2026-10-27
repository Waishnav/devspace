import type { WireInput, JsonObject } from "./json-value.js";
import assert from "node:assert/strict";
import test from "node:test";
import {
  decodeAgentRecord,
  decodeAgentWaitResults,
  decodeDaemonHello,
  decodeLocalAgentDaemonRequest,
  decodeLocalAgentDaemonResponse,
  decodeWorkflowCall,
  decodeWorkflowEventList,
  decodeWorkflowRun,
  encodeLocalAgentDaemonResponse,
  LocalAgentDaemonProtocolError,
} from "./local-agent-daemon-protocol.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";

function request(method: string, params: WireInput, extra: JsonObject = {}) {
  return decodeLocalAgentDaemonRequest({
    requestId: "req",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    authToken: "test-secret",
    method,
    params,
    ...extra,
  });
}

const record = {
  id: "agt_1234",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/project",
  worktreePath: "/wt/app-1a2b",
  branch: "devspace/agt_1234",
  profileName: "reviewer",
  providerInstanceId: "codex",
  driver: "codex",
  model: "gpt-work",
  effort: "high",
  writeMode: "read_only",
  providerSessionId: "session-1",
  status: "error",
  latestResponse: "  response whitespace  \n",
  error: "Timed out waiting for the local agent daemon.",
  errorCode: "DAEMON_TIMEOUT",
  errorRetryable: true,
  errorDetail: "429 rate limited",
  latestTurnId: "trn_abc12345",
  createdAt: "now",
  updatedAt: "now",
} as const;

test("requests keep every field the daemon acts on", () => {
  // Hand-written decoders copy fields one by one, so a dropped field is a silent feature break.
  const startParams = {
    agentId: "job-1",
    target: "reviewer",
    prompt: "  keep prompt whitespace  \n",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
    model: "gpt-work",
    effort: "high",
    writeMode: "read_only",
    worktree: { branch: "feature/x" },
  };

  assert.deepEqual({ ...request("agent.start", startParams).params }, startParams);

  const direct = request("agent.start", { target: "reviewer", prompt: "Review this", workspaceRoot: "/tmp/project" });
  assert.equal(direct.method === "agent.start" && direct.params.workspaceId, undefined);

  const hello = request("hello", {}, { configRevision: "provider-config-revision" });
  assert.equal(hello.method === "hello" && hello.configRevision, "provider-config-revision");

  const stop = request("daemon.stop", { ifIdle: true });
  assert.equal(stop.method === "daemon.stop" && stop.params.ifIdle, true);

  const scope = { workspaceId: "ws_test", workspaceRoot: "/tmp/project" };
  const wait = request("agent.wait", { ids: ["agt_one", "agt_two"], scope, timeoutMs: 5_000 });
  assert.ok(wait.method === "agent.wait");
  assert.deepEqual([wait.params.ids, wait.params.timeoutMs], [["agt_one", "agt_two"], 5_000]);

  const agentStop = request("agent.stop", { id: "agt_stop", scope });
  assert.equal(agentStop.method === "agent.stop" && agentStop.params.id, "agt_stop");

  const workflow = request("workflow.run", { ...scope, name: "review", args: { base: "main" }, writeMode: "read_only" });
  assert.ok(workflow.method === "workflow.run");
  assert.deepEqual(workflow.params.args, { base: "main" });

  const events = request("workflow.events", { id: "wfl_test", scope: { workspaceRoot: "/tmp/project" }, after: 12 });
  assert.equal(events.method === "workflow.events" && events.params.after, 12);
});

test("invalid requests are rejected", () => {
  assert.throws(
    () => request("agent.start", { target: "reviewer", prompt: "" }),
    (error: WireInput) => error instanceof LocalAgentDaemonProtocolError && error.code === "INVALID_PARAMS",
  );
  assert.throws(
    () => request("workflow.run", { workspaceRoot: "/tmp/project", name: "review", resume: "wfl_old" }),
    /Exactly one workflow/,
  );
  assert.throws(
    () => request("workflow.wait", { id: "wfl_test", scope: { workspaceRoot: "/tmp/project" }, timeoutMs: 60_001 }),
    /between 0 and 60000/,
  );
});

test("results keep every field and preserve response whitespace", () => {
  assert.deepEqual(decodeAgentRecord(record), record);
  assert.equal(decodeAgentRecord({ ...record, latestResponse: "" }).latestResponse, "");
  assert.equal(decodeAgentRecord({ ...record, workspaceId: undefined }).workspaceId, undefined);

  const waitResults = [
    { id: "agt_one", status: "completed", response: "Done.", turnId: "trn_abc12345", worktree: "/wt/a", branch: "b" },
    { id: "agt_whitespace", status: "completed", response: "  \n" },
    { id: "agt_two", status: "running", wait: "timeout" },
    { id: "agt_three", status: "failed", error: { code: "PROVIDER_EXECUTION_ERROR", message: "Failed.", retryable: true } },
  ];

  assert.deepEqual(decodeAgentWaitResults(waitResults), waitResults);

  const hello = {
    status: {
      state: "ready",
      protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
      pid: 123,
      endpoint: "/tmp/agentd.sock",
      startedAt: "now",
      activeTurns: 0,
      runtimeCount: 0,
      clientConnections: 1,
    },
    configMatches: false,
  };

  assert.deepEqual(decodeDaemonHello(hello), hello);

  assert.equal(decodeWorkflowRun({
    id: "wfl_test",
    workspaceRoot: "/tmp/project",
    name: "review",
    status: "running",
    writeMode: "read_only",
    concurrency: 2,
    createdAt: "now",
    updatedAt: "now",
    callCount: 1,
  }).concurrency, 2);
  assert.equal(decodeWorkflowCall({
    runId: "wfl_test",
    index: 0,
    agentId: "agt_test",
    status: "running",
    prompt: "Review this",
    options: { target: "reviewer" },
    fingerprint: "fingerprint",
    workspaceRoot: "/tmp/project",
    createdAt: "now",
    updatedAt: "now",
  }).options.target, "reviewer");
  const workflowEvents = [{ sequence: 13, runId: "wfl_test", type: "phase_started", data: { phase: "review" }, createdAt: "now" }];
  assert.deepEqual(decodeWorkflowEventList(workflowEvents), workflowEvents);
});

test("error responses survive an encode and decode round trip", () => {
  const error = {
    code: "PROVIDER_UNAVAILABLE",
    message: "Codex executable was not found.",
    retryable: false,
    provider: "codex",
    agentId: "agt_1234",
    workspaceId: "ws_test",
    target: "reviewer",
    operation: "create_runtime",
  } as const;

  const response = decodeLocalAgentDaemonResponse(JSON.parse(encodeLocalAgentDaemonResponse({
    requestId: "req_error",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    ok: false,
    error,
  })));

  assert.equal(response.ok, false);
  assert.deepEqual(!response.ok && response.error, error);
});
