import assert from "node:assert/strict";
import {
  isSubagentProviderEnabled,
  subagentProviderConfig,
  subagentsConfigSchema,
} from "./local-agent-config.js";

const config = subagentsConfigSchema.parse({
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: " gpt-5.4 ", effort: " high " },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.deepEqual(config, {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-5.4", effort: "high" },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
for (const networkAccess of [false, true]) {
  const parsed = subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, networkAccess }],
  });
  assert.equal(subagentProviderConfig(parsed, "codex")?.networkAccess, networkAccess);
}
assert.equal(subagentProviderConfig(config, "codex")?.networkAccess, undefined);
for (const provider of [
  { id: "codex", enabled: true, networkAccess: "true" },
  { id: "claude", enabled: true, networkAccess: true },
]) {
  assert.equal(subagentsConfigSchema.safeParse({ enabled: true, providers: [provider] }).success, false);
}
assert.equal(isSubagentProviderEnabled(config, "codex"), true);
assert.equal(isSubagentProviderEnabled(config, "claude"), false);
assert.equal(isSubagentProviderEnabled(config, "pi"), false);
assert.equal(subagentProviderConfig(config, "codex")?.model, "gpt-5.4");

assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true }, { id: "codex", enabled: false }],
  }),
  /Duplicate subagent provider: codex/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "unknown", enabled: true }],
  }),
  /Invalid option/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, effort: "  " }],
  }),
  /Too small/,
);
