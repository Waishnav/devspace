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
    { enabled: false, instructions: "on-demand", providers: [] },
    ["codex", "claude"],
  ),
  {
    enabled: true,
    instructions: "on-demand",
    providers: [
      { id: "codex", driver: "codex", enabled: true },
      { id: "claude", driver: "claude", enabled: true },
    ],
  },
);

const configured = {
  enabled: true,
  instructions: "preload" as const,
  providers: [
    {
      id: "codex" as const,
      driver: "codex" as const,
      enabled: true,
      model: "gpt-5.4",
      effort: "high",
      command: "/opt/bin/codex-wrapper",
      env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
    },
    { id: "claude" as const, driver: "claude" as const, enabled: true, model: "sonnet" },
    { id: "codex-work", driver: "codex" as const, enabled: true, model: "gpt-work" },
  ],
};
assert.deepEqual(
  updateOnboardingSubagentsConfig(configured, ["claude", "codex-work"]),
  {
    enabled: true,
    instructions: "preload",
    providers: [
      {
        id: "codex",
        driver: "codex",
        enabled: false,
        model: "gpt-5.4",
        effort: "high",
        command: "/opt/bin/codex-wrapper",
        env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
      },
      { id: "claude", driver: "claude", enabled: true, model: "sonnet" },
      { id: "codex-work", driver: "codex", enabled: true, model: "gpt-work" },
    ],
  },
);
