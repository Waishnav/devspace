import assert from "node:assert/strict";
import {
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
} from "./onboarding.js";

for (const [selections, expected] of [
  [["chatgpt"], "chatgpt"],
  [["coding-agents"], "coding-agents"],
  [["coding-agents", "chatgpt"], "both"],
] as const) {
  assert.equal(resolveOnboardingUsage(selections), expected);
}
assert.throws(() => resolveOnboardingUsage([]), /Choose ChatGPT, Coding Agents, or both/);

assert.deepEqual(
  updateOnboardingSubagentsConfig(
    { enabled: false, providers: [] },
    ["codex", "claude"],
  ),
  {
    enabled: true,
    providers: [
      { id: "codex", enabled: true },
      { id: "claude", enabled: true },
    ],
  },
);

const configured = {
  enabled: true,
  providers: [
    {
      id: "codex" as const,
      enabled: true,
      model: "gpt-5.4",
      effort: "high",
      command: "/opt/bin/codex-wrapper",
      env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
    },
    { id: "claude" as const, enabled: true, model: "sonnet" },
  ],
};
assert.deepEqual(
  updateOnboardingSubagentsConfig(configured, ["claude"]),
  {
    enabled: true,
    providers: [
      {
        id: "codex",
        enabled: false,
        model: "gpt-5.4",
        effort: "high",
        command: "/opt/bin/codex-wrapper",
        env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
      },
      { id: "claude", enabled: true, model: "sonnet" },
    ],
  },
);
