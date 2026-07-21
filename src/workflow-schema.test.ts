import assert from "node:assert/strict";
import {
  augmentPromptForSchema,
  enforceAgentSchema,
  formatAjvErrors,
  NATIVE_SCHEMA_PROVIDERS,
} from "./workflow-schema.js";
import { WorkflowEngineError } from "./workflow-api.js";

{
  const prompt = augmentPromptForSchema("find bugs", {
    type: "object",
    properties: { n: { type: "number" } },
    required: ["n"],
  });
  assert.match(prompt, /ONLY a JSON/);
  assert.match(prompt, /"n"/);
}

assert.equal(
  formatAjvErrors([{ instancePath: "/n", message: "must be number" }]),
  "/n must be number",
);

assert.ok(NATIVE_SCHEMA_PROVIDERS.has("codex"));
assert.ok(NATIVE_SCHEMA_PROVIDERS.has("claude"));
assert.ok(!NATIVE_SCHEMA_PROVIDERS.has("opencode"));

{
  let attempts = 0;
  const result = await enforceAgentSchema({
    schema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
    prompt: "give n",
    run: async () => {
      attempts += 1;
      if (attempts === 1) return { finalResponse: '{"n":"x"}' };
      return { finalResponse: '{"n":2}', providerSessionId: "sess" };
    },
  });
  assert.deepEqual(result.value, { n: 2 });
  assert.equal(result.attempts, 2);
  assert.equal(result.providerSessionId, "sess");
  assert.equal(result.mode, "prompt");
}

{
  await assert.rejects(
    () =>
      enforceAgentSchema({
        schema: { type: "object", properties: { n: { type: "number" } }, required: ["n"] },
        prompt: "x",
        maxRetries: 1,
        run: async () => ({ finalResponse: "not json" }),
      }),
    (error: unknown) =>
      error instanceof WorkflowEngineError && error.kind === "schema",
  );
}

// Native provider: structured on attempt 0 → single attempt, raw prompt.
{
  const seen: Array<{ prompt: string; mode?: string }> = [];
  const result = await enforceAgentSchema({
    schema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
    prompt: "give n",
    provider: "codex",
    run: async (prompt, opts) => {
      seen.push({ prompt, mode: opts?.mode });
      return { finalResponse: "noise", structured: { n: 7 } };
    },
  });
  assert.deepEqual(result.value, { n: 7 });
  assert.equal(result.attempts, 1);
  assert.equal(result.mode, "native");
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.prompt, "give n");
  assert.equal(seen[0]?.mode, "native");
  assert.ok(!seen[0]?.prompt.includes("ONLY a JSON"));
}

// Native fail then prompt repair.
{
  const seen: Array<{ prompt: string; mode?: string }> = [];
  const retries: Array<{ attempt: number; mode: string }> = [];
  const result = await enforceAgentSchema({
    schema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
      additionalProperties: false,
    },
    prompt: "give n",
    provider: "claude",
    onRetry: ({ attempt, mode }) => {
      retries.push({ attempt, mode });
    },
    run: async (prompt, opts) => {
      seen.push({ prompt, mode: opts?.mode });
      if (opts?.mode === "native") {
        return { finalResponse: '{"n":"bad"}', structured: { n: "bad" } };
      }
      return { finalResponse: '{"n":3}', structured: { n: 3 } };
    },
  });
  assert.deepEqual(result.value, { n: 3 });
  assert.equal(result.attempts, 2);
  assert.equal(result.mode, "prompt");
  assert.equal(seen[0]?.mode, "native");
  assert.equal(seen[1]?.mode, "prompt");
  assert.ok(seen[1]?.prompt.includes("ONLY a JSON"));
  assert.deepEqual(retries[0], { attempt: 1, mode: "native" });
}

// Non-native never gets native mode.
{
  const modes: string[] = [];
  const result = await enforceAgentSchema({
    schema: {
      type: "object",
      properties: { n: { type: "number" } },
      required: ["n"],
    },
    prompt: "give n",
    provider: "opencode",
    run: async (prompt, opts) => {
      modes.push(opts?.mode ?? "missing");
      assert.ok(prompt.includes("ONLY a JSON"));
      return { finalResponse: '{"n":1}' };
    },
  });
  assert.deepEqual(result.value, { n: 1 });
  assert.deepEqual(modes, ["prompt"]);
  assert.equal(result.mode, "prompt");
}

console.log("workflow-schema.test.ts: ok");
