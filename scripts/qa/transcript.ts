import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import type { JsonObject } from "../../src/json-value.js";

/** Everything one scenario replay produced; written to transcript.json and served to the QA host. */
export interface QaRun {
  scenario: { name: string; description: string };
  checkout: { path: string; commit?: string; branch?: string; dirty: boolean };
  serverUrl: string;
  fixture: string;
  tools: Tool[];
  steps: QaStep[];
  resources: Record<string, QaResource>;
  /** Tool calls made by rendered cards through the host bridge. */
  cardCalls: QaCardCall[];
}

export interface QaStep {
  index: number;
  label?: string;
  tool: string;
  arguments: JsonObject;
  result?: CallToolResult;
  error?: string;
  durationMs: number;
  /** Set when the tool declares a UI resource and returned a non-error result. */
  resourceUri?: string;
  failures: string[];
}

export interface QaResource {
  mimeType?: string;
  html: string;
  meta: JsonObject;
}

export interface QaCardCall {
  step: number;
  name: string;
  arguments: JsonObject;
  result?: CallToolResult;
  error?: string;
}
