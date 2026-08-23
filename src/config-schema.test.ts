import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createDevspaceConfigJsonSchema } from "./user-config.js";

const checkedIn = JSON.parse(
  readFileSync(new URL("../schema/devspace-config.schema.json", import.meta.url), "utf8"),
) as Record<string, unknown>;

assert.deepEqual(checkedIn, createDevspaceConfigJsonSchema());
