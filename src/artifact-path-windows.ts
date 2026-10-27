import { win32 } from "node:path";

function hasAsciiControlCharacters(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);

    if (code <= 0x1f || code === 0x7f) return true;
  }

  return false;
}

const WINDOWS_INVALID_NAME_CHARS = /[<>"|?*]/u;
const WINDOWS_DEVICE_NAME = /^(?:CON|PRN|AUX|NUL|CLOCK\$|CONIN\$|CONOUT\$|COM[1-9¹²³]|LPT[1-9¹²³])$/iu;

export interface SafeWindowsArtifactPath {
  path: string;
  parts: string[];
  name: string;
}

export function parseSafeWindowsArtifactRelativePath(
  value: string,
): SafeWindowsArtifactPath | undefined {
  if (
    !value
    || hasAsciiControlCharacters(value)
    || /^[\\/]/u.test(value)
    || /^[A-Za-z]:/u.test(value)
    || win32.isAbsolute(value)
    || value.endsWith("\\")
    || value.endsWith("/")
    || value.includes(":")
  ) return undefined;

  const rawParts = value.split(/[\\/]+/u);

  if (rawParts.includes("..") || rawParts.at(-1) === ".") return undefined;
  const parts = rawParts.filter((part) => part !== "" && part !== ".");

  if (parts.length === 0 || parts.some(isUnsafeWindowsPathPart)) return undefined;
  const name = parts.at(-1);

  if (!name) return undefined;

  return { path: parts.join("/"), parts, name };
}

function isUnsafeWindowsPathPart(part: string): boolean {
  if (!part || part === "." || part === "..") return true;

  if (part.endsWith(".") || part.endsWith(" ")) return true;

  if (WINDOWS_INVALID_NAME_CHARS.test(part)) return true;
  const deviceBase = (part.split(".", 1)[0] ?? part).trimEnd();

  return WINDOWS_DEVICE_NAME.test(deviceBase);
}
