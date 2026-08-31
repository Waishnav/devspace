import assert from "node:assert/strict";
import {
  isSubagentProviderEnabled,
  localAgentProviderConfigRevision,
  localAgentProviderEnvironment,
  subagentProviderConfig,
  subagentsConfigSchema,
} from "./local-agent-config.js";

const config = subagentsConfigSchema.parse({
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
  providers: [
    {
      id: "codex",
      enabled: true,
      model: "gpt-5.4",
      effort: "high",
      command: "/opt/bin/codex-wrapper",
      env: { OPENAI_API_KEY: "configured", EMPTY_VALUE: "" },
    },
    { id: "claude", enabled: false, model: "sonnet" },
  ],
});
assert.equal(isSubagentProviderEnabled(config, "codex"), true);
assert.equal(isSubagentProviderEnabled(config, "claude"), false);
assert.equal(isSubagentProviderEnabled(config, "pi"), false);
assert.equal(subagentProviderConfig(config, "codex")?.model, "gpt-5.4");

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
  localAgentProviderConfigRevision(subagentsConfigSchema.parse({
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
  localAgentProviderConfigRevision(subagentsConfigSchema.parse({
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
  /Invalid option/,
);
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
  assert.throws(
    () => subagentsConfigSchema.parse({
      enabled: true,
      providers: [{ id, enabled: true, command: "/opt/bin/agent" }],
    }),
    new RegExp(`${id} is embedded and does not support command or env configuration`),
  );
}
