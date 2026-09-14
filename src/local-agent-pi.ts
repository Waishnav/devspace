import { join } from "node:path";
import type {
  AgentSession,
  CreateAgentSessionOptions,
  ModelRegistry,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import {
  AgentProviderExecutionError,
  AgentProviderProtocolError,
  AgentProviderUnavailableError,
  captureAgentProviderResult,
} from "./local-agent-errors.js";
import type {
  LocalAgentDriver,
  LocalAgentRunCallbacks,
  LocalAgentRunInput,
  LocalAgentRunResult,
  LocalAgentRuntime,
  LocalAgentRuntimeContext,
} from "./local-agent-runtime.js";
import {
  createPiSandboxExtension,
  createPiSandboxModeRef,
  registerPiSandboxSession,
  releasePiSandboxSession,
  updatePiSandboxSession,
} from "./local-agent-pi-sandbox.js";

const PI_READ_ONLY_TOOLS = ["read", "grep", "find", "ls"] as const;

const PI_WORKSPACE_TOOLS = ["read", "grep", "find", "ls", "edit", "write", "bash"] as const;

const PI_FULL_ACCESS_TOOLS = [...PI_WORKSPACE_TOOLS] as const;

const MAX_PI_EVENTS = 10_000;

type PiThinkingLevel = NonNullable<CreateAgentSessionOptions["thinkingLevel"]>;

export interface PiSessionLike {
  readonly sessionId: string;
  messageCount(): number;
  messagesSince(index: number): PiExternalPayload[];
  prompt(text: string): Promise<void>;
  subscribe(listener: (event: PiExternalPayload) => void): () => void;
  setActiveToolsByName(toolNames: string[]): void;
  setModel(reference: string): Promise<boolean>;
  setThinkingLevel(level: PiThinkingLevel): void;
  dispose(): void;
}

export type PiSessionFactory = (
  context: LocalAgentRuntimeContext,
  input: LocalAgentRunInput,
  env?: NodeJS.ProcessEnv,
) => Promise<PiSessionLike>;

export class PiSessionRuntime implements LocalAgentRuntime {
  readonly provider = "pi" as const;
  private readonly unsubscribe: () => void;
  private alive = true;
  private closed = false;
  private collectingEvents = false;
  private events: PiExternalPayload[] = [];

  constructor(
    private readonly session: PiSessionLike,
  ) {
    this.unsubscribe = session.subscribe((event) => {
      if (!this.collectingEvents) return;

      if (this.events.length >= MAX_PI_EVENTS) this.events.shift();
      this.events.push(event);
    });
  }

  async run(input: LocalAgentRunInput, callbacks?: LocalAgentRunCallbacks) {
    return captureAgentProviderResult({
      provider: this.provider,
      operation: "run",
      run: async (): Promise<LocalAgentRunResult> => {
        if (!this.isAlive()) {
          throw new AgentProviderUnavailableError({
            code: "PROVIDER_UNAVAILABLE",
            provider: this.provider,
            operation: "run",
            retryable: true,
            message: "Pi runtime is not running.",
          });
        }

        await callbacks?.onSessionId?.(this.session.sessionId);
        await this.applyOverrides(input);
        this.events = [];
        const messageStart = this.session.messageCount();
        this.collectingEvents = true;

        try {
          await this.session.prompt(input.prompt);
        } finally {
          this.collectingEvents = false;
        }

        const currentMessages = this.session.messagesSince(messageStart);
        const finalResponse = extractPiFinalResponse({ messages: currentMessages });

        if (!finalResponse) {
          const providerError = extractPiProviderError(this.events) || extractPiProviderError(currentMessages);

          if (providerError) {
            throw new AgentProviderExecutionError({
              code: "PROVIDER_EXECUTION_ERROR",
              provider: this.provider,
              operation: "run",
              retryable: false,
              cause: new Error(providerError),
              message: "Pi agent turn failed.",
            });
          }

          throw new AgentProviderProtocolError({
            code: "PROVIDER_PROTOCOL_ERROR",
            provider: this.provider,
            operation: "run",
            retryable: false,
            message: "Pi did not return a final assistant response.",
          });
        }

        return {
          provider: this.provider,
          providerSessionId: this.session.sessionId,
          finalResponse,
          items: [...this.events, ...currentMessages],
        };
      },
    });
  }

  async releaseSession(_providerSessionId: string): Promise<void> {
    // The runtime is already scoped to one logical Pi session.
  }

  isAlive(): boolean {
    return this.alive && !this.closed;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.alive = false;
    this.unsubscribe();

    try {
      await releasePiSandboxSession(this.session);
    } finally {
      this.session.dispose();
    }
  }

  private async applyOverrides(input: LocalAgentRunInput): Promise<void> {
    await updatePiSandboxSession(this.session, input.workspaceRoot, input.writeMode ?? "allowed");
    this.session.setActiveToolsByName([...piToolsForWriteMode(input.writeMode)]);

    if (input.model) {
      const configured = await this.session.setModel(input.model);

      if (!configured) {
        throw new AgentProviderProtocolError({
          code: "PROVIDER_PROTOCOL_ERROR",
          provider: "pi",
          operation: "configure_model",
          retryable: false,
          message: `Pi model not found: ${input.model}.`,
        });
      }

    }

    if (input.effort) {
      this.session.setThinkingLevel(parsePiThinkingLevel(input.effort));
    }
  }
}

export class PiLocalAgentDriver implements LocalAgentDriver {
  readonly provider = "pi" as const;
  readonly idleTimeoutMs = 3 * 60_000;

  constructor(
    private readonly factory: PiSessionFactory = defaultPiSessionFactory,
    private readonly env: NodeJS.ProcessEnv = {},
  ) {}

  runtimeKey(context: LocalAgentRuntimeContext): string {
    return `pi:${context.agentId}`;
  }

  async createRuntime(context: LocalAgentRuntimeContext) {
    return captureAgentProviderResult({
      provider: this.provider,
      agentId: context.agentId,
      operation: "create_runtime",
      run: async (): Promise<LocalAgentRuntime> => {
        const input: LocalAgentRunInput = {
          prompt: "",
          workspaceRoot: context.workspaceRoot,
          providerSessionId: context.providerSessionId,
          writeMode: context.writeMode,
          model: context.model,
          effort: context.effort,
        };

        const session = await this.factory(context, input, this.env);

        return new PiSessionRuntime(session);
      },
    });
  }
}

async function defaultPiSessionFactory(
  context: LocalAgentRuntimeContext,
  input: LocalAgentRunInput,
  env: NodeJS.ProcessEnv = {},
): Promise<PiSessionLike> {
  const {
    AuthStorage,
    ModelRegistry,
    SessionManager,
    DefaultResourceLoader,
    createAgentSession,
    getAgentDir,
  } = await import("@earendil-works/pi-coding-agent");

  // DevSpace's agentDir is the compatibility directory used for instructions;
  // Pi keeps its own native auth, model, and session state under getAgentDir().
  const agentDir = getAgentDir();
  const authStorage = AuthStorage.create(join(agentDir, "auth.json"));
  const modelRegistry = ModelRegistry.create(authStorage, join(agentDir, "models.json"));
  applyPiProviderEnvironment(modelRegistry, env);
  const sessionManager = await resolveSessionManager(SessionManager, input.workspaceRoot, input.providerSessionId);
  const model = input.model ? resolvePiModel(modelRegistry, input.model) : undefined;

  if (input.model && !model) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "pi",
      agentId: context.agentId,
      operation: "configure_model",
      retryable: false,
      message: `Pi model not found: ${input.model}.`,
    });
  }

  const modeRef = createPiSandboxModeRef(input.writeMode ?? "allowed");

  const resourceLoader = new DefaultResourceLoader({
    cwd: input.workspaceRoot,
    agentDir,
    extensionFactories: [createPiSandboxExtension(input.workspaceRoot, modeRef, env)],
  });

  let session: PiSessionLike | undefined;

  try {
    const sessionOptions: CreateAgentSessionOptions = {
      cwd: input.workspaceRoot,
      agentDir,
      authStorage,
      modelRegistry,
      sessionManager,
      resourceLoader,
      // Keep the full built-in registry available so warm turns can narrow or
      // broaden active tools without recreating the session.
      tools: [...PI_FULL_ACCESS_TOOLS],
    };

    if (model) sessionOptions.model = model;

    if (input.effort) sessionOptions.thinkingLevel = parsePiThinkingLevel(input.effort);

    const result = await createAgentSession(sessionOptions);

    const agentSession = result.session;
    session = createPiSessionAdapter(agentSession, modelRegistry);
    await registerPiSandboxSession(session, input.workspaceRoot, modeRef, input.writeMode ?? "allowed");
    agentSession.setActiveToolsByName([...piToolsForWriteMode(input.writeMode)]);

    return session;
  } catch (error) {
    if (session) {
      try {
        await releasePiSandboxSession(session);
      } finally {
        session.dispose();
      }
    }

    throw error;
  }
}

function applyPiProviderEnvironment(
  modelRegistry: ModelRegistry,
  env: NodeJS.ProcessEnv,
): void {
  const getApiKeyAndHeaders = modelRegistry.getApiKeyAndHeaders.bind(modelRegistry);

  const providerEnv = Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );

  modelRegistry.getApiKeyAndHeaders = async (model) => {
    const auth = await getApiKeyAndHeaders(model);

    if (!auth.ok) return auth;

    return {
      ...auth,
      env: {
        ...auth.env,
        ...providerEnv,
      },
    };
  };
}

export function piToolsForWriteMode(writeMode: LocalAgentRunInput["writeMode"]): readonly string[] {
  switch (writeMode) {
    case "read_only": return PI_READ_ONLY_TOOLS;
    case "full_access": return PI_FULL_ACCESS_TOOLS;
    case "allowed":
    case undefined:
      return PI_WORKSPACE_TOOLS;
  }
}

interface PiSessionManagerApi {
  create(cwd: string): SessionManager;
  open(path: string): SessionManager;
  list(cwd: string): Promise<Array<{ id: string; path: string }>>;
}

async function resolveSessionManager(
  SessionManager: PiSessionManagerApi,
  workspaceRoot: string,
  providerSessionId: string | undefined,
): Promise<SessionManager> {
  if (!providerSessionId) return SessionManager.create(workspaceRoot);
  const sessions = await SessionManager.list(workspaceRoot);
  const match = sessions.find((session) => session.id === providerSessionId);

  if (!match) {
    throw new AgentProviderProtocolError({
      code: "PROVIDER_PROTOCOL_ERROR",
      provider: "pi",
      operation: "session",
      retryable: false,
      message: `Pi session not found: ${providerSessionId}.`,
    });
  }

  return SessionManager.open(match.path);
}

type PiModel = NonNullable<ReturnType<ModelRegistry["find"]>>;

function resolvePiModel(
  registry: Pick<ModelRegistry, "find" | "getAll">,
  reference: string,
): PiModel | undefined {
  const separator = reference.indexOf("/");

  if (separator !== -1) {
    return registry.find(reference.slice(0, separator), reference.slice(separator + 1));
  }

  const all = registry.getAll?.() ?? [];

  return all.find((model) => model.id === reference);
}

function createPiSessionAdapter(
  session: AgentSession,
  modelRegistry: Pick<ModelRegistry, "find" | "getAll">,
): PiSessionLike {
  return {
    sessionId: session.sessionId,
    messageCount: () => session.messages.length,
    messagesSince: (index) => session.messages.slice(index).flatMap((message) => {
      const parsed = piMessageSchema.safeParse(message);

      return parsed.success ? [parsed.data] : [];
    }),
    prompt: (text) => session.prompt(text),
    subscribe: (listener) => session.subscribe((event) => {
      const parsed = piPayloadSchema.safeParse(event);

      if (parsed.success) listener(parsed.data);
    }),
    setActiveToolsByName: (toolNames) => session.setActiveToolsByName(toolNames),
    setModel: async (reference) => {
      const model = resolvePiModel(modelRegistry, reference);

      if (!model) return false;
      await session.setModel(model);

      return true;
    },
    setThinkingLevel: (level) => session.setThinkingLevel(level),
    dispose: () => session.dispose(),
  };
}

const piThinkingLevelSchema = z.enum(["off", "minimal", "low", "medium", "high", "xhigh"]);

function parsePiThinkingLevel(value: string): PiThinkingLevel {
  return piThinkingLevelSchema.parse(value);
}

const piTextPartSchema = z.object({ type: z.literal("text"), text: z.string() });

const piContentSchema = z.union([piTextPartSchema, z.object({ type: z.string() }).passthrough()]);

const piMessageSchema = z.object({
  role: z.string(),
  content: z.json().optional(),
}).passthrough();

const piPayloadSchema: z.ZodType<PiPayload> = z.lazy(() => z.union([
  z.array(piMessageSchema),
  z.object({
    messages: z.array(piMessageSchema).optional(),
    data: piPayloadSchema.optional(),
    result: piPayloadSchema.optional(),
    message: piPayloadSchema.optional(),
    error: z.string().optional(),
    errorMessage: z.string().optional(),
  }).passthrough(),
]));

type PiMessage = z.infer<typeof piMessageSchema>;

type PiContent = z.infer<typeof piContentSchema>;

type PiPayload = PiMessage[] | { messages?: PiMessage[]; data?: PiPayload; result?: PiPayload; error?: string; errorMessage?: string; message?: PiPayload };

type PiExternalPayload = z.input<typeof piPayloadSchema>;

function parsePiPayload(value: PiExternalPayload): PiPayload | undefined {
  const parsed = piPayloadSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

export function extractPiFinalResponse(value: PiExternalPayload): string {
  const root = unwrapProviderPayload(parsePiPayload(value));
  const messages = Array.isArray(root) ? root : readArray(root, "messages");

  if (!messages) return "";

  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];

    if (!message || message.role !== "assistant") continue;

    const content = z.array(piContentSchema).safeParse(message.content);

    if (!content.success) continue;

    const text = content.data
      .filter((part): part is Extract<PiContent, { type: "text" }> => part.type === "text")
      .map((part) => part.text)
      .filter(Boolean)
      .join("\n\n")
      .trim();

    if (text) return text;
  }

  return "";
}

export function extractPiProviderError(value: PiExternalPayload): string {
  const root = unwrapProviderPayload(parsePiPayload(value));

  if (Array.isArray(root)) {
    for (let index = root.length - 1; index >= 0; index -= 1) {
      const error = extractPiProviderError(root[index]);

      if (error) return error;
    }

    return "";
  }

  const messages = readArray(root, "messages");

  if (messages) return extractPiProviderError(messages);

  if (!root || Array.isArray(root)) return "";

  const nested = root.message;

  if (nested) return extractPiProviderError(nested);

  return (root.errorMessage ?? root.error ?? "").trim();
}

function unwrapProviderPayload(value: PiPayload | undefined): PiPayload | undefined {
  if (!value || Array.isArray(value)) return value;

  return value.data ?? value.result ?? value;
}

function readArray(value: PiPayload | undefined, key: "messages"): PiMessage[] | undefined {
  return value && !Array.isArray(value) ? value[key] : undefined;
}
