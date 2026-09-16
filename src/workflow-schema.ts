import { Ajv, type ValidateFunction } from "ajv";
import { WorkflowError } from "./workflow-types.js";

/** Schemas are model supplied: bound compilation and disallow executable/recursive regex paths. */
export function compileWorkflowSchema(schema: Record<string, unknown>): ValidateFunction {
  if (Buffer.byteLength(JSON.stringify(schema)) > 16_384) throw new WorkflowError("INVALID_SCHEMA", "Schema exceeds 16 KiB.");
  let nodes = 0;
  function visit(value: unknown, depth: number, position: "schema" | "schemas" | "data"): void {
    if (++nodes > 512 || depth > 16) throw new WorkflowError("INVALID_SCHEMA", "Schema is too complex.");
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (position === "schema" && ["$ref", "$dynamicRef", "$recursiveRef", "$async", "pattern", "patternProperties", "format"].includes(key)) {
        throw new WorkflowError("INVALID_SCHEMA", `Workflow schemas do not support ${key}. Use inline structural constraints.`);
      }
      const childPosition = position === "schemas" ? "schema"
        : position !== "schema" ? "data"
        : ["properties", "definitions", "$defs", "dependencies", "allOf", "anyOf", "oneOf"].includes(key) ? "schemas"
        : ["additionalProperties", "additionalItems", "items", "contains", "not", "if", "then", "else", "propertyNames"].includes(key) ? (Array.isArray(child) ? "schemas" : "schema")
        : "data";
      visit(child, depth + 1, childPosition);
    }
  }
  visit(schema, 0, "schema");
  try {
    return new Ajv({ strict: true, allErrors: false, logger: false }).compile(schema);
  } catch (error) {
    throw new WorkflowError("INVALID_SCHEMA", `Invalid JSON schema: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function parseWorkflowOutput(text: string, validate: ValidateFunction): unknown {
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { throw new WorkflowError("INVALID_OUTPUT", "Agent output was not JSON."); }
  if (!validate(value)) {
    const error = validate.errors?.[0];
    throw new WorkflowError("INVALID_OUTPUT", `JSON output ${error?.instancePath ?? ""} ${error?.message ?? "does not match the schema"}.`);
  }
  return value;
}
