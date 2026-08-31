import assert from "node:assert/strict";
import {
  buildLocalAgentCatalog,
  buildLocalAgentProviderStatuses,
} from "./local-agent-catalog.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type { SubagentsConfig } from "./local-agent-config.js";

const config: SubagentsConfig = {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-default", effort: "medium" },
    { id: "claude", enabled: true, model: "sonnet" },
    { id: "pi", enabled: false },
  ],
};
const statuses = buildLocalAgentProviderStatuses(config, [
  { name: "codex", available: true },
  { name: "claude", available: false, reason: "credentials missing" },
  { name: "pi", available: true },
]);
assert.equal(statuses.find((provider) => provider.id === "codex")?.usable, true);
assert.equal(statuses.find((provider) => provider.id === "claude")?.usable, false);
assert.equal(statuses.find((provider) => provider.id === "pi")?.usable, false);
assert.equal(statuses.find((provider) => provider.id === "opencode")?.enabled, false);

const profiles: LocalAgentProfile[] = [
  {
    name: "reviewer",
    description: "Review changes.",
    provider: "codex",
    filePath: "/project/reviewer.md",
    body: "Review only.",
    disabled: false,
  },
  {
    name: "custom",
    description: "Use a custom model.",
    provider: "codex",
    model: "gpt-custom",
    filePath: "/project/custom.md",
    body: "Inspect.",
    disabled: false,
  },
  {
    name: "claude-reviewer",
    description: "Unavailable profile.",
    provider: "claude",
    filePath: "/project/claude.md",
    body: "Review.",
    disabled: false,
  },
];
const catalog = buildLocalAgentCatalog(config, profiles, statuses);
assert.deepEqual(catalog.providers.map((provider) => provider.id), ["codex", "claude"]);
assert.deepEqual(catalog.profiles.map((profile) => profile.name), ["reviewer", "custom"]);
assert.equal(catalog.profiles[0]?.model, "gpt-default");
assert.equal(catalog.profiles[0]?.effort, "medium");
assert.equal(catalog.profiles[1]?.model, "gpt-custom");
