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
  instructions: "on-demand",
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
{
  // Windows environment blocks commonly store "Path"; a spread drops the
  // case-insensitive process.env.PATH lookup that command resolution relies on.
  const windowsInherited = { Path: "C:\\tools;C:\\Windows", Other: "kept" };
  const providerEnv = localAgentProviderEnvironment(
    subagentsConfigSchema.parse({ enabled: true, providers: [{ id: "codex", enabled: true }] }),
    "codex",
    windowsInherited,
  );
  assert.equal(providerEnv.PATH, "C:\\tools;C:\\Windows");
  assert.equal(providerEnv.Path, "C:\\tools;C:\\Windows");
  assert.equal(providerEnv.Other, "kept");
}
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
  /Invalid discriminator value/,
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
  const embedded = subagentsConfigSchema.parse({
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
