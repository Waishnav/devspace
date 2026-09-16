import { randomUUID } from "node:crypto";
import { open, realpath } from "node:fs/promises";
import { realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ServerConfig } from "./config.js";
import type { SubagentsConfig } from "./local-agent-config.js";
import type { LocalAgentManager } from "./local-agent-manager.js";
import type { LocalAgentProfile } from "./local-agent-profiles.js";
import type { LocalAgentWorkspaceScope } from "./local-agent-store.js";
import { resolveLocalAgentTarget } from "./local-agent-targets.js";
import { resolveCanonicalAllowedPath } from "./roots.js";
import { workflowContextHash, workflowHash } from "./workflow-context.js";
import { runWorkflowScript } from "./workflow-runner.js";
import { parseWorkflowScript } from "./workflow-script.js";
import { compileWorkflowSchema, parseWorkflowOutput } from "./workflow-schema.js";
import type { WorkflowStore } from "./workflow-store.js";
import {
  WorkflowError, workflowFailure, workflowTerminal,
  type WorkflowAgentOptions, type WorkflowCall, type WorkflowEvent, type WorkflowRun, type WorkflowRunInput, type WorkflowSnapshot,
} from "./workflow-types.js";
import { createWorkflowWorkspace, isManagedWorkflowWorkspace } from "./workflow-workspaces.js";

interface WorkflowManagerOptions {
  store: WorkflowStore;
  agents: LocalAgentManager;
  loadProfiles: (workspaceRoot: string) => Promise<LocalAgentProfile[]>;
  subagents: SubagentsConfig;
  allowedRoots?: readonly string[];
  config?: ServerConfig;
  /** Tests may exercise the supervisor without a provider or child process. */
  runner?: typeof runWorkflowScript;
}
interface ActiveRun {
  run: WorkflowSnapshot;
  controller: AbortController;
  done: Promise<void>;
  pending: Set<Promise<unknown>>;
  preparing: Promise<unknown>;
  calls: number;
  dispatches: number;
  nested: number;
  eventBytes: number;
  slots: Slots;
  workspaces: Map<string, Promise<LocalAgentWorkspaceScope>>;
  previous: WorkflowCall[];
  replayPrefix: boolean;
}

/** Owns execution; host-authored JavaScript owns the workflow decisions. */
export class WorkflowManager {
  private readonly active = new Map<string, ActiveRun>();
  private readonly slots = new Slots(8);
  private scripts = 0;
  private accepting = true;
  constructor(private readonly options: WorkflowManagerOptions) {}
  get activeRunCount(): number { return this.active.size; }

  async run(input: WorkflowRunInput): Promise<WorkflowRun> {
    if (!this.accepting) throw new WorkflowError("WORKFLOW_STOPPING", "Workflow service is stopping.");
    if (this.active.size >= 8) throw new WorkflowError("WORKFLOW_CAPACITY", "Eight workflows are already active. Wait for one to finish.", true);
    const scope = await this.authorize(input);
    if ([input.source !== undefined, input.name !== undefined, input.resume !== undefined].filter(Boolean).length !== 1) {
      throw new WorkflowError("INVALID_WORKFLOW", "Supply exactly one source, name, or resume ID.");
    }
    const previous = input.resume ? this.snapshot(input.resume, scope) : undefined;
    if (previous && (!workflowTerminal(previous.status) || this.active.has(previous.id))) {
      throw new WorkflowError("WORKFLOW_ACTIVE", "Cancel and wait for the previous run before resuming.");
    }
    const previousCalls = previous ? this.options.store.calls(previous.id) : [];
    for (const call of previousCalls) {
      const record = this.options.agents.get(call.agentId, call);
      if (record.isErr() && record.error.code !== "AGENT_NOT_FOUND") {
        throw new WorkflowError("RECOVERY_REQUIRED", `Cannot establish ownership of prior agent ${call.agentId}: ${record.error.message}`);
      }
      if (record.isOk() && (record.value.status === "running" || record.value.status === "starting")) {
        throw new WorkflowError("WORKFLOW_ACTIVE", `Child agent ${call.agentId} is still active.`);
      }
      if (call.options.writeMode !== "read_only" || call.options.isolation || call.options.workspace) {
        throw new WorkflowError("RECOVERY_REQUIRED", "This run may have changed a workspace. Inspect its calls and preserved worktrees, then start a new explicit workflow; editing calls are never replayed.");
      }
    }
    if (previous && (input.args !== undefined || input.writeMode !== undefined)) {
      throw new WorkflowError("INVALID_WORKFLOW", "Resume uses the original arguments and authority. Start a new run to change them.");
    }
    const source = previous?.source ?? input.source ?? await this.namedSource(input.name!, scope.workspaceRoot);
    if (typeof source !== "string" || Buffer.byteLength(source) > 65_536) throw new WorkflowError("SOURCE_LIMIT", "Workflow source exceeds 64 KiB.");
    let meta: ReturnType<typeof parseWorkflowScript>["meta"];
    try { meta = parseWorkflowScript(source).meta; }
    catch (error) { throw new WorkflowError("INVALID_WORKFLOW", workflowFailure(error).message); }
    const args = jsonValue(previous ? previous.args : input.args ?? {}, 131_072, "arguments");
    const contextHash = await workflowContextHash(scope.workspaceRoot);
    if (previous && (!contextHash || contextHash !== previous.contextHash)) {
      throw new WorkflowError("RECOVERY_CONTEXT_CHANGED", "Workspace context changed or cannot be fully fingerprinted. Start a new workflow after reviewing the previous run.");
    }
    const writeMode = previous?.writeMode ?? input.writeMode ?? "read_only";
    if (writeMode !== "read_only" && writeMode !== "allowed") throw new WorkflowError("INVALID_WORKFLOW", "Invalid workflow write mode.");
    const now = new Date().toISOString();
    const run: WorkflowSnapshot = {
      id: `wf_${randomUUID()}`, ...scope, name: meta.name, source, args, contextHash: contextHash ?? "unavailable",
      writeMode, concurrency: meta.concurrency, status: "starting", resumeOf: previous?.id,
      createdAt: now, updatedAt: now, callCount: 0,
    };
    if (this.active.size >= 8) throw new WorkflowError("WORKFLOW_CAPACITY", "Eight workflows are already active. Wait for one to finish.", true);
    this.options.store.create(run);
    const active: ActiveRun = {
      run, controller: new AbortController(), pending: new Set(), preparing: Promise.resolve(),
      calls: 0, dispatches: 0, nested: 0, eventBytes: 0, slots: new Slots(run.concurrency), workspaces: new Map(), previous: previousCalls, replayPrefix: true,
      done: Promise.resolve(),
    };
    this.active.set(run.id, active);
    active.done = this.execute(active);
    // Completion failures remain visible in persisted state; never create an unhandled rejection.
    void active.done.catch(() => {});
    return summary(run);
  }

  get(id: string, scope: LocalAgentWorkspaceScope): WorkflowRun { return summary(this.snapshot(id, scope)); }
  list(scope: LocalAgentWorkspaceScope): WorkflowRun[] {
    return this.options.store.list({ ...scope, workspaceRoot: canonicalRoot(scope.workspaceRoot) }).map(summary);
  }
  calls(id: string, scope: LocalAgentWorkspaceScope): WorkflowCall[] {
    this.snapshot(id, scope);
    return this.options.store.calls(id);
  }
  call(id: string, index: number, scope: LocalAgentWorkspaceScope): WorkflowCall {
    this.snapshot(id, scope);
    const call = this.options.store.call(id, index);
    if (!call) throw new WorkflowError("WORKFLOW_CALL_NOT_FOUND", `Unknown workflow call: ${index}`);
    return call;
  }
  events(id: string, scope: LocalAgentWorkspaceScope, after = 0): WorkflowEvent[] {
    this.snapshot(id, scope);
    if (!Number.isSafeInteger(after) || after < 0) throw new WorkflowError("INVALID_WORKFLOW", "Event cursor must be a nonnegative sequence number.");
    return this.options.store.events(id, after);
  }
  async wait(id: string, scope: LocalAgentWorkspaceScope, timeoutMs = 60_000, signal?: AbortSignal): Promise<WorkflowRun> {
    const run = this.get(id, scope);
    if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) throw new WorkflowError("INVALID_WORKFLOW", "Wait timeout must be 0–60000 milliseconds.");
    const active = this.active.get(id);
    if (!active || workflowTerminal(run.status) || signal?.aborted) return run;
    await new Promise<void>((done) => {
      const finish = () => { clearTimeout(timer); signal?.removeEventListener("abort", finish); done(); };
      const timer = setTimeout(finish, timeoutMs);
      signal?.addEventListener("abort", finish, { once: true });
      void active.done.then(finish, finish);
    });
    return this.get(id, scope);
  }
  async cancel(id: string, scope: LocalAgentWorkspaceScope): Promise<WorkflowRun> {
    const run = this.get(id, scope);
    const active = this.active.get(id);
    if (active) {
      this.options.store.update(id, { status: "stopping" });
      active.controller.abort(new WorkflowError("WORKFLOW_CANCELLED", "Workflow cancellation requested."));
    }
    return active ? this.get(id, scope) : run;
  }
  reconcile(): void {
    for (const run of this.options.store.list()) {
      if (workflowTerminal(run.status)) continue;
      for (const call of this.options.store.calls(run.id)) {
        if (call.status !== "queued" && call.status !== "running") continue;
        // Recover a crash between durable agent dispatch and saving the turn link.
        const turn = this.options.agents.getTurn(call.agentId, call);
        this.options.store.updateCall(run.id, call.index, {
          status: "interrupted", turnId: turn.isOk() ? turn.value?.id : call.turnId,
          error: { code: "WORKFLOW_INTERRUPTED", message: "Daemon stopped before this call was finalized. Inspect the agent before retrying.", retryable: false },
        });
      }
      this.options.store.update(run.id, {
        status: "interrupted", error: { code: "WORKFLOW_INTERRUPTED", message: "Daemon stopped. Explicit resume is required; no calls were automatically dispatched.", retryable: false },
      });
    }
  }
  async close(): Promise<void> {
    this.accepting = false;
    const active = [...this.active.values()];
    for (const run of active) run.controller.abort(new WorkflowError("WORKFLOW_CANCELLED", "Daemon is stopping."));
    await Promise.allSettled(active.map((run) => run.done));
    this.options.store.close();
  }

  private async execute(active: ActiveRun): Promise<void> {
    const { run, controller } = active;
    let result: unknown;
    let failure: unknown;
    try {
      this.options.store.update(run.id, { status: "running" });
      result = await this.script(active, run.source, run.args, 0);
      if (active.pending.size) throw new WorkflowError("UNAWAITED_CALLS", "Workflow returned while agent calls were still pending. Await all calls before returning.");
      if (controller.signal.aborted) throw controller.signal.reason;
    } catch (error) { failure = error; }
    finally {
      // One finalization path: stop admission first, then confirm every owned turn has settled.
      controller.abort(failure ?? new WorkflowError("WORKFLOW_FINISHED", "Workflow finished."));
      try {
        if (active.pending.size) {
          try { this.options.store.update(run.id, { status: "stopping" }); } catch { /* Still stop children if persistence is unavailable. */ }
        }
        await Promise.allSettled([...active.pending]);
        const error = failure ? workflowFailure(failure) : undefined;
        this.options.store.update(run.id, {
          status: error ? (error.code === "WORKFLOW_CANCELLED" ? "cancelled" : "failed") : "completed",
          result: error ? undefined : result, error,
        });
      } finally { this.active.delete(run.id); }
    }
  }
  private async script(active: ActiveRun, source: string, args: unknown, depth: number): Promise<unknown> {
    if (this.scripts >= 16) throw this.fatal(active, new WorkflowError("WORKFLOW_RUNNER_LIMIT", "Sixteen script runners are already active."));
    this.scripts++;
    const runner = this.options.runner ?? runWorkflowScript;
    try { return await runner({
      source, args, signal: active.controller.signal, depth,
      onAgent: (prompt, options) => {
        const task = this.agent(active, prompt, options as WorkflowAgentOptions, workflowHash(source));
        active.pending.add(task);
        void task.then(() => active.pending.delete(task), () => active.pending.delete(task));
        return task;
      },
      onWorkflow: (name, nestedArgs) => {
        if (depth >= 1) throw this.fatal(active, new WorkflowError("WORKFLOW_DEPTH_LIMIT", "Nested workflows are limited to one level."));
        if (++active.nested > 8) throw this.fatal(active, new WorkflowError("WORKFLOW_NESTED_LIMIT", "A run can invoke at most eight nested workflows."));
        const task = (async () => {
          const nestedSource = await this.namedSource(name, active.run.workspaceRoot);
          this.options.store.event(active.run.id, "nested_workflow", { name, source: nestedSource });
          return this.script(active, nestedSource, nestedArgs, depth + 1);
        })();
        active.pending.add(task);
        void task.then(() => active.pending.delete(task), (error) => {
          active.pending.delete(task);
          if (workflowFailure(error).code.includes("LIMIT")) this.fatal(active, error);
        });
        return task;
      },
      onEvent: (type, data) => {
        active.eventBytes += Buffer.byteLength(JSON.stringify(data));
        if (active.eventBytes > 65_536) throw this.fatal(active, new WorkflowError("WORKFLOW_LOG_LIMIT", "Combined workflow events exceed 64 KiB."));
        this.options.store.event(active.run.id, type, data);
      },
    }); } finally { this.scripts--; }
  }
  private async agent(active: ActiveRun, prompt: string, value: WorkflowAgentOptions, sourceHash: string): Promise<unknown> {
    const signal = active.controller.signal;
    signal.throwIfAborted();
    const index = active.calls++;
    if (index >= 128) throw this.fatal(active, new WorkflowError("WORKFLOW_CALL_LIMIT", "Workflow exceeds 128 agent calls."));
    // Serialize preparation/replay decisions, never the agent execution itself.
    const prepared = active.preparing.then(async () => {
      signal.throwIfAborted();
      const options = agentOptions(value, active.run.writeMode);
      if (typeof prompt !== "string" || !prompt.trim() || Buffer.byteLength(prompt) > 65_536) throw new WorkflowError("INVALID_AGENT_CALL", "Agent prompt must be nonempty and at most 64 KiB.");
      const validate = options.schema ? compileWorkflowSchema(options.schema) : undefined;
      const scope = await this.callWorkspace(active, options, index);
      const profiles = await this.options.loadProfiles(scope.workspaceRoot);
      const target = resolveLocalAgentTarget(options.target, profiles, options.model, options.effort, this.options.subagents.providers);
      if (!target) throw new WorkflowError("UNKNOWN_TARGET", `Unknown agent target: ${options.target}`);
      options.model = target.model;
      options.effort = target.effort;
      const fingerprint = workflowHash({ prompt, options, sourceHash, scope, context: active.run.contextHash,
        profile: target.kind === "profile" ? target.profile : null, providers: this.options.subagents });
      const previous = active.previous[index];
      const reuse = active.replayPrefix && previous?.status === "completed" && previous.fingerprint === fingerprint && options.writeMode === "read_only";
      if (!reuse) {
        if (active.replayPrefix && active.run.resumeOf) this.options.store.event(active.run.id, "replay_invalidated", { index, reason: previous ? "call context or result changed" : "end of previous calls" });
        active.replayPrefix = false;
      }
      const now = new Date().toISOString();
      const call: WorkflowCall = {
        runId: active.run.id, index, agentId: `agt_${randomUUID()}`, ...scope, prompt, options, fingerprint,
        status: reuse ? "completed" : "queued", createdAt: now, updatedAt: now,
        ...(reuse ? { reusedFrom: active.run.resumeOf, result: previous.result, agentId: previous.agentId, turnId: previous.turnId } : {}),
      };
      this.options.store.addCall(call);
      return { call, validate, reuse };
    });
    active.preparing = prepared.catch(() => {});
    const { call, validate, reuse } = await prepared;
    if (reuse) return call.result;
    let releaseRun: (() => void) | undefined;
    let releaseGlobal: (() => void) | undefined;
    try {
      releaseRun = await active.slots.acquire(signal);
      releaseGlobal = await this.slots.acquire(signal);
      signal.throwIfAborted();
      this.countDispatch(active);
      const fullPrompt = validate ? `${prompt}\n\nReturn only JSON matching this schema:\n${JSON.stringify(call.options.schema)}` : prompt;
      const started = await this.options.agents.start({ ...call, ...call.options, prompt: fullPrompt, agentId: call.agentId });
      if (started.isErr()) throw started.error;
      let turn = this.options.agents.getTurn(call.agentId, call);
      if (turn.isErr()) throw turn.error;
      if (!turn.value) throw new WorkflowError("WORKFLOW_INTERNAL", "Agent dispatch returned without a durable turn.");
      call.turnId = turn.value.id;
      this.options.store.updateCall(call.runId, call.index, { status: "running", turnId: turn.value.id });
      this.options.store.event(call.runId, "agent_turn", { index, agentId: call.agentId, turnId: turn.value.id, repair: false });
      let response = await this.awaitTurn(active, call, turn.value.id);
      let output: unknown = response;
      if (validate) {
        try { output = parseWorkflowOutput(response, validate); }
        catch (error) {
          // Repair only formatting, in the same session with authority reduced to read-only.
          signal.throwIfAborted();
          this.countDispatch(active);
          this.options.store.event(call.runId, "schema_repair", { index, reason: workflowFailure(error).message });
          const repair = await this.options.agents.continue(call.agentId,
            `Your last response failed JSON validation: ${workflowFailure(error).message}\nReturn corrected JSON only. Do not redo the task or change files. Schema: ${JSON.stringify(call.options.schema)}`,
            { writeMode: "read_only" }, call);
          if (repair.isErr()) throw repair.error;
          turn = this.options.agents.getTurn(call.agentId, call);
          if (turn.isErr()) throw turn.error;
          if (!turn.value) throw new WorkflowError("WORKFLOW_INTERNAL", "Schema repair has no durable turn.");
          call.turnId = turn.value.id;
          this.options.store.updateCall(call.runId, call.index, { turnId: turn.value.id });
          this.options.store.event(call.runId, "agent_turn", { index, agentId: call.agentId, turnId: turn.value.id, repair: true });
          response = await this.awaitTurn(active, call, turn.value.id);
          output = parseWorkflowOutput(response, validate);
        }
      }
      output = jsonValue(output, 262_144, "agent result");
      this.options.store.updateCall(call.runId, index, { status: "completed", result: output });
      return output;
    } catch (error) {
      // Resolve ownership again if cancellation raced dispatch or the turn-link write.
      await this.stopOwnedCall(active, call);
      this.options.store.updateCall(call.runId, index, { status: signal.aborted ? "cancelled" : "failed", error: workflowFailure(error) });
      if (workflowFailure(error).code === "WORKFLOW_INTERNAL" || workflowFailure(error).code.includes("LIMIT")) this.fatal(active, error);
      throw error;
    } finally { releaseGlobal?.(); releaseRun?.(); }
  }
  private async awaitTurn(active: ActiveRun, call: WorkflowCall, turnId: number): Promise<string> {
    const signal = active.controller.signal;
    const waited = await this.options.agents.wait([call.agentId], call, undefined, signal);
    if (signal.aborted) {
      await this.stopOwnedCall(active, { ...call, turnId });
      throw signal.reason;
    }
    if (waited.isErr()) throw waited.error;
    const result = waited.value[0];
    if (result?.status === "completed") {
      const response = result.response ?? "";
      if (Buffer.byteLength(response) > 262_144) throw new WorkflowError("WORKFLOW_VALUE_LIMIT", "Agent result exceeds 256 KiB.");
      return response;
    }
    if (result?.status === "failed" || result?.status === "stopped") throw new WorkflowError(result.error?.code ?? "AGENT_STOPPED", result.error?.message ?? "Agent stopped.", result.error?.retryable);
    throw new WorkflowError("WORKFLOW_INTERNAL", "Agent wait ended without a terminal result.");
  }
  private async stopOwnedCall(active: ActiveRun, call: WorkflowCall): Promise<void> {
    for (;;) {
      let uncertainty: unknown;
      try {
        const current = this.options.agents.getTurn(call.agentId, call);
        if (current.isErr()) {
          if (current.error.code === "AGENT_NOT_FOUND" && call.turnId === undefined) return;
          uncertainty = current.error;
        } else {
          if (!current.value || current.value.status !== "running") return;
          if (call.turnId !== undefined && current.value.id !== call.turnId) return;
          call.turnId ??= current.value.id;
          const stopped = await this.options.agents.cancel(call.agentId, call.turnId, call);
          if (stopped.isOk() && stopped.value.status !== "running") return;
          uncertainty = stopped.isErr() ? stopped.error : new Error("Provider has not confirmed stopping.");
        }
      } catch (error) { uncertainty = error; }
      const error = new WorkflowError("RECOVERY_REQUIRED", `Waiting to confirm agent ${call.agentId} stopped: ${workflowFailure(uncertainty).message}`, true);
      this.fatal(active, error);
      try {
        this.options.store.update(active.run.id, { status: "stopping", error: workflowFailure(error) });
        this.options.store.updateCall(call.runId, call.index, { error: workflowFailure(error) });
      } catch { /* Keep ownership in memory until persistence returns or the daemon restarts. */ }
      // Admission remains closed while confirmation is unavailable; cancellation is not completion.
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  private fatal(active: ActiveRun, error: unknown): unknown { active.controller.abort(error); return error; }
  private countDispatch(active: ActiveRun): void {
    if (++active.dispatches > 128) throw this.fatal(active, new WorkflowError("WORKFLOW_CALL_LIMIT", "Workflow exceeds 128 agent turns, including schema repairs."));
  }
  private snapshot(id: string, scope: LocalAgentWorkspaceScope): WorkflowSnapshot {
    const run = this.options.store.get(id);
    if (!run || run.workspaceRoot !== canonicalRoot(scope.workspaceRoot) || run.workspaceId !== scope.workspaceId) {
      throw new WorkflowError("WORKFLOW_NOT_FOUND", `Workflow is not in this workspace: ${id}`);
    }
    return run;
  }
  private async authorize(scope: LocalAgentWorkspaceScope): Promise<LocalAgentWorkspaceScope> {
    const root = await realpath(scope.workspaceRoot);
    if (this.options.allowedRoots) {
      const managed = this.options.config && scope.workspaceId && isManagedWorkflowWorkspace(this.options.config, root, scope.workspaceId);
      if (!managed) await resolveCanonicalAllowedPath(root, root, [...this.options.allowedRoots]);
    }
    return { workspaceRoot: root, ...(scope.workspaceId ? { workspaceId: scope.workspaceId } : {}) };
  }
  private async namedSource(name: string, root: string): Promise<string> {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(name)) throw new WorkflowError("INVALID_WORKFLOW", "Workflow name must be a simple name, without paths.");
    try {
    const path = await resolveCanonicalAllowedPath(join(root, ".devspace", "workflows", `${name}.js`), root, [root]);
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(65_537);
      const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
      if (bytesRead > 65_536) throw new WorkflowError("SOURCE_LIMIT", "Workflow source exceeds 64 KiB.");
      return new TextDecoder("utf-8", { fatal: true }).decode(buffer.subarray(0, bytesRead));
    } finally { await file.close(); }
    } catch (error) {
      if (error instanceof WorkflowError) throw error;
      throw new WorkflowError("INVALID_WORKFLOW", `Cannot read workflow ${name}: ${workflowFailure(error).message}`);
    }
  }
  private async callWorkspace(active: ActiveRun, options: WorkflowAgentOptions, index: number): Promise<LocalAgentWorkspaceScope> {
    if (!options.workspace && !options.isolation) return { workspaceRoot: active.run.workspaceRoot, workspaceId: active.run.workspaceId };
    const key = options.workspace ?? `@call:${index}`;
    let workspace = active.workspaces.get(key);
    if (!workspace) {
      if (!options.isolation) throw new WorkflowError("INVALID_WORKSPACE", `Unknown workflow workspace: ${key}. Create it with isolation: 'worktree'.`);
      if (!this.options.config) throw new WorkflowError("INVALID_WORKSPACE", "Managed worktrees are unavailable.");
      workspace = createWorkflowWorkspace(this.options.config, active.run);
      active.workspaces.set(key, workspace);
      const scope = await workspace;
      this.options.store.event(active.run.id, "workspace_created", { key, ...scope, retained: true });
    }
    return workspace;
  }
}

function summary({ source: _source, args: _args, contextHash: _hash, ...run }: WorkflowSnapshot): WorkflowRun { return run; }
function canonicalRoot(root: string): string {
  try { return realpathSync(root); } catch { return resolve(root); }
}
function jsonValue(value: unknown, bytes: number, label: string): unknown {
  let encoded: string | undefined;
  try { encoded = JSON.stringify(value); } catch { /* Fail with the same public boundary error. */ }
  if (encoded === undefined || Buffer.byteLength(encoded) > bytes) throw new WorkflowError("WORKFLOW_VALUE_LIMIT", `Workflow ${label} must be JSON and at most ${bytes} bytes.`);
  return JSON.parse(encoded);
}
function agentOptions(value: WorkflowAgentOptions, authority: "read_only" | "allowed"): WorkflowAgentOptions {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new WorkflowError("INVALID_AGENT_CALL", "Agent options must be an object.");
  const options = jsonValue(value, 32_768, "agent options") as WorkflowAgentOptions;
  const keys = new Set(["target", "model", "effort", "schema", "label", "phase", "writeMode", "isolation", "workspace"]);
  for (const key of Object.keys(options)) if (!keys.has(key)) throw new WorkflowError("INVALID_AGENT_CALL", `Unknown agent option: ${key}`);
  if (typeof options.target !== "string" || !options.target.trim()) throw new WorkflowError("INVALID_AGENT_CALL", "Agent target is required.");
  for (const key of ["model", "effort", "label", "phase", "workspace"] as const) {
    if (options[key] !== undefined && (typeof options[key] !== "string" || options[key]!.length > 256 || !options[key]!.trim())) throw new WorkflowError("INVALID_AGENT_CALL", `Invalid agent ${key}.`);
  }
  if (options.workspace && !/^[\w-]{1,64}$/.test(options.workspace)) throw new WorkflowError("INVALID_WORKSPACE", "Workspace is a logical name, not a path.");
  if (options.isolation !== undefined && options.isolation !== "worktree") throw new WorkflowError("INVALID_AGENT_CALL", "Only worktree isolation is supported.");
  options.writeMode ??= authority;
  if (!["read_only", "allowed"].includes(options.writeMode) || (authority === "read_only" && options.writeMode !== "read_only")) throw new WorkflowError("WORKFLOW_AUTHORITY", "Agent call cannot increase the workflow's write authority.");
  if (options.schema !== undefined && (!options.schema || typeof options.schema !== "object" || Array.isArray(options.schema))) throw new WorkflowError("INVALID_SCHEMA", "Schema must be an object.");
  return options;
}

class Slots {
  private used = 0;
  private readonly waiting: Array<() => void> = [];
  constructor(private readonly limit: number) {}
  async acquire(signal: AbortSignal): Promise<() => void> {
    signal.throwIfAborted();
    if (this.used >= this.limit) {
      await new Promise<void>((resolve, reject) => {
        const ready = () => { signal.removeEventListener("abort", aborted); resolve(); };
        const aborted = () => { const index = this.waiting.indexOf(ready); if (index >= 0) this.waiting.splice(index, 1); reject(signal.reason); };
        this.waiting.push(ready);
        signal.addEventListener("abort", aborted, { once: true });
      });
    } else this.used++;
    if (signal.aborted) { this.release(); throw signal.reason; }
    return () => this.release();
  }
  private release(): void {
    const next = this.waiting.shift();
    if (next) next(); else this.used--;
  }
}
