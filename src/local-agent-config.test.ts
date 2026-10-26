import assert from "node:assert/strict";
import {
  isSubagentProviderEnabled,
  localAgentProviderConfigRevision,
  localAgentProviderEnvironment,
  parseSubagentsConfig,
  subagentProviderConfig,
  subagentsConfigSchema,
} from "./local-agent-config.js";

const config = parseSubagentsConfig({
  enabled: true,
  providers: [
    {
      id: "codex",
      enabled: true,
      model: " gpt-5.4 ",
      effort: " high ",
      command: " /opt/bin/codex-wrapper ",
      env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
    },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.deepEqual(config, {
  enabled: true,
  instructions: "on-demand",
  providers: [
    {
      id: "codex",
      driver: "codex",
      enabled: true,
      model: "gpt-5.4",
      effort: "high",
      command: "/opt/bin/codex-wrapper",
      env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
    },
    { id: "claude", driver: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.equal(isSubagentProviderEnabled(config, "codex"), true);
assert.equal(isSubagentProviderEnabled(config, "claude"), false);
assert.equal(isSubagentProviderEnabled(config, "pi"), false);
assert.equal(subagentProviderConfig(config, "codex")?.model, "gpt-5.4");
assert.equal(
  subagentsConfigSchema.parse({ enabled: true, instructions: "preload", providers: [] }).instructions,
  "preload",
);

const inherited = {
  CODEX_COMMAND: "/usr/bin/codex",
  OPENAI_API_KEY: "inherited",
  UNCHANGED: "yes",
};
assert.deepEqual(localAgentProviderEnvironment(config, "codex", inherited), {
  CODEX_COMMAND: "/opt/bin/codex-wrapper",
  OPENAI_API_KEY: "configured",
  EMPTY_VALUE: "",
  UNCHANGED: "yes",
});
assert.deepEqual(inherited, {
  CODEX_COMMAND: "/usr/bin/codex",
  OPENAI_API_KEY: "inherited",
  UNCHANGED: "yes",
});
assert.equal(
  localAgentProviderConfigRevision(config),
  localAgentProviderConfigRevision(parseSubagentsConfig({
    enabled: true,
    providers: [
      { id: "claude", enabled: false, model: "sonnet" },
      {
        id: "codex",
        enabled: true,
        effort: "high",
        model: "gpt-5.4",
        command: "/opt/bin/codex-wrapper",
        env: { EMPTY_VALUE: "", OPENAI_API_KEY: "configured" },
      },
    ],
  })),
  "provider and environment key order must not restart the daemon",
);
assert.notEqual(
  localAgentProviderConfigRevision(config),
  localAgentProviderConfigRevision(parseSubagentsConfig({
    ...config,
    providers: config.providers.map((provider) => provider.id === "codex"
      ? { ...provider, command: "/opt/bin/another-wrapper" }
      : provider),
  })),
);
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
  /must declare a driver/,
);
const namedInstance = parseSubagentsConfig({
  enabled: true,
  providers: [{ id: "codex-work", driver: "codex", enabled: true, model: "gpt-work" }],
});
assert.deepEqual(namedInstance.providers[0], {
  id: "codex-work",
  driver: "codex",
  enabled: true,
  model: "gpt-work",
});
assert.equal(subagentProviderConfig(namedInstance, "codex-work")?.driver, "codex");
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, effort: "  " }],
  }),
  /Too small/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, command: "  " }],
  }),
  /non-whitespace character/,
);
assert.throws(
  () => subagentsConfigSchema.parse({
    enabled: true,
    providers: [{ id: "codex", enabled: true, env: { "INVALID-NAME": "value" } }],
  }),
  /Invalid environment variable name/,
);
for (const id of ["opencode", "pi"] as const) {
  const embedded = parseSubagentsConfig({
    enabled: true,
    providers: [{ id, enabled: true, env: { HARNESS_ENV: id } }],
  });
  assert.equal(localAgentProviderEnvironment(embedded, id, {}).HARNESS_ENV, id);
  assert.throws(
    () => subagentsConfigSchema.parse({
      enabled: true,
      providers: [{ id, enabled: true, command: "/opt/bin/agent" }],
    }),
  );
}
