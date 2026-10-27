import assert from "node:assert/strict";
import test from "node:test";
import { concurrencyLimiter } from "./code-mode-executions.js";

const settle = () => new Promise((resolve) => setImmediate(resolve));

async function afterMicrotasks(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) await Promise.resolve();
}

test("concurrency limiter never runs more tasks than its limit", async () => {
  // A caller can arrive at any microtask boundary after a slot is released.
  for (let delay = 0; delay < 8; delay += 1) {
    const limit = concurrencyLimiter(4);
    let active = 0;
    let peak = 0;
    const releases: Array<() => void> = [];

    const task = () => limit(async () => {
      peak = Math.max(peak, ++active);
      await new Promise<void>((resolve) => releases.push(resolve));
      active--;
    });

    const started = Array.from({ length: 5 }, task);
    await settle();
    releases.shift()?.();
    await afterMicrotasks(delay);
    started.push(task());
    await settle();

    while (releases.length > 0) {
      releases.shift()?.();
      await settle();
    }

    await Promise.all(started);
    assert.equal(peak, 4, `peak exceeded the limit with a caller arriving after ${delay} microtasks`);
  }
});
