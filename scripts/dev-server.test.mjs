import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { createServerCommand } from "./dev-server.mjs";

const require = createRequire(import.meta.url);

assert.deepEqual(createServerCommand(), {
  command: process.execPath,
  args: [require.resolve("tsx/cli"), "src/cli.ts", "serve"],
});
