import assert from "node:assert/strict";
import { getProviderLogo } from "./icons.js";

const cursor = getProviderLogo("cursor");

for (const name of ["codex", "copilot", "pi"]) {
  const logo = getProviderLogo(name);
  assert.ok(logo);
  assert.equal(logo.light, logo.dark);
  assert.equal(logo.invertInLight, true);
}

assert.ok(cursor);
assert.notEqual(cursor.light, cursor.dark);
assert.match(cursor.light, /cursor-light/);

assert.deepEqual(getProviderLogo("  CoDeX  "), getProviderLogo("codex"));
assert.equal(getProviderLogo("unknown"), undefined);
