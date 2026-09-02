import type {
  ModelRegistry,
  ProviderConfig,
  ProviderModelConfig,
} from "@earendil-works/pi-coding-agent";
import {
  PiLocalAgentDriver,
  type PiSessionFactory,
} from "./local-agent-pi.js";

export const MINIMAX_DEFAULT_MODEL = "MiniMax-M3";

export const MINIMAX_REGIONAL_ENDPOINTS = [
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
] as const;

export const MINIMAX_MODEL_CONFIGS = [
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
] as const;

export interface MiniMaxModelRegistry {
  find: ModelRegistry["find"];
  hasConfiguredAuth: ModelRegistry["hasConfiguredAuth"];
  registerProvider: ModelRegistry["registerProvider"];
}

export class MiniMaxLocalAgentDriver extends PiLocalAgentDriver {
  constructor(factory?: PiSessionFactory) {
    super(factory, {
      provider: "minimax",
      defaultModel: MINIMAX_DEFAULT_MODEL,
      configureModelRegistry: registerMiniMaxProviders,
      resolveModel: resolveMiniMaxModel,
    });
  }
}

export function registerMiniMaxProviders(registry: MiniMaxModelRegistry): void {
  for (const endpoint of MINIMAX_REGIONAL_ENDPOINTS) {
    const config: ProviderConfig = {
      name: endpoint.region === "global_en" ? "MiniMax" : "MiniMax CN",
      baseUrl: endpoint.anthropicBaseUrl,
      apiKey: endpoint.apiKey,
      api: "anthropic-messages",
      models: MINIMAX_MODEL_CONFIGS.map((model) => (
        miniMaxProviderModel(registry, endpoint.providerId, endpoint.anthropicBaseUrl, model)
      )),
    };
    registry.registerProvider(endpoint.providerId, config);
  }
}

export function resolveMiniMaxModel(
  registry: MiniMaxModelRegistry,
  reference: string,
): ReturnType<ModelRegistry["find"]> {
  const separator = reference.indexOf("/");
  if (separator !== -1) {
    const provider = reference.slice(0, separator);
    const modelId = reference.slice(separator + 1);
    if (!isMiniMaxProviderId(provider)) return undefined;
    return registry.find(provider, modelId);
  }

  const candidates = MINIMAX_REGIONAL_ENDPOINTS
    .map((endpoint) => registry.find(endpoint.providerId, reference))
    .filter((model): model is NonNullable<typeof model> => model !== undefined);
  return candidates.find((model) => registry.hasConfiguredAuth(model)) ?? candidates[0];
}

function miniMaxProviderModel(
  registry: MiniMaxModelRegistry,
  providerId: string,
  baseUrl: string,
  model: typeof MINIMAX_MODEL_CONFIGS[number],
): ProviderModelConfig {
  const builtIn = registry.find(providerId, model.modelId);
  if (!builtIn) {
    throw new Error(`Embedded MiniMax model is unavailable: ${providerId}/${model.modelId}.`);
  }
  const thinking: readonly string[] = model.thinking;
  const inputModalities: readonly ("text" | "image" | "video")[] = model.inputModalities;
  const compat = thinking.includes("adaptive")
    ? { ...builtIn.compat, forceAdaptiveThinking: true }
    : builtIn.compat;
  const thinkingLevelMap = thinking.includes("always_on")
    ? { ...builtIn.thinkingLevelMap, off: null }
    : builtIn.thinkingLevelMap;

  return {
    id: model.modelId,
    name: model.modelId,
    api: "anthropic-messages",
    baseUrl,
    reasoning: true,
    ...(thinkingLevelMap ? { thinkingLevelMap } : {}),
    input: inputModalities.filter(isSupportedModelInput),
    cost: {
      input: model.pricingUsdPerMillionTokens.input,
      output: model.pricingUsdPerMillionTokens.output,
      cacheRead: model.pricingUsdPerMillionTokens.cacheRead,
      cacheWrite: model.pricingUsdPerMillionTokens.cacheWrite ?? 0,
    },
    contextWindow: model.contextWindow,
    maxTokens: builtIn.maxTokens,
    ...(compat ? { compat } : {}),
  };
}

function isMiniMaxProviderId(value: string): boolean {
  return MINIMAX_REGIONAL_ENDPOINTS.some((endpoint) => endpoint.providerId === value);
}

function isSupportedModelInput(
  value: typeof MINIMAX_MODEL_CONFIGS[number]["inputModalities"][number],
): value is "text" | "image" {
  return value === "text" || value === "image";
}
