import assert from "node:assert/strict";
import test from "node:test";
import {
  parseLocalAgentContinueArgs,
  parseLocalAgentRunArgs,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

const defaults = { writeMode: undefined, requestId: undefined, wait: false, timeoutMs: undefined };

const profiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "Review changes.",
    provider: "codex",
    model: "gpt-5-codex",
    effort: "high",
    filePath: "/workspace/.devspace/agents/reviewer.md",
    body: "Review carefully.",
    disabled: false,
  },
  {
    name: "claude",
    description: "A profile that shadows the raw provider.",
    provider: "opencode",
    model: "qwen/custom",
    filePath: "/workspace/.devspace/agents/claude.md",
    body: "Use OpenCode.",
    disabled: false,
  },
];

test("run arguments parse the target, prompt, model, and effort", () => {
  for (const [args, expected] of [
    [["codex", "hello", "world"], { prompt: "hello world" }],
    [["codex", "--model", "gpt-5.1", "hello"], { prompt: "hello", model: "gpt-5.1" }],
    [["codex", "--model=gpt-5.1", "hello"], { prompt: "hello", model: "gpt-5.1" }],
    [["codex", "--effort", "high", "hello"], { prompt: "hello", effort: "high" }],
    [["codex", "--effort=high", "hello"], { prompt: "hello", effort: "high" }],
    // `--` ends option parsing so prompts may start with a dash.
    [["codex", "--", "--json", "literal"], { prompt: "--json literal" }],
  ] as const) {
    assert.deepEqual(parseLocalAgentRunArgs([...args]), {
      target: "codex",
      model: undefined,
      effort: undefined,
      ...defaults,
      ...expected,
    });
  }
});

test("run arguments reject missing option values and unknown options", () => {
  for (const [args, error] of [
    [["codex", "--model"], /Missing value for --model/],
    [["codex", "--effort"], /Missing value for --effort/],
    [["codex", "--unknown", "hello"], /Unknown option: --unknown/],
    [["codex", "--model", "--unknown", "hello"], /Unknown option: --unknown/],
  ] as const) {
    assert.throws(() => parseLocalAgentRunArgs([...args]), error);
  }
});

test("run arguments parse write mode, request id, wait, and timeout", () => {
  assert.deepEqual(
    parseLocalAgentRunArgs(["codex", "--write-mode", "read_only", "--request-id=job-1", "--wait", "--timeout", "90", "hi"]),
    {
      target: "codex",
      prompt: "hi",
      model: undefined,
      effort: undefined,
      writeMode: "read_only",
      requestId: "job-1",
      wait: true,
      timeoutMs: 90_000,
    },
  );
  assert.throws(() => parseLocalAgentRunArgs(["codex", "--write-mode", "root", "hi"]), /Invalid --write-mode root/);
  assert.throws(() => parseLocalAgentRunArgs(["codex", "--timeout", "5", "hi"]), /--timeout requires --wait/);
  assert.throws(() => parseLocalAgentRunArgs(["codex", "--request-id", "a/b", "hi"]), /Request id must be 1-128/);
  assert.throws(() => parseLocalAgentContinueArgs(["agt_1", "--request-id", "x", "hi"]), /Unknown option: --request-id/);
});

test("worktree and branch flags apply only to new runs", () => {
  assert.deepEqual(parseLocalAgentRunArgs(["codex", "--worktree", "hi"]).worktree, { branch: undefined });
  assert.deepEqual(
    parseLocalAgentRunArgs(["codex", "--branch", "feature/x", "--worktree", "hi"]).worktree,
    { branch: "feature/x" },
  );
  assert.equal(parseLocalAgentRunArgs(["codex", "hi"]).worktree, undefined);
  assert.throws(() => parseLocalAgentRunArgs(["codex", "--branch", "feature/x", "hi"]), /--branch requires --worktree/);
  assert.throws(() => parseLocalAgentContinueArgs(["agt_1", "--worktree", "hi"]), /Unknown option: --worktree/);
  assert.throws(() => parseLocalAgentContinueArgs(["agt_1", "--branch", "x", "hi"]), /Unknown option: --branch/);
});

test("continue arguments parse wait and the prompt", () => {
  assert.deepEqual(parseLocalAgentContinueArgs(["agt_1", "--wait", "go on"]), {
    agentId: "agt_1",
    prompt: "go on",
    model: undefined,
    effort: undefined,
    writeMode: undefined,
    wait: true,
    timeoutMs: undefined,
  });
});

test("model and effort come from the run override, then the profile, then the provider default", () => {
  // Model and effort precedence: run override, then profile, then provider default.
  const providers = [
    { id: "codex", driver: "codex", enabled: true, model: "gpt-default", effort: "medium" },
    { id: "opencode", driver: "opencode", enabled: true },
  ] as const;
  for (const [name, model, effort, expected] of [
    ["reviewer", undefined, undefined, { kind: "profile", provider: "codex", model: "gpt-5-codex", effort: "high" }],
    ["reviewer", "gpt-run", "xhigh", { kind: "profile", provider: "codex", model: "gpt-run", effort: "xhigh" }],
    ["codex", undefined, undefined, { kind: "provider", provider: "codex", model: "gpt-default", effort: "medium" }],
    ["opencode", undefined, undefined, { kind: "provider", provider: "opencode", model: undefined, effort: undefined }],
    ["opencode", "kimi-k2", "deep", { kind: "provider", provider: "opencode", model: "kimi-k2", effort: "deep" }],
  ] as const) {
    const target = resolveLocalAgentTarget(name, profiles, model, effort, providers);
    assert.deepEqual(
      { kind: target?.kind, provider: target?.provider, model: target?.model, effort: target?.effort },
      expected,
      name,
    );
  }
});

test("a named provider instance resolves as a provider target", () => {
  const providerInstances = [{
    id: "codex-work",
    driver: "codex",
    enabled: true,
    model: "gpt-work",
  }] as const;
  const target = resolveLocalAgentTarget("codex-work", profiles, undefined, undefined, providerInstances);
  assert.equal(target?.kind, "provider");
  assert.equal(target?.provider, "codex-work");
  assert.equal(target?.model, "gpt-work");
});

test("a profile shadows a raw provider with the same name", () => {
  const target = resolveLocalAgentTarget("claude", profiles);
  assert.equal(target?.kind, "profile");
  assert.equal(target?.provider, "opencode");
});

test("an unknown target does not resolve", () => {
  assert.equal(resolveLocalAgentTarget("missing", profiles), undefined);
});
