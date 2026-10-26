import assert from "node:assert/strict";
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

assert.deepEqual(parseLocalAgentRunArgs(["codex", "hello", "world"]), {
  target: "codex",
  prompt: "hello world",
  model: undefined,
  effort: undefined,
  ...defaults,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--model", "gpt-5.1", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: "gpt-5.1",
  effort: undefined,
  ...defaults,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--model=gpt-5.1", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: "gpt-5.1",
  effort: undefined,
  ...defaults,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--effort", "high", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: undefined,
  effort: "high",
  ...defaults,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--effort=high", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: undefined,
  effort: "high",
  ...defaults,
});

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--model"]),
  /Missing value for --model/,
);

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--effort"]),
  /Missing value for --effort/,
);

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--unknown", "hello"]),
  /Unknown option: --unknown/,
);

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--model", "--unknown", "hello"]),
  /Unknown option: --unknown/,
);

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--", "--json", "literal"]), {
  target: "codex",
  prompt: "--json literal",
  model: undefined,
  effort: undefined,
  ...defaults,
});

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
assert.deepEqual(parseLocalAgentRunArgs(["codex", "--worktree", "hi"]).worktree, { branch: undefined });
assert.deepEqual(
  parseLocalAgentRunArgs(["codex", "--branch", "feature/x", "--worktree", "hi"]).worktree,
  { branch: "feature/x" },
);
assert.equal(parseLocalAgentRunArgs(["codex", "hi"]).worktree, undefined);
assert.throws(() => parseLocalAgentRunArgs(["codex", "--branch", "feature/x", "hi"]), /--branch requires --worktree/);
assert.throws(() => parseLocalAgentContinueArgs(["agt_1", "--worktree", "hi"]), /Unknown option: --worktree/);
assert.throws(() => parseLocalAgentContinueArgs(["agt_1", "--branch", "x", "hi"]), /Unknown option: --branch/);
assert.deepEqual(parseLocalAgentContinueArgs(["agt_1", "--wait", "go on"]), {
  agentId: "agt_1",
  prompt: "go on",
  model: undefined,
  effort: undefined,
  writeMode: undefined,
  wait: true,
  timeoutMs: undefined,
});

{
  const target = resolveLocalAgentTarget("reviewer", profiles);
  assert.equal(target?.kind, "profile");
  assert.equal(target?.name, "reviewer");
  assert.equal(target?.provider, "codex");
  assert.equal(target?.model, "gpt-5-codex");
  assert.equal(target?.effort, "high");
}

{
  const target = resolveLocalAgentTarget("reviewer", profiles, "gpt-5.2", "xhigh");
  assert.equal(target?.kind, "profile");
  assert.equal(target?.model, "gpt-5.2");
  assert.equal(target?.effort, "xhigh");
}

{
  const providers = [{ id: "opencode", driver: "opencode", enabled: true }] as const;
  const target = resolveLocalAgentTarget("opencode", profiles, undefined, undefined, providers);
  assert.equal(target?.kind, "provider");
  assert.equal(target?.name, "opencode");
  assert.equal(target?.provider, "opencode");
  assert.equal(target?.model, undefined);
  assert.equal(target?.effort, undefined);
}

{
  const providers = [{ id: "opencode", driver: "opencode", enabled: true }] as const;
  const target = resolveLocalAgentTarget("opencode", profiles, "kimi-k2", "deep", providers);
  assert.equal(target?.kind, "provider");
  assert.equal(target?.model, "kimi-k2");
  assert.equal(target?.effort, "deep");
}

{
  const providerDefaults = [{
    id: "codex",
    driver: "codex",
    enabled: true,
    model: "gpt-default",
    effort: "medium",
  }] as const;
  const raw = resolveLocalAgentTarget("codex", profiles, undefined, undefined, providerDefaults);
  assert.equal(raw?.model, "gpt-default");
  assert.equal(raw?.effort, "medium");
  const profiled = resolveLocalAgentTarget("reviewer", profiles, undefined, undefined, providerDefaults);
  assert.equal(profiled?.model, "gpt-5-codex");
  assert.equal(profiled?.effort, "high");
  const overridden = resolveLocalAgentTarget("reviewer", profiles, "gpt-run", "xhigh", providerDefaults);
  assert.equal(overridden?.model, "gpt-run");
  assert.equal(overridden?.effort, "xhigh");
}

{
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
}

{
  const target = resolveLocalAgentTarget("claude", profiles);
  assert.equal(target?.kind, "profile");
  assert.equal(target?.provider, "opencode");
}

assert.equal(resolveLocalAgentTarget("missing", profiles), undefined);
