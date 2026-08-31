import assert from "node:assert/strict";
import { AgentProviderExecutionError } from "./local-agent-errors.js";
import { WorkflowEngineError } from "./workflow-api.js";
import { supportsNativeStructuredOutput } from "./local-agent-capabilities.js";
import {
  augmentPromptForSchema,
  enforceAgentSchema,
  formatAjvErrors,
} from "./workflow-schema.js";

const schema = {
  type: "object",
  properties: { n: { type: "number" } },
  required: ["n"],
  additionalProperties: false,
} as const;

const prompt = augmentPromptForSchema("find bugs", schema);
assert.match(prompt, /ONLY a JSON/);
assert.match(prompt, /"n"/);
assert.equal(
  formatAjvErrors([{ instancePath: "/n", message: "must be number" }]),
  "/n must be number",
);

assert.equal(supportsNativeStructuredOutput("codex"), false);
assert.equal(supportsNativeStructuredOutput("claude"), false);
assert.equal(supportsNativeStructuredOutput("grok"), false);

{
  const seen: Array<{ prompt: string; session?: string }> = [];
  const result = await enforceAgentSchema({
    schema,
    prompt: "give n",
    provider: "codex",
    run: async (attemptPrompt, options) => {
      seen.push({ prompt: attemptPrompt, session: options.providerSessionId });
      if (seen.length === 1) {
        return { finalResponse: '{"n":"bad"}', providerSessionId: "session_1" };
      }
      return { finalResponse: '{"n":2}', providerSessionId: "session_1" };
    },
  });
  assert.deepEqual(result.value, { n: 2 });
  assert.equal(result.mode, "prompt");
  assert.equal(result.attempts, 2);
  assert.equal(seen[1]?.session, "session_1");
  assert.ok(seen.every((attempt) => attempt.prompt.includes("ONLY a JSON")));
}

await assert.rejects(
  () => enforceAgentSchema({
    schema,
    prompt: "give n",
    provider: "opencode",
    maxRetries: 0,
    run: async () => ({ finalResponse: "not json" }),
  }),
  (error: unknown) => error instanceof WorkflowEngineError && error.kind === "schema",
);

await assert.rejects(
  () => enforceAgentSchema({
    schema,
    prompt: "give n",
    provider: "codex",
    run: async () => {
      throw new Error("authentication failed");
    },
  }),
  (error: unknown) => AgentProviderExecutionError.is(error),
);

console.log("workflow-schema.test.ts: ok");
