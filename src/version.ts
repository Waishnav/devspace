import { isJsonString } from "./json-value.js";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);

// SAFETY: The surrounding checks or construction already match this type.
const packageJson = require("../package.json") as { version?: unknown };

if (!isJsonString(packageJson.version) || !packageJson.version) {
  throw new Error("DevSpace package version is missing.");
}

export const DEVSPACE_VERSION = packageJson.version;
