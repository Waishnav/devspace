/**
 * MCP Session Lifecycle Regression Tests
 *
 * Tests the fix for the inFlight counter leak caused by duplicate markActive calls.
 * Also tests the atomic reservation API (tryReserveSlot/commitReservation/releaseReservation).
 * Each test simulates the server's request handling pattern (try/catch/finally)
 * to verify that inFlight is correctly balanced.
 */

import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-session-registry.js";
import type { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";

/** Create a mock transport that satisfies the StreamableHTTPServerTransport interface. */
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

/** Simulate the server's fixed request handling pattern for an existing session. */
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

/** Simulate the server's initialize flow with reservation. */
function simulateInitializeWithReservation(
  registry: McpSessionRegistry,
  sessionId: string,
): { committed: boolean; reservation: unknown } {
  const reservation = registry.tryReserveSlot();
  if (!reservation) {
    return { committed: false, reservation: undefined };
  }
  const transport = createMockTransport();
  const committed = registry.commitReservation(reservation, sessionId, transport);
  return { committed, reservation };
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
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "test-1";

  assert.ok(registry.register(sessionId, transport) === true, "register should return true");
  assert.strictEqual(registry.size, 1, "should have 1 session");
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight should start at 0");

  simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight should be 1 during request");
  }).then(() => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight should be 0 after request");
  });
});

// Test 2: handleRequest throws — finally still executes, inFlight=0
test("Test 2: handleRequest throws — finally still executes, inFlight=0", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "test-2";

  registry.register(sessionId, transport);

  await simulateExistingSessionRequest(registry, sessionId, async () => {
    throw new Error("handleRequest simulated failure");
  });

  const session = registry.get(sessionId);
  assert.ok(session, "session should still exist");
  assert.strictEqual(session!.inFlight, 0, "inFlight must be 0 even after exception (finally block)");
});

// Test 3: 100 consecutive sessions — count <= 64, new sessions can initialize
test("Test 3: 100 consecutive ChatGPT-style sessions — count \u2264 64", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  for (let i = 0; i < 100; i++) {
    const sessionId = `chatgpt-session-${i}`;
    const transport = createMockTransport();
    const registered = registry.register(sessionId, transport);

    if (registered) {
      await simulateExistingSessionRequest(registry, sessionId, async () => {
        // request handled
      });
    }
  }

  assert.ok(
    registry.size <= 64,
    `session count should be \u2264 64, got ${registry.size}`,
  );
  assert.ok(registry.get("chatgpt-session-99"), "latest session should be alive");
});

// Test 4: 64 old idle sessions — new session evicts oldest, new session survives
test("Test 4: 64 idle sessions — new session evicts oldest, new survives", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  for (let i = 0; i < 64; i++) {
    const transport = createMockTransport();
    assert.ok(registry.register(`old-${i}`, transport), `old-${i} should register`);
  }
  assert.strictEqual(registry.size, 64, "should be at capacity");

  const newTransport = createMockTransport();
  const registered = registry.register("new-session", newTransport);

  assert.ok(registered, "new session should register successfully");
  assert.strictEqual(registry.size, 64, "should still be 64 after eviction+registration");
  assert.ok(registry.get("new-session"), "new session must be in registry");
  assert.ok(!registry.get("old-0"), "oldest session (old-0) should have been evicted");
});

// Test 5: 64 active sessions — new initialize gets 503, no timeout
test("Test 5: 64 active sessions — atCapacity=true, register rejected", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  for (let i = 0; i < 64; i++) {
    const transport = createMockTransport();
    registry.register(`active-${i}`, transport);
    registry.markActive(`active-${i}`);
  }
  assert.strictEqual(registry.size, 64, "should be at capacity");

  assert.ok(registry.atCapacity, "atCapacity must be true when all sessions are busy");

  const newTransport = createMockTransport();
  const registered = registry.register("rejected-session", newTransport);

  assert.strictEqual(registered, false, "register must return false at capacity");
  assert.strictEqual(registry.size, 64, "size must remain 64 (new session not added)");
  assert.ok(!registry.get("rejected-session"), "rejected session must not be in registry");
});

// Test 6: Full flow — initialize -> notifications/initialized -> tools/list -> open_workspace
test("Test 6: Full MCP flow — initialize \u2192 notifications/initialized \u2192 tools/list \u2192 open_workspace", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  // Step 1: initialize using reservation API
  assert.ok(!registry.atCapacity, "should not be at capacity initially");
  const initResult = simulateInitializeWithReservation(registry, "full-flow-session");
  assert.ok(initResult.committed, "initialize should commit reservation");
  assert.strictEqual(registry.pendingReservations, 0, "no pending reservations after commit");

  const sessionId = "full-flow-session";
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after initialize");

  // Step 2: notifications/initialized
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during notifications/initialized");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after notifications/initialized");

  // Step 3: tools/list
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during tools/list");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after tools/list");

  // Step 4: open_workspace
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during open_workspace");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after open_workspace");

  assert.ok(registry.get(sessionId), "session should still exist after full flow");
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after complete flow");
});

// Test 7 (regression): 70 consecutive requests on same session — inFlight stays 0
test("Test 7 (regression): 70 consecutive requests, inFlight stays 0", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "regression-70";

  registry.register(sessionId, transport);

  for (let i = 0; i < 70; i++) {
    await simulateExistingSessionRequest(registry, sessionId, async () => {
      // request handled
    });
  }

  const session = registry.get(sessionId);
  assert.ok(session, "session should still exist");
  assert.strictEqual(session!.inFlight, 0, "inFlight must be 0 after 70 requests (was 70 with old bug)");
  assert.ok(!registry.atCapacity, "should not be at capacity with 1 session");
});

// Test 8 (regression): Old bug simulation — verify double markActive is detected
test("Test 8 (regression): Double markActive + single markIdle leaves inFlight=1 (documents old bug)", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "old-bug-demo";

  registry.register(sessionId, transport);

  registry.markActive(sessionId);
  registry.markActive(sessionId);
  registry.markIdle(sessionId);

  assert.strictEqual(
    registry.get(sessionId)?.inFlight,
    1,
    "OLD BUG: inFlight=1 after double markActive + single markIdle (should be 0)",
  );

  registry.markIdle(sessionId);
  registry.markActive(sessionId);
  registry.markIdle(sessionId);

  assert.strictEqual(
    registry.get(sessionId)?.inFlight,
    0,
    "FIXED: inFlight=0 after single markActive + single markIdle",
  );
});

// ─── Reservation API Tests ─────────────────────────────────────────────

// Test 9: tryReserveSlot creates a reservation
test("Test 9: tryReserveSlot creates reservation, occupiedCapacity increases", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  assert.strictEqual(registry.occupiedCapacity, 0, "initial capacity 0");
  assert.strictEqual(registry.pendingReservations, 0, "no reservations initially");

  const res = registry.tryReserveSlot();
  assert.ok(res, "reservation should be created");
  assert.strictEqual(registry.pendingReservations, 1, "1 pending reservation");
  assert.strictEqual(registry.occupiedCapacity, 1, "capacity includes reservation");
  assert.strictEqual(registry.size, 0, "no sessions yet");
});

// Test 10: commitReservation turns reservation into session
test("Test 10: commitReservation creates session, clears reservation", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  const res = registry.tryReserveSlot();
  assert.ok(res);

  const transport = createMockTransport();
  const committed = registry.commitReservation(res!, "sess-1", transport);
  assert.strictEqual(committed, true, "commit should succeed");
  assert.strictEqual(registry.pendingReservations, 0, "reservation cleared");
  assert.strictEqual(registry.size, 1, "1 session registered");
  assert.strictEqual(registry.occupiedCapacity, 1, "capacity still 1 (session replaces reservation)");
  assert.ok(registry.get("sess-1"), "session exists");
});

// Test 11: releaseReservation returns slot without creating session
test("Test 11: releaseReservation frees slot without session", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  const res = registry.tryReserveSlot();
  assert.ok(res);
  assert.strictEqual(registry.occupiedCapacity, 1);

  registry.releaseReservation(res!);
  assert.strictEqual(registry.pendingReservations, 0, "reservation cleared");
  assert.strictEqual(registry.size, 0, "no session created");
  assert.strictEqual(registry.occupiedCapacity, 0, "capacity back to 0");
});

// Test 12: Double commit is rejected
test("Test 12: Double commit is rejected (returns false)", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  const res = registry.tryReserveSlot();
  assert.ok(res);

  const t1 = createMockTransport();
  const t2 = createMockTransport();
  assert.ok(registry.commitReservation(res!, "sess-a", t1), "first commit succeeds");
  assert.strictEqual(registry.commitReservation(res!, "sess-b", t2), false, "second commit rejected");
  assert.strictEqual(registry.size, 1, "only 1 session");
  assert.ok(!registry.get("sess-b"), "second session not created");
});

// Test 13: Double release is a no-op
test("Test 13: Double release is a no-op", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  const res = registry.tryReserveSlot();
  assert.ok(res);

  registry.releaseReservation(res!);
  assert.strictEqual(registry.occupiedCapacity, 0);
  // Second release should not throw or affect state
  registry.releaseReservation(res!);
  assert.strictEqual(registry.occupiedCapacity, 0, "still 0 after double release");
});

// Test 14: Reservation prevents exceeding maxSessions under concurrency
test("Test 14: 100 concurrent tryReserveSlot — at most 64 succeed", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  let successCount = 0;
  let failCount = 0;
  const reservations: unknown[] = [];

  for (let i = 0; i < 100; i++) {
    const res = registry.tryReserveSlot();
    if (res) {
      successCount++;
      reservations.push(res);
    } else {
      failCount++;
    }
  }

  assert.strictEqual(successCount, 64, `exactly 64 reservations should succeed, got ${successCount}`);
  assert.strictEqual(failCount, 36, `36 should fail, got ${failCount}`);
  assert.strictEqual(registry.occupiedCapacity, 64, "capacity at 64");
  assert.strictEqual(registry.pendingReservations, 64, "64 pending reservations");
  assert.ok(registry.atCapacity, "atCapacity with all reservations (no idle sessions to evict)");
});

// Test 15: Reservation + commit + 100 more initialize
test("Test 15: 64 committed sessions, then 100 tryReserveSlot — evicts idle, stays <=64", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  // Fill with 64 idle sessions via reservation+commit
  for (let i = 0; i < 64; i++) {
    const res = registry.tryReserveSlot();
    assert.ok(res, `reservation ${i} should succeed`);
    const transport = createMockTransport();
    assert.ok(registry.commitReservation(res!, `sess-${i}`, transport), `commit ${i}`);
  }
  assert.strictEqual(registry.size, 64, "64 sessions");
  assert.strictEqual(registry.pendingReservations, 0, "no pending");

  // Now 100 more initialize requests — each should evict an idle session
  for (let i = 0; i < 100; i++) {
    const res = registry.tryReserveSlot();
    assert.ok(res, `reservation new-${i} should succeed (evicts idle)`);
    const transport = createMockTransport();
    assert.ok(registry.commitReservation(res!, `new-${i}`, transport), `commit new-${i}`);
    assert.ok(registry.occupiedCapacity <= 64, `capacity must stay <= 64, got ${registry.occupiedCapacity}`);
  }

  assert.strictEqual(registry.size, 64, "still 64 sessions");
  assert.ok(registry.get("new-99"), "latest session alive");
  assert.ok(!registry.get("sess-0"), "oldest evicted");
});

// Test 16: Release reservation on failure (simulate initialize exception)
test("Test 16: Initialize fails — reservation released in finally, slot freed", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  // Simulate the server pattern: reserve -> exception -> release in finally
  let initReservation: ReturnType<typeof registry.tryReserveSlot> | undefined;
  let reservationCommitted = false;

  try {
    initReservation = registry.tryReserveSlot();
    assert.ok(initReservation, "reservation created");
    assert.strictEqual(registry.pendingReservations, 1, "1 pending");

    // Simulate server.connect or transport creation throwing
    throw new Error("server.connect failed");
  } catch {
    // error handling
  } finally {
    if (initReservation && !reservationCommitted) {
      registry.releaseReservation(initReservation);
    }
  }

  assert.strictEqual(registry.pendingReservations, 0, "reservation released");
  assert.strictEqual(registry.occupiedCapacity, 0, "capacity back to 0");
  assert.strictEqual(registry.size, 0, "no session created");
});

// Wait for all async tests to complete
setTimeout(() => {
  if (process.exitCode === 1) {
    console.error("\n\u2717 Some tests FAILED\n");
    process.exit(1);
  } else {
    console.log("\n\u2713 All session lifecycle tests passed\n");
  }
}, 3000);
