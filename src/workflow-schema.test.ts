import assert from "node:assert/strict";
import {
  augmentPromptForSchema,
  enforceAgentSchema,
  formatAjvErrors,
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

console.log("workflow-schema.test.ts: ok");
