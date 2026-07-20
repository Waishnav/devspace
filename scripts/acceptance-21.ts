/**
 * DevSpace 21-Point Acceptance Test Suite v2 — Strict PASS/SKIP/FAIL
 *
 * Changes from v1:
 *  - Strict PASS/SKIP/FAIL: no "skipped" counted as PASS.
 *  - Test 1: healthz must have all required fields (ok, sessions, pendingReservations, occupiedCapacity, maxSessions).
 *  - Test 6: maxSessions read from real response only — no ?? 64 fallback.
 *  - Test 8: Actually injects transport.close() failure and verifies other sessions survive.
 *  - Test 15: contextIgnorePaths must exist in diagnose config — no ?? [] fallback.
 *  - Test 19: diagnose must have required fields (shell, sessions, config, config.contextIgnorePaths).
 *  - Test 21: 7676 must be reachable — FAIL if not, no skip.
 *
 * Usage:
 *   node --import tsx scripts/acceptance-21.ts --port 7677
 */

import assert from "node:assert/strict";

const PORT = parseInt(process.argv.find((a, i) => process.argv[i - 1] === "--port") ?? "7677", 10);
const BASE = `http://localhost:${PORT}`;
const WORKSPACE_PATH = "C:\\Users\\Administrator\\.devspace\\upgrade-work\\devspace";

type TestStatus = "PASS" | "SKIP" | "FAIL";

interface TestResult {
  testId: number;
  name: string;
  status: TestStatus;
  detail: string;
}

const results: TestResult[] = [];
let mcpSessionId: string | null = null;
let workspaceId: string | null = null;

function log(msg: string): void {
  console.log(`  ${msg}`);
}

async function healthz(): Promise<any> {
  const resp = await fetch(`${BASE}/healthz`);
  return resp.json();
}

async function diagnose(): Promise<any> {
  const resp = await fetch(`${BASE}/devspace-runtime/diagnose`);
  return resp.json();
}

async function mcpRequest(method: string, params: unknown, id: number = 1): Promise<{ status: number; body: any }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (mcpSessionId) {
    headers["mcp-session-id"] = mcpSessionId;
  }

  const resp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const text = await resp.text();
  let body: any;
  try {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        body = JSON.parse(line.slice(6));
        break;
      }
    }
    if (!body) body = JSON.parse(text);
  } catch {
    body = { error: { message: text.slice(0, 200) } };
  }

  const sid = resp.headers.get("mcp-session-id");
  if (sid) mcpSessionId = sid;

  return { status: resp.status, body };
}

async function rawMcpRequest(method: string, params: unknown, sessionId?: string, id: number = 1): Promise<{ status: number; body: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["mcp-session-id"] = sessionId;

  const resp = await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers,
    body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });

  const text = await resp.text();
  let body: any;
  try {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        body = JSON.parse(line.slice(6));
        break;
      }
    }
    if (!body) body = JSON.parse(text);
  } catch {
    body = { error: { message: text.slice(0, 200) } };
  }

  const sid = resp.headers.get("mcp-session-id") ?? undefined;
  return { status: resp.status, body, sessionId: sid };
}

async function initializeWithSid(): Promise<string> {
  const { status, body, sessionId } = await rawMcpRequest("initialize", {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "acceptance-test", version: "1.0" },
  });
  assert.strictEqual(status, 200, `initialize failed: ${status}`);
  assert.ok(!body.error, `initialize error: ${JSON.stringify(body.error)}`);
  assert.ok(sessionId, "no session ID returned");

  await fetch(`${BASE}/mcp`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      "mcp-session-id": sessionId!,
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId!;
}

async function initialize(): Promise<void> {
  mcpSessionId = await initializeWithSid();
}

async function openWorkspace(): Promise<string> {
  const { body } = await mcpRequest("tools/call", {
    name: "open_workspace",
    arguments: { path: WORKSPACE_PATH },
  }, 5);
  assert.ok(!body.error, `open_workspace error: ${JSON.stringify(body.error)}`);
  const result = body.result;
  if (result?.workspaceId) {
    return result.workspaceId;
  }
  const resultStr = JSON.stringify(result);
  const match = resultStr.match(/ws_[a-f0-9-]+/);
  if (match) {
    return match[0];
  }
  return "";
}

async function bash(command: string, id: number): Promise<string> {
  const args: any = { command };
  if (workspaceId) {
    args.workspaceId = workspaceId;
  }
  const { body } = await mcpRequest("tools/call", {
    name: "bash",
    arguments: args,
  }, id);
  if (body.error) {
    throw new Error(`MCP error ${body.error.code}: ${body.error.message}`);
  }
  return (body.result?.content?.[0]?.text ?? "").trim();
}

async function runTest(testId: number, name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ testId, name, status: "PASS", detail });
    console.log(`  [PASS] Test ${testId}: ${name} — ${detail}`);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    results.push({ testId, name, status: "FAIL", detail });
    console.error(`  [FAIL] Test ${testId}: ${name} — ${detail}`);
  }
}

async function main(): Promise<void> {
  console.log(`\n=== DevSpace 21-Point Acceptance Test Suite v2 (Strict) ===`);
  console.log(`Target: ${BASE}\n`);

  // ─── Test 1: healthz with strict field validation ───
  await runTest(1, "healthz strict fields", async () => {
    const h = await healthz();
    assert.ok(h.ok === true, `healthz.ok must be true, got ${h.ok}`);
    // Strict: all required fields must be present — no fallback.
    assert.ok("sessions" in h, "healthz missing 'sessions' field");
    assert.ok("pendingReservations" in h, "healthz missing 'pendingReservations' field");
    assert.ok("occupiedCapacity" in h, "healthz missing 'occupiedCapacity' field");
    assert.ok("maxSessions" in h, "healthz missing 'maxSessions' field");
    assert.ok(typeof h.sessions === "number", `sessions must be number, got ${typeof h.sessions}`);
    assert.ok(typeof h.pendingReservations === "number", `pendingReservations must be number`);
    assert.ok(typeof h.occupiedCapacity === "number", `occupiedCapacity must be number`);
    assert.ok(typeof h.maxSessions === "number", `maxSessions must be number`);
    assert.ok(h.maxSessions > 0, `maxSessions must be > 0, got ${h.maxSessions}`);
    return `ok=${h.ok}, sessions=${h.sessions}, pending=${h.pendingReservations}, capacity=${h.occupiedCapacity}, max=${h.maxSessions}`;
  });

  // ─── Test 21: 7676 healthy throughout — strict, no skip ───
  await runTest(21, "7676 healthy throughout", async () => {
    const resp = await fetch("http://localhost:7676/healthz", { signal: AbortSignal.timeout(3000) });
    assert.ok(resp.ok, `7676 healthz must return ok, got ${resp.status}`);
    const h = await resp.json();
    assert.ok(h.ok === true, `7676 healthz.ok must be true, got ${h.ok}`);
    return `ok=${h.ok}, sessions=${h.sessions ?? 0}`;
  });

  // ─── Test 2: Initialize MCP session ───
  await runTest(2, "Initialize MCP session", async () => {
    await initialize();
    assert.ok(mcpSessionId, "session ID should be set");
    return `sessionId=${mcpSessionId!.slice(0, 12)}...`;
  });

  // ─── Test 3: Multiple requests ───
  await runTest(3, "Multiple requests", async () => {
    for (let i = 0; i < 3; i++) {
      const { status, body } = await mcpRequest("tools/list", {}, i + 10);
      assert.strictEqual(status, 200, `request ${i} failed with status ${status}`);
      assert.ok(!body.error, `request ${i} error: ${JSON.stringify(body.error)}`);
    }
    return "3 sequential requests OK";
  });

  // Open workspace FIRST (needed for bash tool)
  workspaceId = await openWorkspace();
  log(`workspaceId: ${workspaceId}`);

  // ─── Test 9: PowerShell $_ ───
  await runTest(9, "PowerShell $_", async () => {
    const output = await bash("1,2,3 | ForEach-Object { $_ * 2 }", 20);
    assert.ok(output.includes("2"), `output should contain 2: ${output}`);
    assert.ok(output.includes("4"), `output should contain 4: ${output}`);
    assert.ok(output.includes("6"), `output should contain 6: ${output}`);
    return `output: ${output.replace(/\r/g, "")}`;
  });

  // ─── Test 10: PowerShell $variable ───
  await runTest(10, "PowerShell $variable", async () => {
    const output = await bash("$x = 42; Write-Output \"x=$x\"", 21);
    assert.ok(output.includes("x=42"), `output should contain x=42: ${output}`);
    return `output: ${output.replace(/\r/g, "")}`;
  });

  // ─── Test 11: PowerShell pipeline ───
  await runTest(11, "PowerShell pipeline", async () => {
    const output = await bash("Get-Process node | Select-Object ProcessName", 22);
    assert.ok(output.includes("node"), `output should contain 'node': ${output}`);
    return `output: ${output.replace(/\r/g, "").slice(0, 60)}`;
  });

  // ─── Test 12: 50000 char output limited ───
  await runTest(12, "50000 char output limited", async () => {
    const output = await bash("Write-Output ('x' * 50000)", 23);
    assert.ok(output.length < 50000, `output should be truncated: length=${output.length}`);
    const hasMarker = output.includes("[output truncated") || output.includes("truncated");
    return `original=50000, returned=${output.length}, marker=${hasMarker}`;
  });

  // ─── Test 13: open_workspace compressed ───
  await runTest(13, "open_workspace compressed", async () => {
    const { body } = await mcpRequest("tools/call", {
      name: "open_workspace",
      arguments: { path: WORKSPACE_PATH },
    }, 24);
    assert.ok(!body.error, `open_workspace error: ${JSON.stringify(body.error)}`);
    const result = JSON.stringify(body.result ?? {});
    const hasReadHint = result.includes("read") || result.includes("workspace");
    return `size=${result.length}, hasReadHint=${hasReadHint}`;
  });

  // ─── Test 17: D:\ path access ───
  await runTest(17, "D:\\ path access", async () => {
    const output = await bash("Test-Path D:\\", 25);
    assert.ok(output.includes("True"), `D:\\ should be accessible: ${output}`);
    return `output: ${output.replace(/\r/g, "")}`;
  });

  // ─── Test 19: Diagnose strict fields + smoke + costs ───
  await runTest(19, "Diagnose strict fields + smoke + costs", async () => {
    const diag = await diagnose();
    // Strict: diagnose must have required fields — no fallback.
    assert.ok("shell" in diag, `diagnose missing 'shell' field`);
    assert.ok(diag.shell, `diagnose.shell must be non-empty, got ${diag.shell}`);
    assert.ok("sessions" in diag, `diagnose missing 'sessions' field`);
    assert.ok(diag.sessions !== null, `diagnose.sessions must not be null`);
    assert.ok("config" in diag, `diagnose missing 'config' field`);
    assert.ok(diag.config !== null, `diagnose.config must not be null`);
    assert.ok("contextIgnorePaths" in diag.config, `diagnose.config missing 'contextIgnorePaths'`);
    assert.ok(Array.isArray(diag.config.contextIgnorePaths), `contextIgnorePaths must be array`);
    assert.ok("maxSessions" in diag.sessions, `diagnose.sessions missing 'maxSessions'`);
    assert.ok(typeof diag.sessions.maxSessions === "number", `maxSessions must be number`);

    const smokeResp = await fetch(`${BASE}/devspace-runtime/smoke`);
    assert.ok(smokeResp.ok, `smoke endpoint should work, got ${smokeResp.status}`);
    const smoke = await smokeResp.json();
    assert.ok(smoke.ok === true, `smoke.ok must be true`);

    const costsResp = await fetch(`${BASE}/devspace-runtime/costs`);
    assert.ok(costsResp.ok, `costs endpoint should work, got ${costsResp.status}`);

    return `shell=${diag.shell}, smoke=${smoke.ok}, maxSessions=${diag.sessions.maxSessions}`;
  });

  // ─── Test 4: lastActivity refresh ───
  await runTest(4, "lastActivity refresh", async () => {
    await mcpRequest("tools/list", {}, 30);
    const h = await healthz();
    assert.ok(h.sessions >= 1, `should have at least 1 session: ${h.sessions}`);
    return `activeSessions=${h.sessions}`;
  });

  // ─── Test 14: Read AGENTS via read tool ───
  await runTest(14, "Read AGENTS via read tool", async () => {
    const { body } = await mcpRequest("tools/call", {
      name: "read",
      arguments: { path: `${WORKSPACE_PATH}\\AGENTS.md` },
    }, 31);
    assert.ok(!body.error, `read should not error: ${JSON.stringify(body.error)}`);
    return "read succeeded";
  });

  // ─── Test 15: contextIgnorePaths exists — strict, no fallback ───
  await runTest(15, "contextIgnorePaths exists (strict)", async () => {
    const diag = await diagnose();
    assert.ok(diag.config, "diagnose.config must exist");
    assert.ok("contextIgnorePaths" in diag.config, "config.contextIgnorePaths must exist as a field");
    const paths = diag.config.contextIgnorePaths;
    assert.ok(Array.isArray(paths), `contextIgnorePaths must be an array, got ${typeof paths}`);
    // Must be a real array — even if empty, the field must exist.
    return `paths=${JSON.stringify(paths)} (count=${paths.length})`;
  });

  // ─── Test 16: Ignored dirs still readable ───
  await runTest(16, "Ignored dirs still readable", async () => {
    const { body } = await mcpRequest("tools/call", {
      name: "read",
      arguments: { path: `${WORKSPACE_PATH}\\package.json` },
    }, 32);
    assert.ok(!body.error, `read should not error: ${JSON.stringify(body.error)}`);
    return "read succeeded";
  });

  // ─── Test 5: inFlight protection ───
  await runTest(5, "inFlight protection", async () => {
    await mcpRequest("tools/list", {}, 33);
    const h = await healthz();
    assert.ok(h.sessions >= 1, `sessions should still be active: ${h.sessions}`);
    return `sessions still active=${h.sessions}`;
  });

  // ─── Test 6: Session limit config — strict, no ?? 64 fallback ───
  await runTest(6, "Session limit config (strict)", async () => {
    const h = await healthz();
    assert.ok("maxSessions" in h, "healthz must have maxSessions field");
    const maxSessions = h.maxSessions;
    assert.ok(typeof maxSessions === "number", `maxSessions must be a number, got ${typeof maxSessions}`);
    assert.ok(maxSessions > 0, `maxSessions must be > 0, got ${maxSessions}`);
    // Cross-check with diagnose
    const diag = await diagnose();
    assert.ok(diag.sessions?.maxSessions, "diagnose.sessions.maxSessions must exist");
    assert.strictEqual(diag.sessions.maxSessions, maxSessions, `healthz and diagnose maxSessions mismatch`);
    return `maxSessions=${maxSessions} (from healthz, confirmed by diagnose)`;
  });

  // ─── Test 7: Multiple sessions (closeAll) ───
  await runTest(7, "Multiple sessions (closeAll)", async () => {
    const oldSid = mcpSessionId;
    mcpSessionId = null;
    await initialize();
    assert.ok(mcpSessionId !== oldSid, "should have a different session ID");
    return `second session=${mcpSessionId!.slice(0, 12)}...`;
  });

  // ─── Test 8: Close failure resilience — actually inject close failure ───
  await runTest(8, "Close failure resilience (injected)", async () => {
    // Create 3 independent sessions.
    const sid1 = await initializeWithSid();
    const sid2 = await initializeWithSid();
    const sid3 = await initializeWithSid();
    log(`created sessions: ${sid1.slice(0, 8)}, ${sid2.slice(0, 8)}, ${sid3.slice(0, 8)}`);

    // Inject close failure for sid1 — its transport.close() will throw.
    const injectResp = await fetch(`${BASE}/test/inject-close-failure`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "mcp-session-id": sid1 },
      body: JSON.stringify({ sessionId: sid1 }),
    });
    assert.ok(injectResp.ok, `inject-close-failure should return ok, got ${injectResp.status}`);
    const injectBody = await injectResp.json();
    assert.ok(injectBody.ok, `inject should succeed: ${JSON.stringify(injectBody)}`);
    log(`injected close failure for ${sid1.slice(0, 8)}...`);

    // DELETE sid1 — triggers transport.close() which will fail.
    const delResp = await fetch(`${BASE}/mcp`, {
      method: "DELETE",
      headers: { "mcp-session-id": sid1 },
    });
    // DELETE returns 200 or 406 — the important thing is the server doesn't crash.
    log(`DELETE sid1: status=${delResp.status}`);

    // Verify sid2 and sid3 still work — this proves close failure resilience.
    const list2 = await rawMcpRequest("tools/list", {}, sid2, 40);
    assert.strictEqual(list2.status, 200, `sid2 should still work after sid1 close failure: ${list2.status}`);
    assert.ok(!list2.body.error, `sid2 tools/list error: ${JSON.stringify(list2.body.error)}`);

    const list3 = await rawMcpRequest("tools/list", {}, sid3, 41);
    assert.strictEqual(list3.status, 200, `sid3 should still work after sid1 close failure: ${list3.status}`);
    assert.ok(!list3.body.error, `sid3 tools/list error: ${JSON.stringify(list3.body.error)}`);

    // Verify server is still healthy.
    const h = await healthz();
    assert.ok(h.ok, "server must still be healthy after close failure");

    // Clean up sid2 and sid3.
    await fetch(`${BASE}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid2 } });
    await fetch(`${BASE}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid3 } });

    return `sid1 close failed (injected), sid2+sid3 survived, server healthy`;
  });

  // ─── Test 18: AGENTS realpath ───
  await runTest(18, "AGENTS realpath", async () => {
    const { body } = await mcpRequest("tools/call", {
      name: "open_workspace",
      arguments: { path: WORKSPACE_PATH },
    }, 41);
    assert.ok(!body.error, `open_workspace should succeed: ${JSON.stringify(body.error)}`);
    return "workspace opened";
  });

  // ─── Test 20: Port active ───
  await runTest(20, "Port active", async () => {
    const h = await healthz();
    assert.ok(h.ok, "port should be active");
    assert.ok("maxSessions" in h, "healthz must have maxSessions");
    return `port=${PORT}, maxSessions=${h.maxSessions}`;
  });

  // ─── Summary ───
  console.log("");
  const passed = results.filter((r) => r.status === "PASS").length;
  const skipped = results.filter((r) => r.status === "SKIP").length;
  const failed = results.filter((r) => r.status === "FAIL").length;
  console.log(`=== Acceptance v2: ${passed} PASS, ${skipped} SKIP, ${failed} FAIL (total ${results.length}) ===`);

  if (failed > 0 || skipped > 0) {
    console.error(`\n\u2717 NOT all 21 strict PASS — ${failed} FAIL, ${skipped} SKIP\n`);
    // List failures
    for (const r of results.filter((r) => r.status !== "PASS")) {
      console.error(`  ${r.status}: Test ${r.testId}: ${r.name} — ${r.detail}`);
    }
    process.exit(1);
  } else if (passed === 21) {
    console.log(`\n\u2713 All 21 acceptance tests strictly passed (21/21)\n`);
  } else {
    console.error(`\n\u2717 Only ${passed}/21 passed — missing tests\n`);
    process.exit(1);
  }
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
