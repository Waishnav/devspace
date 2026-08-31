import assert from "node:assert/strict";
import { McpSessionRegistry } from "./mcp-sessions.js";

interface FakeTransport {
  closeCalls: number;
  close(): Promise<void>;
}

function createTransport(closeError?: Error): FakeTransport {
  return {
    closeCalls: 0,
    async close() {
      this.closeCalls += 1;
      if (closeError) throw closeError;
    },
  };
}

/** Reserve a slot and commit a fake transport for registry tests. */
async function reserveAndCommit(
  registry: McpSessionRegistry<FakeTransport>,
  sessionId: string,
  transport: FakeTransport,
  options: { active?: boolean } = {},
): Promise<void> {
  const result = await registry.reserve();
  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(await result.reservation.commit(sessionId, transport, options), true);
}

let now = 0;
const registry = new McpSessionRegistry<FakeTransport>({ now: () => now, maxSessions: 4 });
const staleTransport = createTransport();
const activeTransport = createTransport();

await reserveAndCommit(registry, "stale", staleTransport);
now = 1_000;
await reserveAndCommit(registry, "active", activeTransport);
now = 1_500;
assert.equal(registry.acquire("active"), activeTransport);
now = 2_000;

const idleResults = await registry.closeIdle(1_500);
assert.deepEqual(idleResults, [{ sessionId: "stale" }]);
assert.equal(staleTransport.closeCalls, 1);
assert.equal(activeTransport.closeCalls, 0);
assert.equal(registry.size, 1);
assert.equal(registry.acquire("stale"), undefined);
assert.equal(registry.release("active"), true);
assert.equal(registry.release("active"), false);
assert.equal(registry.activeSessions, 0);

const closeError = new Error("close failed");
const failingTransport = createTransport(closeError);
await reserveAndCommit(registry, "failing", failingTransport);
now = 10_000;

const failingResults = await registry.closeIdle(1);
assert.equal(failingResults.length, 2);
assert.deepEqual(failingResults.map((result) => result.sessionId).sort(), ["active", "failing"]);
assert.equal(failingResults.find((result) => result.sessionId === "failing")?.error, closeError);
assert.equal(failingTransport.closeCalls, 1);
assert.equal(registry.size, 1, "a failed close keeps its slot occupied");
assert.equal(registry.acquire("failing"), failingTransport);
assert.equal(registry.release("failing"), true);
registry.remove("failing");

const first = createTransport();
const second = createTransport();
await reserveAndCommit(registry, "first", first);
await reserveAndCommit(registry, "second", second);
registry.remove("first");

const shutdownResults = await registry.closeAll();
assert.deepEqual(shutdownResults, [{ sessionId: "second" }]);
assert.equal(first.closeCalls, 0);
assert.equal(second.closeCalls, 1);
assert.equal(registry.size, 0);

const delayedRegistry = new McpSessionRegistry<FakeTransport>();
let finishDelayedClose: (() => void) | undefined;
let delayedCloseResolved = false;
const delayedTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishDelayedClose = resolve;
    });
  },
};
await reserveAndCommit(delayedRegistry, "delayed", delayedTransport);
const delayedClose = delayedRegistry.closeAll();
void delayedClose.then(() => {
  delayedCloseResolved = true;
});

await new Promise<void>((resolve) => setImmediate(resolve));
assert.equal(delayedCloseResolved, false);
assert.equal(delayedTransport.closeCalls, 1);
finishDelayedClose?.();
await delayedClose;
assert.equal(delayedCloseResolved, true);
assert.equal(delayedRegistry.size, 0);

const bounded = new McpSessionRegistry<FakeTransport>({ now: () => now, maxSessions: 2 });
const oldest = createTransport();
const protectedTransport = createTransport();
const replacement = createTransport();

now = 20_000;
await reserveAndCommit(bounded, "oldest", oldest);
now = 21_000;
await reserveAndCommit(bounded, "protected", protectedTransport, { active: true });
assert.equal(bounded.size, 2);
assert.equal(bounded.occupancy, 2);
assert.equal(bounded.activeSessions, 1);

now = 22_000;
const replacementReservation = await bounded.reserve();
assert.equal(replacementReservation.ok, true);
if (replacementReservation.ok) {
  assert.equal(replacementReservation.reservation.evictedSessionId, "oldest");
  assert.equal(oldest.closeCalls, 1);
  assert.equal(protectedTransport.closeCalls, 0);
  assert.equal(await replacementReservation.reservation.commit("replacement", replacement), true);
}
assert.equal(bounded.size, 2);
assert.equal(bounded.occupancy, 2);
assert.equal(bounded.acquire("oldest"), undefined);

assert.equal(bounded.acquire("replacement"), replacement);
assert.equal(bounded.activeSessions, 2);
const blocked = await bounded.reserve();
assert.deepEqual(blocked, { ok: false, reason: "capacity_exhausted" });
assert.equal(bounded.size, 2);
assert.equal(bounded.occupancy, 2);
assert.equal(protectedTransport.closeCalls, 0);
assert.equal(replacement.closeCalls, 0);
assert.equal(bounded.release("replacement"), true);
assert.equal(bounded.release("protected"), true);

const closeFailure = new Error("cannot close candidate");
const closeFailureRegistry = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const stuck = createTransport(closeFailure);
await reserveAndCommit(closeFailureRegistry, "stuck", stuck);
const deniedByCloseFailure = await closeFailureRegistry.reserve();
assert.equal(deniedByCloseFailure.ok, false);
if (!deniedByCloseFailure.ok) {
  assert.equal(deniedByCloseFailure.reason, "close_failed");
  assert.equal(deniedByCloseFailure.sessionId, "stuck");
  assert.equal(deniedByCloseFailure.error, closeFailure);
}
assert.equal(closeFailureRegistry.size, 1);
assert.equal(closeFailureRegistry.occupancy, 1);
assert.equal(stuck.closeCalls, 1);

const fallbackRegistry = new McpSessionRegistry<FakeTransport>({ now: () => now, maxSessions: 2 });
const brokenCandidate = createTransport(new Error("broken candidate"));
const healthyCandidate = createTransport();
now = 30_000;
await reserveAndCommit(fallbackRegistry, "broken", brokenCandidate);
now = 31_000;
await reserveAndCommit(fallbackRegistry, "healthy", healthyCandidate);
const fallbackReservation = await fallbackRegistry.reserve();
assert.equal(fallbackReservation.ok, true);
if (fallbackReservation.ok) {
  assert.equal(fallbackReservation.reservation.evictedSessionId, "healthy");
  assert.equal(await fallbackReservation.reservation.commit("replacement", createTransport()), true);
}
assert.equal(brokenCandidate.closeCalls, 1);
assert.equal(healthyCandidate.closeCalls, 1);
assert.equal(fallbackRegistry.size, 2);
assert.equal(fallbackRegistry.occupancy, 2);

const concurrent = new McpSessionRegistry<FakeTransport>({ maxSessions: 2 });
const base = createTransport();
await reserveAndCommit(concurrent, "base", base);
const firstReservation = await concurrent.reserve();
assert.equal(firstReservation.ok, true);
assert.equal(concurrent.occupancy, 2, "initialize reserves its slot before it runs");
const secondReservation = await concurrent.reserve();
assert.equal(secondReservation.ok, true);
assert.equal(base.closeCalls, 1, "a second initialize evicts the idle session to claim a slot");
assert.equal(concurrent.occupancy, 2);
if (firstReservation.ok) {
  assert.equal(await firstReservation.reservation.commit("new-1", createTransport(), { active: true }), true);
}
if (secondReservation.ok) {
  assert.equal(await secondReservation.reservation.commit("new-2", createTransport(), { active: true }), true);
}
assert.equal(concurrent.size, 2);
assert.equal(concurrent.occupancy, 2);
assert.equal(concurrent.activeSessions, 2);
const allProtected = await concurrent.reserve();
assert.deepEqual(allProtected, { ok: false, reason: "capacity_exhausted" });

const callbackRemovalRegistry = new McpSessionRegistry<FakeTransport>({ maxSessions: 2 });
let finishCallbackClose: (() => void) | undefined;
let callbackCloseStarted!: () => void;
const callbackCloseStartedPromise = new Promise<void>((resolve) => {
  callbackCloseStarted = resolve;
});
const callbackRemovingTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    callbackRemovalRegistry.remove("callback-removal");
    callbackCloseStarted();
    return new Promise<void>((resolve) => {
      finishCallbackClose = resolve;
    });
  },
};
await reserveAndCommit(callbackRemovalRegistry, "callback-removal", callbackRemovingTransport);
await reserveAndCommit(callbackRemovalRegistry, "other", createTransport());
const callbackFirstReservationPromise = callbackRemovalRegistry.reserve();
await callbackCloseStartedPromise;
const callbackSecondReservationPromise = callbackRemovalRegistry.reserve();
finishCallbackClose?.();
const [callbackFirstReservation, callbackSecondReservation] = await Promise.all([
  callbackFirstReservationPromise,
  callbackSecondReservationPromise,
]);
assert.equal(callbackFirstReservation.ok, true);
assert.equal(callbackSecondReservation.ok, true);
assert.equal(
  callbackRemovalRegistry.occupancy,
  2,
  "onclose removal must not make the slot look free during eviction",
);
if (callbackFirstReservation.ok) {
  assert.equal(
    await callbackFirstReservation.reservation.commit("callback-new-1", createTransport(), { active: true }),
    true,
  );
}
if (callbackSecondReservation.ok) {
  assert.equal(
    await callbackSecondReservation.reservation.commit("callback-new-2", createTransport(), { active: true }),
    true,
  );
}
assert.equal(callbackRemovalRegistry.size, 2);
assert.equal(callbackRemovalRegistry.occupancy, 2);

const referenceCounted = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const referenceTransport = createTransport();
await reserveAndCommit(referenceCounted, "reference", referenceTransport);
assert.equal(referenceCounted.acquire("reference"), referenceTransport);
assert.equal(referenceCounted.acquire("reference"), referenceTransport);
assert.equal(referenceCounted.activeSessions, 1);
assert.equal(referenceCounted.release("reference"), true);
assert.equal(referenceCounted.activeSessions, 1);
assert.deepEqual(await referenceCounted.reserve(), { ok: false, reason: "capacity_exhausted" });
assert.equal(referenceCounted.release("reference"), true);
assert.equal(referenceCounted.activeSessions, 0);

const churnLimit = 256;
const churnRegistry = new McpSessionRegistry<FakeTransport>({ maxSessions: churnLimit });
const churnTransports: FakeTransport[] = [];
for (let index = 0; index < 1_024; index += 1) {
  const transport = createTransport();
  churnTransports.push(transport);
  const reservation = await churnRegistry.reserve();
  assert.equal(reservation.ok, true);
  if (!reservation.ok) continue;
  assert.equal(await reservation.reservation.commit(`churn-${index}`, transport), true);
  assert.ok(churnRegistry.size <= churnLimit);
  assert.ok(churnRegistry.occupancy <= churnLimit);
}
assert.equal(churnRegistry.size, churnLimit);
assert.equal(churnRegistry.occupancy, churnLimit);
assert.equal(
  churnTransports.slice(0, 1_024 - churnLimit).filter((transport) => transport.closeCalls === 1).length,
  1_024 - churnLimit,
  "churn closes every evicted session",
);
assert.equal(
  churnTransports.slice(1_024 - churnLimit).filter((transport) => transport.closeCalls !== 0).length,
  0,
  "the newest sessions stay open",
);

const releasedReservationRegistry = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const pending = await releasedReservationRegistry.reserve();
assert.equal(pending.ok, true);
assert.equal(releasedReservationRegistry.occupancy, 1);
if (pending.ok) pending.reservation.release();
assert.equal(releasedReservationRegistry.occupancy, 0);
assert.equal(releasedReservationRegistry.size, 0);

const shutdownRegistry = new McpSessionRegistry<FakeTransport>({ maxSessions: 1 });
const lateReservation = await shutdownRegistry.reserve();
assert.equal(lateReservation.ok, true);
assert.equal(shutdownRegistry.occupancy, 1);
let finishShutdownClose: (() => void) | undefined;
const lateTransport: FakeTransport = {
  closeCalls: 0,
  close() {
    this.closeCalls += 1;
    return new Promise<void>((resolve) => {
      finishShutdownClose = resolve;
    });
  },
};
let shutdownResolved = false;
const shutdown = shutdownRegistry.closeAll().then((results) => {
  shutdownResolved = true;
  return results;
});
await Promise.resolve();
assert.equal(shutdownResolved, false);
if (lateReservation.ok) {
  const lateCommit = lateReservation.reservation.commit("late", lateTransport);
  await Promise.resolve();
  assert.equal(lateTransport.closeCalls, 1);
  assert.equal(shutdownResolved, false);
  finishShutdownClose?.();
  assert.equal(await lateCommit, false);
}
assert.deepEqual(await shutdown, []);
assert.equal(shutdownResolved, true);
assert.equal(shutdownRegistry.size, 0);
assert.equal(shutdownRegistry.occupancy, 0);
assert.deepEqual(await shutdownRegistry.reserve(), { ok: false, reason: "capacity_exhausted" });

assert.throws(
  () => new McpSessionRegistry<FakeTransport>({ maxSessions: 0 }),
  /positive integer/,
);
