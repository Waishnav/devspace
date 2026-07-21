import assert from "node:assert/strict";
import {
  agentOptsSchema,
  localAgentProviderSchema,
  parseWorkflowEventPayload,
  workflowMetaSchema,
  type WorkflowAgent,
  type WorkflowParallel,
} from "./workflow-contracts.js";
import {
  jsonSchemaSchema,
  jsonValueSchema,
} from "./json-types.js";
import {
  LOCAL_AGENT_PROVIDER_CAPABILITIES,
} from "./local-agent-capabilities.js";
import { LOCAL_AGENT_PROVIDERS } from "./local-agent-profiles.js";

assert.deepEqual(localAgentProviderSchema.options, LOCAL_AGENT_PROVIDERS);
assert.deepEqual(
  Object.keys(LOCAL_AGENT_PROVIDER_CAPABILITIES).sort(),
  [...LOCAL_AGENT_PROVIDERS].sort(),
);

assert.deepEqual(
  workflowMetaSchema.parse({
    name: "typed-review",
    description: "Review with typed contracts",
    defaultProvider: "codex",
    phases: [{ title: "Review" }],
  }),
  {
    name: "typed-review",
    description: "Review with typed contracts",
    defaultProvider: "codex",
    phases: [{ title: "Review" }],
  },
);

assert.throws(
  () =>
    workflowMetaSchema.parse({
      name: "typed-review",
      description: "d",
      unknown: true,
    }),
  /Unrecognized key/,
);

assert.throws(
  () => agentOptsSchema.parse({ provider: "made-up" }),
  /Invalid option/,
);
assert.throws(() => agentOptsSchema.parse({ schema: [] }), /expected record/i);
assert.throws(() => jsonValueSchema.parse(new Date()), /invalid input/i);
assert.throws(() => jsonValueSchema.parse(() => undefined), /invalid input/i);

assert.deepEqual(
  jsonSchemaSchema.parse({
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  }),
  {
    type: "object",
    properties: { count: { type: "number" } },
    required: ["count"],
  },
);

assert.deepEqual(
  parseWorkflowEventPayload("agent_call_completed", {
    callIndex: 2,
    provider: "claude",
    isolation: "shared",
    fromCache: false,
  }),
  {
    callIndex: 2,
    provider: "claude",
    isolation: "shared",
    fromCache: false,
  },
);
assert.throws(
  () =>
    parseWorkflowEventPayload("run_completed", {
      provider: "codex",
    }),
  /callCount/,
);

declare const agent: WorkflowAgent;
declare const parallel: WorkflowParallel;

if (false) {
  const output = await agent("Return a count", {
    schema: {
      type: "object",
      properties: {
        count: { type: "number" },
      },
      required: ["count"],
      additionalProperties: false,
    } as const,
  });
  const count: number = output.count;
  void count;

  // @ts-expect-error schema-derived output has no `missing` field
  void output.missing;

  // @ts-expect-error providers are exhaustive
  await agent("x", { provider: "made-up" });

  const tuple = await parallel([
    async () => "text",
    async () => 42,
  ] as const);
  const first: string | null = tuple[0];
  const second: number | null = tuple[1];
  void first;
  void second;
}

console.log("workflow-contracts.test.ts: ok");
