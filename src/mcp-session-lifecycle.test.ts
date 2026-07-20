/**
 * MCP Session Lifecycle Regression Tests
 *
 * Tests the fix for the inFlight counter leak caused by duplicate markActive calls.
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
  // This mirrors the fixed pattern in server.ts:
  // - activeSessionId declared outside try
  // - single markActive inside try
  // - markIdle in finally, only if activeSessionId was set
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
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });
  const transport = createMockTransport();
  const sessionId = "test-1";

  assert.ok(registry.register(sessionId, transport) === true, "register should return true");
  assert.strictEqual(registry.size, 1, "should have 1 session");
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight should start at 0");

  // Simulate a normal request
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

// Test 3: 100 consecutive sessions — count ≤ 64, new sessions can initialize
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
      // Simulate a complete request lifecycle
      await simulateExistingSessionRequest(registry, sessionId, async () => {
        // request handled
      });
    }
  }

  assert.ok(
    registry.size <= 64,
    `session count should be \u2264 64, got ${registry.size}`,
  );
  // After 100 sessions with proper lifecycle, the oldest idle ones get evicted
  // The newest sessions should be alive
  assert.ok(registry.get("chatgpt-session-99"), "latest session should be alive");
});

// Test 4: 64 old idle sessions — new session evicts oldest, new session survives
test("Test 4: 64 idle sessions — new session evicts oldest, new survives", () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  // Fill up with 64 idle sessions (inFlight=0)
  for (let i = 0; i < 64; i++) {
    const transport = createMockTransport();
    assert.ok(registry.register(`old-${i}`, transport), `old-${i} should register`);
  }
  assert.strictEqual(registry.size, 64, "should be at capacity");

  // Register a new session — should evict the oldest idle one
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

  // Fill up with 64 active sessions (inFlight > 0, never markIdle)
  for (let i = 0; i < 64; i++) {
    const transport = createMockTransport();
    registry.register(`active-${i}`, transport);
    registry.markActive(`active-${i}`); // inFlight = 1, never markIdle
  }
  assert.strictEqual(registry.size, 64, "should be at capacity");

  // atCapacity should be true — no evictable sessions
  assert.ok(registry.atCapacity, "atCapacity must be true when all sessions are busy");

  // Attempt to register a new session — should be rejected (returns false)
  const newTransport = createMockTransport();
  const registered = registry.register("rejected-session", newTransport);

  assert.strictEqual(registered, false, "register must return false at capacity");
  assert.strictEqual(registry.size, 64, "size must remain 64 (new session not added)");
  assert.ok(!registry.get("rejected-session"), "rejected session must not be in registry");
});

// Test 6: Full flow — initialize → notifications/initialized → tools/list → open_workspace
test("Test 6: Full MCP flow — initialize \u2192 notifications/initialized \u2192 tools/list \u2192 open_workspace", async () => {
  const registry = new McpSessionRegistry({
    idleMs: 60_000,
    sweepMs: 5_000,
    maxSessions: 64,
  });

  // Step 1: initialize — creates a new session (no markActive)
  assert.ok(!registry.atCapacity, "should not be at capacity initially");
  const initTransport = createMockTransport();
  const sessionId = "full-flow-session";
  assert.ok(registry.register(sessionId, initTransport), "initialize should register");

  // initialize does NOT call markActive (activeSessionId stays undefined in server.ts)
  // So markIdle is NOT called in finally for initialize
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after initialize");

  // Step 2: notifications/initialized — existing session request
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during notifications/initialized");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after notifications/initialized");

  // Step 3: tools/list — existing session request
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during tools/list");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after tools/list");

  // Step 4: open_workspace — existing session request
  await simulateExistingSessionRequest(registry, sessionId, async () => {
    assert.strictEqual(registry.get(sessionId)?.inFlight, 1, "inFlight=1 during open_workspace");
  });
  assert.strictEqual(registry.get(sessionId)?.inFlight, 0, "inFlight=0 after open_workspace");

  // After full flow, session should still be alive with inFlight=0
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

  // Simulate 70 consecutive requests (the old bug would leave inFlight=70)
  for (let i = 0; i < 70; i++) {
    await simulateExistingSessionRequest(registry, sessionId, async () => {
      // request handled
    });
  }

  const session = registry.get(sessionId);
  assert.ok(session, "session should still exist");
  assert.strictEqual(session!.inFlight, 0, "inFlight must be 0 after 70 requests (was 70 with old bug)");

  // Registry should not be at capacity
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

  // Simulate the OLD buggy pattern: markActive twice, markIdle once
  registry.markActive(sessionId); // first markActive (was at line 1534/1911)
  registry.markActive(sessionId); // second markActive (was at line 1565/1951) — BUG!
  registry.markIdle(sessionId);   // only one markIdle (was at line 1570/1956)

  assert.strictEqual(
    registry.get(sessionId)?.inFlight,
    1,
    "OLD BUG: inFlight=1 after double markActive + single markIdle (should be 0)",
  );

  // Now verify the FIXED pattern gives 0
  registry.markIdle(sessionId); // clean up
  registry.markActive(sessionId); // single markActive
  registry.markIdle(sessionId);   // single markIdle

  assert.strictEqual(
    registry.get(sessionId)?.inFlight,
    0,
    "FIXED: inFlight=0 after single markActive + single markIdle",
  );
});

// Wait for all async tests to complete
setTimeout(() => {
  if (process.exitCode === 1) {
    console.error("\n\u2717 Some tests FAILED\n");
    process.exit(1);
  } else {
    console.log("\n\u2713 All session lifecycle tests passed\n");
  }
}, 2000);
