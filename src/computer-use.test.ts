import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureComputerScreen,
  getComputerDisplays,
  getComputerUsePermissions,
  isComputerUseSupportedPlatform,
  performComputerAction,
} from "./computer-use.js";

assert.equal(isComputerUseSupportedPlatform("darwin"), true);
assert.equal(isComputerUseSupportedPlatform("linux"), false);
assert.equal(isComputerUseSupportedPlatform("win32"), false);

if (
  process.platform === "darwin"
  && process.env.DEVSPACE_TEST_SWIFT_COMPUTER_USE === "1"
) {
  const stateDir = await mkdtemp(join(tmpdir(), "devspace-computer-use-test-"));
  try {
    const permissions = await getComputerUsePermissions(stateDir);
    assert.equal(typeof permissions.screenCapture, "boolean");
    assert.equal(typeof permissions.accessibility, "boolean");

    const displays = await getComputerDisplays(stateDir);
    assert.ok(displays.length >= 1);
    assert.equal(displays[0]?.index, 1);
    assert.equal(displays[0]?.main, true);
    assert.ok((displays[0]?.width ?? 0) > 0);
    assert.ok((displays[0]?.height ?? 0) > 0);

    const waited = await performComputerAction(stateDir, {
      action: "wait",
      durationMs: 0,
    });
    assert.equal(waited.action, "wait");
    assert.deepEqual(waited.permissions, permissions);

    if (permissions.screenCapture) {
      const capture = await captureComputerScreen({
        stateDir,
        maxFileBytes: 50 * 1024 * 1024,
        display: 1,
        includeCursor: false,
      });
      assert.equal(capture.mimeType, "image/png");
      assert.ok(capture.size > 24);
      assert.equal(Buffer.from(capture.data, "base64").length, capture.size);
      assert.equal(capture.width, Math.round(capture.display.width));
      assert.equal(capture.height, Math.round(capture.display.height));
      assert.match(capture.sha256, /^sha256:[0-9a-f]{64}$/u);
    }
  } finally {
    await rm(stateDir, { recursive: true, force: true });
  }
}
