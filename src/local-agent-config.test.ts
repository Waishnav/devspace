import assert from "node:assert/strict";
import {
  isSubagentProviderEnabled,
  resolveSubagentsConfig,
  subagentProviderConfig,
} from "./local-agent-config.js";

const config = resolveSubagentsConfig({
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: " gpt-5.4 ", effort: " high " },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
}, {});
assert.deepEqual(config, {
  enabled: true,
  providers: [
    { id: "codex", enabled: true, model: "gpt-5.4", effort: "high" },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.equal(isSubagentProviderEnabled(config, "codex"), true);
assert.equal(isSubagentProviderEnabled(config, "claude"), false);
assert.equal(isSubagentProviderEnabled(config, "pi"), false);
assert.equal(subagentProviderConfig(config, "codex")?.model, "gpt-5.4");

assert.equal(resolveSubagentsConfig(config, { DEVSPACE_SUBAGENTS: "0" }).enabled, false);
assert.equal(resolveSubagentsConfig({ ...config, enabled: false }, {
  DEVSPACE_SUBAGENTS: "1",
}).enabled, true);
assert.equal(resolveSubagentsConfig(undefined, {}).providers.length, 0);
assert.equal(resolveSubagentsConfig(true, {}).providers.length, 7);

assert.throws(
  () => resolveSubagentsConfig({
    enabled: true,
    providers: [{ id: "codex", enabled: true }, { id: "codex", enabled: false }],
  }, {}),
  /Duplicate subagent provider: codex/,
);
assert.throws(
  () => resolveSubagentsConfig({
    enabled: true,
    providers: [{ id: "unknown", enabled: true }],
  }, {}),
  /Invalid option/,
);
assert.throws(
  () => resolveSubagentsConfig({
    enabled: true,
    providers: [{ id: "codex", enabled: true, effort: "  " }],
  }, {}),
  /Too small/,
);
