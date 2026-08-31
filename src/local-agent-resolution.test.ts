import assert from "node:assert/strict";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import {
  LocalAgentResolutionError,
  resolveLocalAgentExecution,
} from "./local-agent-resolution.js";

const reviewer: LocalAgentProfile = {
  name: "reviewer",
  description: "Review changes.",
  provider: "codex",
  model: "gpt-profile",
  effort: "high",
  filePath: "/repo/.devspace/agents/reviewer.md",
  body: "Review carefully.",
  disabled: false,
};

const profile = resolveLocalAgentExecution({
  target: "reviewer",
  prompt: "Inspect src/auth.ts",
  profiles: [reviewer],
  availableProviders: ["codex"],
});
assert.equal(profile.kind, "profile");
assert.equal(profile.provider, "codex");
assert.equal(profile.model, "gpt-profile");
assert.equal(profile.effort, "high");
assert.equal(profile.prompt, "Review carefully.\n\nTask:\nInspect src/auth.ts");
assert.equal(profile.profileFingerprint?.length, 64);

const overridden = resolveLocalAgentExecution({
  profile: "reviewer",
  prompt: "Inspect src/auth.ts",
  profiles: [reviewer],
  availableProviders: ["codex"],
  model: "gpt-call",
  effort: "xhigh",
});
assert.equal(overridden.model, "gpt-call");
assert.equal(overridden.effort, "xhigh");

const provider = resolveLocalAgentExecution({
  target: "claude",
  prompt: "Investigate the failure",
  profiles: [],
  availableProviders: ["claude"],
});
assert.equal(provider.kind, "provider");
assert.equal(provider.prompt, "Investigate the failure");

const fallback = resolveLocalAgentExecution({
  prompt: "Investigate the failure",
  profiles: [],
  availableProviders: ["pi", "codex"],
});
assert.equal(fallback.provider, "pi");

assert.throws(
  () => resolveLocalAgentExecution({
    profile: "missing",
    prompt: "x",
    profiles: [reviewer],
    availableProviders: ["codex"],
  }),
  (error) => error instanceof LocalAgentResolutionError && error.kind === "profile_not_found",
);

assert.throws(
  () => resolveLocalAgentExecution({
    target: "reviewer",
    prompt: "x",
    profiles: [reviewer],
    availableProviders: ["claude"],
  }),
  /requires unavailable provider codex/,
);

assert.throws(
  () => resolveLocalAgentExecution({
    prompt: "x",
    profiles: [],
    availableProviders: [],
  }),
  (error) => error instanceof LocalAgentResolutionError && error.kind === "no_provider",
);

console.log("local-agent-resolution.test.ts: ok");
