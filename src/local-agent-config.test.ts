import assert from "node:assert/strict";
import test from "node:test";
import {
  isSubagentProviderEnabled,
  localAgentProviderConfigRevision,
  localAgentProviderEnvironment,
  parseSubagentsConfig,
  subagentProviderConfig,
  subagentsConfigSchema,
} from "./local-agent-config.js";

const parseCodexAndClaudeConfig = () => parseSubagentsConfig({
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

test("provider config is trimmed, gains its driver, and reports enablement", () => {
  const config = parseCodexAndClaudeConfig();
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
});

test("the provider environment overlays configured values without mutating the inherited environment", () => {
  const config = parseCodexAndClaudeConfig();
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
});

test("the provider config revision ignores key order but tracks command changes", () => {
  const config = parseCodexAndClaudeConfig();
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
});

test("duplicate providers and unknown ids without a driver are rejected", () => {
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
});

test("a named provider instance keeps its declared driver", () => {
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
});

test("a generic ACP provider keeps its custom args", () => {
  const genericAcp = parseSubagentsConfig({
    enabled: true,
    providers: [{
      id: "kiro",
      driver: "acp",
      enabled: true,
      command: "kiro",
      config: { args: ["acp"] },
    }],
  });
  assert.deepEqual(genericAcp.providers[0], {
    id: "kiro",
    driver: "acp",
    enabled: true,
    command: "kiro",
    config: { args: ["acp"] },
  });
});

// Built-in ACP flavors derive sandbox flags from the write mode; custom args would drop them.
test("built-in ACP flavors reject custom args", () => {
  for (const provider of [
    { id: "cursor", driver: "cursor", enabled: true, config: { args: ["acp"] } },
    { id: "copilot-work", driver: "acp", enabled: true, command: "copilot", config: { flavor: "copilot", args: ["--acp"] } },
  ]) {
    assert.throws(() => parseSubagentsConfig({ enabled: true, providers: [provider] }), /config\.args applies only to generic/);
  }
});

test("legacy ACP drivers normalize to the acp driver with a flavor", () => {
  const legacyAcp = parseSubagentsConfig({
    enabled: true,
    providers: [{ id: "cursor", driver: "cursor", enabled: true }],
  });
  assert.equal(legacyAcp.providers[0]?.driver, "acp");
  assert.deepEqual(legacyAcp.providers[0]?.config, { flavor: "cursor" });
  const namedLegacyAcp = parseSubagentsConfig({
    enabled: true,
    providers: [
      { id: "cursor-work", driver: "cursor", enabled: true, command: "cursor-agent" },
      { id: "grok", driver: "codex", enabled: true },
    ],
  });
  assert.equal(namedLegacyAcp.providers[0]?.driver, "acp");
  assert.deepEqual(namedLegacyAcp.providers[0]?.config, { flavor: "cursor" }, "a named legacy-driver instance keeps its flavor");
  assert.equal(namedLegacyAcp.providers[1]?.config, undefined, "a built-in id with another driver is not an ACP provider");
});

test("blank effort, blank command, and invalid environment names are rejected", () => {
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
});

test("embedded providers receive configured environment and command overrides", () => {
  for (const id of ["opencode", "pi"] as const) {
    const embedded = parseSubagentsConfig({
      enabled: true,
      providers: [{ id, enabled: true, env: { HARNESS_ENV: id } }],
    });
    assert.equal(localAgentProviderEnvironment(embedded, id, {}).HARNESS_ENV, id);
  }
  const opencodeCommand = parseSubagentsConfig({
    enabled: true,
    providers: [{ id: "opencode", enabled: true, command: "/opt/bin/opencode" }],
  });
  assert.equal(localAgentProviderEnvironment(opencodeCommand, "opencode", {}).OPENCODE_COMMAND, "/opt/bin/opencode");
  const piCommand = parseSubagentsConfig({
    enabled: true,
    providers: [{ id: "pi", enabled: true, command: "/opt/bin/pi" }],
  });
  assert.equal(localAgentProviderEnvironment(piCommand, "pi", {}).PI_COMMAND, "/opt/bin/pi");
});
