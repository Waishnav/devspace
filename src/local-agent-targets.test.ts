import assert from "node:assert/strict";
import {
  formatAvailableLocalAgentTargets,
  parseLocalAgentRunArgs,
  resolveLocalAgentTarget,
} from "./local-agent-targets.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";

const profiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "Review changes.",
    provider: "codex",
    model: "gpt-5-codex",
    thinking: "high",
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
  thinking: undefined,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--model", "gpt-5.1", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: "gpt-5.1",
  thinking: undefined,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--model=gpt-5.1", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: "gpt-5.1",
  thinking: undefined,
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--thinking", "high", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: undefined,
  thinking: "high",
});

assert.deepEqual(parseLocalAgentRunArgs(["codex", "--thinking=high", "hello"]), {
  target: "codex",
  prompt: "hello",
  model: undefined,
  thinking: "high",
});

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--model"]),
  /Missing value for --model/,
);

assert.throws(
  () => parseLocalAgentRunArgs(["codex", "--thinking"]),
  /Missing value for --thinking/,
);

{
  const target = resolveLocalAgentTarget("reviewer", profiles);
  assert.equal(target?.kind, "profile");
  assert.equal(target?.name, "reviewer");
  assert.equal(target?.provider, "codex");
  assert.equal(target?.model, "gpt-5-codex");
  assert.equal(target?.thinking, "high");
}

{
  const target = resolveLocalAgentTarget("reviewer", profiles, "gpt-5.2", "xhigh");
  assert.equal(target?.kind, "profile");
  assert.equal(target?.model, "gpt-5.2");
  assert.equal(target?.thinking, "xhigh");
}

{
  const target = resolveLocalAgentTarget("opencode", profiles);
  assert.equal(target?.kind, "provider");
  assert.equal(target?.name, "opencode");
  assert.equal(target?.provider, "opencode");
  assert.equal(target?.model, undefined);
  assert.equal(target?.thinking, undefined);
}

{
  const target = resolveLocalAgentTarget("opencode", profiles, "kimi-k2", "deep");
  assert.equal(target?.kind, "provider");
  assert.equal(target?.model, "kimi-k2");
  assert.equal(target?.thinking, "deep");
}

{
  const target = resolveLocalAgentTarget("claude", profiles);
  assert.equal(target?.kind, "profile");
  assert.equal(target?.provider, "opencode");
}

assert.equal(resolveLocalAgentTarget("missing", profiles), undefined);
assert.match(formatAvailableLocalAgentTargets(profiles), /profiles: reviewer, claude/);
assert.match(formatAvailableLocalAgentTargets([]), /providers: codex, claude, opencode, pi, cursor, copilot/);
