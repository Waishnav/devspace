import { realpath, stat } from "node:fs/promises";
import { basename, extname, resolve, sep } from "node:path";
import { isPathInsideRoot } from "./roots.js";

const SECRET_SEGMENTS = new Set([
  ".aws",
  ".gnupg",
  ".ssh",
  "credentials",
  "credential",
  "secrets",
  "secret",
]);
const SECRET_EXTENSIONS = new Set([".key", ".pem", ".p12", ".pfx"]);
const BINARY_EXTENSIONS = new Set([
  ".7z", ".avi", ".bin", ".bmp", ".class", ".dmg", ".doc", ".docx",
  ".gif", ".gz", ".ico", ".jar", ".jpeg", ".jpg", ".mov", ".mp3",
  ".mp4", ".pdf", ".png", ".tar", ".wasm", ".webp", ".woff", ".woff2", ".zip",
]);
const GENERATED_SEGMENTS = new Set([
  ".git", ".next", ".turbo", "build", "coverage", "dist", "node_modules",
]);

export function pathSegments(path: string): string[] {
  return resolve(path).split(sep).filter(Boolean).map((part) => part.toLowerCase());
}

export function isSecretLikePath(path: string): boolean {
  const segments = pathSegments(path);
  const name = basename(path).toLowerCase();
  return segments.some((part) => SECRET_SEGMENTS.has(part))
    || name === ".env"
    || name.startsWith(".env.")
    || name === "id_rsa"
    || name === "id_ed25519"
    || /(?:^|[-_.])(token|credentials?|secrets?)(?:[-_.]|$)/.test(name)
    || SECRET_EXTENSIONS.has(extname(name));
}

export function isGeneratedOrBinaryPath(path: string): boolean {
  const segments = pathSegments(path);
  return segments.some((part) => GENERATED_SEGMENTS.has(part))
    || BINARY_EXTENSIONS.has(extname(path).toLowerCase());
}

export function containsSecretValue(text: string): boolean {
  return /-----BEGIN [A-Z ]*PRIVATE KEY-----/i.test(text)
    || /\b(?:bearer|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*["']?[A-Za-z0-9_./+=-]{12,}/i.test(text);
}

export function redactSensitiveText(text: string): string {
  return text
    .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]")
    .replace(/(\b(?:bearer|api[_-]?key|access[_-]?token|client[_-]?secret)\s*[:=]\s*)[^\s,;]+/gi, "$1[REDACTED]");
}

export async function safeRealFile(path: string, root: string): Promise<string | undefined> {
  try {
    const [realFile, realRoot] = await Promise.all([realpath(path), realpath(root)]);
    if (!isPathInsideRoot(realFile, realRoot)) return undefined;
    if (!(await stat(realFile)).isFile()) return undefined;
    return realFile;
  } catch {
    return undefined;
  }
}
