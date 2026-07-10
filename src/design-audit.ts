import { lookup } from "node:dns/promises";
import { realpath } from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import { isPathInsideRoot } from "./roots.js";
import { redactSensitiveText, safeRealFile } from "./safe-inspection.js";
import {
  buildBoundedPayload,
  measuredPayload,
  takeWithinCharacterBudget,
  type ToolMetrics,
} from "./tool-metrics.js";

export interface DesignAuditInput {
  workspaceRoot: string;
  url: string;
  desktopViewport?: { width: number; height: number };
  mobileViewport?: { width: number; height: number };
  routes?: string[];
  checks?: string[];
  outputDirectory?: string;
}

export interface DesignAuditArtifact {
  kind: "desktop-screenshot" | "mobile-screenshot" | "report";
  path: string;
}

export interface DesignAuditAdapterResult {
  artifacts: DesignAuditArtifact[];
  consoleErrors: number;
  overflowIssues: number;
  accessibilityIssues: number;
  headingIssues: number;
  diagnostics: string[];
}

export interface DesignAuditAdapter {
  readonly name: string;
  availability(): Promise<{ available: boolean; diagnostic?: string }>;
  run(input: DesignAuditInput & {
    validatedUrl: URL;
    outputDirectory: string;
    validateNavigationUrl(value: string): Promise<URL>;
  }): Promise<DesignAuditAdapterResult>;
}

export interface DesignAuditResult extends Record<string, unknown> {
  status: "disabled" | "unavailable" | "completed";
  adapter: string;
  validatedUrl?: string;
  artifacts: DesignAuditArtifact[];
  diagnostics: string[];
  consoleErrors?: number;
  overflowIssues?: number;
  accessibilityIssues?: number;
  headingIssues?: number;
  metrics: ToolMetrics;
}

export class UnavailableDesignAuditAdapter implements DesignAuditAdapter {
  readonly name = "unavailable";

  async availability(): Promise<{ available: false; diagnostic: string }> {
    return {
      available: false,
      diagnostic: "No Playwright, Chrome DevTools, Browser MCP runtime bridge, or accessibility engine is available.",
    };
  }

  async run(): Promise<DesignAuditAdapterResult> {
    throw new Error("Design audit adapter is unavailable.");
  }
}

export async function runDesignAudit(
  config: ServerConfig,
  input: DesignAuditInput,
  adapter: DesignAuditAdapter = new UnavailableDesignAuditAdapter(),
): Promise<DesignAuditResult> {
  const startedAt = performance.now();
  if (!config.designAudit) {
    return measuredPayload({
      status: "disabled" as const,
      adapter: safeAdapterName(adapter.name),
      artifacts: [],
      diagnostics: ["Design audit is disabled. Set DEVSPACE_DESIGN_AUDIT=1 to expose the adapter."],
    }, {
      startedAt,
      returnedItems: 0,
      truncated: false,
    });
  }

  const validatedUrl = await validateDesignAuditUrl(input.url, config.designAuditAllowedHosts);
  const validatedRoutes = validateRoutes(validatedUrl, input.routes);
  const outputDirectory = await validateOutputDirectory(config, input.workspaceRoot, input.outputDirectory);
  const availability = await adapter.availability();
  if (!availability.available) {
    return measuredPayload({
      status: "unavailable" as const,
      adapter: safeAdapterName(adapter.name),
      validatedUrl: safeUrlForOutput(validatedUrl),
      artifacts: [],
      diagnostics: [safeDiagnostic(availability.diagnostic ?? "Design audit adapter is unavailable.")],
    }, {
      startedAt,
      returnedItems: 0,
      truncated: false,
    });
  }

  const result = await adapter.run({
    ...input,
    routes: validatedRoutes,
    validatedUrl,
    outputDirectory,
    validateNavigationUrl: (value) => validateDesignAuditUrl(value, config.designAuditAllowedHosts),
  });
  const artifacts: DesignAuditArtifact[] = [];
  let invalidArtifacts = 0;
  for (const artifact of result.artifacts.slice(0, 50)) {
    const candidate = resolve(outputDirectory, artifact.path);
    const realFile = await safeRealFile(candidate, outputDirectory);
    if (!realFile) {
      invalidArtifacts += 1;
      continue;
    }
    artifacts.push({ kind: artifact.kind, path: realFile });
  }
  const diagnostics = [
    ...result.diagnostics.slice(0, 50).map(safeDiagnostic),
    ...(invalidArtifacts > 0 ? [`Ignored ${invalidArtifacts} artifact path(s) outside the audit output directory.`] : []),
  ];
  const counts = {
    consoleErrors: safeCount(result.consoleErrors),
    overflowIssues: safeCount(result.overflowIssues),
    accessibilityIssues: safeCount(result.accessibilityIssues),
    headingIssues: safeCount(result.headingIssues),
  };

  return buildBoundedPayload({
    startedAt,
    maxCharacters: 12_000,
    build: (contentBudget) => {
      const boundedArtifacts = takeWithinCharacterBudget(artifacts, Math.floor(contentBudget * 0.55));
      const boundedDiagnostics = takeWithinCharacterBudget(diagnostics, Math.floor(contentBudget * 0.35));
      const truncated = result.artifacts.length > 50
        || result.diagnostics.length > 50
        || invalidArtifacts > 0
        || boundedArtifacts.truncated
        || boundedDiagnostics.truncated;
      return {
        payload: {
          status: "completed" as const,
          adapter: safeAdapterName(adapter.name),
          validatedUrl: safeUrlForOutput(validatedUrl),
          artifacts: boundedArtifacts.items,
          diagnostics: boundedDiagnostics.items,
          ...counts,
        },
        returnedItems: boundedArtifacts.items.length
          + counts.consoleErrors
          + counts.overflowIssues
          + counts.accessibilityIssues
          + counts.headingIssues,
        truncated,
      };
    },
  });
}

export async function validateDesignAuditUrl(
  value: string,
  allowedHosts: string[],
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Design audit URL must be an absolute HTTP(S) URL.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Design audit URL must use http or https.");
  }
  if (url.username || url.password) {
    throw new Error("Design audit URL must not contain credentials.");
  }

  const hostname = normalizeHostname(url.hostname);
  const allowed = allowedHosts.some((entry) => {
    const normalized = entry.trim().toLowerCase();
    if (!normalized) return false;
    if (normalized.includes("://")) {
      try {
        return new URL(normalized).origin === url.origin;
      } catch {
        return false;
      }
    }
    return normalizeHostname(normalized) === hostname;
  });
  if (!allowed) throw new Error(`Design audit URL host is not allowed: ${hostname}`);
  if (hostname === "0.0.0.0" || hostname === "metadata.google.internal") {
    throw new Error(`Design audit URL host is unsafe: ${hostname}`);
  }
  if (hostname.startsWith("::ffff:")) {
    throw new Error(`Design audit URL host uses an unsafe mapped address: ${hostname}`);
  }

  const addresses = isIP(hostname)
    ? [{ address: hostname }]
    : await lookup(hostname, { all: true, verbatim: true });
  const loopbackHost = hostname === "localhost" || isLoopbackAddress(hostname);
  const unsafeResolution = addresses.length === 0 || addresses.some(({ address }) =>
    loopbackHost ? !isLoopbackAddress(address) : isPrivateOrMetadataAddress(address));
  if (unsafeResolution) {
    throw new Error(`Design audit URL resolves to a private or unsafe address: ${hostname}`);
  }
  return url;
}

async function validateOutputDirectory(
  config: ServerConfig,
  workspaceRoot: string,
  value: string | undefined,
): Promise<string> {
  if (!value) return resolve(config.stateDir, "design-audits");
  const directory = resolve(workspaceRoot, value);
  if (!isPathInsideRoot(directory, workspaceRoot)) {
    throw new Error("Design audit outputDirectory must stay inside the workspace root.");
  }
  const realWorkspaceRoot = await realpath(workspaceRoot);
  let existing = directory;
  for (;;) {
    try {
      const realExisting = await realpath(existing);
      if (!isPathInsideRoot(realExisting, realWorkspaceRoot)) {
        throw new Error("Design audit outputDirectory resolves outside the workspace root.");
      }
      break;
    } catch (error) {
      if (error instanceof Error && error.message.includes("resolves outside")) throw error;
      const parent = dirname(existing);
      if (parent === existing) throw new Error("Unable to validate design audit outputDirectory.");
      existing = parent;
    }
  }
  return directory;
}

function validateRoutes(baseUrl: URL, routes: string[] | undefined): string[] | undefined {
  if (!routes) return undefined;
  return routes.slice(0, 20).map((route) => {
    let resolved: URL;
    try {
      resolved = new URL(route, baseUrl);
    } catch {
      throw new Error(`Invalid design audit route: ${route}`);
    }
    if (resolved.origin !== baseUrl.origin || resolved.username || resolved.password) {
      throw new Error(`Design audit route must stay on the validated origin: ${route}`);
    }
    return `${resolved.pathname}${resolved.search}`;
  });
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}

function isPrivateOrMetadataAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  const mapped = mappedIpv4(normalized);
  const ipv4 = mapped ?? normalized;
  const parts = ipv4.split(".").map(Number);
  if (parts.length === 4 && parts.every((part) => Number.isInteger(part) && part >= 0 && part <= 255)) {
    const [a, b, c] = parts as [number, number, number, number];
    return a === 0
      || a === 10
      || a === 127
      || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 0 && c === 0)
      || (a === 192 && b === 0 && c === 2)
      || (a === 192 && b === 88 && c === 99)
      || (a === 192 && b === 168)
      || (a === 198 && (b === 18 || b === 19))
      || (a === 198 && b === 51 && c === 100)
      || (a === 203 && b === 0 && c === 113);
  }

  if (isIP(normalized) === 6) {
    if (normalized === "::" || normalized === "::1") return true;
    if (/^fe[89a-f]/.test(normalized) || /^(?:fc|fd|ff)/.test(normalized)) return true;
    if (normalized.startsWith("2001:db8:")) return true;
    return !/^[23][0-9a-f]{0,3}:/.test(normalized);
  }

  return true;
}

function isLoopbackAddress(address: string): boolean {
  const normalized = normalizeHostname(address);
  if (normalized === "::1") return true;
  const ipv4 = mappedIpv4(normalized) ?? normalized;
  if (!/^\d+\.\d+\.\d+\.\d+$/.test(ipv4)) return false;
  return Number(ipv4.split(".")[0]) === 127;
}

function mappedIpv4(address: string): string | undefined {
  const dotted = address.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (dotted) return dotted;
  const hexadecimal = address.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/i);
  if (!hexadecimal) return undefined;
  const high = Number.parseInt(hexadecimal[1]!, 16);
  const low = Number.parseInt(hexadecimal[2]!, 16);
  return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
}

function safeAdapterName(name: string): string {
  return redactSensitiveText(String(name)).slice(0, 100);
}

function safeDiagnostic(value: string): string {
  return redactSensitiveText(String(value)).replace(/\s+/g, " ").trim().slice(0, 500);
}

function safeCount(value: number): number {
  return Number.isFinite(value) ? Math.max(0, Math.min(1_000_000, Math.floor(value))) : 0;
}

function safeUrlForOutput(url: URL): string {
  return `${url.origin}${url.pathname}`;
}
