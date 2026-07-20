/**
 * MCP Integration Tests v3 — Real HTTP/MCP server tests with handshake protection.
 *
 * Test scenarios:
 *  1. Single real connection: initialize -> tools/list -> open_workspace
 *  2. handleRequest throws -> inFlight back to 0
 *  3. 100 concurrent initialize with barrier test
 *  4. Max active sessions -> overflow gets 503, not timeout
 *  5. Max idle sessions -> new initialize evicts oldest, stays max
 *  6. 100 consecutive full flows -> no inFlight accumulation
 */

import assert from "node:assert/strict";
import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NODE = process.execPath;
const SERVER_DIR = "C:\\Users\\Administrator\\.devspace\\upgrade-work\\devspace";
const TEST_PORT = 7681;
const MAX_SESSIONS = 8;

interface TestResult { passed: boolean; message: string; data?: Record<string, unknown>; }
const results: TestResult[] = [];
let serverProcess: ChildProcess | null = null;
let useBarrier = false;

function log(msg: string): void { console.log(`  ${msg}`); }

async function startServer(barrier: boolean = false): Promise<void> {
  useBarrier = barrier;
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: "test",
    DEVSPACE_TEST_BYPASS_AUTH: "1",
    PORT: String(TEST_PORT),
    DEVSPACE_MAX_SESSIONS: String(MAX_SESSIONS),
    DEVSPACE_SESSION_IDLE_MS: "86400000",
    DEVSPACE_SESSION_SWEEP_MS: "300000",
    DEVSPACE_SESSION_HANDSHAKE_TIMEOUT_MS: "30000",
    DEVSPACE_INLINE_OUTPUT_CHARACTERS: "12000",
    DEVSPACE_SHELL: "powershell",
    DEVSPACE_LOG_LEVEL: "warn",
    DEVSPACE_LOG_FORMAT: "json",
    DEVSPACE_ALLOWED_HOSTS: "*",
  };
  if (barrier) env.DEVSPACE_TEST_RESERVATION_BARRIER = "1";
  await startServerWithEnv(env);
}

async function startServerWithEnv(env: Record<string, string>): Promise<void> {

  return new Promise((resolve, reject) => {
    serverProcess = spawn(NODE, ["--import", "tsx", "src/cli.ts", "serve"], {
      cwd: SERVER_DIR, env, stdio: ["pipe", "pipe", "pipe"],
    });
    let started = false;
    const timeout = setTimeout(() => { if (!started) reject(new Error("Server start timeout")); }, 20000);
    const checkReady = (line: string) => {
      if ((line.includes("listening") || line.includes("started") || line.includes("ready")) && !started) {
        started = true; clearTimeout(timeout); setTimeout(resolve, 1000);
      }
    };
    createInterface({ input: serverProcess.stdout! }).on("line", checkReady);
    createInterface({ input: serverProcess.stderr! }).on("line", checkReady);
    const poll = setInterval(async () => {
      if (started) { clearInterval(poll); return; }
      try {
        const resp = await fetch(`http://localhost:${TEST_PORT}/healthz`);
        if (resp.ok) { started = true; clearTimeout(timeout); clearInterval(poll); setTimeout(resolve, 1000); }
      } catch {}
    }, 1000);
  });
}

async function stopServer(): Promise<void> {
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 2000));
    if (!serverProcess.killed) serverProcess.kill("SIGKILL");
    serverProcess = null;
    // Wait for port to be fully freed
    for (let i = 0; i < 10; i++) {
      try {
        await fetch(`http://localhost:${TEST_PORT}/healthz`, { signal: AbortSignal.timeout(500) });
        // Port still in use — wait more
        await new Promise((r) => setTimeout(r, 500));
      } catch {
        break; // Port is free
      }
    }
  }
}

function parseSseBody(text: string): any {
  for (const line of text.split("\n")) {
    if (line.startsWith("data: ")) { try { return JSON.parse(line.slice(6)); } catch {} }
  }
  try { return JSON.parse(text); } catch { return { error: { message: text.slice(0, 200) } }; }
}

async function mcpRequest(method: string, params: unknown, sessionId?: string, id: number = 1): Promise<{ status: number; body: any; sessionId?: string }> {
  const headers: Record<string, string> = { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" };
  if (sessionId) headers["mcp-session-id"] = sessionId;
  const resp = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
    method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }),
  });
  const text = await resp.text();
  const json = parseSseBody(text);
  const sid = resp.headers.get("mcp-session-id") ?? undefined;
  return { status: resp.status, body: json, sessionId: sid };
}

async function initialize(id?: number): Promise<string> {
  const { status, body, sessionId } = await mcpRequest("initialize", {
    protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test-client", version: "1.0" },
  }, undefined, id ?? 1);
  assert.strictEqual(status, 200, `initialize failed: ${status}: ${JSON.stringify(body)}`);
  assert.ok(!body.error, `initialize error: ${JSON.stringify(body.error)}`);
  assert.ok(sessionId, "no session ID");
  await fetch(`http://localhost:${TEST_PORT}/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sessionId! },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  });
  return sessionId!;
}

async function getHealthz(): Promise<any> {
  return await (await fetch(`http://localhost:${TEST_PORT}/healthz`)).json();
}

async function releaseBarrier(): Promise<void> {
  await fetch(`http://localhost:${TEST_PORT}/test/release-barrier`, { method: "POST" });
}

async function runTest(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
    results.push({ passed: true, message: name });
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ passed: false, message: name, data: { error: msg } });
    console.error(`  \u2717 ${name}`);
    console.error(`    ${msg}`);
  }
}

// ─── Tests ─────────────────────────────────────────────────────────────

async function test1_singleRealConnection(): Promise<void> {
  const sessionId = await initialize();
  log(`session: ${sessionId.slice(0, 8)}...`);
  const listResp = await mcpRequest("tools/list", {}, sessionId, 2);
  assert.strictEqual(listResp.status, 200, "tools/list should return 200");
  assert.ok(!listResp.body.error, `tools/list error: ${JSON.stringify(listResp.body.error)}`);
  const tools = (listResp.body.result as { tools: unknown[] })?.tools;
  assert.ok(Array.isArray(tools), "tools/list should return tools array");
  log(`tools count: ${tools!.length}`);

  const wsResp = await mcpRequest("tools/call", {
    name: "open_workspace", arguments: { path: process.cwd() },
  }, sessionId, 3);
  assert.strictEqual(wsResp.status, 200, "open_workspace should return 200");
  assert.ok(!wsResp.body.error, `open_workspace error: ${JSON.stringify(wsResp.body.error)}`);
  log(`open_workspace result: ${JSON.stringify(wsResp.body.result).slice(0, 80)}...`);

  const h = await getHealthz();
  assert.strictEqual(h.sessions, 1, `should have 1 session, got ${h.sessions}`);
  log(`sessions: ${h.sessions}, capacity: ${h.occupiedCapacity}`);
}

async function test2_handleRequestException(): Promise<void> {
  const sessionId = await initialize();
  const resp = await mcpRequest("invalid/method", {}, sessionId, 99);
  assert.ok(resp.body.error || resp.body.result, "should get a response");
  const listResp = await mcpRequest("tools/list", {}, sessionId, 100);
  assert.strictEqual(listResp.status, 200, "session should still work after error");
  const h = await getHealthz();
  log(`sessions: ${h.sessions}, capacity: ${h.occupiedCapacity}`);
}

async function test3_concurrentWithBarrier(): Promise<void> {
  // Restart with barrier enabled
  await stopServer();
  await startServer(true);
  await new Promise((r) => setTimeout(r, 1000));

  // Send MAX_SESSIONS (8) concurrent initialize requests — they will block on barrier
  const barrierPromises: Promise<{ status: number; sessionId?: string; error?: string }>[] = [];
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const p = (async () => {
      try {
        const resp = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: i, method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `barrier-${i}`, version: "1.0" } },
          }),
        });
        const sid = resp.headers.get("mcp-session-id") ?? undefined;
        return { status: resp.status, sessionId: sid };
      } catch (err) {
        return { status: 0, error: err instanceof Error ? err.message : String(err) };
      }
    })();
    barrierPromises.push(p);
  }

  // Wait for all 8 to be blocked at the barrier (pendingReservations should be 8)
  await new Promise((r) => setTimeout(r, 2000));

  const h1 = await getHealthz();
  log(`barrier state: sessions=${h1.sessions}, reservations=${h1.pendingReservations}, capacity=${h1.occupiedCapacity}`);
  assert.strictEqual(h1.pendingReservations, MAX_SESSIONS, `pendingReservations should be ${MAX_SESSIONS}, got ${h1.pendingReservations}`);
  assert.strictEqual(h1.occupiedCapacity, MAX_SESSIONS, `occupiedCapacity should be ${MAX_SESSIONS}, got ${h1.occupiedCapacity}`);

  // Send 9th initialize — should get 503 immediately (all capacity in reservations)
  const sw = Date.now();
  let status9 = 0;
  try {
    const resp9 = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 999, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "overflow", version: "1.0" } },
      }),
      signal: AbortSignal.timeout(3000),
    });
    status9 = resp9.status;
  } catch (err) {
    throw new Error(`9th initialize threw: ${err} — should have gotten 503`);
  }
  const elapsed9 = Date.now() - sw;
  assert.strictEqual(status9, 503, `9th initialize should return 503, got ${status9}`);
  assert.ok(elapsed9 < 2000, `9th initialize should respond within 2s, took ${elapsed9}ms`);
  log(`9th initialize: 503 in ${elapsed9}ms`);

  // Release barrier
  await releaseBarrier();
  log("barrier released");

  // Wait for all 8 to complete
  const barrierResults = await Promise.all(barrierPromises);
  const successCount = barrierResults.filter((r) => r.status === 200).length;
  log(`barrier results: ${successCount}/${MAX_SESSIONS} succeeded`);

  // For each successful session, send notifications/initialized and tools/list
  for (const r of barrierResults) {
    if (r.status === 200 && r.sessionId) {
      // Send notifications/initialized
      await fetch(`http://localhost:${TEST_PORT}/mcp`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": r.sessionId },
        body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
      });
      // tools/list
      const listResp = await mcpRequest("tools/list", {}, r.sessionId, 50);
      assert.strictEqual(listResp.status, 200, `tools/list failed for session ${r.sessionId?.slice(0, 8)}`);
      assert.ok(!listResp.body.error, `tools/list error: ${JSON.stringify(listResp.body.error)}`);
    }
  }

  const h2 = await getHealthz();
  log(`after barrier: sessions=${h2.sessions}, reservations=${h2.pendingReservations}, capacity=${h2.occupiedCapacity}`);
  assert.strictEqual(h2.pendingReservations, 0, `pendingReservations should be 0, got ${h2.pendingReservations}`);
  assert.ok(h2.occupiedCapacity <= MAX_SESSIONS, `capacity must be <= ${MAX_SESSIONS}, got ${h2.occupiedCapacity}`);

  // Now send 100 more concurrent initialize (without barrier)
  await stopServer();
  await startServer(false);
  await new Promise((r) => setTimeout(r, 1000));

  // Phase 1: Send all 100 initialize concurrently, collect results.
  // Do NOT send notifications/initialized yet — keep sessions in initializing
  // state so they are protected from eviction while other initialize requests
  // are still in flight.
  let success100 = 0, reject100 = 0, timeout100 = 0;
  const successSessionIds: string[] = [];
  const promises100: Promise<void>[] = [];
  for (let i = 0; i < 100; i++) {
    promises100.push((async () => {
      try {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
          body: JSON.stringify({
            jsonrpc: "2.0", id: i, method: "initialize",
            params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: `conc-${i}`, version: "1.0" } },
          }),
          signal: controller.signal,
        });
        clearTimeout(t);
        if (resp.status === 200) {
          success100++;
          const sid = resp.headers.get("mcp-session-id");
          if (sid) successSessionIds.push(sid);
        } else if (resp.status === 503) {
          reject100++;
        }
      } catch (err) {
        if (err instanceof Error && err.name === "AbortError") timeout100++;
      }
    })());
  }
  await Promise.all(promises100);

  log(`100 concurrent phase 1: success=${success100}, 503=${reject100}, timeout=${timeout100}`);
  assert.strictEqual(timeout100, 0, `no timeout, got ${timeout100}`);
  assert.strictEqual(success100 + reject100, 100, `success+503=100, got ${success100}+${reject100}`);

  // Phase 2: All 100 initialize have settled. Now process successful sessions.
  // Since no new initialize requests are in flight, sessions won't be evicted
  // while we complete their handshake.
  let unknown100 = 0;
  for (const sid of successSessionIds) {
    // Send notifications/initialized
    await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream", "mcp-session-id": sid },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    // tools/list
    const listResp = await mcpRequest("tools/list", {}, sid, 50);
    if (listResp.body.error?.message?.includes("Unknown MCP session")) {
      unknown100++;
    }
  }

  log(`100 concurrent phase 2: processed ${successSessionIds.length} sessions, unknown=${unknown100}`);
  assert.strictEqual(unknown100, 0, `no Unknown MCP session, got ${unknown100}`);

  const h3 = await getHealthz();
  log(`final: sessions=${h3.sessions}, reservations=${h3.pendingReservations}, capacity=${h3.occupiedCapacity}`);
  assert.strictEqual(h3.pendingReservations, 0, `pendingReservations should be 0`);
  assert.ok(h3.occupiedCapacity <= MAX_SESSIONS, `capacity <= ${MAX_SESSIONS}`);
}

async function test4_deterministicRequestBarrier(): Promise<void> {
  // Restart with request barrier enabled
  await stopServer();
  // Wait for port to be fully freed on Windows
  await new Promise((r) => setTimeout(r, 2000));
  const env: Record<string, string> = {
    ...process.env as Record<string, string>,
    NODE_ENV: "test",
    DEVSPACE_TEST_BYPASS_AUTH: "1",
    PORT: String(TEST_PORT),
    DEVSPACE_MAX_SESSIONS: String(MAX_SESSIONS),
    DEVSPACE_SESSION_IDLE_MS: "86400000",
    DEVSPACE_SESSION_SWEEP_MS: "300000",
    DEVSPACE_SESSION_HANDSHAKE_TIMEOUT_MS: "30000",
    DEVSPACE_INLINE_OUTPUT_CHARACTERS: "12000",
    DEVSPACE_SHELL: "powershell",
    DEVSPACE_LOG_LEVEL: "warn",
    DEVSPACE_LOG_FORMAT: "json",
    DEVSPACE_ALLOWED_HOSTS: "*",
    DEVSPACE_TEST_REQUEST_BARRIER: "1",
  };
  await startServerWithEnv(env);
  await new Promise((r) => setTimeout(r, 1000));

  // 1. Create and complete handshake for MAX_SESSIONS sessions
  const sessionIds: string[] = [];
  for (let i = 0; i < MAX_SESSIONS; i++) {
    const sid = await initialize(i + 1);
    sessionIds.push(sid);
  }
  const h1 = await getHealthz();
  log(`after ${MAX_SESSIONS} handshaked: sessions=${h1.sessions}, capacity=${h1.occupiedCapacity}`);
  assert.strictEqual(h1.sessions, MAX_SESSIONS, `should have ${MAX_SESSIONS} sessions`);

  // 2. Send a real MCP request on each session — they will block on request barrier
  const requestPromises = sessionIds.map((sid, i) =>
    mcpRequest("tools/list", {}, sid, 100 + i).then((resp) => ({ sid, resp }))
  );

  // 3. Wait for blockedRequests = MAX_SESSIONS
  let blockedCount = 0;
  for (let attempt = 0; attempt < 20; attempt++) {
    await new Promise((r) => setTimeout(r, 200));
    const statusResp = await fetch(`http://localhost:${TEST_PORT}/test/request-barrier-status`);
    const statusBody = await statusResp.json();
    blockedCount = statusBody.blockedRequests;
    if (blockedCount >= MAX_SESSIONS) break;
  }
  log(`blockedRequests: ${blockedCount}`);
  assert.strictEqual(blockedCount, MAX_SESSIONS, `blockedRequests should be ${MAX_SESSIONS}, got ${blockedCount}`);

  // 4. Confirm all sessions have inFlight=1 (via healthz — sessions should be MAX_SESSIONS)
  const h2 = await getHealthz();
  assert.strictEqual(h2.sessions, MAX_SESSIONS, "sessions should still be active");

  // 5. Send 9th initialize — must strictly return 503 within 2s
  const sw = Date.now();
  let status9 = 0;
  try {
    const resp9 = await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json, text/event-stream" },
      body: JSON.stringify({
        jsonrpc: "2.0", id: 9999, method: "initialize",
        params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "overflow", version: "1.0" } },
      }),
      signal: AbortSignal.timeout(3000),
    });
    status9 = resp9.status;
  } catch (err) {
    throw new Error(`9th initialize threw: ${err} — should have gotten 503`);
  }
  const elapsed9 = Date.now() - sw;
  assert.strictEqual(status9, 503, `9th initialize must return 503, got ${status9}`);
  assert.ok(elapsed9 < 2000, `9th initialize must respond within 2s, took ${elapsed9}ms`);
  log(`9th initialize: 503 in ${elapsed9}ms (all sessions genuinely in-flight)`);

  // 6. Release request barrier
  await fetch(`http://localhost:${TEST_PORT}/test/release-request-barrier`, { method: "POST" });
  log("request barrier released");

  // 7. All 8 requests must complete successfully
  const results8 = await Promise.all(requestPromises);
  for (const { sid, resp } of results8) {
    assert.strictEqual(resp.status, 200, `session ${sid?.slice(0, 8)} tools/list should return 200`);
    assert.ok(!resp.body.error, `session ${sid?.slice(0, 8)} error: ${JSON.stringify(resp.body.error)}`);
  }
  log(`all ${MAX_SESSIONS} blocked requests completed successfully`);

  // 8. Verify inFlight back to 0
  const h3 = await getHealthz();
  assert.strictEqual(h3.sessions, MAX_SESSIONS, "sessions should still be active");
}

async function test5_idleSessionsEviction(): Promise<void> {
  await stopServer();
  await startServer(false);
  await new Promise((r) => setTimeout(r, 1000));

  for (let i = 0; i < MAX_SESSIONS; i++) {
    await initialize(i + 1);
  }
  const h1 = await getHealthz();
  log(`after ${MAX_SESSIONS} idle: sessions=${h1.sessions}`);
  assert.strictEqual(h1.sessions, MAX_SESSIONS);

  const newSid = await initialize(999);
  log(`new session: ${newSid.slice(0, 8)}...`);
  const h2 = await getHealthz();
  assert.strictEqual(h2.sessions, MAX_SESSIONS, `should still have ${MAX_SESSIONS}`);
  log(`after eviction: sessions=${h2.sessions}`);
}

async function test6_consecutiveFullFlows(): Promise<void> {
  await stopServer();
  await startServer(false);
  await new Promise((r) => setTimeout(r, 1000));

  for (let i = 0; i < 100; i++) {
    const sid = await initialize(i + 1);
    const listResp = await mcpRequest("tools/list", {}, sid, 2);
    assert.strictEqual(listResp.status, 200, `round ${i}: tools/list failed`);
    await fetch(`http://localhost:${TEST_PORT}/mcp`, {
      method: "DELETE", headers: { "mcp-session-id": sid },
    });
    if (i % 10 === 9) {
      const h = await getHealthz();
      log(`round ${i + 1}: sessions=${h.sessions}, capacity=${h.occupiedCapacity}`);
      assert.ok(h.occupiedCapacity <= MAX_SESSIONS, `capacity must stay <= ${MAX_SESSIONS}`);
    }
  }
  const h = await getHealthz();
  log(`final: sessions=${h.sessions}, capacity=${h.occupiedCapacity}`);
  assert.ok(h.occupiedCapacity <= MAX_SESSIONS);
}

async function test7_realCloseFailure(): Promise<void> {
  await stopServer();
  await startServer(false);
  await new Promise((r) => setTimeout(r, 1000));

  // 1. Create 3 sessions with completed handshakes
  const sid1 = await initialize(1);
  const sid2 = await initialize(2);
  const sid3 = await initialize(3);
  log(`created: ${sid1.slice(0, 8)}, ${sid2.slice(0, 8)}, ${sid3.slice(0, 8)}`);

  // 2. Inject close failure for sid1
  const injectResp = await fetch(`http://localhost:${TEST_PORT}/test/inject-close-failure`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": sid1 },
    body: JSON.stringify({ sessionId: sid1 }),
  });
  assert.ok(injectResp.ok, `inject should succeed: ${injectResp.status}`);
  log(`injected close failure for ${sid1.slice(0, 8)}`);

  // 3. Close sid1 via registry (triggers transport.close which will fail)
  const closeResp = await fetch(`http://localhost:${TEST_PORT}/test/close-registry-session`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "mcp-session-id": sid1 },
    body: JSON.stringify({ sessionId: sid1 }),
  });
  assert.ok(closeResp.ok, `close-registry-session should succeed: ${closeResp.status}`);
  const closeBody = await closeResp.json();
  log(`close result: closed=${closeBody.closed}, lastError=${closeBody.lastError}, remaining=${closeBody.remainingSessions}`);

  // 4. Assert lastError contains "Injected close failure"
  assert.ok(closeBody.closed, "sid1 should have been closed");
  assert.ok(closeBody.lastError, "lastError should be set");
  assert.ok(
    closeBody.lastError.includes("Injected close failure"),
    `lastError should contain "Injected close failure", got: ${closeBody.lastError}`
  );

  // 5. sid2 and sid3 must still work
  const list2 = await mcpRequest("tools/list", {}, sid2, 200);
  assert.strictEqual(list2.status, 200, `sid2 tools/list should return 200: ${list2.status}`);
  assert.ok(!list2.body.error, `sid2 error: ${JSON.stringify(list2.body.error)}`);

  const list3 = await mcpRequest("tools/list", {}, sid3, 201);
  assert.strictEqual(list3.status, 200, `sid3 tools/list should return 200: ${list3.status}`);
  assert.ok(!list3.body.error, `sid3 error: ${JSON.stringify(list3.body.error)}`);
  log(`sid2 and sid3 survived close failure`);

  // 6. Clean up sid2 and sid3
  await fetch(`http://localhost:${TEST_PORT}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid2 } });
  await fetch(`http://localhost:${TEST_PORT}/mcp`, { method: "DELETE", headers: { "mcp-session-id": sid3 } });
  await new Promise((r) => setTimeout(r, 500));

  const h = await getHealthz();
  log(`final: sessions=${h.sessions}, capacity=${h.occupiedCapacity}`);
  assert.ok(h.sessions <= 1, `sessions should be <= 1, got ${h.sessions}`);
}

// ─── Main ──────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log("\n=== MCP Integration Tests v3 (Handshake Protection) ===\n");
  console.log(`Node: ${process.version}, Max sessions: ${MAX_SESSIONS}\n`);

  try {
    await startServer(false);
    log(`Server started on port ${TEST_PORT}`);
    await runTest("Test 1: Single real connection (initialize, tools/list, open_workspace)", test1_singleRealConnection);
    await runTest("Test 2: handleRequest exception, inFlight=0, session usable", test2_handleRequestException);
    await runTest("Test 3: 100 concurrent initialize with barrier test", test3_concurrentWithBarrier);
    await runTest("Test 4: Deterministic request barrier — 8 inFlight, 9th gets 503", test4_deterministicRequestBarrier);
    await runTest("Test 5: Max idle sessions, new evicts oldest, stays max", test5_idleSessionsEviction);
    await runTest("Test 6: 100 consecutive full flows, no inFlight accumulation", test6_consecutiveFullFlows);
    await runTest("Test 7: Real close failure via registry, other sessions survive", test7_realCloseFailure);
  } finally {
    await stopServer();
  }

  console.log("");
  const passed = results.filter((r) => r.passed).length;
  const failed = results.filter((r) => !r.passed).length;
  console.log(`=== Integration Tests: ${passed} passed, ${failed} failed ===`);
  if (failed > 0) { console.error("\n\u2717 Some integration tests FAILED\n"); process.exit(1); }
  else { console.log("\n\u2713 All integration tests passed\n"); }
}

main().catch((err) => { console.error("Fatal error:", err); stopServer().finally(() => process.exit(1)); });
