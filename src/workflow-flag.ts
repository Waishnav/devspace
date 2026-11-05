/**
 * Workflows ship hidden in v1.1. This environment variable is the only switch:
 * there is intentionally no config key and no MCP tool surface until they graduate.
 */
export const WORKFLOWS_ENV = "DEVSPACE_EXPERIMENTAL_WORKFLOWS";

export function workflowsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env[WORKFLOWS_ENV] === "1";
}
