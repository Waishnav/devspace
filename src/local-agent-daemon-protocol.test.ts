import assert from "node:assert/strict";
import {
  decodeAgentRecord,
  decodeAgentWaitResults,
  decodeDaemonHello,
  decodeLocalAgentDaemonRequest,
  decodeLocalAgentDaemonResponse,
  encodeLocalAgentDaemonResponse,
  LocalAgentDaemonProtocolError,
} from "./local-agent-daemon-protocol.js";
import { LOCAL_AGENT_DAEMON_PROTOCOL_VERSION } from "./local-agent-daemon-lifecycle.js";

const request = decodeLocalAgentDaemonRequest({
  requestId: "req_1",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "Review this",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
    writeMode: "read_only",
  },
});
assert.equal(request.method, "agent.start");
if (request.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(request.params.writeMode, "read_only");

const whitespaceRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_whitespace",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "  keep prompt whitespace  \n",
    workspaceId: "ws_test",
    workspaceRoot: "/tmp/project",
  },
});
if (whitespaceRequest.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(whitespaceRequest.params.prompt, "  keep prompt whitespace  \n");

const directRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_direct",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.start",
  params: {
    target: "reviewer",
    prompt: "Review this",
    workspaceRoot: "/tmp/project",
  },
});
if (directRequest.method !== "agent.start") throw new Error("expected agent.start request");
assert.equal(directRequest.params.workspaceId, undefined);

const helloRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_hello",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "hello",
  params: {},
  configRevision: "provider-config-revision",
});
assert.equal(helloRequest.method, "hello");
if (helloRequest.method !== "hello") throw new Error("expected hello request");
assert.equal(helloRequest.configRevision, "provider-config-revision");
const conditionalStop = decodeLocalAgentDaemonRequest({
  requestId: "req_stop",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "daemon.stop",
  params: { ifIdle: true },
});
assert.equal(conditionalStop.method, "daemon.stop");
if (conditionalStop.method !== "daemon.stop") throw new Error("expected daemon.stop request");
assert.equal(conditionalStop.params.ifIdle, true);
assert.deepEqual(decodeDaemonHello({
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
}), {
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
});

assert.throws(
  () => decodeLocalAgentDaemonRequest({
    requestId: "req_2",
    protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
    authToken: "test-secret",
    method: "agent.start",
    params: { target: "reviewer", prompt: "" },
  }),
  (error: unknown) => error instanceof LocalAgentDaemonProtocolError && error.code === "INVALID_PARAMS",
);

const record = decodeAgentRecord({
  id: "agt_1234",
  workspaceId: "ws_test",
  workspaceRoot: "/tmp/project",
  profileName: "reviewer",
  provider: "codex",
  status: "idle",
  latestResponse: "  response whitespace  \n",
  createdAt: "now",
  updatedAt: "now",
});
assert.equal(record.id, "agt_1234");
assert.equal(record.latestResponse, "  response whitespace  \n");

const directRecord = decodeAgentRecord({ ...record, workspaceId: undefined });
assert.equal(directRecord.workspaceId, undefined);

const response = decodeLocalAgentDaemonResponse({
  requestId: "req_1",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  ok: true,
  result: record,
});
assert.equal(response.ok, true);

const errorResponse = decodeLocalAgentDaemonResponse(JSON.parse(encodeLocalAgentDaemonResponse({
  requestId: "req_error",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  ok: false,
  error: {
    code: "PROVIDER_UNAVAILABLE",
    message: "Codex executable was not found.",
    retryable: false,
    provider: "codex",
    agentId: "agt_1234",
    operation: "create_runtime",
  },
}))) ;
assert.equal(errorResponse.ok, false);
if (!errorResponse.ok) {
  assert.equal(errorResponse.error.code, "PROVIDER_UNAVAILABLE");
  assert.equal(errorResponse.error.retryable, false);
  assert.equal(errorResponse.error.provider, "codex");
  assert.equal(errorResponse.error.agentId, "agt_1234");
  assert.equal(errorResponse.error.operation, "create_runtime");
}

const failedRecord = decodeAgentRecord({
  id: "agt_error",
  workspaceId: "ws_error",
  workspaceRoot: "/tmp/project",
  profileName: "reviewer",
  provider: "codex",
  status: "error",
  error: "Timed out waiting for the local agent daemon.",
  errorCode: "DAEMON_TIMEOUT",
  errorRetryable: true,
  createdAt: "now",
  updatedAt: "now",
});
assert.equal(failedRecord.errorCode, "DAEMON_TIMEOUT");
assert.equal(failedRecord.errorRetryable, true);

const waitRequest = decodeLocalAgentDaemonRequest({
  requestId: "req_wait",
  protocolVersion: LOCAL_AGENT_DAEMON_PROTOCOL_VERSION,
  authToken: "test-secret",
  method: "agent.wait",
  params: {
    ids: ["agt_one", "agt_two"],
    scope: { workspaceId: "ws_test", workspaceRoot: "/tmp/project" },
    timeoutMs: 5_000,
  },
});
assert.equal(waitRequest.method, "agent.wait");
if (waitRequest.method !== "agent.wait") throw new Error("expected agent.wait request");
assert.deepEqual(waitRequest.params.ids, ["agt_one", "agt_two"]);
assert.equal(waitRequest.params.timeoutMs, 5_000);

assert.deepEqual(decodeAgentWaitResults([
  { id: "agt_one", status: "completed", response: "Done." },
  { id: "agt_empty", status: "completed", response: "" },
  { id: "agt_whitespace", status: "completed", response: "  \n" },
  { id: "agt_two", status: "running", wait: "timeout" },
  {
    id: "agt_three",
    status: "failed",
    error: { code: "PROVIDER_EXECUTION_ERROR", message: "Failed.", retryable: true },
  },
]), [
  { id: "agt_one", status: "completed", response: "Done." },
  { id: "agt_empty", status: "completed", response: "" },
  { id: "agt_whitespace", status: "completed", response: "  \n" },
  { id: "agt_two", status: "running", wait: "timeout" },
  {
    id: "agt_three",
    status: "failed",
    error: { code: "PROVIDER_EXECUTION_ERROR", message: "Failed.", retryable: true },
  },
]);
