import assert from "node:assert/strict";
import test from "node:test";
import {
  isNonInteractiveInit,
  parseInitArgs,
  resolveInitAnswers,
  resolveOnboardingUsage,
  updateOnboardingSubagentsConfig,
} from "./onboarding.js";

test("onboarding usage resolves from the selected uses and requires at least one", () => {
  for (const [selections, expected] of [
    [["chatgpt"], "chatgpt"],
    [["coding-agents"], "coding-agents"],
    [["coding-agents", "chatgpt"], "both"],
  ] as const) {
    assert.equal(resolveOnboardingUsage(selections), expected);
  }

  assert.throws(() => resolveOnboardingUsage([]), /Choose ChatGPT, Coding Agents, or both/);
});

test("onboarding enables subagents with the selected providers", () => {
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
});

test("onboarding toggles existing providers and preserves their settings", () => {
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
});

const DEFAULTS = {
  destinations: ["coding-agents" as const],
  providers: ["codex"],
  knownProviders: ["codex", "claude", "pi"],
  roots: ["/home/me/work"],
  publicUrl: null,
};

test("init flags parse spaced and inline values and reject unknown options", () => {
  assert.deepEqual(
    parseInitArgs(["--use=both", "--providers", "codex, claude", "--roots", "~/a,~/b", "--public-url", "https://t.example", "--json"]),
    {
      force: false,
      yes: false,
      json: true,
      use: ["chatgpt", "coding-agents"],
      providers: ["codex", "claude"],
      roots: ["~/a", "~/b"],
      publicUrl: "https://t.example",
    },
  );
  assert.throws(() => parseInitArgs(["--use", "slack"]), /Unknown --use value: slack/);
  assert.throws(() => parseInitArgs(["--providers"]), /--providers needs a value/);
  assert.throws(() => parseInitArgs(["--bogus"]), /Unknown option: --bogus/);
});

test("init runs without prompts when given answers or no terminal", () => {
  assert.equal(isNonInteractiveInit(parseInitArgs([]), true), false);
  assert.equal(isNonInteractiveInit(parseInitArgs([]), false), true);
  assert.equal(isNonInteractiveInit(parseInitArgs(["--yes"]), true), true);
  assert.equal(isNonInteractiveInit(parseInitArgs(["--providers", "codex"]), true), true);
});

test("init answers fall back to the prompt defaults for coding agents", () => {
  assert.deepEqual(resolveInitAnswers(parseInitArgs(["--yes"]), DEFAULTS), {
    usage: "coding-agents",
    providers: ["codex"],
  });
  assert.throws(
    () => resolveInitAnswers(parseInitArgs(["--providers", "codex,nope"]), DEFAULTS),
    /Unknown provider: nope. Known providers: codex, claude, pi/,
  );
  assert.throws(
    () => resolveInitAnswers(parseInitArgs(["--yes"]), { ...DEFAULTS, providers: [] }),
    /No coding agents were detected/,
  );
  assert.throws(
    () => resolveInitAnswers(parseInitArgs(["--public-url", "https://t.example"]), DEFAULTS),
    /apply only with --use chatgpt/,
  );
});

test("init answers for an MCP host need a public URL and default the roots", () => {
  assert.throws(
    () => resolveInitAnswers(parseInitArgs(["--use", "chatgpt"]), DEFAULTS),
    /--public-url is required/,
  );
  assert.deepEqual(
    resolveInitAnswers(parseInitArgs(["--use", "chatgpt", "--public-url", "https://t.example"]), DEFAULTS),
    { usage: "chatgpt", providers: ["codex"], roots: ["/home/me/work"], publicUrl: "https://t.example" },
  );
});
