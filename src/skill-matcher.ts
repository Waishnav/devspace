import { open, realpath, type FileHandle } from "node:fs/promises";
import { parse as parseYaml } from "yaml";
import type { Skill } from "@earendil-works/pi-coding-agent";
import { formatPathForPrompt } from "./skills.js";
import { isPathInsideRoot } from "./roots.js";
import { containsSecretValue, isSecretLikePath, safeRealFile } from "./safe-inspection.js";
import {
  buildBoundedPayload,
  clampInteger,
  takeWithinCharacterBudget,
  type ToolMetrics,
} from "./tool-metrics.js";

export interface SkillMatch {
  name: string;
  shortDescription: string;
  path: string;
  matchReason: string;
  confidence: number;
  requiredTools?: string[];
}

export interface SkillMatchResult extends Record<string, unknown> {
  matches: SkillMatch[];
  metrics: ToolMetrics;
}

interface IndexedSkill {
  match: Omit<SkillMatch, "matchReason" | "confidence">;
  normalizedName: string;
  nameTokens: Set<string>;
  descriptionTokens: Set<string>;
  triggers: string[];
  triggerTokens: Set<string>;
  global: boolean;
}

const FRONTMATTER_BYTES = 16 * 1024;
const DEFAULT_LIMIT = 3;
const MAX_LIMIT = 10;
const MATCH_PAYLOAD_CHARACTERS = 8_000;
const metadataCache = new WeakMap<Skill[], Promise<IndexedSkill[]>>();
const STOP_WORDS = new Set([
  "and", "for", "from", "into", "the", "this", "that", "use", "with",
  "your", "task", "work", "using", "when", "where", "what", "how",
]);

export async function matchWorkspaceSkills(input: {
  skills: Skill[];
  workspaceRoot: string;
  task: string;
  limit?: number;
  includeGlobal?: boolean;
}): Promise<SkillMatchResult> {
  const startedAt = performance.now();
  const cacheHit = metadataCache.has(input.skills);
  let indexPromise = metadataCache.get(input.skills);
  if (!indexPromise) {
    indexPromise = buildSkillIndex(input.skills, input.workspaceRoot);
    metadataCache.set(input.skills, indexPromise);
  }

  const index = await indexPromise;
  const limit = clampInteger(input.limit, DEFAULT_LIMIT, 1, MAX_LIMIT);
  const task = normalize(input.task).slice(0, 2_000);
  const taskTokens = tokens(task);
  const candidates = index
    .filter((skill) => input.includeGlobal === true || !skill.global)
    .map((skill) => scoreSkill(skill, task, taskTokens))
    .filter((candidate): candidate is SkillMatch => candidate !== undefined)
    .sort((a, b) => b.confidence - a.confidence || a.name.localeCompare(b.name));
  const limited = candidates.slice(0, limit);

  return buildBoundedPayload({
    startedAt,
    maxCharacters: MATCH_PAYLOAD_CHARACTERS,
    cacheHit,
    build: (contentBudget) => {
      const bounded = takeWithinCharacterBudget(limited, contentBudget);
      return {
        payload: { matches: bounded.items },
        returnedItems: bounded.items.length,
        truncated: candidates.length > limited.length || bounded.truncated,
      };
    },
  });
}

async function buildSkillIndex(skills: Skill[], workspaceRoot: string): Promise<IndexedSkill[]> {
  let realWorkspaceRoot: string;
  try {
    realWorkspaceRoot = await realpath(workspaceRoot);
  } catch {
    return [];
  }

  const indexed = await Promise.all(skills.map(async (skill): Promise<IndexedSkill | undefined> => {
    if (skill.disableModelInvocation || isSecretLikePath(skill.filePath)) return undefined;
    const realFile = await safeRealFile(skill.filePath, skill.baseDir);
    if (!realFile) return undefined;

    const frontmatter = await readBoundedFrontmatter(realFile);
    const shortDescription = readShortDescription(frontmatter) ?? skill.description.trim();
    const triggers = readStringList(
      frontmatter,
      ["triggers", "__body-triggers"],
      12,
      120,
    );
    const requiredTools = readStringList(
      frontmatter,
      ["required-tools", "requiredTools", "__body-required-tools"],
      12,
      64,
    ).filter((tool) => /^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(tool));

    if (!shortDescription || containsSecretValue(shortDescription) || triggers.some(containsSecretValue)) {
      return undefined;
    }

    const normalizedName = normalize(skill.name.replaceAll("-", " "));
    return {
      match: {
        name: skill.name.slice(0, 100),
        shortDescription: shortDescription.slice(0, 240),
        path: formatPathForPrompt(skill.filePath),
        ...(requiredTools.length > 0 ? { requiredTools } : {}),
      },
      normalizedName,
      nameTokens: tokens(normalizedName),
      descriptionTokens: tokens(shortDescription),
      triggers: triggers.map(normalize),
      triggerTokens: tokens(triggers.join(" ")),
      global: !isPathInsideRoot(realFile, realWorkspaceRoot),
    };
  }));

  return indexed.filter((skill): skill is IndexedSkill => skill !== undefined);
}

function scoreSkill(
  skill: IndexedSkill,
  task: string,
  taskTokens: Set<string>,
): SkillMatch | undefined {
  const matchedFields: string[] = [];
  let score = 0;

  const triggerPhrase = skill.triggers.find((trigger) =>
    trigger.length >= 3 && (task.includes(trigger) || trigger.includes(task))
  );
  if (triggerPhrase) {
    score += 0.62;
    matchedFields.push("trigger");
  }

  if (skill.normalizedName.length >= 3 && task.includes(skill.normalizedName)) {
    score += 0.55;
    matchedFields.push("name");
  }

  const nameOverlap = overlap(taskTokens, skill.nameTokens);
  if (nameOverlap > 0) {
    score += Math.min(0.38, nameOverlap * 0.19);
    if (!matchedFields.includes("name")) matchedFields.push("name");
  }

  const triggerOverlap = overlap(taskTokens, skill.triggerTokens);
  if (triggerOverlap > 0) {
    score += Math.min(0.34, triggerOverlap * 0.17);
    if (!matchedFields.includes("trigger")) matchedFields.push("trigger");
  }

  const descriptionOverlap = overlap(taskTokens, skill.descriptionTokens);
  if (descriptionOverlap > 0) {
    score += Math.min(0.3, descriptionOverlap * 0.1);
    matchedFields.push("description");
  }

  if (score < 0.2) return undefined;
  const confidence = Math.min(0.99, Math.round(score * 100) / 100);
  return {
    ...skill.match,
    matchReason: `Matched ${Array.from(new Set(matchedFields)).join(" + ")}.`,
    confidence,
  };
}

function overlap(left: Set<string>, right: Set<string>): number {
  let count = 0;
  for (const token of left) {
    if (right.has(token)) count += 1;
  }
  return count;
}

function normalize(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/\s+/g, " ").trim();
}

function tokens(value: string): Set<string> {
  const output = new Set<string>();
  const normalized = normalize(value);
  const segmenter = new Intl.Segmenter(undefined, { granularity: "word" });
  for (const segment of segmenter.segment(normalized)) {
    if (!segment.isWordLike) continue;
    const token = segment.segment.trim();
    if (token.length < 2 || STOP_WORDS.has(token)) continue;
    output.add(token);
  }
  return output;
}

async function readBoundedFrontmatter(path: string): Promise<Record<string, unknown>> {
  let handle: FileHandle | undefined;
  try {
    handle = await open(path, "r");
    const buffer = Buffer.alloc(FRONTMATTER_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    const source = buffer.subarray(0, bytesRead).toString("utf8").replace(/^\uFEFF/, "");
    const lines = source.split(/\r?\n/);
    if (lines[0]?.trim() !== "---") return {};
    const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
    if (end === -1) return {};
    const parsed = parseYaml(lines.slice(1, end).join("\n"));
    const frontmatter = parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : {};
    const bodyLines = lines.slice(end + 1);
    return {
      ...frontmatter,
      "__body-triggers": readMarkdownList(bodyLines, "Triggers"),
      "__body-required-tools": readMarkdownList(bodyLines, "Required tools")
        .map((value) => value.replace(/^`|`$/g, "")),
    };
  } catch {
    return {};
  } finally {
    await handle?.close();
  }
}

function readMarkdownList(lines: string[], heading: string): string[] {
  const start = lines.findIndex((line) => line.trim().toLowerCase() === `## ${heading.toLowerCase()}`);
  if (start === -1) return [];
  const values: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s+/.test(line.trim())) break;
    const match = line.match(/^\s*[-*]\s+(.+?)\s*$/);
    if (match?.[1]) values.push(match[1]);
  }
  return values;
}

function readShortDescription(frontmatter: Record<string, unknown>): string | undefined {
  for (const key of ["short-description", "shortDescription"]) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return undefined;
}

function readStringList(
  frontmatter: Record<string, unknown>,
  keys: string[],
  maxItems: number,
  maxCharacters: number,
): string[] {
  const value = keys.map((key) => frontmatter[key]).find((candidate) => candidate !== undefined);
  const values = typeof value === "string" ? [value] : Array.isArray(value) ? value : [];
  return values
    .filter((entry): entry is string => typeof entry === "string")
    .map((entry) => entry.trim().slice(0, maxCharacters))
    .filter(Boolean)
    .slice(0, maxItems);
}
