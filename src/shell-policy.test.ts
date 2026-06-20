import assert from "node:assert/strict";
import { validateShellCommand } from "./shell-policy.js";

assert.equal(validateShellCommand("full", "npm test").allowed, true);
assert.equal(validateShellCommand("off", "pwd").allowed, false);
assert.equal(validateShellCommand("read-only", "rg devspace src").allowed, true);
assert.equal(validateShellCommand("read-only", "git status --short").allowed, true);
assert.equal(validateShellCommand("read-only", "find . -name '*.ts'").allowed, true);
assert.equal(validateShellCommand("read-only", "find . -delete").allowed, false);
assert.equal(validateShellCommand("read-only", "npm test").allowed, false);
assert.equal(validateShellCommand("read-only", "git commit -m nope").allowed, false);
assert.equal(validateShellCommand("read-only", "rg devspace src | head").allowed, false);
