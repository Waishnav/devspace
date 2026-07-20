/**
 * MCP Session Lifecycle Regression Tests
 *
 * Tests the fix for the inFlight counter leak caused by duplicate markActive calls.
 * Also tests the atomic reservation API (tryReserveSlot/commitReservation/releaseReservation).
 * Tests the initialization handshake protection (initializing flag, inFlight=1 during init).
 */

import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-session-registry.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

function createMockTransport(): StreamableHTTPServerTransport {
  const handlers: Record<string, ((...args: unknown[]) => void)[]> = {};
  return {
    close: async () => {
      handlers["close"]?.forEach((h) => h());
    },
    on: (event: string, handler: (...args: unknown[]) => void) => {
      if (!handlers[event]) handlers[event] = [];
      handlers[event].push(handler);
    },
    handleRequest: async () => {},
    sessionId: undefined,
  } as unknown as StreamableHTTPServerTransport;
}

function simulateExistingSessionRequest(
  registry: McpSessionRegistry,
  sessionId: string,
  handler: () => Promise<void>,
): Promise<void> {
  let activeSessionId: string | undefined;
  return (async () => {
    try {
      const transport = registry.get(sessionId)?.transport;
      if (!transport) throw new Error("Unknown session");
      registry.markActive(sessionId);
      activeSessionId = sessionId;
      await handler();
    } catch {
      // error handling
    } finally {
      if (activeSessionId) {
        registry.markIdle(activeSessionId);
      }
    }
  })();
}

function test(name: string, fn: () => void | Promise<void>): void {
  Promise.resolve(fn())
    .then(() => console.log(`  \u2713 ${name}`))
    .catch((err) => {
      console.error(`  \u2717 ${name}`);
      console.error(`    ${err.message}`);
      process.exitCode = 1;
    });
}

console.log("\n=== MCP Session Lifecycle Regression Tests ===\n");

// Test 1: Normal request — markActive once, markIdle once, inFlight=0
test("Test 1: Normal request — markActive once, markIdle once, inFlight=0", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "test-1";
  assert.ok(registry.register(sessionId, transport) === true);
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0);
  simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1);
  }).then(() => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 0);
  });
});

// Test 2: handleRequest throws — finally still executes, inFlight=0
test("Test 2: handleRequest throws — finally still executes, inFlight=0", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "test-2";
  registry.register(sessionId, transport);
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    throw new Error("handleRequest simulated failure");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0);
});

// Test 3: 100 consecutive sessions — count <= 64, new sessions can initialize
test("Test 3: 100 consecutive ChatGPT-style sessions — count \u2264 64", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  for (let i = 0; i < 100; i++) {
    const sessionId = `chatgpt-session-${i}`;
    const transport = createMockTransport();
    const registered = registry.register(sessionId, transport);
    if (registered) {
      await simulateExistingSessionRequest(registry, sessionId, async () => {});
    }
  }
  assert.ok(registry.size <= 64, `session count should be \u2264 64, got ${registry.size}`);
  assert.ok(registry.get("chatgpt-session-99"), "latest session should be alive");
});

// Test 4: 64 old idle sessions — new session evicts oldest, new session survives
test("Test 4: 64 idle sessions — new session evicts oldest, new survives", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  for (let i = 0; i < 64; i++) {
    const transport = createMockTransport();
    assert.ok(registry.register(`old-${i}`, transport), `old-${i} should register`);
  }
  assert.strictEqual(registry.size, 64);
  const newTransport = createMockTransport();
  const registered = registry.register("new-session", newTransport);
  assert.ok(registered);
  assert.strictEqual(registry.size, 64);
  assert.ok(registry.get("new-session"));
  assert.ok(!registry.get("old-0"));
});

// Test 5: 64 active sessions — new initialize gets 503, no timeout
test("Test 5: 64 active sessions — atCapacity=true, register rejected", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  for (let i = 0; i < 64; i++) {
    const transport = createMockTransport();
    registry.register(`active-${i}`, transport);
    registry.markActive(`active-${i}`);
  }
  assert.ok(registry.atCapacity);
  const newTransport = createMockTransport();
  const registered = registry.register("rejected-session", newTransport);
  assert.strictEqual(registered, false);
  assert.strictEqual(registry.size, 64);
});

// Test 6: Full flow with handshake protection — initialize (inFlight=1) → markIdle (inFlight=0) → completeHandshake → tools/list → open_workspace
test("Test 6: Full MCP flow with handshake protection", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });

  // Step 1: initialize using reservation API
  const res = registry.tryReserveSlot();
  assert.ok(res, "reservation should be created");
  assert.strictEqual(registry.pendingReservations, 1);

  const transport = createMockTransport();
  const sessionId = "full-flow-session";
  const committed = registry.commitReservation(res!, sessionId, transport);
  assert.ok(committed, "commit should succeed");
  assert.strictEqual(registry.pendingReservations, 0);

  // After commit: inFlight=1 (initialize still in progress), initializing=true
  const session = registry.get(sessionId);
  assert.ok(session, "session should exist");
  assert.strictEqual(session!.inFlight, 1, "inFlight=1 during initialize (commitReservation sets this)");
  assert.strictEqual(session!.initializing, true, "initializing=true during initialize");

  // Step 2: markIdle (initialize request finished) — simulates server finally block
  registry.markIdle(sessionId);
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after initialize completes");
  // Session is still initializing=true (notifications/initialized not yet received)
  assert.strictEqual(registry.get(sessionId)?.initializing, true, "still initializing before notifications/initialized");

  // Step 3: completeHandshake (notifications/initialized received)
  const handshakeResult = registry.completeHandshake(sessionId);
  assert.strictEqual(handshakeResult, true, "completeHandshake should succeed");
  assert.strictEqual(registry.get(sessionId)?.initializing, false, "initializing=false after handshake");
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after handshake");

  // Step 4: tools/list (normal existing session request)
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during tools/list");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0);

  // Step 5: open_workspace
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during open_workspace");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0);
  assert.ok(registry.get(sessionId), "session should still exist");
});

// Test 7 (regression): 70 consecutive requests on same session — inFlight stays 0
test("Test 7 (regression): 70 consecutive requests, inFlight stays 0", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "regression-70";
  registry.register(sessionId, transport);
  for (let i = 0; i < 70; i++) {
    await simulateExistingSessionRequest(registry, sessionId, async () => {});
  }
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0);
});

// Test 8 (regression): Old bug simulation — verify double markActive is detected
test("Test 8 (regression): Double markActive + single markIdle leaves inFlight=1", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "old-bug-demo";
  registry.register(sessionId, transport);
  registry.markActive(sessionId);
  registry.markActive(sessionId);
  registry.markIdle(sessionId);
  assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "OLD BUG: inFlight=1");
  registry.markIdle(sessionId);
  registry.markActive(sessionId);
  registry.markIdle(sessionId);
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "FIXED: inFlight=0");
});

// ─── Reservation API Tests ─────────────────────────────────────────────

test("Test 9: tryReserveSlot creates reservation, occupiedCapacity increases", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  assert.strictEqual(registry.occupiedCapacity, 0);
  const res = registry.tryReserveSlot();
  assert.ok(res);
  assert.strictEqual(registry.pendingReservations, 1);
  assert.strictEqual(registry.occupiedCapacity, 1);
  assert.strictEqual(registry.size, 0);
});

test("Test 10: commitReservation creates session with initializing=true, inFlight=1", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const res = registry.tryReserveSlot();
  assert.ok(res);
  const transport = createMockTransport();
  const committed = registry.commitReservation(res!, "sess-1", transport);
  assert.strictEqual(committed, true);
  assert.strictEqual(registry.pendingReservations, 0);
  assert.strictEqual(registry.size, 1);
  assert.strictEqual(registry.occupiedCapacity, 1);
  // NEW: commitReservation sets initializing=true and inFlight=1
  const session = registry.get("sess-1");
  assert.ok(session);
  assert.strictEqual(session!.inFlight, 1, "inFlight=1 during initialize");
  assert.strictEqual(session!.initializing, true, "initializing=true");
  assert.ok(session!.handshakeDeadline, "handshakeDeadline should be set");
});

test("Test 11: releaseReservation frees slot without session", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const res = registry.tryReserveSlot();
  assert.ok(res);
  assert.strictEqual(registry.occupiedCapacity, 1);
  registry.releaseReservation(res!);
  assert.strictEqual(registry.pendingReservations, 0);
  assert.strictEqual(registry.size, 0);
  assert.strictEqual(registry.occupiedCapacity, 0);
});

test("Test 12: Double commit is rejected (returns false)", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const res = registry.tryReserveSlot();
  assert.ok(res);
  const t1 = createMockTransport();
  const t2 = createMockTransport();
  assert.ok(registry.commitReservation(res!, "sess-a", t1));
  assert.strictEqual(registry.commitReservation(res!, "sess-b", t2), false);
  assert.strictEqual(registry.size, 1);
});

test("Test 13: Double release is a no-op", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const res = registry.tryReserveSlot();
  assert.ok(res);
  registry.releaseReservation(res!);
  assert.strictEqual(registry.occupiedCapacity, 0);
  registry.releaseReservation(res!);
  assert.strictEqual(registry.occupiedCapacity, 0);
});

test("Test 14: 100 concurrent tryReserveSlot — at most 64 succeed", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  let successCount = 0;
  let failCount = 0;
  for (let i = 0; i < 100; i++) {
    const res = registry.tryReserveSlot();
    if (res) { successCount++; } else { failCount++; }
  }
  assert.strictEqual(successCount, 64);
  assert.strictEqual(failCount, 36);
  assert.strictEqual(registry.occupiedCapacity, 64);
  assert.ok(registry.atCapacity);
});

// Test 15: Handshake protection prevents eviction of initializing sessions
test("Test 15: 64 committed initializing sessions — tryReserveSlot cannot evict any", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  // Fill with 64 sessions via reservation+commit (all initializing=true, inFlight=1)
  for (let i = 0; i < 64; i++) {
    const res = registry.tryReserveSlot();
    assert.ok(res, `reservation ${i} should succeed`);
    const transport = createMockTransport();
    assert.ok(registry.commitReservation(res!, `sess-${i}`, transport), `commit ${i}`);
  }
  assert.strictEqual(registry.size, 64);
  assert.strictEqual(registry.pendingReservations, 0);

  // Now try to reserve more — should fail because all sessions are initializing (protected)
  const res = registry.tryReserveSlot();
  assert.strictEqual(res, undefined, "tryReserveSlot should fail — all sessions are initializing");

  // Complete handshakes for all sessions
  for (let i = 0; i < 64; i++) {
    // First markIdle (initialize request finished)
    registry.markIdle(`sess-${i}`);
    // Then completeHandshake
    registry.completeHandshake(`sess-${i}`);
  }

  // Now all sessions are idle and fully handshaked — tryReserveSlot can evict
  for (let i = 0; i < 100; i++) {
    const res2 = registry.tryReserveSlot();
    assert.ok(res2, `reservation new-${i} should succeed (evicts idle handshaked session)`);
    const transport = createMockTransport();
    assert.ok(registry.commitReservation(res2!, `new-${i}`, transport), `commit new-${i}`);
    // Complete handshake immediately to allow further eviction
    registry.markIdle(`new-${i}`);
    registry.completeHandshake(`new-${i}`);
    assert.ok(registry.occupiedCapacity <= 64, `capacity must stay <= 64, got ${registry.occupiedCapacity}`);
  }
  assert.strictEqual(registry.size, 64);
  assert.ok(registry.get("new-99"));
  assert.ok(!registry.get("sess-0"));
});

// Test 16: Initialize fails — reservation released in finally, slot freed
test("Test 16: Initialize fails — reservation released in finally, slot freed", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  let initReservation: ReturnType<typeof registry.tryReserveSlot> | undefined;
  let reservationCommitted = false;
  try {
    initReservation = registry.tryReserveSlot();
    assert.ok(initReservation);
    assert.strictEqual(registry.pendingReservations, 1);
    throw new Error("server.connect failed");
  } catch {
    // error handling
  } finally {
    if (initReservation && !reservationCommitted) {
      registry.releaseReservation(initReservation);
    }
  }
  assert.strictEqual(registry.pendingReservations, 0);
  assert.strictEqual(registry.occupiedCapacity, 0);
  assert.strictEqual(registry.size, 0);
});

// Test 17: Handshake timeout cleanup
test("Test 17: Stale handshake cleanup — past deadline with inFlight=0 gets cleaned", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
    handshakeTimeoutMs: 100, // 100ms for testing
  });
  const res = registry.tryReserveSlot();
  assert.ok(res);
  const transport = createMockTransport();
  registry.commitReservation(res!, "stale-sess", transport);

  // Simulate initialize completed (markIdle) but no notifications/initialized
  registry.markIdle("stale-sess");
  assert.strictEqual(registry.get("stale-sess")?.inFlight, 0);
  assert.strictEqual(registry.get("stale-sess")?.initializing, true);

  // Wait for deadline to pass
  // Note: in real code, closeStaleHandshakes is called by sweep timer
  // Here we call it manually after sleeping
  // We can't easily sleep in sync test, so we manipulate the deadline directly
  const session = registry.get("stale-sess");
  if (session) {
    session.handshakeDeadline = Date.now() - 1; // Set deadline in the past
  }

  const cleaned = registry.closeStaleHandshakes();
  assert.strictEqual(cleaned, 1, "should clean 1 stale handshake");
  assert.strictEqual(registry.size, 0, "session should be removed");
});

// Test 18: completeHandshake on non-existent or non-initializing session returns false
test("Test 18: completeHandshake returns false for non-initializing session", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000, sweepMs: 5_000, maxSessions: 64,
  });
  const transport = createMockTransport();
  registry.register("normal-sess", transport);
  // register() sets initializing=false
  assert.strictEqual(registry.get("normal-sess")?.initializing, false);
  // completeHandshake should return false (not initializing)
  assert.strictEqual(registry.completeHandshake("normal-sess"), false);
  // Non-existent session
  assert.strictEqual(registry.completeHandshake("nonexistent"), false);
});

setTimeout(() => {
  if (process.exitCode === 1) {
    console.error("\n\u2717 Some tests FAILED\n");
    process.exit(1);
  } else {
    console.log("\n\u2713 All session lifecycle tests passed\n");
  }
}, 3000);
