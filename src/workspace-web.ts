import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import type { NextFunction, Request, Response, Router } from "express";
import type { ServerConfig } from "./config.js";
import {
  getActivityWorkspace,
  listActivityWorkspaces,
  listTurnToolCalls,
  listWorkspaceTurns,
  readTurnDiff,
} from "./workspace-activity.js";
import type { WorkspaceActivityStore } from "./workspace-activity-store.js";
import type { WorkspaceRegistry } from "./workspaces.js";
import { isJsonString } from "./json-value.js";
import type { JsonValue } from "./json-value.js";

/**
 * Read-only workspace observability pages: workspaces, their turns, and each
 * turn's diff and tool calls.
 *
 * The pages expose local code, so every page and API route requires a browser
 * session created by entering the owner token. The session lives in an
 * HttpOnly, SameSite=Strict cookie scoped to this path, so other sites can
 * neither read it nor send it; state-changing forms (login, logout) also
 * require a same-origin request. No CORS headers are ever sent.
 */
export const WORKSPACE_WEB_PATH = "/web";

const SESSION_COOKIE = "devspace_web_session";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILED_LOGINS = 10;

export function workspaceWebUrl(config: Pick<ServerConfig, "publicBaseUrl">): string {
  return `${config.publicBaseUrl.replace(/\/+$/, "")}${WORKSPACE_WEB_PATH}/`;
}

export interface WorkspaceWebOptions {
  config: ServerConfig;
  activity: WorkspaceActivityStore;
  workspaces: WorkspaceRegistry;
  /** Directory holding the built pages; defaults to dist/web. */
  buildDirectory?: string;
}

export function createWorkspaceWebRouter(options: WorkspaceWebOptions): Router {
  const { config, activity, workspaces } = options;
  const buildDirectory = options.buildDirectory ?? fileURLToPath(new URL("../dist/web", import.meta.url));
  const sessions = new WebSessions();
  const failedLogins = new FailedLoginWindow();
  const router = express.Router();

  router.use((_req, res, next) => {
    setSecurityHeaders(res);
    next();
  });

  router.use("/assets", express.static(`${buildDirectory}/assets`, {
    immutable: true,
    maxAge: "1y",
    fallthrough: false,
    setHeaders: (res) => res.setHeader("Cache-Control", "public, max-age=31536000, immutable"),
  }));

  router.get("/login", (req, res) => {
    if (sessions.isValid(sessionCookie(req))) {
      res.redirect(303, safeNextPath(req.query.next));

      return;
    }

    sendLoginPage(res, 200, safeNextPath(req.query.next));
  });

  router.post("/login", express.urlencoded({ extended: false, limit: "8kb" }), (req, res) => {
    const next = safeNextPath(req.body?.next);

    if (!isSameOriginRequest(req, config)) {
      res.status(403).type("text/plain").send("Cross-origin login is not allowed.");

      return;
    }

    if (failedLogins.isLocked()) {
      sendLoginPage(res, 429, next, "Too many failed attempts. Try again in a few minutes.");

      return;
    }

    if (!tokenMatches(String(req.body?.owner_token ?? ""), config.oauth.ownerToken)) {
      failedLogins.record();
      sendLoginPage(res, 401, next, "The owner password was not accepted.");

      return;
    }

    res.cookie(SESSION_COOKIE, sessions.create(), {
      httpOnly: true,
      sameSite: "strict",
      secure: isHttpsRequest(req),
      path: WORKSPACE_WEB_PATH,
      maxAge: SESSION_TTL_MS,
    });
    res.redirect(303, next);
  });

  router.post("/logout", (req, res) => {
    if (!isSameOriginRequest(req, config)) {
      res.status(403).type("text/plain").send("Cross-origin logout is not allowed.");

      return;
    }

    sessions.revoke(sessionCookie(req));
    res.clearCookie(SESSION_COOKIE, { path: WORKSPACE_WEB_PATH });
    res.redirect(303, `${WORKSPACE_WEB_PATH}/login`);
  });

  router.use((req, res, next) => {
    if (sessions.isValid(sessionCookie(req))) {
      next();

      return;
    }

    if (req.path.startsWith("/api/")) {
      res.status(401).json({ error: "Sign in to view workspaces." });

      return;
    }

    res.redirect(303, `${WORKSPACE_WEB_PATH}/login?next=${encodeURIComponent(req.originalUrl)}`);
  });

  router.get("/api/workspaces", asyncRoute(async (_req, res) => {
    res.json({ workspaces: await listActivityWorkspaces(activity) });
  }));

  router.get("/api/workspaces/:workspaceId", asyncRoute(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const workspace = await getActivityWorkspace(activity, workspaceId);

    if (!workspace) {
      res.status(404).json({ error: "Workspace not found." });

      return;
    }

    res.json({
      workspace,
      context: await workspaces.describeWorkspace(workspace),
      turns: listWorkspaceTurns(activity, workspaceId),
    });
  }));

  router.get("/api/workspaces/:workspaceId/turns/:sequence", asyncRoute(async (req, res) => {
    const workspaceId = String(req.params.workspaceId);
    const sequence = Number(req.params.sequence);
    const turn = Number.isSafeInteger(sequence) ? activity.getTurn(workspaceId, sequence) : undefined;

    if (!turn) {
      res.status(404).json({ error: "Turn not found." });

      return;
    }

    const toolCalls = listTurnToolCalls(activity, workspaceId, sequence) ?? [];
    const diff = await readTurnDiff(activity, workspaceId, sequence);
    res.json({ turn, toolCalls, diff });
  }));

  router.use("/api", (_req, res) => {
    res.status(404).json({ error: "Not found." });
  });

  // Every other path is a client-side page.
  router.get("/{*page}", asyncRoute(async (_req, res) => {
    res.type("html").send(await readFile(`${buildDirectory}/index.html`, "utf8"));
  }));

  return router;
}

class WebSessions {
  private readonly expiresAt = new Map<string, number>();

  create(): string {
    const token = randomBytes(32).toString("base64url");
    this.expiresAt.set(digest(token), Date.now() + SESSION_TTL_MS);

    return token;
  }

  isValid(token: string | undefined): boolean {
    if (!token) return false;
    const key = digest(token);
    const expiresAt = this.expiresAt.get(key);

    if (expiresAt === undefined) return false;

    if (expiresAt > Date.now()) return true;
    this.expiresAt.delete(key);

    return false;
  }

  revoke(token: string | undefined): void {
    if (token) this.expiresAt.delete(digest(token));
  }
}

/** Slows guessing of a weak owner password; DevSpace has a single owner. */
class FailedLoginWindow {
  private failures: number[] = [];

  isLocked(): boolean {
    this.prune();

    return this.failures.length >= MAX_FAILED_LOGINS;
  }

  record(): void {
    this.prune();
    this.failures.push(Date.now());
  }

  private prune(): void {
    const cutoff = Date.now() - LOGIN_WINDOW_MS;
    this.failures = this.failures.filter((time) => time > cutoff);
  }
}

function tokenMatches(provided: string, expected: string): boolean {
  return timingSafeEqual(createHash("sha256").update(provided).digest(), createHash("sha256").update(expected).digest());
}

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function sessionCookie(req: Request): string | undefined {
  for (const part of (req.get("cookie") ?? "").split(";")) {
    const separator = part.indexOf("=");

    if (separator === -1) continue;

    if (part.slice(0, separator).trim() === SESSION_COOKIE) {
      return decodeURIComponent(part.slice(separator + 1).trim());
    }
  }

  return undefined;
}

/**
 * Browsers send Sec-Fetch-Site on form posts; older ones send only Origin.
 * Accept a post only when one of them identifies our own origin.
 */
function isSameOriginRequest(req: Request, config: ServerConfig): boolean {
  const fetchSite = req.get("sec-fetch-site");

  if (fetchSite) return fetchSite === "same-origin";

  const origin = req.get("origin");

  if (!origin) return false;

  if (origin === new URL(config.publicBaseUrl).origin) return true;

  try {
    return new URL(origin).host === req.get("host");
  } catch {
    return false;
  }
}

function isHttpsRequest(req: Request): boolean {
  return req.secure || req.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
}

function safeNextPath(value: JsonValue): string {
  const fallback = `${WORKSPACE_WEB_PATH}/`;

  if (!isJsonString(value)) return fallback;

  if (!value.startsWith(`${WORKSPACE_WEB_PATH}/`) || value.startsWith("//") || value.includes("\\")) {
    return fallback;
  }

  return value.startsWith(`${WORKSPACE_WEB_PATH}/login`) ? fallback : value;
}

function setSecurityHeaders(res: Response): void {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "same-origin");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  res.setHeader(
    "Content-Security-Policy",
    [
      "default-src 'self'",
      "script-src 'self' 'wasm-unsafe-eval'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "font-src 'self' data:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-ancestors 'none'",
      "base-uri 'none'",
      "form-action 'self'",
    ].join("; "),
  );
}

function asyncRoute(
  handler: (req: Request, res: Response) => Promise<void>,
): (req: Request, res: Response, next: NextFunction) => void {
  return (req, res, next) => {
    handler(req, res).catch(next);
  };
}

function sendLoginPage(res: Response, status: number, next: string, error?: string): void {
  res.status(status).type("html").send(`<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="color-scheme" content="light dark" />
    <title>Sign in · DevSpace</title>
    <style>
      :root { color-scheme: light dark; --bg: #f7f7f8; --panel: #ffffff; --border: #e3e3e6; --text: #18181b; --muted: #6b6b73; --danger: #c43c3c; --accent: #18181b; --accent-text: #ffffff; }
      @media (prefers-color-scheme: dark) { :root { --bg: #111113; --panel: #18181b; --border: #2e2e33; --text: #f5f5f6; --muted: #a3a3aa; --danger: #ee7676; --accent: #f5f5f6; --accent-text: #18181b; } }
      * { box-sizing: border-box; }
      body { margin: 0; min-height: 100vh; display: grid; place-items: center; padding: 16px; background: var(--bg); color: var(--text); font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
      main { width: min(380px, 100%); padding: 24px; border: 1px solid var(--border); border-radius: 12px; background: var(--panel); }
      h1 { margin: 0 0 6px; font-size: 18px; font-weight: 600; }
      p { margin: 0 0 18px; color: var(--muted); font-size: 13px; line-height: 1.5; }
      label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 500; }
      input { width: 100%; padding: 10px 12px; border: 1px solid var(--border); border-radius: 8px; background: transparent; color: inherit; font: inherit; font-size: 16px; }
      button { width: 100%; margin-top: 14px; padding: 10px 12px; border: 0; border-radius: 8px; background: var(--accent); color: var(--accent-text); font: inherit; font-weight: 600; cursor: pointer; }
      .error { margin: 0 0 14px; color: var(--danger); font-size: 13px; }
    </style>
  </head>
  <body>
    <main>
      <h1>DevSpace workspaces</h1>
      <p>Enter the owner password to view workspace activity on this machine.</p>
      ${error ? `<p class="error" role="alert">${htmlEscape(error)}</p>` : ""}
      <form method="post" action="${WORKSPACE_WEB_PATH}/login">
        <input type="hidden" name="next" value="${htmlEscape(next)}" />
        <label for="owner_token">Owner password</label>
        <input id="owner_token" name="owner_token" type="password" autocomplete="current-password" autofocus required />
        <button type="submit">Sign in</button>
      </form>
    </main>
  </body>
</html>`);
}

function htmlEscape(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}
