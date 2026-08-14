import { execFile as execFileCallback } from "node:child_process";
import { constants } from "node:fs";
import { access, cp, mkdtemp, readFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import type { CodexRuntimePaths } from "./codex-runtime-discovery.js";

const execFile = promisify(execFileCallback);
const CHROME_EXTENSION_SETTINGS = "Local Extension Settings";

export interface ChromeProfileInfo {
  path: string;
  name?: string;
  email?: string;
  extensionInstalled: boolean;
  extensionInstanceId?: string;
  live: boolean;
  isDefault: boolean;
}

export interface ChromeProfileResolverOptions {
  defaultProfile: string;
  runtimePaths: () => Promise<CodexRuntimePaths>;
  env?: NodeJS.ProcessEnv;
  homeDirectory?: string;
  userDataDirectory?: string;
  extensionIds?: string[];
  readExtensionInstanceId?: (
    storagePath: string,
    runtimePaths: CodexRuntimePaths,
  ) => Promise<string | undefined>;
  launchProfile?: (
    profile: ChromeProfileInfo,
    profileDirectory: string,
    runtimePaths: CodexRuntimePaths,
  ) => Promise<void>;
}

export class ChromeProfileResolverError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "ChromeProfileResolverError";
  }
}

export class ChromeProfileResolver {
  private readonly env: NodeJS.ProcessEnv;
  private readonly homeDirectory: string;
  private cachedProfiles?: ChromeProfileInfo[];

  constructor(private readonly options: ChromeProfileResolverOptions) {
    this.env = options.env ?? process.env;
    this.homeDirectory = options.homeDirectory ?? homedir();
  }

  get defaultProfile(): string {
    return this.options.defaultProfile;
  }

  async list(liveInstanceIds: ReadonlySet<string> = new Set()): Promise<ChromeProfileInfo[]> {
    const profiles = await this.scanProfiles(liveInstanceIds);
    this.cachedProfiles = profiles.map((profile) => ({ ...profile }));
    return profiles;
  }

  async resolve(
    selector: string | undefined,
    liveInstanceIds?: ReadonlySet<string>,
  ): Promise<ChromeProfileInfo> {
    const requested = selector?.trim() || this.options.defaultProfile;
    const cached = this.cachedProfiles
      ? resolveProfileSelector(this.cachedProfiles, requested, true)
      : undefined;
    if (cached) {
      if (liveInstanceIds === undefined) return { ...cached };
      if (cached.extensionInstanceId && liveInstanceIds.has(cached.extensionInstanceId)) {
        return { ...cached, live: true };
      }
    }

    const profiles = await this.scanProfiles(liveInstanceIds ?? new Set());
    this.cachedProfiles = profiles.map((profile) => ({ ...profile }));
    const profile = resolveProfileSelector(profiles, requested, true);
    if (!profile) {
      throw new ChromeProfileResolverError(
        `Chrome profile not found: ${requested}`,
        "chrome_profile_not_found",
      );
    }
    return profile;
  }

  private async scanProfiles(
    liveInstanceIds: ReadonlySet<string>,
  ): Promise<ChromeProfileInfo[]> {
    const runtimePaths = await this.options.runtimePaths();
    const userDataDirectory = this.userDataDirectory();
    const localState = await readJson(join(userDataDirectory, "Local State"));
    const infoCache = record(record(localState.profile).info_cache);
    const extensionIds = this.options.extensionIds ?? await readChromeExtensionIds(runtimePaths);
    const profiles: ChromeProfileInfo[] = [];

    for (const [profilePath, rawProfile] of Object.entries(infoCache)) {
      const profile = record(rawProfile);
      const profileDirectory = join(userDataDirectory, profilePath);
      if (!await exists(join(profileDirectory, "Preferences"))) continue;

      const extensionId = await firstInstalledExtensionId(profileDirectory, extensionIds);
      const storagePath = extensionId
        ? join(profileDirectory, CHROME_EXTENSION_SETTINGS, extensionId)
        : undefined;
      const extensionInstanceId = storagePath
        ? await (this.options.readExtensionInstanceId ?? readExtensionInstanceId)(
            storagePath,
            runtimePaths,
          ).catch(() => undefined)
        : undefined;

      profiles.push({
        path: profilePath,
        name: stringValue(profile.name),
        email: stringValue(profile.user_name),
        extensionInstalled: extensionId !== undefined,
        extensionInstanceId,
        live: extensionInstanceId !== undefined && liveInstanceIds.has(extensionInstanceId),
        isDefault: false,
      });
    }

    const resolvedDefault = resolveProfileSelector(profiles, this.options.defaultProfile, false);
    if (resolvedDefault) resolvedDefault.isDefault = true;
    return profiles.sort(compareProfiles);
  }

  async launch(profile: ChromeProfileInfo): Promise<void> {
    const runtimePaths = await this.options.runtimePaths();
    const profileDirectory = join(this.userDataDirectory(), profile.path);
    if (this.options.launchProfile) {
      await this.options.launchProfile(profile, profileDirectory, runtimePaths);
      return;
    }

    const script = join(dirname(runtimePaths.browserClientPath), "open-chrome-window.js");
    await execFile(runtimePaths.nodeExecutable, [script, "--browser", "chrome"], {
      env: {
        ...this.env,
        CODEX_CHROMIUM_PREFERENCES_PATH: join(profileDirectory, "Preferences"),
      },
      encoding: "utf8",
      timeout: 20_000,
      maxBuffer: 4 * 1024 * 1024,
    });
  }

  private userDataDirectory(): string {
    if (this.options.userDataDirectory) return this.options.userDataDirectory;
    if (this.env.CODEX_CHROMIUM_USER_DATA_DIR?.trim()) {
      return this.env.CODEX_CHROMIUM_USER_DATA_DIR.trim();
    }
    if (process.platform === "darwin") {
      return join(this.homeDirectory, "Library", "Application Support", "Google", "Chrome");
    }
    if (process.platform === "win32") {
      const localAppData = this.env.LOCALAPPDATA;
      if (localAppData) return join(localAppData, "Google", "Chrome", "User Data");
    }
    return join(this.homeDirectory, ".config", "google-chrome");
  }
}

async function readChromeExtensionIds(runtimePaths: CodexRuntimePaths): Promise<string[]> {
  const config = await readJson(join(dirname(runtimePaths.browserClientPath), "extension-ids.json"));
  const browserExtensions = Array.isArray(config.browserExtensions)
    ? config.browserExtensions
    : [];
  for (const entry of browserExtensions) {
    const browser = record(entry);
    if (browser.browserFamily !== "chrome" || !Array.isArray(browser.extensionIds)) continue;
    return browser.extensionIds.filter((value): value is string => typeof value === "string");
  }
  return [];
}

async function firstInstalledExtensionId(
  profileDirectory: string,
  extensionIds: readonly string[],
): Promise<string | undefined> {
  for (const extensionId of extensionIds) {
    if (
      await exists(join(profileDirectory, "Extensions", extensionId))
      || await exists(join(profileDirectory, CHROME_EXTENSION_SETTINGS, extensionId))
    ) {
      return extensionId;
    }
  }
  return undefined;
}

async function readExtensionInstanceId(
  storagePath: string,
  runtimePaths: CodexRuntimePaths,
): Promise<string | undefined> {
  if (!await exists(storagePath)) return undefined;
  const copyRoot = await mkdtemp(join(tmpdir(), "devspace-chrome-profile-"));
  const copyPath = join(copyRoot, "storage");
  try {
    await cp(storagePath, copyPath, { recursive: true });
    const classicLevelPath = join(
      dirname(runtimePaths.browserClientPath),
      "node_modules",
      "classic-level",
      "index.js",
    );
    const module = await import(pathToFileURL(classicLevelPath).href) as {
      ClassicLevel?: new (
        path: string,
        options?: { valueEncoding?: string },
      ) => {
        open(): Promise<void>;
        get(key: string): Promise<string>;
        close(): Promise<void>;
      };
    };
    if (typeof module.ClassicLevel !== "function") return undefined;
    const db = new module.ClassicLevel(copyPath, { valueEncoding: "utf8" });
    try {
      await db.open();
      const raw = await db.get("extensionInstanceId");
      const parsed = JSON.parse(raw) as unknown;
      return typeof parsed === "string" && parsed.trim() ? parsed.trim() : undefined;
    } finally {
      await db.close().catch(() => undefined);
    }
  } finally {
    await rm(copyRoot, { recursive: true, force: true }).catch(() => undefined);
  }
}

function resolveProfileSelector(
  profiles: ChromeProfileInfo[],
  selector: string,
  throwOnAmbiguous: boolean,
): ChromeProfileInfo | undefined {
  const needle = selector.trim().toLocaleLowerCase();
  const matches = profiles.filter((profile) => [profile.path, profile.name, profile.email]
    .some((value) => value?.trim().toLocaleLowerCase() === needle));
  if (matches.length <= 1) return matches[0];
  if (!throwOnAmbiguous) return undefined;
  throw new ChromeProfileResolverError(
    `Chrome profile selector is ambiguous: ${selector}. Matches: ${matches
      .map((profile) => `${profile.name ?? profile.path} <${profile.email ?? profile.path}>`)
      .join(", ")}`,
    "chrome_profile_ambiguous",
  );
}

function compareProfiles(a: ChromeProfileInfo, b: ChromeProfileInfo): number {
  if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
  if (a.path === "Default" || b.path === "Default") return a.path === "Default" ? -1 : 1;
  return a.path.localeCompare(b.path, undefined, { numeric: true });
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

async function readJson(path: string): Promise<Record<string, unknown>> {
  return record(JSON.parse(await readFile(path, "utf8")));
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
