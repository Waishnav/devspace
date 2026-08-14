import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdir, stat } from "node:fs/promises";
import { createServer } from "node:http";
import { homedir } from "node:os";
import { join, relative } from "node:path";
import { CodexChromeUseAdapter } from "./codex-chrome-use.js";
import { CodexComputerUseAdapter } from "./codex-computer-use.js";
import { isMacScreenLocked } from "./codex-request-context.js";
import { CodexRuntimeHost } from "./codex-runtime-host.js";

if (process.env.DEVSPACE_TEST_CODEX_LIVE !== "1") {
  process.exit(0);
}

const html = `<!doctype html>
<html>
<head><meta charset="utf-8"><title>DevSpace Formal Chrome Acceptance</title></head>
<body>
  <h1>DevSpace Chrome Acceptance</h1>
  <label>Acceptance input <input aria-label="Acceptance input" id="value"></label>
  <button id="apply" onclick="document.querySelector('#result').textContent='Accepted: '+document.querySelector('#value').value">Apply</button>
  <div id="result" data-testid="result">Waiting</div>
</body>
</html>`;

const server = createServer((_request, response) => {
  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "content-length": Buffer.byteLength(html),
    connection: "close",
  });
  response.end(html);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
assert.ok(address && typeof address === "object");
const url = `http://127.0.0.1:${address.port}/`;

const methods: string[] = [];
const sessionsBefore = await snapshotCodexSessions();
const host = new CodexRuntimeHost({
  onAppServerMethod: (method) => methods.push(method),
});
const chrome = new CodexChromeUseAdapter(host);
const computer = new CodexComputerUseAdapter(host);
const context = {
  requestMeta: { "openai/session": "devspace-formal-live-acceptance" },
  mcpSessionId: "devspace-formal-live-acceptance",
  requestId: "live-1",
  onElicitation: async () => ({ action: "accept", content: {} }),
};

try {
  assert.equal(await isMacScreenLocked(), true, "This live acceptance is expected to run while locked.");

  await assert.rejects(
    () => computer.invoke({ action: "list_apps" }, context),
    (error: unknown) => (
      error instanceof Error
      && "code" in error
      && error.code === "codex_computer_use_locked_context_unavailable"
    ),
    "Native Computer Use must fail closed while locked without authentic turn metadata.",
  );

  const created = await chrome.invoke({
    action: "new_tab",
    url,
    observe: "both",
  }, { ...context, requestId: "live-new-tab" });
  assert.equal(created.isError, false);
  const createdPayload = firstJsonText(created);
  const tabId = stringField(createdPayload, "tabId");
  assert.equal(stringField(createdPayload, "title"), "DevSpace Formal Chrome Acceptance");
  assert.match(stringField(createdPayload, "dom"), /DevSpace Chrome Acceptance/u);
  assert.equal(imageCount(created), 1);

  const filled = await chrome.invoke({
    action: "fill",
    tabId,
    selector: "#value",
    text: "codex-chrome-formal-acceptance",
    observe: "dom",
  }, { ...context, requestId: "live-fill" });
  assert.equal(filled.isError, false);

  const clicked = await chrome.invoke({
    action: "click",
    tabId,
    selector: "#apply",
    observe: "both",
  }, { ...context, requestId: "live-click" });
  assert.equal(clicked.isError, false);
  const clickedPayload = firstJsonText(clicked);
  assert.match(
    stringField(clickedPayload, "dom"),
    /Accepted: codex-chrome-formal-acceptance/u,
  );
  assert.equal(imageCount(clicked), 1);

  const closed = await chrome.invoke({
    action: "close",
    tabId,
  }, { ...context, requestId: "live-close" });
  assert.equal(closed.isError, false);
  assert.equal(firstJsonText(closed).closed, true);

  await host.invalidate();
  const recovered = await chrome.invoke({
    action: "status",
  }, { ...context, requestId: "live-recovery" });
  assert.equal(recovered.isError, false);
  const recoveredPayload = firstJsonText(recovered);
  assert.equal(recoveredPayload.backend, "extension");
  assert.equal(recoveredPayload.connected, true);
} finally {
  await computer.close().catch(() => undefined);
  await chrome.close().catch(() => undefined);
  await host.close().catch(() => undefined);
  server.closeAllConnections();
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

const sessionsAfter = await snapshotCodexSessions();
assert.deepEqual(sessionsAfter, sessionsBefore, "Codex session files changed during local execution.");
assert.equal(methods.includes("thread/start"), false);
assert.equal(methods.includes("turn/start"), false);
assert.ok(methods.includes("process/spawn"));
assert.ok(methods.includes("process/writeStdin"));
assert.ok(methods.includes("process/kill"));

console.log(JSON.stringify({
  locked: true,
  nativeComputerUse: "failed_closed",
  chromeUse: "passed",
  methods: Array.from(new Set(methods)),
  sessionFilesChanged: false,
}, null, 2));

function firstJsonText(result: {
  content: Array<{ type: string; text?: string }>;
}): Record<string, unknown> {
  const text = result.content.find((item) => item.type === "text")?.text;
  assert.ok(text, "Expected text output from Codex runtime.");
  return JSON.parse(text) as Record<string, unknown>;
}

function stringField(value: Record<string, unknown>, key: string): string {
  const field = value[key];
  assert.equal(typeof field, "string", `Expected ${key} to be a string.`);
  return field as string;
}

function imageCount(result: { content: Array<{ type: string }> }): number {
  return result.content.filter((item) => item.type === "image").length;
}

async function snapshotCodexSessions(): Promise<Array<{
  path: string;
  size: number;
  mtimeNs: string;
  sha256: string;
}>> {
  const root = join(homedir(), ".codex", "sessions");
  const files = await walk(root).catch(() => []);
  return Promise.all(files.sort().map(async (path) => {
    const metadata = await stat(path, { bigint: true });
    const data = await import("node:fs/promises").then((module) => module.readFile(path));
    return {
      path: relative(root, path),
      size: Number(metadata.size),
      mtimeNs: metadata.mtimeNs.toString(),
      sha256: createHash("sha256").update(data).digest("hex"),
    };
  }));
}

async function walk(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const path = join(root, entry.name);
    if (entry.isDirectory()) output.push(...await walk(path));
    else if (entry.isFile()) output.push(path);
  }
  return output;
}
