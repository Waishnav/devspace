import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import * as z from "zod/v4";
import type { ServerConfig } from "./config.js";

const localAgentProviderSchema = z.enum([
  "codex",
  "claude",
  "opencode",
  "pi",
  "cursor",
  "copilot",
  "grok",
]);

export type LocalAgentProvider = z.output<typeof localAgentProviderSchema>;

export const LOCAL_AGENT_PROVIDERS: readonly LocalAgentProvider[] = localAgentProviderSchema.options;

export interface LocalAgentProfile {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
  filePath: string;
  body: string;
  disabled: boolean;
}

export interface LocalAgentProfileSummary {
  name: string;
  description: string;
  provider: LocalAgentProvider;
  model?: string;
  effort?: string;
}

interface ParsedFrontmatter {
  frontmatter: ProfileFrontmatter;
  body: string;
}

const FRONTMATTER_DELIMITER = "---";

const optionalProfileStringSchema = z.string()
  .trim()
  .transform((value) => value || undefined)
  .optional();

const profileFrontmatterSchema = z.object({
  name: optionalProfileStringSchema,
  description: optionalProfileStringSchema,
  provider: optionalProfileStringSchema,
  model: optionalProfileStringSchema,
  effort: optionalProfileStringSchema,
  disabled: z.boolean().default(false),
}).strip();

type ProfileFrontmatter = z.output<typeof profileFrontmatterSchema>;

export async function loadLocalAgentProfiles(
  config: ServerConfig,
  workspaceRoot: string,
  options: { includeDisabled?: boolean } = {},
): Promise<LocalAgentProfile[]> {
  if (!config.subagents.enabled) return [];

  const profileDirs = [
    config.devspaceAgentsDir,
    join(workspaceRoot, ".devspace", "agents"),
  ];

  const profilesByName = new Map<string, LocalAgentProfile>();

  for (const directory of profileDirs) {
    for (const profile of await loadProfilesFromDirectory(directory)) {
      profilesByName.set(profile.name, profile);
    }
  }

  return Array.from(profilesByName.values())
    .filter((profile) => options.includeDisabled || !profile.disabled)
    .sort((a, b) => a.name.localeCompare(b.name));
}

async function loadProfilesFromDirectory(directory: string): Promise<LocalAgentProfile[]> {
  const resolvedDirectory = resolve(directory);

  if (!existsSync(resolvedDirectory)) return [];

  const entries = await readdir(resolvedDirectory, { withFileTypes: true });
  const profiles: LocalAgentProfile[] = [];

  for (const entry of entries) {
    if (!entry.isFile()) continue;

    if (!entry.name.endsWith(".md")) continue;

    const filePath = join(resolvedDirectory, entry.name);

    try {
      profiles.push(await loadProfileFile(filePath));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      console.warn(`Skipping invalid subagent profile ${filePath}: ${message}`);
    }
  }

  return profiles;
}

async function loadProfileFile(filePath: string): Promise<LocalAgentProfile> {
  const content = await readFile(filePath, "utf8");
  const parsed = parseFrontmatter(content, filePath);

  return profileFromFrontmatter(parsed.frontmatter, parsed.body, filePath);
}

function parseFrontmatter(content: string, filePath: string): ParsedFrontmatter {
  const normalized = content.replace(/^\uFEFF/, "");
  const lines = normalized.split(/\r?\n/);

  if (lines[0]?.trim() !== FRONTMATTER_DELIMITER) {
    throw new Error(`Subagent profile is missing frontmatter: ${filePath}`);
  }

  const endIndex = lines.findIndex(
    (line, index) => index > 0 && line.trim() === FRONTMATTER_DELIMITER,
  );

  if (endIndex === -1) {
    throw new Error(`Subagent profile frontmatter is not closed: ${filePath}`);
  }

  return {
    frontmatter: parseProfileYaml(lines.slice(1, endIndex).join("\n"), filePath),
    body: lines.slice(endIndex + 1).join("\n").trim(),
  };
}

function parseProfileYaml(source: string, filePath: string): ProfileFrontmatter {
  const parsedYaml = (() => {
    try {
      return parseYaml(source) ?? {};
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      throw new Error(`Unable to parse subagent profile frontmatter: ${filePath}: ${message}`);
    }
  })();

  const parsed = profileFrontmatterSchema.safeParse(parsedYaml);

  if (!parsed.success) throw new Error(`Subagent profile frontmatter must be a mapping: ${filePath}`);

  return parsed.data;
}

function profileFromFrontmatter(
  frontmatter: ProfileFrontmatter,
  body: string,
  filePath: string,
): LocalAgentProfile {
  const name = frontmatter.name ?? basename(filePath, ".md");
  const description = frontmatter.description;
  const provider = readProvider(frontmatter.provider, filePath);

  if (!description) {
    throw new Error(`Subagent profile is missing description: ${filePath}`);
  }

  return {
    name,
    description,
    provider,
    model: frontmatter.model,
    effort: frontmatter.effort,
    filePath,
    body,
    disabled: frontmatter.disabled,
  };
}

function readProvider(
  provider: ProfileFrontmatter["provider"],
  filePath: string,
): LocalAgentProvider {
  if (!provider) {
    throw new Error(`Subagent profile is missing provider: ${filePath}`);
  }

  const parsed = localAgentProviderSchema.safeParse(provider);

  if (!parsed.success) {
    throw new Error(
      `Subagent profile provider must be codex, claude, opencode, pi, cursor, copilot, or grok: ${filePath}`,
    );
  }

  return parsed.data;
}

export function isLocalAgentProvider(value: string): value is LocalAgentProvider {
  return localAgentProviderSchema.safeParse(value).success;
}
