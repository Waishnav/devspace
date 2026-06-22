import assert from "node:assert/strict";
import type { Request } from "express";
import { requestPath } from "./logger.js";

assert.equal(
  requestPath({
    originalUrl: "/register?source=chatgpt",
    path: "/",
    url: "/",
  } as Request),
  "/register",
);
assert.equal(
  requestPath({ originalUrl: "", path: "/mcp", url: "/mcp" } as Request),
  "/mcp",
);
