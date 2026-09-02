import assert from "node:assert/strict";
import {
  AuthStorage,
  ModelRegistry,
  type AgentSessionEvent,
  type AgentSessionEventListener,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent";
import {
  MINIMAX_DEFAULT_MODEL,
  MINIMAX_MODEL_CONFIGS,
  MINIMAX_REGIONAL_ENDPOINTS,
  MiniMaxLocalAgentDriver,
  registerMiniMaxProviders,
  resolveMiniMaxModel,
  type MiniMaxModelRegistry,
} from "./local-agent-minimax.js";
import type { PiSessionLike } from "./local-agent-pi.js";

assert.deepEqual(MINIMAX_REGIONAL_ENDPOINTS, [
  {
    region: "global_en",
    providerId: "minimax",
    apiKey: "$MINIMAX_API_KEY",
    openaiBaseUrl: "https://api.minimax.io/v1",
    anthropicBaseUrl: "https://api.minimax.io/anthropic",
    docsRoot: "https://platform.minimax.io/docs",
  },
  {
    region: "cn_zh",
    providerId: "minimax-cn",
    apiKey: "$MINIMAX_CN_API_KEY",
    openaiBaseUrl: "https://api.minimaxi.com/v1",
    anthropicBaseUrl: "https://api.minimaxi.com/anthropic",
    docsRoot: "https://platform.minimaxi.com/docs",
  },
]);
assert.deepEqual(MINIMAX_MODEL_CONFIGS, [
  {
    modelId: "MiniMax-M3",
    contextWindow: 1_000_000,
    pricingUsdPerMillionTokens: {
      input: 0.6,
      output: 2.4,
      cacheRead: 0.12,
      cacheWrite: null,
    },
    inputModalities: ["text", "image", "video"],
    thinking: ["adaptive", "disabled"],
  },
  {
    modelId: "MiniMax-M2.7",
    contextWindow: 204_800,
    pricingUsdPerMillionTokens: {
      input: 0.3,
      output: 1.2,
      cacheRead: 0.06,
      cacheWrite: 0.375,
    },
    inputModalities: ["text"],
    thinking: ["always_on"],
  },
]);

const builtInModels = new Map([
  ["minimax/MiniMax-M3", model("minimax", "MiniMax-M3", 128_000)],
  ["minimax/MiniMax-M2.7", model("minimax", "MiniMax-M2.7", 131_072)],
  ["minimax-cn/MiniMax-M3", model("minimax-cn", "MiniMax-M3", 128_000)],
  ["minimax-cn/MiniMax-M2.7", model("minimax-cn", "MiniMax-M2.7", 131_072)],
]);
const registrations: Array<{ provider: string; config: ProviderConfig }> = [];
const registry = {
  find(provider: string, modelId: string) {
    return builtInModels.get(`${provider}/${modelId}`);
  },
  hasConfiguredAuth() {
    return false;
  },
  registerProvider(provider: string, config: ProviderConfig) {
    registrations.push({ provider, config });
  },
} as MiniMaxModelRegistry;

registerMiniMaxProviders(registry);
assert.deepEqual(registrations.map(({ provider }) => provider), ["minimax", "minimax-cn"]);
const globalConfig = registrations[0]?.config;
assert.equal(globalConfig?.baseUrl, "https://api.minimax.io/anthropic");
const m3 = globalConfig?.models?.find((candidate) => candidate.id === "MiniMax-M3");
assert.deepEqual(m3?.cost, {
  input: 0.6,
  output: 2.4,
  cacheRead: 0.12,
  cacheWrite: 0,
});
assert.deepEqual(m3?.input, ["text", "image"]);
assert.equal(m3?.contextWindow, 1_000_000);
assert.equal(m3?.maxTokens, 128_000);
assert.equal((m3?.compat as { forceAdaptiveThinking?: boolean })?.forceAdaptiveThinking, true);
const m27 = globalConfig?.models?.find((candidate) => candidate.id === "MiniMax-M2.7");
assert.deepEqual(m27?.thinkingLevelMap, { off: null });

const realRegistry = ModelRegistry.inMemory(AuthStorage.inMemory({
  "minimax-cn": { type: "api_key", key: "test-key" },
}));
registerMiniMaxProviders(realRegistry);
assert.equal(resolveMiniMaxModel(realRegistry, MINIMAX_DEFAULT_MODEL)?.provider, "minimax-cn");
assert.deepEqual(realRegistry.find("minimax", "MiniMax-M3")?.cost, {
  input: 0.6,
  output: 2.4,
  cacheRead: 0.12,
  cacheWrite: 0,
});

const regionalRegistry = {
  find(provider: string, modelId: string) {
    return builtInModels.get(`${provider}/${modelId}`);
  },
  hasConfiguredAuth(candidate: { provider: string }) {
    return candidate.provider === "minimax-cn";
  },
  registerProvider() {},
} as MiniMaxModelRegistry;
assert.equal(
  resolveMiniMaxModel(regionalRegistry, "MiniMax-M3")?.provider,
  "minimax-cn",
);
assert.equal(
  resolveMiniMaxModel(regionalRegistry, "minimax/MiniMax-M2.7")?.provider,
  "minimax",
);
assert.equal(resolveMiniMaxModel(regionalRegistry, "other/MiniMax-M3"), undefined);

class FakeSession implements PiSessionLike {
  readonly sessionId = "minimax_session_1";
  readonly messages: any[] = [];
  readonly modelRegistry = regionalRegistry as PiSessionLike["modelRegistry"];
  private readonly listeners = new Set<AgentSessionEventListener>();

  async prompt(): Promise<void> {
    this.messages.push({
      role: "assistant",
      content: [{ type: "text", text: "MiniMax response" }],
    });
    for (const listener of this.listeners) listener({ type: "agent_end" } as AgentSessionEvent);
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async setModel(): Promise<void> {}
  setActiveToolsByName(): void {}
  setThinkingLevel(): void {}
  dispose(): void {}
}

const factoryContexts: Array<{ provider: string; model?: string }> = [];
const driver = new MiniMaxLocalAgentDriver(async (context) => {
  factoryContexts.push({ provider: context.provider, model: context.model });
  return new FakeSession();
});
const runtimeResult = await driver.createRuntime({
  agentId: "agt_minimax",
  provider: "minimax",
  workspaceRoot: "/tmp/project",
});
assert.equal(runtimeResult.isOk(), true);
if (runtimeResult.isErr()) throw runtimeResult.error;
assert.deepEqual(factoryContexts, [{ provider: "minimax", model: MINIMAX_DEFAULT_MODEL }]);
const runResult = await runtimeResult.value.run({
  prompt: "inspect",
  workspaceRoot: "/tmp/project",
});
assert.equal(runResult.isOk(), true);
if (runResult.isErr()) throw runResult.error;
assert.equal(runResult.value.provider, "minimax");
assert.equal(runResult.value.finalResponse, "MiniMax response");
await runtimeResult.value.close();

function model(provider: string, id: string, maxTokens: number) {
  return {
    provider,
    id,
    maxTokens,
    compat: {},
  } as ReturnType<MiniMaxModelRegistry["find"]>;
}
