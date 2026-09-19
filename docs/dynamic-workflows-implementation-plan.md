# Dynamic workflows: implementation plan

Status: design contract, 2026-09-16. See [the usage guide](dynamic-workflows.md) and the executable schemas/tests for current implementation behavior. This document records the design and acceptance criteria.

## 1. Scope and decisions

Implement every script primitive described in the supplied Claude dynamic-workflow reference: `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, and nested `workflow`. Include the supporting launch, discovery, persistence, inspection, pause, stop, individual-agent restart, editable replay, structured output, worktree, and progress contracts. These are milestones of one complete feature, not optional primitives to defer indefinitely.

Keep orchestration in plain JavaScript and agent execution in DevSpace's existing manager and adapters. The host authors or selects the script and interprets its final result. DevSpace executes the program, enforces authority and resource limits, and makes every child invocation inspectable.

Preserve Claude-shaped script names and syntax. `agentType` resolves a DevSpace profile or built-in provider; it does not mean a Claude-only subagent registry. Model and effort strings remain provider-specific. Default models come from DevSpace configuration and profiles, not an assumption about the remote host's model.

Compatibility means the portable script contract and workflow behavior. Anthropic account billing, slash-menu presentation, keyword highlighting, private cloud infrastructure, and access to a host's authenticated tools cannot be implemented universally by a local MCP server. Expose equivalent capabilities through DevSpace's own execution and presentation boundaries. Do not claim a harness capability that its adapter cannot establish.

The official docs confirm the main script surface and lifecycle. The supplied gist also specifies `budget`, nested `workflow`, and detailed combinator semantics. Treat that union as the requested DevSpace contract, version it as `devspace-workflow/v1`, and maintain a conformance suite. Exact equivalence to undocumented Anthropic internals is not asserted. [Official workflows](https://code.claude.com/docs/en/workflows), [supplied reference](https://gist.github.com/Waishnav/38801adec1580aa689426ba075490670).

## 2. Existing foundation and integration points

The current model-facing route is workspace shell → `devspace agents` → `LocalAgentClient` → private daemon → `LocalAgentManager` → `LocalAgentRuntimePool` → driver. MCP workspace opening publishes agent discovery and instructions; it does not currently register a complete agent-management tool family.

Reuse:

- `src/local-agent-manager.ts`: target resolution, logical agents, turn lifecycle, scoped lookup, wait.
- `src/local-agent-store.ts`: durable agents and turns, typed errors, continuation identity.
- `src/local-agent-runtime.ts` and provider adapters: harness-specific invocation.
- `src/local-agent-daemon*.ts`: one execution owner per state directory, authenticated local IPC.
- `src/workspaces.ts`, `src/workspace-store.ts`, `src/git-worktrees.ts`: workspace identity and managed worktrees.
- `src/db/*`: SQLite, migrations, permissions, transactions.
- `src/local-agent-profiles.ts` and `src/local-agent-targets.ts`: existing profiles and provider defaults.

Required extensions:

- Individual turn cancellation, structured output, usage, optional progress and permission events.
- Persist effective write authority and resolved invocation settings; a continuation cannot accidentally regain the default `allowed` authority.
- Add a shared admission scheduler. The runtime pool is a resource cache, not a concurrency limiter.
- Associate workflow steps with exact logical agents and turns.
- Count live/paused workflows during daemon idle shutdown and configuration replacement.
- Resolve stored managed workspaces using their validated managed root and source ownership. Do not force their path through checkout-only allowed roots, and do not bypass containment.

## 3. Architecture

```text
MCP host / local CLI
        │
        ▼
Workflow service in existing daemon ─── SQLite run/step/event/usage records
        │                                   ▲
        ├── registry + source validation     │
        ├── lifecycle + replay driver ───────┘
        ├── bounded interpreter worker
        │       └── QuickJS guest: JS + eight primitives
        └── validated agent bridge
                └── shared scheduler
                        └── LocalAgentManager
                                └── current harness drivers
```

One interpreter worker per active root run; nested scripts use separately bounded workers admitted through a shared nested-execution limiter. They share the root controller, workflow journal, agent admission limits, and token budget. Each guest has its own heap and CPU ceilings. Parked runs without live interpreter state recover through their journal. No second daemon, broker, distributed leases, graph DSL, or orchestration model is needed.

Use ordinary QuickJS with deferred promises. The bridge returns guest promises immediately and resolves them when daemon operations complete. Explicitly pump pending jobs in bounded batches after each delivery. Configure guest heap/stack limits and an interrupt handler. A worker watchdog provides an independent termination mechanism. [QuickJS documentation](https://github.com/justjake/quickjs-emscripten).

QuickJS is the guest-code boundary; a Node worker is for responsiveness and termination, not an OS security sandbox. Do not evaluate guest source with Node `eval`, `Function`, or `vm`. The worker wrapper, parser, and validator are trusted application code and must also have bounded inputs and watchdogs.

## 4. Common data and naming

The declarations below describe public contracts; scripts themselves are JavaScript, not TypeScript.

```ts
type JsonValue = null | boolean | number | string | JsonValue[] | JsonObject;
type JsonObject = { [key: string]: JsonValue };
type JsonSchema = JsonObject | boolean;
type RunId = string;   // generated wf_... opaque identifier
type StepId = string;  // generated wfs_... opaque identifier

interface WorkflowError {
  code: string;
  message: string;
  layer: "script" | "workflow" | "workspace" | "adapter" | "provider";
  retryable: boolean;
  runId?: RunId;
  stepId?: StepId;
  agentId?: string;
  provider?: string;
  location?: { line: number; column: number };
}
```

JSON numbers must be finite. Reject cycles, BigInt, functions, symbols, accessors, and unsupported objects at crossings that require JSON. Do not silently turn `NaN` into `null`, drop undefined properties, execute getters or user `toJSON`, or stringify errors as `{}`. Top-level `return;` is normalized to JSON `null` and recorded as an omitted result; absent launch `args` remains guest `undefined`.

Use camelCase in scripts, daemon records, and TypeScript. MCP outer parameters follow the existing `workspace_id` convention. MCP source selection uses `script_path` and `resume_from_run_id`; internal requests use `scriptPath` and `resumeFromRunId`. Generate transport validation from one schema definition and test what `tools/list` actually exposes.

For direct local CLI use without an injected workspace ID, resolve/register the current checkout in the workspace store and allocate a stable workspace identity before creating a run. Preserve the distinction between local-user authority and remote MCP allowed-root authority in the authenticated service context. A guest or remote request cannot obtain local-user authority by omitting an ID.

### Configuration schema

```ts
interface WorkflowsConfig {
  enabled: boolean;
  instructions: "on-demand" | "preload";
  defaultAgentType?: string;
  maxConcurrentAgents: number;
  maxConcurrentRuns: number;
  maxAgentsPerRun: number;
  maxAttemptsPerRun: number;
  defaultOutputTokenBudget?: number;
  maxOutputTokenBudget?: number;
  requireWorktreesForConcurrentWrites: boolean;
  maxUsageLimitWaits: number;
  maxUsageLimitWaitMs: number;
  limits: {
    scriptBytes: number; argsBytes: number; promptBytes: number;
    schemaBytes: number; schemaDepth: number;
    agentResultBytes: number; runResultBytes: number;
    guestHeapBytes: number; guestStackBytes: number;
    guestSliceMs: number; guestTotalCpuMs: number; runActiveMs: number;
    logMessageBytes: number; logTotalBytes: number; eventsPerRun: number;
  };
}
```

Use strict Zod objects, positive safe integers with implementation maximums, and defaults from the limits table. Persist the effective configuration per run. Script metadata cannot override these values. Configuration changes affect new work; disabling execution prevents new dispatches, while lowering a limit does not retroactively erase running attempts or recorded results.

Add optional `writeMode` to user-owned agent profiles and their schema, interpreted only as a restriction on inherited run authority. Effective authority is the intersection of host/workspace policy, operator configuration, run snapshot, and profile restriction. Do not interpret prose such as 'read-only reviewer' as a permission setting. A profile cannot broaden authority by naming `full_access`.

## 5. Script format and metadata

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files and independently verify findings',
  whenToUse: 'When a change needs review across many files',
  phases: [
    { title: 'Review', detail: 'Find possible defects' },
    { title: 'Verify', detail: 'Check the evidence' },
  ],
}

// Ordinary JavaScript, with top-level await and return.
const results = await pipeline(args.files, file => agent(`Review ${file}`))
return results
```

```ts
interface WorkflowMeta {
  name: string;        // 1..128 characters; kebab-case local name
  description: string; // 1..2,000 characters
  whenToUse?: string;  // up to 2,000 characters
  phases?: Array<{
    title: string;     // 1..200 characters, unique within this metadata block
    detail?: string;  // up to 2,000 characters
    model?: string;   // opaque provider model identifier
  }>;
}
```

Parser rules:

1. Permit comments and whitespace before the first statement.
2. Require that statement to be a single `export const meta = { ... }` declaration.
3. Decode its AST as literal data: object, array, string, finite numeric, boolean, and null literals only. Reject calls, identifiers as values, computed keys, spreads, getters, methods, regex literals, duplicate keys, and interpolated templates.
4. Permit ordinary property-name syntax such as `name:`. Reject prototype-sensitive metadata keys rather than assigning them into ordinary objects.
5. Validate the decoded metadata and reject other module exports and all import declarations/expressions.
6. Remove only the metadata statement by AST offsets, preserving newlines; wrap the body in an async function inside QuickJS. Map runtime errors back to original source lines.
7. Keep `meta` available as frozen data in the guest if the body references it.

Use TypeScript AST with a pinned ECMAScript grammar compatible with the chosen QuickJS build, module parsing, top-level return enabled, and location tracking. Do not split source with regex or execute metadata to discover it. [TypeScript AST parser](https://github.com/acornjs/acorn).

The guest has normal JS collections, promises, expressions, and control flow. It has no `process`, `require`, host filesystem/network functions, subprocesses, timers, module loader, credentials, or daemon client. Deny dynamic imports both during source validation and at the interpreter loader boundary. Code constructed inside the guest cannot gain a host loader.

Make nondeterministic clock/random APIs unavailable: `Date.now()`, zero-argument Date construction, Date-as-function, `Math.random()`, and equivalent exposed entropy sources. Allow explicit fixed dates. Pin timezone/locale-dependent behavior or reject locale-dependent operations; do not let replay depend on the machine's current timezone. Freeze protected intrinsic methods so scripts cannot restore prohibited APIs. Input timestamps and seeds belong in `args`.

## 6. Full primitive contracts

### 6.1 `agent(prompt, options)`

```ts
interface AgentOptions {
  label?: string;                  // 1..200 characters
  phase?: string;                  // 1..200 characters
  schema?: JsonSchema;
  model?: string;                  // nonempty opaque provider value
  effort?: string;                 // nonempty opaque provider value
  isolation?: "worktree";
  agentType?: string;              // DevSpace profile or provider target
}

declare function agent(
  prompt: string,
  options?: AgentOptions,
): Promise<string | JsonValue | null>;
```

Prompt must contain non-whitespace text and remain within the configured byte bound. Options are strict: unknown fields fail validation. Copy and validate options when invoked; later mutations must not change a queued request.

Semantics:

- Every call creates a fresh logical DevSpace agent. Structured-output correction continues that agent; it does not create an unrelated worker.
- Resolve to final text without `schema`, validated JSON with `schema`, or `null` for a skipped, individually stopped, policy-blocked, or terminally failed agent. The journal retains the distinct outcome and original safe error.
- Invalid options, unavailable target/configuration, invalid schema, and exhausted schema correction reject with a typed error. Combinators convert task-level rejection to a null slot as specified below.
- A run-level stop or interpreter failure cannot be neutralized by catching an agent rejection: the daemon independently closes admission and terminates/parks the run.
- The worker receives the self-contained task plus selected profile and resolved workspace instructions. It does not inherit an unavailable parent transcript.
- Authority is inherited from the run and can only be narrowed. Script options cannot request `full_access`, add roots, or inject environment variables.
- The return value stays compact. IDs, tool events, usage, worktree references, and raw provider diagnostics are inspectable through step details.

Agent target precedence: call `agentType` → launch `agentType` → configured workflow default. If unresolved, fail clearly. Existing profile resolution precedes raw provider lookup. No arbitrary choice of the first installed provider.

Model precedence: call `model` → matching phase metadata `model` → launch `model` → selected profile `model` → provider default. Effort: call → launch → profile → provider default. An incompatible model/effort is an explicit error; never silently translate another provider's naming or substitute a different provider. Freeze effective values in the step record. A phase's model matters only when the call has not provided its own model.

### 6.2 `parallel(tasks)`

```ts
declare function parallel<T>(
  tasks: Array<() => T | Promise<T>>,
): Promise<Array<T | null>>;
```

Validate the full input before invoking any thunk. Require a dense array of functions, length 0..4,096. Call thunks in input order, launch their work concurrently, await every settlement, and preserve input order in results. Synchronous throws and rejected task promises yield `null` at that position. Successful `false`, `0`, empty string, and `null` values are preserved.

Empty input resolves to `[]`. Invalid input rejects; the statement that the combinator swallows failures applies to valid task execution, not its own argument validation or root termination. Record task failures with combinator index and source location. A failure must remain visible even if the script filters nulls.

The helper never owns a scheduler slot. Each underlying agent does. Nested `parallel` calls use the same root admission limits.

### 6.3 `pipeline(items, ...stages)`

```ts
type PipelineStage = (
  previous: unknown,
  originalItem: unknown,
  index: number,
) => unknown | Promise<unknown>;

declare function pipeline(
  items: unknown[],
  ...stages: PipelineStage[]
): Promise<unknown[]>;
```

Require a dense items array of length 0..4,096 and at least one callable stage. Validate everything before invoking a stage. For item `items[i]`, call stage 1 with `(items[i], items[i], i)` and later stages with `(previousResult, items[i], i)`.

Different items advance independently. There is no barrier between stages. Results retain original item ordering; intermediate arrays are not implicitly flattened. Pure transformations are allowed and consume no agent slot. A thrown/rejected stage makes that item's final slot `null` and skips its remaining stages.

A successfully returned `null` is an ordinary stage value and is passed onward; only a failure skips the chain. This distinction must be tested because `agent()` can resolve to `null`. Authors who want to stop on null explicitly branch in their next stage.

`originalItem` is the original JS reference inside the guest. It is not automatically cloned per stage. Guest state sharing remains ordinary JavaScript, with concurrency pitfalls documented.

### 6.4 `phase(title)`

```ts
declare function phase(title: string): void;
```

Validate 1..200 characters. Set the default phase for subsequent calls in the current script context and emit a phase event. It introduces no barrier, transaction, worktree, or budget scope. Match metadata titles exactly; unknown titles create dynamic groups.

Capture the phase at agent invocation, not at queue dispatch. Per-call `options.phase` wins. Concurrent callbacks share this script-local default; use explicit phases in those callbacks. Nested workflows have their own phase default, so child code cannot overwrite the parent's default.

### 6.5 `log(message)`

```ts
declare function log(message: string): void;
```

Emit a bounded structured progress event with run/child context and timestamp supplied by the daemon. Strings only; at most 8 KiB each by default. No implicit console dumping or provider-secret serialization. Preserve order within a script. Limit total log bytes and event count; report an explicit quota event rather than silently dropping messages.

Replay must not duplicate previous user-visible log events. A replay view links to original events; genuinely new execution appends new events.

### 6.6 `args`

```ts
declare const args: JsonValue | undefined;
```

Absent input becomes `undefined`; explicit JSON null remains null. Objects/arrays arrive as objects/arrays, never double-encoded JSON strings. Clone the persisted launch arguments into each script context. Scripts may mutate their local copy, but cannot mutate the durable launch record or another context. Nested calls receive only their explicit arguments.

### 6.7 `budget`

```ts
declare const budget: {
  readonly total: number | null;
  spent(): number;
  remaining(): number; // Infinity only inside JS when total is null
};
```

Unit: provider-reported output tokens, with adapter definitions stating whether reasoning tokens are already included. Input/cache counts are separately observable and are not added to `spent()`. Do not derive output usage from final text length.

Root run, nested workflows, structured-output corrections, retries, and individual restarts share one ledger. Replay cache hits add no new usage. A resume lineage retains prior real spending; editing the script is not a budget reset.

`spent()` reads the latest accounted usage delivered to the interpreter. `remaining()` is `max(0, total - spent)` or Infinity when unlimited. Return getters are synchronous, so their observations must be journaled for deterministic replay. The daemon performs authoritative admission checks even if the interpreter has a slightly older snapshot.

Check budget at invocation and again before dispatch. Once accounted spending reaches the limit, no further provider attempts start, including queued work. Already-running attempts can finish and overshoot. This is a dispatch budget, not a guaranteed maximum bill. Do not market it as one.

Unknown usage cannot be represented as zero. If any executed target cannot provide reliable usage, `spent()`/`remaining()` throw `USAGE_UNAVAILABLE`; `total` remains readable. A finite-budget run rejects an unmetered target before dispatch. Unlimited runs can use that target, with usage marked incomplete in status. A failed attempt with unknown incurred usage similarly makes the ledger incomplete and blocks further finite-budget dispatch until reconciled.

Host-session budget sharing is optional integration, not assumed MCP functionality. The public launch surface exposes only `outputTokenBudget`. A trusted host adapter may internally bind multiple root runs to one ledger and report external host usage with deduplication IDs; guest scripts cannot create these reports. Without that integration, budget scope is the root workflow lineage, explicitly reported in status.

### 6.8 `workflow(reference, childArgs)`

```ts
declare function workflow(
  reference: string | { scriptPath: string },
  childArgs?: JsonValue,
): Promise<JsonValue>;
```

String resolves a registered workflow name. Object is strict and contains only `scriptPath`. Resolve paths relative to the parent script's source directory when it has one, otherwise its workspace root; then apply the same approved-root and registry rules as launch.

Root depth is 0; child depth is 1. Calling `workflow` from a child fails with `NESTING_LIMIT`. Child script, metadata, arguments, and source hash are persisted as an invocation record. Child execution shares root concurrency, total agent/attempt counters, budget, stop signal, deadline, and maximum authority. It cannot raise any limit.

Use a separate guest context so top-level variables and default phases do not collide. Represent child phases under a child group in progress. The parent awaits the child's JSON return value. Resolution, syntax, and runtime failures reject the nested call and remain inspectable. Child invocations themselves have a root-wide count cap so a loop over zero-agent children cannot evade resource bounds.

## 7. Launch and management schemas

### 7.1 Launch

```ts
interface RunWorkflowInput {
  workspace_id: string;
  script?: string;
  name?: string;
  scriptPath?: string;
  args?: JsonValue;
  resumeFromRunId?: RunId;
  agentType?: string;
  model?: string;
  effort?: string;
  outputTokenBudget?: number; // positive safe integer
}

interface RunWorkflowReceipt {
  runId: RunId;
  status: "running";
  workflowName: string;
  scriptPath: string;       // readable editable copy; running snapshot is immutable
  transcriptDir: string;    // authorized export directory, not raw stateDir access
  revision: number;
  resumedFromRunId?: RunId;
  warnings?: Array<{ code: string; message: string }>;
}
```

At least one source is required. Preserve reference source precedence: `scriptPath` > `name` > `script`. If several are supplied, expose which was selected in diagnostics; never merge them. Keep title/description exclusively in `meta`; do not introduce ignored duplicate fields.

Validate all transport fields, source bounds, source paths, metadata, syntax, baseline target, permissions, and resume eligibility before returning a receipt. A syntax error is a failed launch, not a success-shaped background task. Dynamic call-specific targets/schemas are validated when invoked.

Create the durable run before starting its interpreter. Return after acceptance, never wait for the script's final result. Do not return daemon endpoint, credentials, provider session IDs, or internal worker routing.

CLI `run <script-path>` and `run --name <name>` map to the same service. Accept JSON arguments via a file or stdin to avoid shell-quoting mistakes. CLI uses current-workspace resolution and supplies a validated internal scope; MCP callers must supply `workspace_id`.

### 7.2 Read and control

```ts
type WorkflowState =
  | "starting" | "running" | "pausing" | "paused"
  | "waiting_for_permission" | "waiting_for_usage"
  | "stopping" | "stopped" | "completed" | "failed"
  | "recovery_required";

interface WorkflowRef { workspace_id: string; runId: RunId }

interface GetWorkflowInput extends WorkflowRef {
  afterRevision?: number;
  stepId?: StepId; // request one detailed child; default is compact summary
}

interface WaitWorkflowInput extends WorkflowRef {
  afterRevision?: number;
  timeoutMs?: number; // 0..60,000; default 30,000
}

type ControlWorkflowInput = WorkflowRef & (
  | { action: "pause" | "resume" | "stop" }
  | { action: "stop_agent" | "restart_agent"; stepId: StepId }
);

interface ListWorkflowsInput {
  workspace_id: string;
  kind: "definitions" | "runs";
  cursor?: string;
  limit?: number; // 1..100, default 20
}

interface SaveWorkflowInput extends WorkflowRef {
  name: string;
  location: "project" | "user";
  replace?: boolean; // false by default; explicit conflict handling
}
```

MCP names: `run_workflow`, `get_workflow`, `wait_workflow`, `control_workflow`, `list_workflows`, `save_workflow`. Register identical contracts across this checkout's actual `claude` and `codex` tool modes; do not invent extra modes from historical documentation. Tools disappear when workflows are disabled. Continue supporting the equivalent CLI through existing workspace shell tools.

`wait_workflow` returns on terminal state, attention-required state, a newer revision, or timeout. Without `afterRevision`, capture the current revision on entry. It never cancels execution when the connection closes. Notifications are optional hints; durable read/wait is the source of truth. A host reconnect can always retrieve results.

### 7.3 Status output

```ts
interface WorkflowSnapshot {
  runId: RunId;
  workflowName: string;
  state: WorkflowState;
  revision: number;
  counts: {
    requested: number; queued: number; running: number;
    completed: number; failed: number; stopped: number; cached: number;
  };
  usage: {
    outputTokens: number | null;
    knownOutputTokens: number;
    complete: boolean;
    budgetTotal: number | null;
    remaining: number | null; // null if unlimited or unknown; never wire Infinity
    scope: "workflow_lineage" | "host_session";
  };
  phases: Array<{
    id: string; title: string; parentId?: string;
    running: number; completed: number; failed: number;
  }>;
  result?: JsonValue;
  resultArtifact?: { id: string; path: string; bytes: number };
  error?: WorkflowError;
  pauseReason?: string;
  nextEligibleAt?: string;
  partial: boolean;
  warnings: Array<{ code: string; message: string }>;
  events?: WorkflowEvent[];
  nextCursor?: string;
}
```

`completed` means the script returned, not that every child succeeded. Set `partial` when any child failed/stopped or unresolved coverage was reported. Return both summary counters and the script result so filtering cannot hide failed execution. Large results are persisted intact and exposed as artifacts rather than silently truncated.

### 7.4 Step and event details

```ts
type StepState =
  | "queued" | "starting" | "running" | "waiting_for_permission"
  | "waiting_for_usage" | "completed" | "failed" | "stopped"
  | "cached" | "uncertain";

interface WorkflowStepSnapshot {
  id: StepId;
  runId: RunId;
  parentStepId?: StepId;
  kind: "agent" | "workflow";
  state: StepState;
  callSequence: number;
  phase?: string;
  label?: string;
  agentId?: string;
  agentType?: string;
  provider?: string;
  model?: string;
  effort?: string;
  workspaceId: string;
  prompt?: string; // detailed scoped response only
  attempts: number;
  output?: JsonValue;
  outputArtifact?: { id: string; path: string; bytes: number };
  error?: WorkflowError;
  cachedFromStepId?: StepId;
  worktree?: { workspaceId: string; path: string; baseSha: string; changed: boolean };
}

type WorkflowEvent = {
  runId: RunId;
  sequence: number;
  timestamp: string;
  stepId?: StepId;
} & (
  | { type: "run_state"; state: WorkflowState; reason?: string }
  | { type: "step_state"; state: StepState; attemptId?: string }
  | { type: "phase"; title: string; parentGroupId?: string }
  | { type: "log"; message: string }
  | { type: "usage"; attemptId: string; outputTokens: number; complete: boolean }
  | { type: "tool"; toolCallId: string; name: string; state: "started" | "completed" | "failed"; summary?: string }
  | { type: "warning"; code: string; message: string }
  | { type: "error"; error: WorkflowError }
  | { type: "result"; artifactId?: string }
);
```

Internal replay records additionally carry request/delivery IDs and budget observations; public events omit routing internals. Bound tool summaries and keep full inputs/outputs in protected detail artifacts. A `final_only` adapter exposes its final step result without manufacturing intermediate tool events.

Permission events use an internal `PermissionRequest` containing a request ID, exact step/attempt identity, safe action description, and allowed decisions. Resolution requires an authenticated user-approval channel bound to that request, not an arbitrary script response or a free-form 'approved' string. A headless host without that channel receives an actionable waiting/failure state; configured operator policy may already authorize the action.

Function-taking combinators are guest JavaScript APIs, not JSON-RPC schemas: validate their callable arguments inside the guest. Only data crossing the bridge receives JSON Schema/Zod transport validation. Publish declaration files and examples for script authoring alongside generated MCP JSON schemas.

## 8. Structured-output execution

Use a real JSON Schema validator. Support Draft 7 and 2020-12 with distinct validator instances, defaulting to 2020-12 if `$schema` is omitted. Document the supported dialects and annotation policy. Local `$ref` within the submitted schema is supported; disable network/file schema loading and arbitrary custom keywords. No coercion, inserted defaults, or additional-property removal.

Ajv is the proposed implementation. Its documentation explicitly treats untrusted schemas as a resource risk. Compile and validate in a disposable validation worker with byte/depth limits, an independent time limit, bounded cache, and memory limits, never synchronously on the daemon's event loop. [Ajv security](https://ajv.js.org/security.html).

Do not confuse schema validity with satisfiability. Add only provably sound contradiction checks: for example, a required object key that is neither declared nor admitted by any pattern when `additionalProperties: false` at that same schema node. Also check obvious impossible bounds. Do not reject valid `allOf`/conditional/recursive schemas using a naive global heuristic.

Dispatch algorithm:

1. Compile and validate the schema before starting this agent.
2. Resolve adapter capabilities for the actual target/model.
3. Ask the adapter for native structured output if it supports this schema dialect/subset; otherwise instruct the agent to return JSON and validate centrally.
4. Validate native output too. For text fallback, parse either the entire response as JSON or one complete JSON-fenced response; never extract an arbitrary brace-delimited substring from prose.
5. On mismatch, continue the same agent with bounded validation errors and a request to format its existing result. Up to five total output attempts by default, including the initial answer.
6. Correction turns use no tools when supported; otherwise enforce read-only tools through the adapter. If neither can be enforced, fail instead of allowing a formatting retry to repeat mutations.
7. Every correction is a separate durable turn/attempt, consumes actual budget, and remains part of one workflow step.
8. On exhaustion reject with `SCHEMA_VALIDATION_FAILED`, retaining the last bounded validation error and raw-output artifact.

Successful schema output may itself be JSON null; the step status distinguishes that from a failed-agent null return.

## 9. Scheduling, limits, and completion ownership

Place admission above `LocalAgentManager.begin` and below all workflow bridges. Use a daemon-global ceiling and per-root ceiling; optionally constrain a provider where its runtime needs a smaller limit. Schedule eligible root queues fairly. A paused root cannot occupy the head of the global queue indefinitely.

Proposed defaults, to be verified with load tests:

| Bound | Default |
|---|---:|
| Active agent turns per root | `max(1, min(16, availableParallelism() - 2))` |
| Active agent turns across daemon | 16 |
| Agent invocations per root execution | 1,000, shared with nested scripts |
| Provider turns/attempts per root execution | 5,000, including repair/restart |
| Items per combinator | 4,096 |
| Nested depth | 1 |
| Nested invocations per root | 1,000 |
| Active interpreter roots | 4 |
| Script source | 256 KiB |
| Launch arguments / individual agent prompt | 1 MiB each |
| Schema size / structural depth | 128 KiB / 64 |
| Individual structured result | 4 MiB |
| Root final result | 16 MiB |
| Guest heap per root | 64 MiB |
| Guest stack per context | 1 MiB |
| Continuous guest execution slice | 1 second watchdog ceiling |
| Cumulative guest execution | 30 seconds, excluding provider wait |
| Wall time | 6 hours of active elapsed run time |
| Logs | 8 KiB/message, 1 MiB/root |
| Durable events | 100,000/root; terminal transition has reserved capacity |
| Structured-output attempts | 5 total |

These are DevSpace resource-policy proposals, not claims about exact Anthropic constants. Time suspended for a deliberate pause or rate-limit wait is separately tracked and bounded by a retention/wait policy. Limit overrides belong in trusted configuration, not in arbitrary script metadata. Caller-supplied budgets can narrow configured ceilings but cannot enlarge them.

Count invocations at validated call admission, before awaiting provider startup. Count cache hits in logical invocation counts, but not in active slots or new usage. Retry/restart cannot reset attempt caps. A new run created by explicit resume has a new execution counter and retained lineage spending; retain lifetime audit totals separately.

The daemon rechecks current enablement and scope before every live dispatch. Profile content used by a run is frozen at resolution for consistency; disabling a provider remains effective immediately at the admission boundary.

Unawaited work is still owned by the run. When the body returns, enter an internal settling phase and wait for all accepted child operations; no workflow may report terminal completion while owned agents still run. On a body exception or hard deadline, stop admission and cancel owned work before finalizing. `Promise.race` does not implicitly abandon or cancel losing agents.

Limit failures reject subsequent calls and set an authoritative admission-closed reason. Script code may catch an agent-count or budget failure and return a partial report, but cannot reopen admission. Infinite loops are stopped by interpreter limits independently of agent limits.

## 10. Agent-adapter contract

Extend existing types instead of replacing the agent system:

```ts
interface AgentCapabilities {
  cancellation: "turn" | "dedicated_process" | "unsupported";
  structuredOutput: "native" | "validated_text";
  usage: "streaming" | "final" | "unavailable";
  correctionAuthority: "no_tools" | "read_only" | "unsupported";
  permissionRequests: "interactive" | "preconfigured";
  progress: "tools_and_text" | "text" | "final_only";
}

interface AgentUsageUpdate {
  attemptId: string;
  sequence: number;
  outputTokens: number; // cumulative within this attempt, not a delta
  inputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number; // informational; do not double-add
  final: boolean;
}

interface AgentRunControl {
  signal: AbortSignal; // per turn, not shared runtime
}

// Add to LocalAgentRunInput:
//   outputSchema?: JsonSchema
//   attemptId: string
//   toolPolicy?: "normal" | "read_only" | "none"
// Add to result:
//   structuredOutput?: JsonValue
//   usage?: AgentUsageUpdate
// Add to callbacks:
//   onUsage?, onProgress?, onPermissionRequest?
// Pass AgentRunControl separately to runtime.run().
```

Capabilities are resolved by adapter/version/model where necessary. They are operational checks, not knobs the host model must manage. Profiles stay the model's primary choice.

Implementation targets by adapter (verify exact installed protocol fields before coding):

| Harness | Cancellation work | Output/accounting work |
|---|---|---|
| Codex app-server | Address interruption to the specific thread and turn | Consume supported output-schema and usage events; retain thread ID |
| Claude SDK | Interrupt the specific query/turn | Native structured output/result usage where exposed |
| OpenCode SDK | Abort the specific server-side session; aborting HTTP alone is insufficient | Consume structured result/token fields from session messages |
| Pi SDK | Abort the particular AgentSession | Validate final text or a configured structured tool result; aggregate model usage |
| Cursor ACP | Session-scoped protocol cancellation | Capability negotiation; JSON fallback; explicit usage support check |
| Copilot ACP | Session-scoped protocol cancellation | Same common ACP contract, independent capability tests |
| Grok ACP | Session-scoped protocol cancellation | Preserve existing Grok model/effort mapping; probe actual usage support |

These are adapter implementation requirements, not a claim that all current adapters already expose every field. If a provider lacks reliable per-session cancellation, use a runtime dedicated to that workflow agent so it can be stopped without affecting siblings. If even that cannot establish remote termination, keep the step unresolved/recovery-required and prevent replacement dispatch until reconciled. Never claim that disconnecting a client proves a remote turn stopped.

Add `LocalAgentManager.stop(agentId, turnId, scope)` and a matching authenticated IPC method. Stop the captured turn; a delayed cancellation must never stop a newer continuation. Persist terminal completion versus cancellation with a compare-and-set winner.

Keep provider-native nested-agent spawning from bypassing DevSpace limits: disable it for workflow children where supported. Otherwise count/observe descendants if the protocol exposes them and report the limitation; a strict bounded-fleet configuration must reject targets that can autonomously spawn unaccounted descendants. This applies to shell-mediated reentry too: cooperative provenance can enforce DevSpace calls, but unrestricted shell is not a sandbox and cannot guarantee containment of arbitrary external agent launches.

## 11. Persistence and transaction boundaries

Reuse the existing SQLite database. Add migrations after the current version 8. Share the daemon's database handle between agent and workflow stores where a transaction spans both; separate connections cannot provide one atomic unit of work.

Logical table definitions (all IDs and foreign keys scoped and validated by the service):

```text
workflow_runs
  id TEXT PRIMARY KEY
  workspace_id TEXT NOT NULL
  workspace_root TEXT NOT NULL
  lineage_id TEXT NOT NULL
  budget_id TEXT NOT NULL
  resumed_from_run_id TEXT NULL
  state TEXT NOT NULL
  meta_json TEXT NOT NULL
  script_source TEXT NOT NULL
  script_hash TEXT NOT NULL
  source_path TEXT NULL
  args_present INTEGER NOT NULL
  args_json TEXT NULL
  defaults_json TEXT NOT NULL
  policy_json TEXT NOT NULL
  runtime_version TEXT NOT NULL
  revision INTEGER NOT NULL
  execution_generation INTEGER NOT NULL
  result_json TEXT NULL
  result_artifact_id TEXT NULL
  error_json TEXT NULL
  pause_reason TEXT NULL
  next_eligible_at TEXT NULL
  created_at / updated_at / finished_at TEXT

workflow_steps
  id TEXT PRIMARY KEY
  run_id TEXT NOT NULL REFERENCES workflow_runs(id)
  parent_step_id TEXT NULL REFERENCES workflow_steps(id)
  kind TEXT NOT NULL                    -- agent | workflow
  call_sequence INTEGER NOT NULL        -- root-wide monotonic order
  logical_path TEXT NOT NULL            -- child/combinator diagnostic identity
  request_hash TEXT NOT NULL
  request_json TEXT NOT NULL            -- effective frozen request
  phase TEXT NULL
  label TEXT NULL
  status TEXT NOT NULL
  agent_id TEXT NULL
  workspace_id TEXT NOT NULL
  cached_from_step_id TEXT NULL
  output_json TEXT NULL
  error_json TEXT NULL
  delivery_sequence INTEGER NULL
  created_at / updated_at / finished_at TEXT
  UNIQUE(run_id, call_sequence)

workflow_attempts
  id TEXT PRIMARY KEY
  step_id TEXT NOT NULL REFERENCES workflow_steps(id)
  attempt_number INTEGER NOT NULL
  agent_id TEXT NOT NULL
  agent_turn_id INTEGER NOT NULL
  reason TEXT NOT NULL                  -- initial | schema_repair | restart | retry
  state TEXT NOT NULL
  usage_sequence INTEGER NOT NULL DEFAULT 0
  output_tokens INTEGER NULL
  usage_complete INTEGER NOT NULL DEFAULT 0
  error_json TEXT NULL
  UNIQUE(step_id, attempt_number)
  UNIQUE(agent_turn_id)

workflow_events
  run_id TEXT NOT NULL REFERENCES workflow_runs(id)
  sequence INTEGER NOT NULL
  step_id TEXT NULL
  type TEXT NOT NULL
  payload_json TEXT NOT NULL
  created_at TEXT NOT NULL
  PRIMARY KEY(run_id, sequence)

workflow_budgets
  id TEXT PRIMARY KEY                    -- root lineage or trusted host scope
  total_output_tokens INTEGER NULL
  known_output_tokens INTEGER NOT NULL
  usage_complete INTEGER NOT NULL
  revision INTEGER NOT NULL
```

Add budget ID linkage to runs and usage rows for trusted external reports only if host-session accounting is implemented. Within workflow-only accounting, attempts are the deduplication source of truth. Store provider session identity in the existing agent table, not in every workflow record.

Use foreign keys, CHECK constraints for enum states/nonnegative counts, unique sequence constraints, and indices on `(workspace_id, updated_at)`, `(run_id, status)`, and `(step_id, attempt_number)`. The exact state enums are shared with validation code. Add workflow association/effective authority fields to existing agent turns where needed.

Atomic boundaries:

1. Launch: run snapshot + initial event.
2. Dispatch preparation: queued step + logical agent + initial turn + attempt association. Persist before contacting a provider.
3. Provider identity callback: save continuation ID before further work, preserving the current awaited callback pattern.
4. Attempt completion: agent turn outcome + attempt status + usage delta + step outcome + event + revision. Commit before delivering a guest promise result.
5. Replay hit: new step links to old immutable output; no provider dispatch or usage increment.
6. Control action: change generation/state + control event before signalling running code.

Do not hold a database transaction across an await or provider call. Provider dispatch cannot be atomically committed with local SQLite. On the crash window after sending work but before recording its remote identity, mark the attempt uncertain; do not automatically resend it. No exactly-once side-effect claim.

JSONL journals and agent transcripts are exports from canonical records, not a second mutable source of truth. Export by append sequence with rebuild support. Keep state-directory permissions private. If stronger power-loss durability is required, use a workflow database policy that changes SQLite synchronous settings deliberately and test it; the current `NORMAL` setting should not be described as a guarantee against every power-loss window.

## 12. Interpreter/daemon bridge

The interpreter receives a validated launch snapshot and an opaque run binding. It never receives the daemon authentication token. Bind all IPC messages to the worker instance and execution generation; reject late messages after stop/restart.

```ts
type GuestRequest = {
  requestId: number;
  generation: number;
} & (
  | { op: "agent"; prompt: string; options: AgentOptions }
  | { op: "workflow"; reference: string | { scriptPath: string }; argsPresent: boolean; args?: JsonValue }
  | { op: "phase"; title: string }
  | { op: "log"; message: string }
  | { op: "budget_read"; getter: "spent" | "remaining"; observationIndex: number }
);

type GuestReply = {
  requestId: number;
  generation: number;
  deliverySequence: number;
  budgetSnapshot: { total: number | null; knownSpent: number; complete: boolean };
} & (
  | { ok: true; value: JsonValue }
  | { ok: false; error: WorkflowError }
);
```

`budget_read` records an observation of the worker's already-delivered budget snapshot; it does not block synchronously waiting for the daemon. During replay, feed recorded observations to synchronous getters. Phase/log messages are buffered in order with bounded memory and persisted before any subsequent provider dispatch or terminal acknowledgement.

The bridge validates message shape, byte size, sequence, generation, and policy again. Guest references are copied as data, not passed as host objects. Adapter results/errors are explicitly serialized. Message traffic is bounded; a script cannot queue unlimited unresolved RPC requests.

Dispose guest value handles, pending deferred promises, contexts, and worker resources on every exit. Pump jobs with an instruction/time budget, including microtasks recursively spawning more microtasks. A never-settling promise with no outstanding accepted operations produces a stalled-script diagnostic; a total deadline remains the final bound.

## 13. Editable replay and recovery

The replay contract is explicit reuse of prior recorded observations, not proof that the working tree or external world has stayed unchanged.

Each valid agent request gets a root-wide sequence before dispatch. Its hash covers prompt, supplied options including label/phase, effective profile content hash, provider, model, effort, output schema, effective authority, workspace identity, requested isolation/base snapshot, and relevant runtime contract version. Canonicalize object keys but preserve array order. Exclude credentials and ephemeral runtime handles.

Do not include the whole new script hash in every call hash: changing only final aggregation should still reuse earlier calls. Keep script hashes in run/invocation records for provenance. Snapshot nested source and arguments; an edited nested body can replay matching internal calls, but cannot simply return the old whole-child output without inspecting its changed script. A nested boundary matches reference, child arguments, and inherited execution context; its source hash is provenance rather than an automatic whole-subtree cache key. Always execute the newly selected child body through the replay driver and compare its internal calls.

Resume procedure:

1. Resolve and authorize the source run in the same stored workspace scope. Require compatible runtime contract and existing journal.
2. Reject if source agents may still be active. Obtain a serialized claim preventing simultaneous resumes of the same source generation.
3. Create a new run with new source/args and a link to the prior run. Omitted resume args inherit prior args including presence/absence; explicit args replace them. Retain policy ceilings and spending lineage; authority never expands implicitly.
4. Re-execute the new script in a fresh guest context. Match its requested calls against the prior successful prefix. Known failed/stopped/uncertain requests establish the earliest non-reusable boundary.
5. Return saved results only for completed, matching calls before that boundary. At the first mismatch/new/failed call, switch permanently to live execution for the remainder. Do not opportunistically reuse later steps.
6. Preserve the original outputs and errors. Record every replayed step's origin.

Concurrency makes a prompt-only journal insufficient. Record request order, guest-visible promise-delivery order, rejection delivery, nested invocation boundaries, and budget getter observations. During replay, a driver releases cached completions in the recorded relative order when their requests exist. Run guest microtasks between deliveries as originally observed. Do not instantly resolve every cached promise: that can change `Promise.race`, pipeline fan-out order, and subsequent prompts.

If edited code requests a different call, diverge explicitly. If replay is unable to satisfy a required recorded dependency and cannot safely establish divergence, return `REPLAY_DIVERGED` with location rather than hanging. Once live execution starts, continue pending reusable completions consistently, then record the new live schedule. Build specific conformance tests for overlapping pipelines and failures before implementing broad replay claims.

Record workspace HEAD, mode, isolation snapshot, and a change summary at start/end. Report observed workspace changes on resume, but acknowledge that external files, ignored files, network state, and arbitrary shell effects cannot be fully fingerprinted. Callers needing fresh observations start a new run. Resume does not restore an entire filesystem or undo side effects.

Daemon crash recovery first reconciles provider attempts. If a provider can establish a turn completed, recover its result. If still running, attach/observe or cancel through its supported API. If identity or status is uncertain, use `recovery_required`; never interpret that as permission to launch a duplicate writer. Runtime versions that cannot reattach must establish termination before replay.

Persist completed steps so new MCP connections and daemon restarts can recover them. This extends scope beyond a host's transient conversation session without pretending to reproduce Anthropic cloud VM infrastructure.

## 14. Lifecycle and controls

```text
starting → running → completed
                  → pausing → paused → running
                  → waiting_for_permission → running
                  → waiting_for_usage → running
                  → stopping → stopped
                  → failed
crash/uncertain provider state → recovery_required → explicit reconciliation/replay
```

Pause means stop admitting new provider attempts and stop delivering new guest completions. Active agents may finish; persist their results. Transition to paused after active owned turns settle. This is a safe boundary pause, not an assertion that every harness can suspend a model mid-generation. Resume continues the same live run when its interpreter exists; a parked/crashed interpreter uses recorded replay after reconciliation.

Stop means close admission, reject queued work, signal every active child, terminate guest execution, and await cancellation acknowledgements. Remain `stopping` while any owned work is unconfirmed. Repeated stop is idempotent and may resend cancellation; it never expands to an unrelated shared runtime.

Individual stop resolves that agent's promise to null, records a stopped step, and lets siblings continue. Individual restart is permitted only before the current step's result has been delivered to the script: cancel its captured attempt, wait for confirmed settlement, then start a fresh agent attempt for that same frozen task and keep the original guest promise pending. After delivery, reject restart with `STEP_ALREADY_DELIVERED`; use workflow replay to recompute dependent code. Charge every restart and keep an attempt history. Existing worktree edits remain visible; a restart does not silently reset or delete them.

On uncaught script failure, record the original error first, stop children, and finish failed after cleanup. Cleanup errors are secondary diagnostics. On body success with failures swallowed by combinators, finish completed with `partial: true` and failure counts.

At terminal state, export results and a compact completion event. Hosts may render a widget or consume plain structured output. No UI refresh or notification is required for correctness.

## 15. Worktree isolation and write authority

`isolation: 'worktree'` creates a managed child workspace using existing worktree code. Store root ownership, source workspace, base SHA, and created workspace ID on the step. Validate canonical containment and registered ownership on every operation.

Existing creation uses a commit and records that the source was dirty; it does not copy all uncommitted work. The full workflow feature needs an explicit policy: support a committed base by default and an opt-in working-tree snapshot selected at launch through trusted workspace setup. Snapshot tracked changes and only approved untracked files using existing recovery facilities where applicable; never sweep ignored credentials/dependencies into it. Report which base was used.

Several calls with no isolation can intentionally share a workspace, matching normal agent behavior. Expose authority and worktree guidance in authoring instructions; do not claim that a 'read-only' prompt is enforcement. Shared writable execution carries ordinary concurrent-edit risk. An administrator can require worktrees for concurrent writers. Enforce that requirement before dispatch.

For sequential steps that must operate on one isolated result, use one pre-opened worktree as the root workspace. Independent `isolation: 'worktree'` calls create independent children; verification does not magically inspect a previous child's edits. Pass its artifact context through a deliberate integration workflow or run validation inside the same agent task.

Retain changed child worktrees and expose them as inspectable artifacts/review checkpoints. Remove unchanged children only after all agents settle and no resume/reference retention requires them. Never auto-merge, auto-commit, force-reset, or delete changes. Worktrees isolate Git working copies; they do not sandbox shell authority.

## 16. Discovery, saved scripts, authoring, and presentation

Discover `.devspace/workflows/*.js` from the workspace directory toward its repository root, `~/.devspace/workflows/*.js`, and configured package roots. Nearest project definition wins, then personal, then packaged; namespace packaged definitions (`package:name`) to avoid collisions. List conflicts and invalid definitions diagnostically. Parse metadata without running scripts.

Saved-script writes use atomic replace, canonical containment, symlink checks, and explicit overwrite semantics. Update the saved script's literal name when saving under a new name through an AST-backed edit. Running snapshots remain immutable regardless of edits to saved/editable copies. Reload discovers new definitions without restarting agent work.

Use a workspace-scoped artifact/export directory for `scriptPath`, transcripts, and journals returned to a remote host. Do not broaden allowed roots to expose the entire private state directory. Authorize export reads by run ownership and existing artifact mechanisms. Authoring tools can edit the run's public copy; replay snapshots it again.

Add a `workflows` skill with the complete API reference, null/failure semantics, budget meaning, phase concurrency guidance, isolation examples, and authoring patterns. Keep `open_workspace` discovery concise and preload/on-demand behavior consistent with the existing subagent skill mechanism. The authoring skill is a separate package task and must follow the skill-creator instructions when implemented.

Ship reusable examples for review→verify, bounded repair loops, nested synthesis, and isolated migrations. Include a deep-research recipe when a configured target has actual web-search capability; do not assume the parent host's web tools or interactive MCP credentials are available to a child harness.

Render the same stored phase/step tree in a CLI view and optional existing workspace widget: state, queued/running/completed counts, usage completeness, elapsed time, logs, individual step details, errors, and worktree artifacts. Show replayed versus newly executed work. Show partial coverage explicitly. Plain CLI/JSON and MCP output remain complete when widgets are off.

Explicit user requests and configured standing authorization govern workflow launches. This user's request authorizes designing the feature, not implementing a universal always-on keyword detector. Do not parse `ultracode` out of repository text, tool output, or a child's prompt as authorization. Host adapters may supply trusted user-origin/standing-policy context; DevSpace's launch handler applies existing authority independently of script claims.

## 17. Rate limits, permissions, and prompt caching

Normalize provider failures without erasing the original safe reason. A rate-limit error can include `retryAfterMs`/`resetAt` and whether reissuing the request is safe. Missing metadata is unknown, not permission to infer a wait duration from arbitrary text.

For a finite known reset within configured wait bounds, park the affected attempt and stop new root dispatches. Persist a `waiting_for_usage` state. Allow already-running siblings to settle. At reset, recheck cancellation, enablement, budget, authority, and attempt identity before retry. No retry of an ambiguous possibly-active turn. Bound wait count/duration (proposed two waits and 24 hours maximum per wait). Unsupported or longer waits become actionable failures, not infinite sleeps.

Provider permission requests enter a typed waiting state. Use existing host/user interaction capabilities where supported; do not invent an approval response from elapsed time. Preconfigured noninteractive adapters must reject or report a required action when approval cannot be delivered. Transport disconnect does not auto-approve.

Prompt caching remains an adapter optimization. When a harness exposes a reliable prefix identity and first-response event, it may stagger matching starts for at most five seconds; bypass the stagger otherwise. Do not fabricate shared caches across models/providers or stall all fan-out behind a missing event. Accounting reports actual provider cache usage when present. This optimization must not alter logical call order or correctness.

## 18. Error taxonomy

Reuse the project's typed Result and tagged-error convention at service/IPC boundaries. Convert to ordinary guest Error objects with enumerable safe `code`, `layer`, and step context. Keep provider/internal causes in protected diagnostics.

| Category | Codes to define |
|---|---|
| Source/registry | `WORKFLOW_NOT_FOUND`, `WORKFLOW_SOURCE_INVALID`, `WORKFLOW_SYNTAX_ERROR`, `WORKFLOW_META_INVALID` |
| Scope/policy | `WORKSPACE_MISMATCH`, `WORKSPACE_NOT_ALLOWED`, `WORKFLOW_DISABLED`, `AGENT_TARGET_UNAVAILABLE` |
| Schema | `SCHEMA_INVALID`, `SCHEMA_UNSUPPORTED`, `SCHEMA_VALIDATION_FAILED`, `SCHEMA_VALIDATION_TIMEOUT` |
| Resource | `AGENT_LIMIT`, `ATTEMPT_LIMIT`, `ITEM_LIMIT`, `NESTING_LIMIT`, `OUTPUT_LIMIT`, `LOG_LIMIT`, `SCRIPT_CPU_LIMIT`, `SCRIPT_MEMORY_LIMIT`, `WORKFLOW_TIMEOUT` |
| Budget | `BUDGET_EXHAUSTED`, `USAGE_UNAVAILABLE`, `BUDGET_SCOPE_MISMATCH` |
| Lifecycle | `WORKFLOW_STOPPED`, `WORKFLOW_BUSY`, `STEP_ALREADY_DELIVERED`, `CANCELLATION_UNCONFIRMED` |
| Replay | `NOTHING_TO_RESUME`, `RESUME_SCOPE_MISMATCH`, `RESUME_RUNTIME_INCOMPATIBLE`, `REPLAY_DIVERGED`, `RECOVERY_REQUIRED` |
| Provider | Preserve existing structured provider codes; add rate-limit metadata where available |

`retryable` describes the failed operation, not blanket permission to repeat arbitrary side effects. Separately track uncertain execution. Null script results retain full typed outcome in step records.

## 19. Implementation sequence and file map

### Milestone A — contracts and agent prerequisites

- Add primitive/transport/config/state schemas and golden host-facing schema tests.
- Add effective-authority persistence, per-turn AbortSignal cancellation, usage callbacks, output-schema support, and capability resolution to existing local-agent files.
- Preserve ordinary `agents run/continue/show/wait` behavior.
- Establish shared store transactions and workflow association fields.
- Test all seven providers through protocol/SDK doubles; live capability checks are separate.

### Milestone B — parser and guest runtime

- `src/workflow-script.ts`: metadata AST parsing, source diagnostics, script wrapping.
- `src/workflow-runtime.ts` and `src/workflow-worker.ts`: QuickJS lifecycle, eight guest bindings, bounded bridge.
- `src/workflow-schema.ts`: transport/metadata validation and structured-output validator integration.
- Exercise JS, promise, isolation, quota, and disposal behavior without any model calls.

### Milestone C — durable service and scheduler

- `src/workflow-manager.ts`: lifecycle, scheduling, root/child ownership, control actions.
- `src/workflow-store.ts`, DB schema/migrations: runs, steps, attempts, events, budgets.
- Extend existing daemon/client/protocol with workflow methods; do not create parallel authentication/lifecycle machinery.
- Preserve typed errors and safe daemon shutdown/configuration replacement with active workflows.

### Milestone D — full agent execution behavior

- Structured JSON validation/correction, finite/incomplete budgets, live usage.
- Worktree child ownership, retained results, rate-limit waits, permission requests.
- Phase/log/progress events and nested workflows sharing all root limits.
- Root settling and child cancellation on every failure path.

### Milestone E — replay and crash recovery

- Request hashes, promise-delivery journal, synchronous observation replay.
- Prefix reuse with edited scripts, nested invocation replay, recovery reconciliation.
- Atomic ownership and concurrent-resume exclusion.
- Fault injection at every dispatch/completion boundary.

### Milestone F — public integration

- `src/workflow-registry.ts`: definitions, resolution, save, reload.
- `src/workflow-tools.ts`: shared MCP registration for existing tool modes.
- CLI subcommands, authoring skill, `open_workspace` discovery, artifact export.
- Optional workspace widget using existing UI infrastructure.
- Package the worker entry, WASM assets, runtime dependencies, docs, and examples.

### Milestone G — conformance and real-path verification

- Run the full matrix below and document provider/version limitations.
- Inspect final MCP schemas through a real host.
- Run the packaged worker/WASM path as well as source execution.
- Verify CLI↔MCP reconnection to the same run, widgets on/off, and managed worktrees.

`workflow-manager.ts` can keep a small private scheduler initially. Split it only when its state machine materially obscures lifecycle logic; do not introduce a pluggable scheduler or execution-backend interface with one implementation.

Proposed new runtime dependencies: `quickjs-emscripten` for isolated JS, `acorn` for real source parsing, and `ajv` for JSON Schema validation. Reuse existing Zod, SQLite, Result, and artifact facilities. None are installed by this planning task. The workspace has no provisioned `node_modules`; implementation verification requires the environment owner to make the chosen dependencies available under the standing no-install/no-refresh instruction. Do not work around that instruction with another package manager or runtime downloads.

## 20. Required checks and release gates

Use the repository's existing `node:assert`/tsx test style. These are behavioral checks, not a new testing framework.

| Area | Minimum meaningful checks |
|---|---|
| Metadata | literal parsing, comments, escaped strings, malformed syntax, no metadata execution, source line accuracy |
| Agent | each target, default precedence, text/JSON/null distinctions, profile snapshots, preserved provider failures |
| Parallel | ordered outputs, concurrency, synchronous throw, rejection, empty input, invalid input before effects |
| Pipeline | fast item advances while slow item remains in first stage; original/index arguments; no implicit flatten; failure skips; successful null passes |
| Phase/log | explicit phase wins, queued calls retain phase, child defaults isolated, log quota and replay deduplication |
| Args | absent versus null, JSON types, mutation does not alter persisted input, output rejects non-JSON data |
| Budget | nested sharing, cumulative usage dedup, no double charge on replay, finite-budget target rejection, queued dispatch recheck, incomplete failure usage |
| Nested workflow | name/path resolution, own context, one-level limit, root cancellation, no independent caps |
| Scheduling | global/root caps, root fairness, retry accounting, nested fan-out cannot deadlock, runaway native Promise loops remain bounded |
| Structured output | supported dialects, local refs, native/fallback paths, corrections cannot write, max attempts, validator watchdog, no remote fetching |
| Stop/restart | cancel one child without killing shared runtime; queued stop; stale turn ID; completion race; no replacement before confirmed stop |
| Pause/waits | active calls settle, queued calls stay queued, callbacks held, disconnect does not cancel/approve, persisted rate-limit wait |
| Replay | unchanged script, aggregation-only edit, early insertion, failure prefix, native Promise.race, reordered completions, budget branches, nested edit |
| Crash | before/after dispatch, identity callback, before/after result commit, delivery lost, daemon restart with active provider, competing resume requests |
| Scope | cross-workspace lookup, symlink swaps, managed-worktree roots, narrowed authority after resume, no arbitrary script roots |
| Worktree | committed/dirty base disclosure, changed work retained, unchanged cleanup, no auto-merge, verification uses correct workspace |
| Isolation | no Node/env/network/import escape through bridge; CPU/microtask/memory limits; handles released; oversized request/output rejection |
| Exposure | actual tools/list schemas, enabled/disabled modes, plain output, artifact permissions, widget rendered controls |
| Packaging | built worker resolves WASM from installed package location; CLI/MCP share daemon state; no dependence on development-only imports |

Run the user's local `pnpm` exactly, without `CI=true`, install, or dependency refresh. Use focused checks while implementing, then `pnpm typecheck` and `pnpm test` once meaningful changes are complete. Package smoke verification must use already-provisioned dependencies; do not run an installation-based smoke script that violates the no-install constraint. If full installed-package verification cannot be performed, label the narrower packed/source check explicitly.

The feature is complete only when all eight primitives, management/replay behavior, and the supported-provider capability matrix pass. Missing provider usage must remain an explicit capability limitation, not a reason to delete `budget`; missing UI notifications must remain a host integration limitation, not a reason to make results inaccessible.

## 21. End-to-end example

```js
export const meta = {
  name: 'review-and-verify',
  description: 'Review files and verify each finding with a separate agent',
  phases: [
    { title: 'Review', detail: 'Find actionable defects' },
    { title: 'Verify', detail: 'Check findings against the code' },
  ],
}

const FINDINGS = {
  type: 'object',
  properties: {
    findings: { type: 'array', items: { type: 'string' } },
  },
  required: ['findings'],
  additionalProperties: false,
}

const VERDICT = {
  type: 'object',
  properties: {
    confirmed: { type: 'boolean' },
    evidence: { type: 'string' },
  },
  required: ['confirmed', 'evidence'],
  additionalProperties: false,
}

log(`Reviewing ${args.files.length} files`)

const rows = await pipeline(
  args.files,
  file => agent(`Read-only: review ${file} for correctness defects.`, {
    agentType: args.reviewer,
    phase: 'Review',
    label: file,
    schema: FINDINGS,
  }),
  async (review, file) => {
    if (review === null) return { file, status: 'review_failed' }
    const verdicts = await parallel(review.findings.map(finding => async () => {
      const verdict = await agent(
        `Read-only: independently verify this finding in ${file}: ${finding}`,
        {
          agentType: args.verifier,
          phase: 'Verify',
          label: file,
          schema: VERDICT,
        },
      )
      return { finding, verdict } // null verdict means unverified
    }))
    return { file, status: 'reviewed', verdicts }
  },
)

return { rows } // runtime separately reports failed steps and partial coverage
```

The read-only text explains intent; enforcement comes from the run/profile authority. `args.reviewer` and `args.verifier` can resolve different harnesses without changing this program. A follow-up saved synthesis workflow can consume this JSON through `workflow('summarize-review', { rows })`; it shares the same budget and counters.
