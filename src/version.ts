import { createRequire } from "node:module";
import { isJsonString } from "./json-value.js";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

if (!isJsonString(packageJson.version) || !packageJson.version) {
  throw new Error("DevSpace package version is missing.");
}

export const DEVSPACE_VERSION = packageJson.version;
