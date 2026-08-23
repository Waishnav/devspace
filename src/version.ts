import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const packageJson = require("../package.json") as { version?: unknown };

if (typeof packageJson.version !== "string" || !packageJson.version) {
  throw new Error("DevSpace package version is missing.");
}

export const DEVSPACE_VERSION = packageJson.version;
