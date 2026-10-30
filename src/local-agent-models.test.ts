import assert from "node:assert/strict";
import test from "node:test";
import { acpModelsFromSession } from "./local-agent-acp.js";
import { claudeModelsFromSdk } from "./local-agent-claude.js";
import { codexModelsFromPages } from "./local-agent-codex.js";
import { opencodeModelsFromCli } from "./local-agent-opencode.js";
import { piModelsFromResponse } from "./local-agent-pi.js";
import { formatAgentModels } from "./local-agent-presentation.js";

test("codex models come from every model/list page, without hidden models", () => {
  assert.deepEqual(codexModelsFromPages([
    {
      data: [
        {
          model: "gpt-6.1-sol",
          displayName: "GPT-6.1-Sol",
          isDefault: true,
          hidden: false,
          supportedReasoningEfforts: [{ reasoningEffort: "low" }, { reasoningEffort: "high" }],
        },
        { model: "internal", displayName: "Internal", hidden: true, supportedReasoningEfforts: [] },
      ],
      nextCursor: "page-2",
    },
    { data: [{ model: "gpt-6-luna", displayName: "GPT-6-Luna", hidden: false, supportedReasoningEfforts: [] }] },
  ]), [
    { id: "gpt-6.1-sol", name: "GPT-6.1-Sol", efforts: ["low", "high"], default: true },
    { id: "gpt-6-luna", name: "GPT-6-Luna" },
  ]);
});

test("claude models use the SDK value that --model accepts", () => {
  assert.deepEqual(claudeModelsFromSdk([
    { value: "opus[1m]", displayName: "Opus", supportedEffortLevels: ["low", "max"] },
    { value: "haiku", displayName: "Haiku" },
    { displayName: "missing value" },
  ]), [
    { id: "opus[1m]", name: "Opus", efforts: ["low", "max"] },
    { id: "haiku", name: "Haiku" },
  ]);
});

test("cursor-style ACP models keep their exact option values, including grouped options", () => {
  const session = {
    sessionId: "s1",
    configOptions: [
      {
        type: "select",
        category: "model",
        currentValue: "composer-2.5[fast=true]",
        options: [
          { value: "default[]", name: "Auto" },
          { name: "Composer", options: [{ value: "composer-2.5[fast=true]", name: "composer-2.5" }] },
        ],
      },
      { type: "select", category: "thought_level", options: [{ value: "low" }, { value: "high" }] },
    ],
  };

  assert.deepEqual(acpModelsFromSession(session, "cursor"), [
    { id: "default[]", name: "Auto", efforts: ["low", "high"] },
    { id: "composer-2.5[fast=true]", name: "composer-2.5", efforts: ["low", "high"], default: true },
  ]);
});

test("grok ACP models carry their own reasoning efforts", () => {
  const session = {
    sessionId: "s1",
    models: {
      currentModelId: "grok-4.7",
      availableModels: [
        { modelId: "grok-4.7", _meta: { reasoningEfforts: [{ id: "high" }, { id: "low" }] } },
        { modelId: "grok-4.5", _meta: { reasoningEfforts: [] } },
      ],
    },
  };

  const models = acpModelsFromSession(session, "grok");
  assert.equal(models[0]?.id, "grok-4.7");
  assert.equal(models[0]?.default, true);
  assert.deepEqual(models[1], { id: "grok-4.5" });
});

test("other ACP agents fall back to the standard models list", () => {
  assert.deepEqual(acpModelsFromSession({
    sessionId: "s1",
    models: { currentModelId: "b", availableModels: [{ modelId: "a", name: "A" }, { modelId: "b" }] },
  }, "copilot"), [{ id: "a", name: "A" }, { id: "b", default: true }]);
});

test("pi models are reported as provider/id", () => {
  assert.deepEqual(piModelsFromResponse({
    models: [{ provider: "xai", id: "grok-4.5", name: "Grok 4.5" }, { provider: "xai" }],
  }), [{ id: "xai/grok-4.5", name: "Grok 4.5" }]);
});

test("opencode models are the provider/model lines of `opencode models`", () => {
  assert.deepEqual(
    opencodeModelsFromCli("opencode/deepseek-v4.1-flash-free\nanthropic/claude-haiku-4-5\n\nWarning: something\n"),
    [{ id: "opencode/deepseek-v4.1-flash-free" }, { id: "anthropic/claude-haiku-4-5" }],
  );
});

test("models output lists each provider, and a failing provider reports its cause", () => {
  assert.equal(formatAgentModels([
    { provider: "codex", models: [{ id: "gpt-6-luna", efforts: ["low", "medium"], default: true }] },
    { provider: "pi", error: { code: "PROVIDER_EXECUTION_ERROR", message: "Pi failed.", detail: "exit 1" } },
  ]), [
    '<models provider="codex">',
    '<model id="gpt-6-luna" efforts="low,medium" default="true"/>',
    "</models>",
    '<models provider="pi" error="PROVIDER_EXECUTION_ERROR">Pi failed.<cause>exit 1</cause></models>',
  ].join("\n"));
});
