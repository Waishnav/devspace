import assert from "node:assert/strict";
import test from "node:test";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import {
  decodeToolResult,
  toolResultFromChatGptGlobals,
} from "./tool-result.js";

test("workspace cards can be rebuilt from structured content without result metadata", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      root: "/tmp/project",
      mode: "checkout",
      skills: [{ name: "tdd", description: "Tests first", path: "/tmp/tdd/SKILL.md" }],
      agentsFiles: [{ path: "AGENTS.md", content: "instructions" }],
      review: { available: true },
      instruction: "Reuse this workspace.",
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "open_workspace");
  assert.equal(decoded.card.workspaceId, "ws_1");
  assert.equal(decoded.card.summary?.skills, 1);
  assert.equal(decoded.card.summary?.agentsFiles, 1);
});

test("review results use rich metadata when the host provides it", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      reviewRef: "a".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
    _meta: {
      card: {
        workspaceId: "ws_1",
        summary: { files: 1, additions: 1, removals: 0 },
        files: [{ path: "new.txt", type: "new", additions: 1, removals: 0 }],
        payload: { patch: "diff --git ..." },
      },
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "show_changes");
  assert.equal(decoded.card.files?.[0]?.path, "new.txt");
  assert.equal(decoded.card.payload?.patch, "diff --git ...");
});

test("review structured content becomes a reload reference when metadata is missing", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      reviewRef: "b".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
  });

  assert.deepEqual(decoded, {
    kind: "review-reference",
    workspaceId: "ws_1",
    reviewRef: "b".repeat(40),
  });
});

test("incomplete review metadata falls back to the durable review reference", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      workspaceId: "ws_1",
      reviewRef: "e".repeat(40),
      result: "Changed 1 file (+1 -0).",
    },
    _meta: { card: {} },
  });

  assert.deepEqual(decoded, {
    kind: "review-reference",
    workspaceId: "ws_1",
    reviewRef: "e".repeat(40),
  });
});

test("older review results can reload from their structured patch", () => {
  const decoded = decodeToolResult({
    content: [],
    structuredContent: {
      result: "Changed 1 file (+1 -0).",
      summary: { files: 1, additions: 1, removals: 0 },
      files: [{ path: "new.txt", type: "new", additions: 1, removals: 0 }],
      patch: "diff --git a/new.txt b/new.txt",
    },
  });

  assert.equal(decoded.kind, "card");
  if (decoded.kind !== "card") return;
  assert.equal(decoded.card.tool, "show_changes");
  assert.equal(decoded.card.files?.[0]?.path, "new.txt");
  assert.equal(decoded.card.payload?.patch, "diff --git a/new.txt b/new.txt");
});

test("ChatGPT globals restore structured output and hidden MCP result metadata together", () => {
  const fullResult: CallToolResult = {
    content: [{ type: "text", text: "Changed 1 file." }],
    structuredContent: { stale: true },
    _meta: { card: { workspaceId: "ws_1", payload: { patch: "patch" } } },
  };
  const restored = toolResultFromChatGptGlobals({
    toolOutput: {
      workspaceId: "ws_1",
      reviewRef: "c".repeat(40),
      result: "Changed 1 file.",
    },
    toolResponseMetadata: {
      mcp_tool_result: fullResult,
    },
  });

  assert.deepEqual(restored?.structuredContent, {
    workspaceId: "ws_1",
    reviewRef: "c".repeat(40),
    result: "Changed 1 file.",
  });
  assert.deepEqual(restored?._meta, fullResult._meta);
});

test("ChatGPT globals also accept result metadata exposed directly", () => {
  const restored = toolResultFromChatGptGlobals({
    toolOutput: {
      workspaceId: "ws_1",
      reviewRef: "d".repeat(40),
      result: "Changed 1 file.",
    },
    toolResponseMetadata: {
      card: {
        workspaceId: "ws_1",
        summary: { files: 1, additions: 1, removals: 0 },
      },
    },
  });

  assert.deepEqual(restored?._meta, {
    card: {
      workspaceId: "ws_1",
      summary: { files: 1, additions: 1, removals: 0 },
    },
  });
});
