import { pathToFileURL } from "node:url";
import {
  ChromeProfileResolver,
  ChromeProfileResolverError,
  type ChromeProfileInfo,
} from "./chrome-profiles.js";
import type { CodexMcpClient, CodexMcpToolResult } from "./codex-mcp-client.js";
import {
  codexConversationKey,
  codexTurnMetadataForChromeUse,
  type CodexExecutionContext,
} from "./codex-request-context.js";
import type { CodexRuntimeHost } from "./codex-runtime-host.js";

const MAX_DOM_CHARACTERS = 200_000;
const MAX_ACTION_TIMEOUT_MS = 120_000;
const DEFAULT_WORKER_COUNT = 4;
const PROFILE_START_TIMEOUT_MS = 12_000;
const PROFILE_START_POLL_MS = 400;
const MAX_STICKY_CONVERSATIONS = 1024;
const INSTANCE_NOT_LIVE_MARKER = "DEVSPACE_CHROME_INSTANCE_NOT_LIVE:";

export type CodexChromeUseAction =
  | "status"
  | "list_profiles"
  | "list_tabs"
  | "list_user_tabs"
  | "new_tab"
  | "claim_tab"
  | "goto"
  | "snapshot"
  | "screenshot"
  | "click"
  | "fill"
  | "type"
  | "press"
  | "reload"
  | "wait"
  | "close";

export type CodexChromeObservation = "none" | "dom" | "screenshot" | "both";

export interface CodexChromeUseInput {
  action: CodexChromeUseAction;
  profile?: string;
  tabId?: string;
  userTabId?: string;
  url?: string;
  selector?: string;
  text?: string;
  key?: string;
  timeoutMs?: number;
  fullPage?: boolean;
  observe?: CodexChromeObservation;
}

export interface CodexChromeUseAdapterOptions {
  defaultProfile?: string;
  workerCount?: number;
  profileResolver?: ChromeProfileResolver;
}

export class CodexChromeUseAdapterError extends Error {
  constructor(
    message: string,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "CodexChromeUseAdapterError";
  }
}

export class CodexChromeUseAdapter {
  private readonly workers: CodexChromeWorker[];
  private readonly profiles: ChromeProfileResolver;
  private readonly stickyProfileByConversation = new Map<string, string>();
  private closePromise?: Promise<void>;
  private hostResetPromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly host: CodexRuntimeHost,
    options: CodexChromeUseAdapterOptions = {},
  ) {
    const workerCount = boundedWorkerCount(options.workerCount ?? DEFAULT_WORKER_COUNT);
    this.workers = Array.from(
      { length: workerCount },
      (_, index) => new CodexChromeWorker(host, index + 1),
    );
    this.profiles = options.profileResolver ?? new ChromeProfileResolver({
      defaultProfile: options.defaultProfile ?? "Default",
      runtimePaths: () => host.paths(),
    });
  }

  async invoke(
    input: CodexChromeUseInput,
    context: CodexExecutionContext,
  ): Promise<CodexMcpToolResult> {
    this.assertOpen();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const worker = this.pickWorker();
      try {
        return await worker.run(() => this.invokeWithWorker(worker, input, context));
      } catch (error) {
        if (attempt > 0 || !isGlobalRuntimeError(error)) throw error;
        await this.resetHost();
      }
    }
    throw new CodexChromeUseAdapterError(
      "Codex Chrome Use recovery exhausted.",
      "codex_chrome_recovery_exhausted",
    );
  }

  async close(): Promise<void> {
    this.closePromise ??= this.closeInternal();
    return this.closePromise;
  }

  private async invokeWithWorker(
    worker: CodexChromeWorker,
    input: CodexChromeUseInput,
    context: CodexExecutionContext,
  ): Promise<CodexMcpToolResult> {
    if (input.action === "list_profiles") {
      const liveInstanceIds = new Set(await worker.listExtensionInstances(context));
      const profiles = await this.profiles.list(liveInstanceIds);
      const selector = this.profileSelector(input, context);
      const selected = await this.profiles.resolve(selector, liveInstanceIds).catch(() => undefined);
      return jsonResult({
        defaultProfile: this.profiles.defaultProfile,
        selectedProfile: selected?.path,
        profiles: profiles.map(profileSummary),
      });
    }

    const selector = this.profileSelector(input, context);
    let profile = await this.profiles.resolve(selector);
    const explicitProfile = input.profile?.trim();
    const conversationKey = codexConversationKey(context);
    if (explicitProfile && conversationKey) {
      this.rememberProfile(conversationKey, explicitProfile);
    }
    if (!profile.extensionInstanceId) {
      throw new ChromeProfileResolverError(
        `Chrome profile ${profileLabel(profile)} has no extension instance identity.`,
        "chrome_profile_extension_identity_unavailable",
      );
    }

    let result: CodexMcpToolResult;
    try {
      result = await worker.invoke(input, profile.extensionInstanceId, context);
    } catch (error) {
      if (!isInstanceNotLiveError(error)) throw error;
      const liveInstanceIds = new Set(await worker.listExtensionInstances(context));
      profile = await this.profiles.resolve(selector, liveInstanceIds);
      profile = await this.ensureProfileLive(worker, profile, context, liveInstanceIds);
      if (!profile.extensionInstanceId) {
        throw new ChromeProfileResolverError(
          `Chrome profile ${profileLabel(profile)} has no extension instance identity.`,
          "chrome_profile_extension_identity_unavailable",
        );
      }
      result = await worker.invoke(input, profile.extensionInstanceId, context);
    }
    return input.action === "status"
      ? enrichStatus(result, profile)
      : result;
  }

  private profileSelector(
    input: CodexChromeUseInput,
    context: CodexExecutionContext,
  ): string {
    const explicit = input.profile?.trim();
    const conversationKey = codexConversationKey(context);
    if (explicit) return explicit;
    return (conversationKey && this.stickyProfileByConversation.get(conversationKey))
      || this.profiles.defaultProfile;
  }

  private rememberProfile(conversationKey: string, selector: string): void {
    this.stickyProfileByConversation.delete(conversationKey);
    this.stickyProfileByConversation.set(conversationKey, selector);
    while (this.stickyProfileByConversation.size > MAX_STICKY_CONVERSATIONS) {
      const oldest = this.stickyProfileByConversation.keys().next().value as string | undefined;
      if (!oldest) break;
      this.stickyProfileByConversation.delete(oldest);
    }
  }

  private async ensureProfileLive(
    worker: CodexChromeWorker,
    profile: ChromeProfileInfo,
    context: CodexExecutionContext,
    initialLiveIds: Set<string>,
  ): Promise<ChromeProfileInfo> {
    if (!profile.extensionInstalled) {
      throw new ChromeProfileResolverError(
        `ChatGPT for Chrome is not installed in ${profileLabel(profile)}.`,
        "chrome_profile_extension_missing",
      );
    }
    if (profile.extensionInstanceId && initialLiveIds.has(profile.extensionInstanceId)) {
      return profile;
    }

    const launchedAt = Date.now();
    await this.profiles.launch(profile);
    const deadline = launchedAt + PROFILE_START_TIMEOUT_MS;
    let latest = profile;
    while (Date.now() < deadline) {
      await sleep(PROFILE_START_POLL_MS);
      const liveIds = new Set(await worker.listExtensionInstances(context));
      latest = await this.profiles.resolve(profile.path, liveIds);
      if (latest.extensionInstanceId && liveIds.has(latest.extensionInstanceId)) {
        return latest;
      }
    }

    throw new ChromeProfileResolverError(
      `Chrome profile ${profileLabel(profile)} did not connect to ChatGPT for Chrome after being launched.`,
      "chrome_profile_not_live",
    );
  }

  private pickWorker(): CodexChromeWorker {
    return this.workers.reduce((best, worker) => (
      worker.load < best.load ? worker : best
    ));
  }

  private async resetHost(): Promise<void> {
    this.hostResetPromise ??= (async () => {
      await Promise.all(this.workers.map((worker) => worker.reset()));
      await this.host.invalidate();
    })().finally(() => {
      this.hostResetPromise = undefined;
    });
    return this.hostResetPromise;
  }

  private async closeInternal(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await Promise.all(this.workers.map((worker) => worker.close().catch(() => undefined)));
  }

  private assertOpen(): void {
    if (this.closed) {
      throw new CodexChromeUseAdapterError(
        "Codex Chrome Use adapter is closed.",
        "codex_chrome_use_closed",
      );
    }
  }
}

class CodexChromeWorker {
  private clientPromise?: Promise<CodexMcpClient>;
  private readyPromise?: Promise<void>;
  private serial = Promise.resolve();
  private queued = 0;
  private closed = false;

  constructor(
    private readonly host: CodexRuntimeHost,
    private readonly index: number,
  ) {}

  get load(): number {
    return this.queued;
  }

  async run<T>(operation: () => Promise<T>): Promise<T> {
    this.queued += 1;
    const run = this.serial.then(operation, operation);
    this.serial = run.then(() => undefined, () => undefined);
    try {
      return await run;
    } finally {
      this.queued -= 1;
    }
  }

  async invoke(
    input: CodexChromeUseInput,
    extensionInstanceId: string,
    context: CodexExecutionContext,
  ): Promise<CodexMcpToolResult> {
    const code = buildChromeCode(input, extensionInstanceId);
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensureReady(context);
        return await this.executeJs(code, context, `Chrome ${input.action}`);
      } catch (error) {
        if (attempt > 0 || !isWorkerRecoverableError(error)) throw error;
        await this.reset();
      }
    }
    throw new CodexChromeUseAdapterError(
      "Codex Chrome worker recovery exhausted.",
      "codex_chrome_worker_recovery_exhausted",
    );
  }

  async listExtensionInstances(context: CodexExecutionContext): Promise<string[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await this.ensureReady(context);
        const result = await this.executeJs(`
          await (async () => {
            const browsers = await globalThis.agent.browsers.list();
            nodeRepl.write(JSON.stringify(browsers
              .filter((browser) => browser.type === "extension" && browser.family === "chrome")
              .map((browser) => browser.metadata?.extensionInstanceId)
              .filter((value) => typeof value === "string" && value.length > 0)));
          })();
        `, context, "List Chrome instances");
        const value = firstJsonValue(result);
        return Array.isArray(value)
          ? value.filter((entry): entry is string => typeof entry === "string")
          : [];
      } catch (error) {
        if (attempt > 0 || !isWorkerRecoverableError(error)) throw error;
        await this.reset();
      }
    }
    return [];
  }

  async reset(): Promise<void> {
    const client = await this.clientPromise?.catch(() => undefined);
    this.clientPromise = undefined;
    this.readyPromise = undefined;
    await client?.close().catch(() => undefined);
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.reset();
  }

  private async ensureReady(context: CodexExecutionContext): Promise<void> {
    if (this.readyPromise) return this.readyPromise;
    const readyPromise = (async () => {
      const paths = await this.host.paths();
      const pluginUrl = pathToFileURL(paths.browserClientPath).href;
      const result = await this.executeJs(`
        await (async () => {
          if (globalThis.agent?.browsers == null) {
            const module = await import(${json(pluginUrl)});
            if (typeof module.setupBrowserRuntime !== "function") {
              throw new Error("Codex Chrome browser-client is missing setupBrowserRuntime");
            }
            const runtimeAgent = await module.setupBrowserRuntime({ globals: globalThis });
            if (globalThis.agent?.browsers == null && runtimeAgent?.browsers != null) {
              globalThis.agent = runtimeAgent;
            }
          }
          if (globalThis.agent?.browsers == null) {
            throw new Error("Codex Chrome browser runtime did not expose agent.browsers");
          }
          globalThis.__devspaceChromeBrowsers ??= new Map();
          globalThis.__devspaceGetChromeBrowser ??= async (extensionInstanceId) => {
            const cached = globalThis.__devspaceChromeBrowsers.get(extensionInstanceId);
            if (cached?.tabs != null) return cached;
            const browsers = await globalThis.agent.browsers.list();
            const match = browsers.find((browser) =>
              browser.type === "extension"
              && browser.family === "chrome"
              && browser.metadata?.extensionInstanceId === extensionInstanceId
            );
            if (!match) {
              throw new Error(${json(INSTANCE_NOT_LIVE_MARKER)} + extensionInstanceId);
            }
            const browser = await globalThis.agent.browsers.get(match.id);
            globalThis.__devspaceChromeBrowsers.set(extensionInstanceId, browser);
            return browser;
          };
          globalThis.__devspaceCreatedChromeTabs ??= new Map();
          nodeRepl.write(JSON.stringify({ devspaceChromeReady: true, backend: "extension" }));
        })();
      `, context, "Connect Chrome");
      const readiness = result.content
        .filter((item) => item.type === "text")
        .map((item) => item.text)
        .join("\n");
      if (!readiness.includes('"devspaceChromeReady":true')) {
        throw new CodexChromeUseAdapterError(
          "Codex browser runtime did not initialize.",
          "codex_chrome_backend_not_selected",
        );
      }
    })();
    this.readyPromise = readyPromise;
    try {
      await readyPromise;
    } finally {
      if (this.readyPromise === readyPromise) this.readyPromise = undefined;
    }
  }

  private async client(): Promise<CodexMcpClient> {
    if (this.closed) {
      throw new CodexChromeUseAdapterError(
        "Codex Chrome worker is closed.",
        "codex_chrome_worker_closed",
      );
    }
    this.clientPromise ??= (async () => {
      const paths = await this.host.paths();
      const client = await this.host.spawnMcpClient({
        command: [paths.nodeReplExecutable],
        cwd: paths.codexHome,
        clientName: `devspace-chrome-use-${this.index}`,
        outputBytesCap: 128 * 1024 * 1024,
        env: {
          BROWSER_USE_AVAILABLE_BACKENDS: "chrome,iab",
          BROWSER_USE_CODEX_APP_BUILD_FLAVOR: "prod",
          BROWSER_USE_CODEX_APP_VERSION: paths.appVersion,
          CODEX_CLI_PATH: paths.codexExecutable,
          CODEX_HOME: paths.codexHome,
          NODE_REPL_INSTRUCTIONS_USE_CASE_BROWSER: "Control",
          NODE_REPL_INSTRUCTIONS_USE_CASE_CHROME: "Control",
          NODE_REPL_INSTRUCTIONS_USE_CASE_COMPUTER_USE: "Control",
          NODE_REPL_NATIVE_PIPE_CONNECT_TIMEOUT_MS: "1000",
          NODE_REPL_NODE_MODULE_DIRS: paths.nodeModulesDir,
          NODE_REPL_NODE_PATH: paths.nodeExecutable,
          NODE_REPL_TRUSTED_BROWSER_CLIENT_SHA256S: paths.browserClientSha256,
          NODE_REPL_TRUSTED_CODE_PATHS: paths.codexHome,
          SKY_CUA_SERVICE_PATH: paths.computerUseAppPath,
        },
      });
      const tools = await client.listTools();
      if (!tools.some((tool) => tool.name === "js")) {
        await client.close();
        throw new CodexChromeUseAdapterError(
          "Codex node_repl MCP does not expose the js tool.",
          "codex_chrome_node_repl_incompatible",
        );
      }
      return client;
    })();
    return this.clientPromise;
  }

  private async executeJs(
    code: string,
    context: CodexExecutionContext,
    title: string,
  ): Promise<CodexMcpToolResult> {
    const client = await this.client();
    const metadata = codexTurnMetadataForChromeUse(context);
    const result = await client.callTool(
      "js",
      {
        code,
        timeout_ms: MAX_ACTION_TIMEOUT_MS,
        title: title.slice(0, 80),
      },
      {
        timeoutMs: MAX_ACTION_TIMEOUT_MS + 10_000,
        meta: { "x-codex-turn-metadata": metadata },
        onElicitation: context.onElicitation,
      },
    );
    if (result.isError) throw toolResultError(result, `Codex Chrome action failed: ${title}`);
    return result;
  }
}

function buildChromeCode(
  input: CodexChromeUseInput,
  extensionInstanceId: string,
): string {
  const timeoutMs = boundedTimeout(input.timeoutMs);
  const observation = input.observe ?? defaultObservation(input.action);
  switch (input.action) {
    case "status":
      return wrapWithBrowser(extensionInstanceId, `
        const tabs = await browser.tabs.list();
        nodeRepl.write(JSON.stringify({
          backend: "extension",
          connected: true,
          browserId: browser.browserId,
          sessionTabs: tabs,
        }));
      `);
    case "list_profiles":
      throw invalidInput("list_profiles is handled by DevSpace and cannot be built as a browser action.");
    case "list_tabs":
      return wrapWithBrowser(extensionInstanceId, `
        nodeRepl.write(JSON.stringify({ tabs: await browser.tabs.list() }));
      `);
    case "list_user_tabs":
      return wrapWithBrowser(extensionInstanceId, `
        nodeRepl.write(JSON.stringify({ tabs: await browser.user.openTabs() }));
      `);
    case "new_tab": {
      const url = optionalUrl(input.url);
      return wrapWithBrowser(extensionInstanceId, `
        const tab = await browser.tabs.new();
        globalThis.__devspaceCreatedChromeTabs.set(tab.id, ${json(extensionInstanceId)});
        ${url ? `await tab.goto(${json(url)});` : ""}
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    }
    case "claim_tab":
      return wrapWithBrowser(extensionInstanceId, `
        const tab = await browser.user.claimTab(${json(requiredString(input.userTabId, "userTabId"))});
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "goto":
      return withTab(input, extensionInstanceId, `
        await tab.goto(${json(requiredUrl(input.url))});
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "snapshot":
      return withTab(input, extensionInstanceId, observeCode("tab", "dom", false));
    case "screenshot":
      return withTab(input, extensionInstanceId, observeCode("tab", "screenshot", input.fullPage === true));
    case "click":
      return withTab(input, extensionInstanceId, `
        await tab.playwright.locator(${json(requiredString(input.selector, "selector"))}).click(${json({ timeoutMs })});
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "fill":
      return withTab(input, extensionInstanceId, `
        await tab.playwright.locator(${json(requiredString(input.selector, "selector"))}).fill(
          ${json(requiredString(input.text, "text", true))},
          ${json({ timeoutMs })}
        );
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "type":
      return withTab(input, extensionInstanceId, `
        await tab.playwright.locator(${json(requiredString(input.selector, "selector"))}).type(
          ${json(requiredString(input.text, "text", true))},
          ${json({ timeoutMs })}
        );
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "press":
      return withTab(input, extensionInstanceId, `
        await tab.playwright.locator(${json(requiredString(input.selector, "selector"))}).press(
          ${json(requiredString(input.key, "key"))},
          ${json({ timeoutMs })}
        );
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "reload":
      return withTab(input, extensionInstanceId, `
        await tab.reload();
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "wait":
      return withTab(input, extensionInstanceId, `
        await tab.playwright.waitForTimeout(${timeoutMs});
        ${observeCode("tab", observation, input.fullPage === true)}
      `);
    case "close":
      return withTab(input, extensionInstanceId, `
        await tab.close();
        globalThis.__devspaceCreatedChromeTabs.delete(tab.id);
        nodeRepl.write(JSON.stringify({ closed: true, tabId: tab.id }));
      `);
  }
}

function withTab(
  input: CodexChromeUseInput,
  extensionInstanceId: string,
  body: string,
): string {
  const tabId = requiredString(input.tabId, "tabId");
  return wrapWithBrowser(extensionInstanceId, `
    const tab = await browser.tabs.get(${json(tabId)});
    ${body}
  `);
}

function wrapWithBrowser(extensionInstanceId: string, body: string): string {
  return `await (async () => {
    const browser = await globalThis.__devspaceGetChromeBrowser(${json(extensionInstanceId)});
    ${body}
  })();`;
}

function observeCode(
  tabName: string,
  observation: CodexChromeObservation,
  fullPage: boolean,
): string {
  const includeDom = observation === "dom" || observation === "both";
  const includeScreenshot = observation === "screenshot" || observation === "both";
  return `
    const observation = {
      tabId: ${tabName}.id,
      title: await ${tabName}.title(),
      url: await ${tabName}.url(),
    };
    ${includeDom ? `
      const dom = await ${tabName}.playwright.domSnapshot();
      observation.dom = dom.length > ${MAX_DOM_CHARACTERS}
        ? dom.slice(0, ${MAX_DOM_CHARACTERS}) + "\\n... DOM snapshot truncated ..."
        : dom;
      observation.domTruncated = dom.length > ${MAX_DOM_CHARACTERS};
    ` : ""}
    ${includeScreenshot ? `
      await nodeRepl.emitImage(await ${tabName}.screenshot({ fullPage: ${fullPage} }));
    ` : ""}
    nodeRepl.write(JSON.stringify(observation));
  `;
}

function defaultObservation(action: CodexChromeUseAction): CodexChromeObservation {
  if (["click", "fill", "type", "press", "goto", "reload", "wait", "new_tab", "claim_tab"].includes(action)) {
    return "dom";
  }
  return "none";
}

function enrichStatus(
  result: CodexMcpToolResult,
  profile: ChromeProfileInfo,
): CodexMcpToolResult {
  const payload = firstJsonValue(result);
  if (!isRecord(payload)) return result;
  return jsonResult({
    ...payload,
    profileName: profile.name,
    profileEmail: profile.email,
    profilePath: profile.path,
    profileDefault: profile.isDefault,
    profileOverride: !profile.isDefault,
  });
}

function profileSummary(profile: ChromeProfileInfo): Record<string, unknown> {
  return {
    name: profile.name,
    email: profile.email,
    path: profile.path,
    extensionInstalled: profile.extensionInstalled,
    live: profile.live,
    isDefault: profile.isDefault,
  };
}

function profileLabel(profile: ChromeProfileInfo): string {
  const identity = [profile.name, profile.email].filter(Boolean).join(" / ");
  return identity ? `${identity} (${profile.path})` : profile.path;
}

function jsonResult(value: unknown): CodexMcpToolResult {
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    isError: false,
  };
}

function firstJsonValue(result: CodexMcpToolResult): unknown {
  const text = result.content.find((item) => item.type === "text")?.text;
  if (!text) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

function boundedTimeout(value: number | undefined): number {
  if (value === undefined) return 15_000;
  if (!Number.isInteger(value) || value < 0 || value > MAX_ACTION_TIMEOUT_MS) {
    throw invalidInput(`timeoutMs must be an integer between 0 and ${MAX_ACTION_TIMEOUT_MS}.`);
  }
  return value;
}

function boundedWorkerCount(value: number): number {
  if (!Number.isInteger(value) || value < 1 || value > 16) {
    throw new CodexChromeUseAdapterError(
      "workerCount must be an integer between 1 and 16.",
      "codex_chrome_invalid_worker_count",
    );
  }
  return value;
}

function requiredString(value: unknown, name: string, allowEmpty = false): string {
  if (typeof value !== "string") throw invalidInput(`${name} is required.`);
  if (!allowEmpty && value.trim().length === 0) throw invalidInput(`${name} must not be empty.`);
  if (value.length > 100_000) throw invalidInput(`${name} is too large.`);
  return value;
}

function optionalUrl(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return requiredUrl(value);
}

function requiredUrl(value: unknown): string {
  const raw = requiredString(value, "url");
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw invalidInput("url must be an absolute URL.");
  }
  if (!["http:", "https:", "file:"].includes(parsed.protocol)) {
    throw invalidInput("url must use http, https, or file.");
  }
  return parsed.toString();
}

function json(value: unknown): string {
  return JSON.stringify(value)
    .replaceAll("<", "\\u003c")
    .replaceAll(">", "\\u003e")
    .replaceAll("&", "\\u0026");
}

function toolResultError(
  result: CodexMcpToolResult,
  fallback: string,
): CodexChromeUseAdapterError {
  const message = result.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return new CodexChromeUseAdapterError(
    message || fallback,
    "codex_chrome_tool_failed",
  );
}

function isWorkerRecoverableError(error: unknown): boolean {
  const code = errorCode(error);
  return new Set([
    "codex_child_not_running",
    "codex_mcp_client_closed",
    "codex_mcp_process_exited",
    "codex_mcp_request_timeout",
    "codex_mcp_write_failed",
  ]).has(code);
}

function isGlobalRuntimeError(error: unknown): boolean {
  return new Set([
    "codex_app_server_closed",
    "codex_app_server_exited",
    "codex_app_server_not_running",
    "codex_app_server_request_timeout",
  ]).has(errorCode(error));
}

function isInstanceNotLiveError(error: unknown): boolean {
  return error instanceof Error && error.message.includes(INSTANCE_NOT_LIVE_MARKER);
}

function errorCode(error: unknown): string {
  if (typeof error !== "object" || error === null || !("code" in error)) return "";
  return String(error.code);
}

function invalidInput(message: string): CodexChromeUseAdapterError {
  return new CodexChromeUseAdapterError(message, "codex_chrome_invalid_input");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
