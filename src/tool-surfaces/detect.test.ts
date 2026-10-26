import assert from "node:assert/strict";
import test from "node:test";
import { detectToolSurface } from "./detect.js";

test("a ChatGPT OAuth client selects the codex surface", () => {
  assert.equal(
    detectToolSurface({
      clientName: "ChatGPT",
      redirectUris: ["https://chatgpt.com/connector/oauth/abc"],
    }),
    "codex",
  );
});

test("a Claude OAuth client selects the claude surface", () => {
  assert.equal(
    detectToolSurface({
      clientName: "Claude",
      redirectUris: ["https://claude.ai/api/mcp/auth_callback"],
    }),
    "claude",
  );
});

test("the client name decides without a recognisable redirect host", () => {
  assert.equal(
    detectToolSurface({ clientName: "Claude", redirectUris: ["http://127.0.0.1/callback"] }),
    "claude",
  );
});

test("the redirect host decides when the client name is generic", () => {
  assert.equal(
    detectToolSurface({ clientName: "MCP", redirectUris: ["https://claude.com/callback"] }),
    "claude",
  );
  assert.equal(
    detectToolSurface({ redirectUris: ["https://chatgpt.com/connector/oauth/x"] }),
    "codex",
  );
});

test("lookalike redirect hosts do not match", () => {
  assert.equal(
    detectToolSurface({ redirectUris: ["https://notchatgpt.com/cb", "https://chatgpt.com.evil.test/cb"] }),
    "claude",
  );
});

test("the OAuth client outranks the User-Agent", () => {
  assert.equal(
    detectToolSurface({ clientName: "Claude", userAgent: "openai-mcp/1.0.0" }),
    "claude",
  );
});

test("the User-Agent decides when the client is unrecognised", () => {
  assert.equal(detectToolSurface({ clientName: "Acme", userAgent: "openai-mcp/1.0.0" }), "codex");
  assert.equal(detectToolSurface({ userAgent: "Claude-User/1.0" }), "claude");
});

test("unknown hosts get the claude surface", () => {
  assert.equal(detectToolSurface({}), "claude");
  assert.equal(detectToolSurface({ clientName: "Acme", userAgent: "curl/8" }), "claude");
});
