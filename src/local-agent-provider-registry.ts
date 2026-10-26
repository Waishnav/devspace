import type {
  SubagentProviderConfig,
  SubagentsConfig,
} from "./local-agent-config.js";
import {
  localAgentProviderEnvironment,
  localAgentProviderEnvironmentOverrides,
} from "./local-agent-config.js";
import type {
  LocalAgentDriverKind,
  LocalAgentProviderInstanceId,
} from "./local-agent-provider.js";
import type { LocalAgentDriver } from "./local-agent-runtime.js";

export interface LocalAgentDriverFactoryContext {
  instance: SubagentProviderConfig;
  env: NodeJS.ProcessEnv;
  envOverrides: Record<string, string>;
}

export type LocalAgentDriverFactory = (
  context: LocalAgentDriverFactoryContext,
) => LocalAgentDriver;

export class LocalAgentProviderRegistry {
  private readonly factories = new Map<LocalAgentDriverKind, LocalAgentDriverFactory>();

  register(kind: LocalAgentDriverKind, factory: LocalAgentDriverFactory): this {
    if (this.factories.has(kind)) throw new Error(`Local agent driver already registered: ${kind}`);
    this.factories.set(kind, factory);
    return this;
  }

  create(
    instance: SubagentProviderConfig,
    subagents: SubagentsConfig | undefined,
    inheritedEnv: NodeJS.ProcessEnv,
  ): LocalAgentDriver {
    const factory = this.factories.get(instance.driver);
    if (!factory) throw new Error(`No local agent driver registered for: ${instance.driver}`);
    const env = subagents
      ? localAgentProviderEnvironment(subagents, instance.id, inheritedEnv)
      : inheritedEnv;
    const envOverrides = subagents
      ? localAgentProviderEnvironmentOverrides(subagents, instance.id)
      : {};
    return new ProviderInstanceDriver(instance.id, factory({ instance, env, envOverrides }));
  }
}

class ProviderInstanceDriver implements LocalAgentDriver {
  readonly provider: LocalAgentDriverKind;
  readonly runtimePolicy: LocalAgentDriver["runtimePolicy"];
  readonly capabilities: LocalAgentDriver["capabilities"];

  constructor(
    readonly providerInstanceId: LocalAgentProviderInstanceId,
    private readonly driver: LocalAgentDriver,
  ) {
    this.provider = driver.provider;
    this.runtimePolicy = driver.runtimePolicy;
    this.capabilities = driver.capabilities;
  }

  createRuntime(context: Parameters<LocalAgentDriver["createRuntime"]>[0]) {
    return this.driver.createRuntime(context);
  }
}
