import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";
import { isJsonString, isJsonObject } from "../../src/json-value.js";
import type { JsonObject, JsonValue } from "../../src/json-value.js";

/**
 * A QA scenario is a fixture project plus an ordered list of MCP tool calls.
 * String values in step arguments may reference `{{fixture}}` (the fixture
 * project path) and `{{workspace_id}}` (the most recent workspace_id returned
 * by any earlier step).
 */
export interface Scenario {
  name: string;
  description: string;
  /** Deep-merged into the generated config.jsonc, e.g. { "tools": { "mode": "claude" } }. */
  config?: JsonObject;
  env?: Record<string, string>;
  /** How the simulated MCP host identifies itself to DevSpace. */
  host?: {
    clientName?: string;
    userAgent?: string;
  };
  fixture: {
    // SAFETY: Boundary value already validated or constructed to match this type.
    /** Committed as the initial Git revision. */
    files: Record<string, string>;
    /** Written after the initial commit, leaving the checkout dirty. */
    dirty?: Record<string, string>;
  };
  steps: ScenarioStep[];
}

export interface ScenarioStep {
  tool: string;
  arguments: JsonObject;
  /** Short label shown in the host page and report. */
  label?: string;
  expect?: {
    isError?: boolean;
    /** Substrings that must appear in the textual result content. */
    text?: string[];
  };
}

export const scenariosDir = new URL("./scenarios/", import.meta.url);

export async function listScenarioNames(): Promise<string[]> {
  const entries = await readdir(scenariosDir);

  return entries
    .filter((entry) => entry.endsWith(".json"))
    .map((entry) => basename(entry, ".json"))
    .sort();
}

export async function loadScenario(nameOrPath: string): Promise<Scenario> {
  const path = nameOrPath.endsWith(".json")
    ? nameOrPath
    : join(scenariosDir.pathname, `${nameOrPath}.json`);

  // SAFETY: Boundary value already validated or constructed to match this type.
  const scenario = JSON.parse(await readFile(path, "utf8")) as Omit<Scenario, "name"> & { name?: string };

  return { ...scenario, name: scenario.name ?? basename(path, ".json") };
}

export function resolveTemplates(value: JsonValue, variables: Record<string, string | undefined>): unknown {
  if (isJsonString(value)) {
    return value.replace(/\{\{(\w+)\}\}/g, (match, key: string) => {
      const resolved = variables[key];

      if (resolved === undefined) throw new Error(`Scenario references ${match} before it is available.`);

      return resolved;
    });
  }

  if (Array.isArray(value)) return value.map((item) => resolveTemplates(item, variables));

  if (value && isJsonObject(value)) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, resolveTemplates(item, variables)]),
    );
  }

  return value;
}
