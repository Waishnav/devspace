import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const SCREENSHOT_TIMEOUT_MS = 20_000;
const ACTION_TIMEOUT_MS = 15_000;
const MAX_HELPER_OUTPUT_BYTES = 2 * 1024 * 1024;
const MAX_TYPED_TEXT_BYTES = 64 * 1024;
const COMPUTER_USE_PLATFORMS = new Set<NodeJS.Platform>(["darwin"]);
const helperBuilds = new Map<string, Promise<string>>();

export class ComputerUseError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "ComputerUseError";
  }
}

export interface ComputerUsePermissions {
  screenCapture: boolean;
  accessibility: boolean;
}

export interface ComputerDisplay {
  index: number;
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  pixelWidth: number;
  pixelHeight: number;
  scale: number;
  main: boolean;
}

export interface ScreenCaptureResult {
  display: ComputerDisplay;
  includeCursor: boolean;
  name: string;
  mimeType: "image/png";
  size: number;
  sha256: string;
  width: number;
  height: number;
  data: string;
}

export type ComputerActionName =
  | "move"
  | "click"
  | "double_click"
  | "right_click"
  | "drag"
  | "scroll"
  | "key"
  | "type_text"
  | "activate_app"
  | "wait"
  | "request_permissions";

export interface ComputerActionInput {
  action: ComputerActionName;
  display?: number;
  x?: number;
  y?: number;
  endX?: number;
  endY?: number;
  button?: "left" | "right" | "center";
  deltaX?: number;
  deltaY?: number;
  durationMs?: number;
  key?: string;
  modifiers?: Array<"command" | "control" | "option" | "shift" | "function">;
  text?: string;
  app?: string;
}

export interface ComputerActionResult {
  action: ComputerActionName;
  display?: ComputerDisplay;
  cursor?: { x: number; y: number };
  permissions: ComputerUsePermissions;
}

export function isComputerUseSupportedPlatform(
  platform: NodeJS.Platform = process.platform,
): boolean {
  return COMPUTER_USE_PLATFORMS.has(platform);
}

export async function getComputerUsePermissions(
  stateDir: string,
): Promise<ComputerUsePermissions> {
  return runHelperJson<ComputerUsePermissions>(stateDir, ["permissions"]);
}

export async function getComputerDisplays(
  stateDir: string,
): Promise<ComputerDisplay[]> {
  const displays = await runHelperJson<ComputerDisplay[]>(stateDir, ["displays"]);
  if (!Array.isArray(displays) || displays.length < 1) {
    throw new ComputerUseError("computer_display_unavailable", "No active display is available.");
  }
  return displays;
}

export async function captureComputerScreen({
  stateDir,
  maxFileBytes,
  display = 1,
  includeCursor = true,
}: {
  stateDir: string;
  maxFileBytes: number;
  display?: number;
  includeCursor?: boolean;
}): Promise<ScreenCaptureResult> {
  assertComputerUseSupported();
  if (!Number.isSafeInteger(maxFileBytes) || maxFileBytes < 1) {
    throw new ComputerUseError(
      "computer_capture_limit_invalid",
      "Screen capture size limit must be a positive integer.",
    );
  }

  const permissions = await getComputerUsePermissions(stateDir);
  if (!permissions.screenCapture) {
    throw new ComputerUseError(
      "computer_screen_permission_required",
      "Screen Recording permission is required for the DevSpace process.",
    );
  }

  const selected = selectDisplay(await getComputerDisplays(stateDir), display);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), "devspace-screen-"));
  const outputPath = join(temporaryDirectory, `display-${selected.index}.png`);
  try {
    const captureArguments = [
      "-x",
      "-t",
      "png",
      "-D",
      String(selected.index),
      ...(includeCursor ? ["-C"] : []),
      outputPath,
    ];
    await executeFile("/usr/sbin/screencapture", captureArguments, SCREENSHOT_TIMEOUT_MS);

    const logicalWidth = Math.max(1, Math.round(selected.width));
    const logicalHeight = Math.max(1, Math.round(selected.height));
    await executeFile(
      "/usr/bin/sips",
      ["--resampleHeightWidth", String(logicalHeight), String(logicalWidth), outputPath],
      SCREENSHOT_TIMEOUT_MS,
    );

    const bytes = await readFile(outputPath);
    if (bytes.length < 24 || !isPng(bytes)) {
      throw new ComputerUseError(
        "computer_capture_invalid",
        "Screen capture did not produce a valid PNG image.",
      );
    }
    if (bytes.length > maxFileBytes) {
      throw new ComputerUseError(
        "computer_capture_too_large",
        "Screen capture exceeds the configured file-size limit.",
      );
    }
    const dimensions = pngDimensions(bytes);
    return {
      display: selected,
      includeCursor,
      name: `display-${selected.index}-${randomUUID()}.png`,
      mimeType: "image/png",
      size: bytes.length,
      sha256: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
      width: dimensions.width,
      height: dimensions.height,
      data: bytes.toString("base64"),
    };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function performComputerAction(
  stateDir: string,
  input: ComputerActionInput,
): Promise<ComputerActionResult> {
  assertComputerUseSupported();
  const action = input.action;
  let displays: ComputerDisplay[] | undefined;
  let selected: ComputerDisplay | undefined;

  if (action === "request_permissions") {
    const permissions = await runHelperJson<ComputerUsePermissions>(stateDir, ["request-permissions"]);
    return { action, permissions };
  }

  if (action === "wait") {
    await delay(clampInteger(input.durationMs ?? 500, 0, 30_000, "durationMs"));
    return {
      action,
      permissions: await getComputerUsePermissions(stateDir),
    };
  }

  const permissions = await getComputerUsePermissions(stateDir);
  if (requiresAccessibility(action) && !permissions.accessibility) {
    throw new ComputerUseError(
      "computer_accessibility_permission_required",
      "Accessibility permission is required for mouse and keyboard control by the DevSpace process.",
    );
  }

  const helperArguments: string[] = [];
  switch (action) {
    case "move": {
      displays = await getComputerDisplays(stateDir);
      selected = selectDisplay(displays, input.display ?? 1);
      const point = displayPoint(selected, requiredNumber(input.x, "x"), requiredNumber(input.y, "y"));
      helperArguments.push("move", String(point.x), String(point.y));
      break;
    }
    case "click":
    case "double_click":
    case "right_click": {
      displays = await getComputerDisplays(stateDir);
      selected = selectDisplay(displays, input.display ?? 1);
      const point = displayPoint(selected, requiredNumber(input.x, "x"), requiredNumber(input.y, "y"));
      const button = action === "right_click" ? "right" : (input.button ?? "left");
      const count = action === "double_click" ? 2 : 1;
      helperArguments.push("click", String(point.x), String(point.y), button, String(count));
      break;
    }
    case "drag": {
      displays = await getComputerDisplays(stateDir);
      selected = selectDisplay(displays, input.display ?? 1);
      const start = displayPoint(selected, requiredNumber(input.x, "x"), requiredNumber(input.y, "y"));
      const end = displayPoint(
        selected,
        requiredNumber(input.endX, "endX"),
        requiredNumber(input.endY, "endY"),
      );
      helperArguments.push(
        "drag",
        String(start.x),
        String(start.y),
        String(end.x),
        String(end.y),
        String(clampInteger(input.durationMs ?? 500, 50, 10_000, "durationMs")),
        input.button ?? "left",
      );
      break;
    }
    case "scroll": {
      displays = await getComputerDisplays(stateDir);
      selected = selectDisplay(displays, input.display ?? 1);
      if (input.x !== undefined || input.y !== undefined) {
        const point = displayPoint(
          selected,
          requiredNumber(input.x, "x"),
          requiredNumber(input.y, "y"),
        );
        await runHelper(stateDir, ["move", String(point.x), String(point.y)]);
      }
      helperArguments.push(
        "scroll",
        String(clampInteger(input.deltaX ?? 0, -100_000, 100_000, "deltaX")),
        String(clampInteger(input.deltaY ?? 0, -100_000, 100_000, "deltaY")),
      );
      break;
    }
    case "key": {
      const key = input.key?.trim().toLowerCase();
      if (!key) throw new ComputerUseError("computer_key_required", "A key name is required.");
      const keyCode = KEY_CODES.get(key);
      if (keyCode === undefined) {
        throw new ComputerUseError("computer_key_unsupported", `Unsupported key name: ${key}`);
      }
      const modifiers = normalizeModifiers(input.modifiers).join(",");
      helperArguments.push("key", String(keyCode), modifiers);
      break;
    }
    case "type_text": {
      const text = input.text;
      if (typeof text !== "string") {
        throw new ComputerUseError("computer_text_required", "Text is required for type_text.");
      }
      const bytes = Buffer.from(text, "utf8");
      if (bytes.length > MAX_TYPED_TEXT_BYTES) {
        throw new ComputerUseError(
          "computer_text_too_large",
          `Typed text must not exceed ${MAX_TYPED_TEXT_BYTES} UTF-8 bytes.`,
        );
      }
      helperArguments.push("type", bytes.toString("base64"));
      break;
    }
    case "activate_app": {
      const app = input.app?.trim();
      if (!app || app.length > 256 || app.includes("\u0000")) {
        throw new ComputerUseError(
          "computer_application_invalid",
          "A valid application name or bundle identifier is required.",
        );
      }
      helperArguments.push("activate", app);
      break;
    }
    default:
      throw new ComputerUseError("computer_action_unsupported", `Unsupported action: ${action}`);
  }

  await runHelper(stateDir, helperArguments);
  const cursor = await runHelperJson<{ x: number; y: number }>(stateDir, ["position"])
    .catch(() => undefined);
  return {
    action,
    display: selected,
    cursor,
    permissions,
  };
}

function assertComputerUseSupported(): void {
  if (!isComputerUseSupportedPlatform()) {
    throw new ComputerUseError(
      "computer_platform_unsupported",
      "Desktop computer use is currently supported on macOS only.",
    );
  }
}

function requiresAccessibility(action: ComputerActionName): boolean {
  return !["activate_app", "wait", "request_permissions"].includes(action);
}

function selectDisplay(displays: ComputerDisplay[], index: number): ComputerDisplay {
  if (!Number.isInteger(index) || index < 1) {
    throw new ComputerUseError("computer_display_invalid", "Display index must be a positive integer.");
  }
  const display = displays.find((candidate) => candidate.index === index);
  if (!display) {
    throw new ComputerUseError(
      "computer_display_unavailable",
      `Display ${index} is not active.`,
    );
  }
  return display;
}

function displayPoint(display: ComputerDisplay, x: number, y: number): { x: number; y: number } {
  if (x < 0 || y < 0 || x >= display.width || y >= display.height) {
    throw new ComputerUseError(
      "computer_coordinate_out_of_bounds",
      `Point (${x}, ${y}) is outside display ${display.index} bounds ${display.width}x${display.height}.`,
    );
  }
  return {
    x: display.x + x,
    y: display.y + y,
  };
}

function requiredNumber(value: number | undefined, name: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new ComputerUseError("computer_action_input_invalid", `${name} must be a finite number.`);
  }
  return value;
}

function clampInteger(value: number, min: number, max: number, name: string): number {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new ComputerUseError(
      "computer_action_input_invalid",
      `${name} must be an integer from ${min} through ${max}.`,
    );
  }
  return value;
}

function normalizeModifiers(
  modifiers: ComputerActionInput["modifiers"],
): Array<"command" | "control" | "option" | "shift" | "function"> {
  const unique = new Set(modifiers ?? []);
  return ["command", "control", "option", "shift", "function"].filter(
    (modifier): modifier is "command" | "control" | "option" | "shift" | "function" =>
      unique.has(modifier as "command" | "control" | "option" | "shift" | "function"),
  );
}

async function runHelperJson<T>(stateDir: string, args: string[]): Promise<T> {
  const output = await runHelper(stateDir, args);
  try {
    return JSON.parse(output) as T;
  } catch {
    throw new ComputerUseError(
      "computer_helper_invalid_output",
      "The macOS computer-use helper returned invalid JSON.",
    );
  }
}

async function runHelper(stateDir: string, args: string[]): Promise<string> {
  const helper = await ensureComputerUseHelper(stateDir);
  return executeFile(helper, args, ACTION_TIMEOUT_MS);
}

async function ensureComputerUseHelper(stateDir: string): Promise<string> {
  assertComputerUseSupported();
  const helperDirectory = join(stateDir, "computer-use");
  const helperPath = join(helperDirectory, "macos-helper");
  const existing = helperBuilds.get(helperPath);
  if (existing) return existing;

  const build = (async () => {
    await mkdir(helperDirectory, { recursive: true, mode: 0o700 });
    const sourcePath = fileURLToPath(new URL("../scripts/macos-computer-use.swift", import.meta.url));
    const source = await readFile(sourcePath);
    const sourceHash = createHash("sha256").update(source).digest("hex");
    const hashPath = `${helperPath}.sha256`;
    const currentHash = await readFile(hashPath, "utf8").catch(() => undefined);
    const helperStats = await stat(helperPath).catch(() => undefined);
    if (helperStats?.isFile() && currentHash?.trim() === sourceHash) {
      return helperPath;
    }

    const temporaryPath = join(helperDirectory, `.macos-helper-${randomUUID()}`);
    try {
      await executeFile(
        "/usr/bin/swiftc",
        ["-O", sourcePath, "-o", temporaryPath],
        120_000,
      );
      await chmod(temporaryPath, 0o700);
      await rename(temporaryPath, helperPath);
      await writeFile(hashPath, `${sourceHash}\n`, { mode: 0o600 });
      return helperPath;
    } finally {
      await rm(temporaryPath, { force: true }).catch(() => undefined);
    }
  })();

  helperBuilds.set(helperPath, build);
  try {
    return await build;
  } catch (error) {
    helperBuilds.delete(helperPath);
    throw error;
  }
}

async function executeFile(
  executable: string,
  args: string[],
  timeout: number,
): Promise<string> {
  try {
    const { stdout } = await execFileAsync(executable, args, {
      encoding: "utf8",
      timeout,
      maxBuffer: MAX_HELPER_OUTPUT_BYTES,
      windowsHide: true,
    });
    return stdout.trim();
  } catch (error) {
    const detail = commandErrorDetail(error);
    throw new ComputerUseError(
      "computer_command_failed",
      `${basename(executable)} failed${detail ? `: ${detail}` : "."}`,
    );
  }
}

function commandErrorDetail(error: unknown): string | undefined {
  if (!(error instanceof Error)) return undefined;
  const stderr = "stderr" in error ? (error as { stderr?: unknown }).stderr : undefined;
  if (typeof stderr === "string" && stderr.trim()) return stderr.trim().slice(0, 500);
  return error.message.slice(0, 500);
}

function isPng(bytes: Buffer): boolean {
  return bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
}

function pngDimensions(bytes: Buffer): { width: number; height: number } {
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const KEY_CODES = new Map<string, number>([
  ["a", 0], ["s", 1], ["d", 2], ["f", 3], ["h", 4], ["g", 5],
  ["z", 6], ["x", 7], ["c", 8], ["v", 9], ["b", 11], ["q", 12],
  ["w", 13], ["e", 14], ["r", 15], ["y", 16], ["t", 17], ["1", 18],
  ["2", 19], ["3", 20], ["4", 21], ["6", 22], ["5", 23], ["=", 24],
  ["9", 25], ["7", 26], ["-", 27], ["8", 28], ["0", 29], ["]", 30],
  ["o", 31], ["u", 32], ["[", 33], ["i", 34], ["p", 35], ["return", 36],
  ["enter", 36], ["l", 37], ["j", 38], ["'", 39], ["k", 40], [";", 41],
  ["\\", 42], [",", 43], ["/", 44], ["n", 45], ["m", 46], [".", 47],
  ["tab", 48], ["space", 49], ["`", 50], ["backspace", 51], ["delete", 51],
  ["escape", 53], ["esc", 53], ["f1", 122], ["f2", 120], ["f3", 99],
  ["f4", 118], ["f5", 96], ["f6", 97], ["f7", 98], ["f8", 100],
  ["f9", 101], ["f10", 109], ["f11", 103], ["f12", 111], ["home", 115],
  ["pageup", 116], ["forwarddelete", 117], ["end", 119], ["pagedown", 121],
  ["left", 123], ["right", 124], ["down", 125], ["up", 126],
]);
