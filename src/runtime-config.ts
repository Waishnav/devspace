import type { ServerConfig } from "./config.js";
import { compileHarness, type CompiledHarness } from "./harness.js";
import { compilePresentation, type CompiledPresentation } from "./presentation.js";

export type ArtifactCapability =
  | {
      status: "available";
      maxFileBytes: number;
    }
  | {
      status: "unavailable";
      reason: "disabled" | "unsupported-platform";
    };

export interface RuntimeConfig extends ServerConfig {
  runtimeHarness: CompiledHarness;
  runtimePresentation: CompiledPresentation;
  artifactCapability: ArtifactCapability;
}

export function compileRuntime(
  config: ServerConfig,
  environment: { artifactDownloadSupported: boolean },
): RuntimeConfig {
  return {
    ...config,
    runtimeHarness: compileHarness(config.harness, { skillsEnabled: config.skillsEnabled }),
    runtimePresentation: compilePresentation(config.presentation),
    artifactCapability: !config.artifactsEnabled
      ? { status: "unavailable", reason: "disabled" }
      : environment.artifactDownloadSupported
        ? { status: "available", maxFileBytes: config.artifactMaxFileBytes }
        : { status: "unavailable", reason: "unsupported-platform" },
  };
}
