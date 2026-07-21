# DevSpace Dynamic Workflow — Primitives & API Spec

Implementation + contract spec for every surface, inspired by Claude Code’s Workflow environment.  
Pairs with [plan.md](./plan.md). Subagents remain CLI-only; this document is **workflow only**.

---

## 0. Product goals (locks)

| Goal | Surface |
|---|---|
| DW for coding agents that lack Workflow (pi, codex, opencode, cursor, …) | **CLI + skill** — host agent authors script, runs `devspace workflow *` |
| ChatGPT as orchestrator, not implementer | **MCP workflow tools** (togglable with subagents) — plan + `run_workflow` / status / cancel |
| Ship both in dev | One engine; two entrypoints; converge later on performance/UX |

```
coding agent ── skill + CLI ──► engine ── agent() ──► adapters
ChatGPT      ── MCP tools  ──► engine ── agent() ──► adapters
```

---

## 1. Resolved decisions

| # | Topic | Decision |
|---|---|---|
| 1 | Default provider | **Configured enabled provider list** (onboarding auto-detect CLIs → `config.json`). Runtime: `opts.provider` → `meta.defaultProvider` → **first entry of enabled+available list**. |
| 2 | Access / writeMode | **Not in v1 API.** No `writeMode`. Skill teaches **prompt-based** RO vs write. Isolation handles *where* writes land (see isolation). |
| 3 | List runs | **No MCP list tool v1.** **CLI** `devspace workflow ls` yes. |
| 4 | Size caps | Soft/hard bounds on journal + results (§8). |
| 5 | Nested `workflow()` | CC-inspired: `name \| { scriptPath }`, depth 1, shared journal/semaphore (§7.8). |
| 6 | Cancel | Cooperative flag → worker abort → hard `terminateProcessTree` (§9). |
| 7 | **`effort` rename** | Profile frontmatter, CLI (`--effort`), store column, runtime input, and `agent()` opts use **`effort`** (not `thinking`). Adapters map `effort` → provider-native flags. |
| 8 | **`isolation`** | **Must-have v1** on `agent()`: `opts.isolation?: 'worktree'`. Shared checkout default; worktree when set (§7.1, §7.1b). |
| — | File-change tracking | Out of scope. Shared disk / worktree is truth; no auto per-stage diff. |
| — | Structured output | **In scope:** `opts.schema` + Ajv + retries (§7.1). |

---

## 2. Claude Code inspiration map

| CC concept | CC behavior (model-facing) | DevSpace v1 |
|---|---|---|
| `Workflow` tool | Host tool; async; script/name/scriptPath/args/resume | CLI `workflow run` + MCP `run_workflow` |
| `export const meta` | Pure literal; name, description, phases | Same + optional `defaultProvider`, `concurrency` |
| `agent(prompt, opts)` | Spawn worker; string or schema object; null on skip/death in combinators | Same return contract; **throw** on failure; `parallel` → null |
| `opts.schema` | StructuredOutput / validated object | Ajv enforce + retry in engine |
| `opts.model` / `effort` | Tier/effort overrides | `model` + **`effort`** (renamed from `thinking`; provider passthrough) |
| `opts.isolation: 'worktree'` | Per-agent worktree | **v1 must-have** — same semantics, DevSpace-managed worktrees |
| Access / sandbox | Session permission mode; not `writeMode` on agent() | Prompt RO/write + **isolation for write containment** |
| `pipeline` | No barrier; per-item chains | Same |
| `parallel` | Barrier; null slots | Same |
| `phase` / `log` | Progress UX | Journal events + CLI follow / MCP drain |
| `args` | Verbatim tool args | Same |
| `budget` | Shared host token hard ceiling | **Stub** `{ total: null, spent:0, remaining: Infinity }` |
| `workflow()` | Nested name/scriptPath; depth 1; shared caps | Same spirit |
| Determinism bans | Date.now / Math.random / bare new Date | Same |
| Resume | Prefix cache by prompt+opts | Index+key + consume-once cacheKey fallback |
| File diffs per stage | **Not a primitive** | Same — no auto-diff |

---

## 3. Config: agent providers (what to add)

### Today (`DevspaceUserConfig` / `.devspace/config.json`)

Existing fields (unchanged conceptually):

```ts
// src/user-config.ts — today
interface DevspaceUserConfig {
  host?: string
  port?: number
  allowedRoots?: string[]
  publicBaseUrl?: string | null
  allowedHosts?: string[]
  stateDir?: string
  worktreeRoot?: string
  agentDir?: string
  subagents?: boolean          // master switch only
}
```

There is **no** persisted enable-list. Runtime exposes every implemented provider that is **currently on PATH** (`getLocalAgentProviderAvailabilitySnapshot`). Order is code order of `LOCAL_AGENT_PROVIDERS`, not user preference. No onboarding write-back.

### Add: `agentProviders` on user config

```ts
/** Known built-in ids — keep in sync with LocalAgentProvider */
type AgentProviderId =
  | "codex"
  | "claude"
  | "opencode"
  | "pi"
  | "cursor"
  | "copilot"

interface AgentProvidersConfig {
  /**
   * Ordered enable-list. Order = preference.
   * index 0 = default fallback for agent() when provider omitted.
   * Only ids in this list may be used by workflows/subagents (if present).
   * Missing/empty → fall back to "all currently available" (compat) OR
   * require init (prefer: treat missing as "auto = all available in code order").
   */
  enabled: AgentProviderId[]

  /** ISO time of last successful probe (init/doctor). Optional. */
  detectedAt?: string

  /**
   * Optional last probe snapshot for doctor UI (not required at runtime).
   * Do not use as source of truth for enablement — `enabled` is.
   */
  lastProbe?: Array<{
    id: AgentProviderId
    available: boolean
    detail?: string          // path or error
  }>
}

interface DevspaceUserConfig {
  // ...existing...
  subagents?: boolean
  agentProviders?: AgentProvidersConfig   // NEW
}
```

### Example `~/.devspace/config.json`

```json
{
  "host": "127.0.0.1",
  "port": 7676,
  "allowedRoots": ["/home/you/work"],
  "subagents": true,
  "agentProviders": {
    "enabled": ["codex", "claude", "opencode", "pi"],
    "detectedAt": "2026-07-21T12:00:00.000Z",
    "lastProbe": [
      { "id": "codex", "available": true, "detail": "/usr/bin/codex" },
      { "id": "claude", "available": true, "detail": "/home/you/.local/bin/claude" },
      { "id": "opencode", "available": true },
      { "id": "pi", "available": true },
      { "id": "cursor", "available": false, "detail": "not found" },
      { "id": "copilot", "available": false, "detail": "not found" }
    ]
  }
}
```

### Semantics

| Concern | Spec |
|---|---|
| **Master switch** | `subagents: true` still required for workflow tools + agent CLI + skills. |
| **Enable-list** | `agentProviders.enabled` is the only user-facing allowlist. |
| **Order** | First entry = default `agent()` provider after availability filter. |
| **Live ∩ config** | `candidates = enabled.filter(id => currentlyAvailable(id))`. Stale enable of uninstalled CLI → skipped with doctor warning, not hard-fail until no candidates. |
| **Unknown ids** | Reject on write/init; ignore-with-warn at read if config hand-edited. |
| **Missing `agentProviders`** | Compat: `enabled` effective = all available in built-in order (today’s behavior). Init should still write the block. |
| **Empty `enabled: []`** | Error at first `agent()` / `agents run`: “no providers enabled”. |
| **Env override (optional)** | `DEVSPACE_AGENT_PROVIDERS=codex,claude` replaces `enabled` for process (ops/debug). |
| **ServerConfig** | Load into `ServerConfig.agentProviders: { enabled: AgentProviderId[] }` resolved at boot. |

### Onboarding (`devspace init` / `doctor`)

1. Probe all six providers (reuse `local-agent-availability`).  
2. Set `enabled` = available ids in **stable product order**:  
   `codex → claude → opencode → pi → cursor → copilot` (only those available).  
3. Write `detectedAt` + optional `lastProbe`.  
4. `doctor` re-probes; offers to refresh `enabled` (add newly installed; optionally keep user-disabled by not auto-re-adding removed ids — v1: refresh = rewrite available set, document that).  

### Default provider algorithm

```
resolveProvider(opts, meta, config):
  enabled = config.agentProviders?.enabled
            ?? ALL_IMPLEMENTED_IN_CODE_ORDER
  candidates = enabled ∩ liveAvailable(PATH)
  if opts.provider:
    if opts.provider ∉ enabled → throw (disabled in config)
    if opts.provider ∉ liveAvailable → throw (not installed)
    return opts.provider
  if meta.defaultProvider:
    same checks against candidates
    return meta.defaultProvider
  if candidates[0] → return candidates[0]
  throw NoProviderError
```

Skill: “Pass `provider` when you care; else first enabled+available provider.”
---

## 4. Entry surfaces

### 4.1 CLI

```
devspace workflow run (--file <path> | --name <name> | --resume <runId>)
                      [--arg key=value]... [--follow]
devspace workflow status <runId> [--follow]
devspace workflow cancel <runId>
devspace workflow ls
devspace workflow __worker <runId>   # hidden
```

| Flag | Spec |
|---|---|
| `--file` | Read script from path (must be under allowed roots when policy applies). |
| `--name` | Resolve via [§6 named files](#6-script-sources). |
| `--resume` | New run row; replay journal from prior runId. |
| `--arg k=v` | Build `args` object (values: JSON-parse if possible else string). |
| `--follow` | Drain events until terminal; print log/phase/agent lines. |

Spawn: same pattern as `agents __worker` (detached, stdio ignore, unref). Inputs only from run row.

### 4.2 MCP (togglable with `config.subagents`)

| Tool | Input | Output (conceptual) |
|---|---|---|
| `run_workflow` | `workspaceId`, `script?` \| `name?` \| `resumeFromRunId?`, `args?`, `yieldTimeMs?` | `{ runId, status, events, nextSeq, result? }` after parse+spawn+short yield |
| `workflow_status` | `runId`, `sinceSeq?`, `yieldTimeMs?` | long-poll events / terminal |
| `workflow_cancel` | `runId` | `{ runId, status }` |

**No** `workflow_ls` on MCP v1.  
**No** `agent_*` MCP tools.

Tool description embeds ~25-line API cheat-sheet (CC-style education in-band).

### 4.3 Skill

`skills/dynamic-workflows/SKILL.md` (+ seed on init):

- When to use CLI vs when host is ChatGPT (MCP).  
- Full primitive reference.  
- Prompt patterns for read-only vs write (instead of writeMode).  
- Provider list / default fallback.  
- Schema examples, resume, cancel, 3 worked examples.

---

## 5. Script contract

### 5.1 Shape

```js
export const meta = {
  name: 'review-auth',
  description: 'Fan-out review of auth changes',
  phases: [
    { title: 'Review', detail: 'parallel reviewers' },
    { title: 'Synthesize' },
  ],
  // DevSpace extensions (optional):
  defaultProvider: 'codex',
  concurrency: 4,
}

// body — async IIFE context
phase('Review')
// ...
return { summary }
```

### 5.2 `meta` rules (CC + DS)

| Rule | Spec |
|---|---|
| First statement | `export const meta = {…}` |
| Pure literal | No vars, calls, spreads, templates in meta object |
| Required | `name`, `description` |
| Optional CC | `phases[]` `{ title, detail? }`, `whenToUse?` |
| Optional DS | `defaultProvider?`, `concurrency?` (clamped to engine max) |
| Validation | Zod `WorkflowMetaSchema` + JSON round-trip purity |
| Extract | Regex start + balanced-brace scanner; `vm.runInNewContext('('+literal+')')` |

### 5.3 Transform pipeline (`workflow-script.ts`)

1. Extract/validate meta.  
2. Strip leading `export ` → 7 spaces (preserve line numbers).  
3. Reject stray `import` / top-level `export` after meta.  
4. Wrap:

```js
(async ({ agent, parallel, pipeline, phase, log, args, budget, workflow, meta, console }) => {
  // user body
})
```

5. `new vm.Script(wrapped, { filename: 'workflow:'+name, lineOffset: -1 })`.  
6. Friendly errors: missing meta, syntax (with line), purity fail.

### 5.4 Language bans (CC)

| Banned in script | Behavior |
|---|---|
| `Date.now()` | `WorkflowDeterminismError` |
| `Math.random()` | same |
| argless `new Date()` | same |
| `require` / `process` / `fetch` / timers | not in context |
| TypeScript syntax | parse fail |

Allowed: normal JS, `JSON`, `Array`, `Map`, `Set`, `Date.parse`, `new Date(isoString)`.

`console.log/warn/error` → `log` events.

---

## 6. Script sources

| Source | Resolution |
|---|---|
| Inline (`--file` content / MCP `script`) | Persist to `<stateDir>/workflows/runs/<runId>.js` |
| Named (`--name` / MCP `name`) | (1) `<workspace>/.devspace/workflows/<name>.js` (2) `~/.devspace/workflows/<name>.js` |
| Resume | Load persisted path on prior run (user may edit that copy) |

Name sanitization: `^[a-z0-9-]+$`.  
Run row stores `scriptPath`, `scriptHash`, `source: inline|named`.

---

## 7. Primitives (spec + implementation)

All injected into the sandbox. Host deps: `{ journal, runProvider, availableProviders, replay?, concurrency, signal, workspaceRoot }`.

---

### 7.1 `agent(prompt, opts?)`

#### Spec (public)

```ts
type AgentOpts = {
  label?: string
  phase?: string              // overrides current ALS phase for this call
  schema?: object             // JSON Schema → validated object return
  model?: string
  effort?: string             // was "thinking"; provider-native effort/reasoning level
  provider?: string           // DevSpace; default via §3
  isolation?: "worktree"      // must-have; omit = shared workspace root
  // NO writeMode in v1
}

function agent(prompt: string, opts?: AgentOpts): Promise<string | object>
// with schema → Promise<object> (validated)
// without → Promise<string> (finalResponse text)
```

| Behavior | Spec |
|---|---|
| Failure | **Throw**. `parallel` maps throw → `null`. |
| Success string | Adapter `finalResponse`. |
| Success schema | Validated object; raw text also journaled. |
| Call index | Program order at invocation (before semaphore). |
| Semaphore | Only `agent()` acquires permit. |
| Cancel | Abort signal → throw cancelled. |
| Replay | Cache key includes isolation; hits journal `from_cache`. |
| Isolation | See §7.1b. |

#### Implementation notes

```
async function agent(prompt, opts) {
  const callIndex = nextCallIndex()
  const provider = resolveProvider(opts, meta, config)
  const phase = opts.phase ?? alsPhase.getStore()
  const isolation = opts.isolation === "worktree" ? "worktree" : "shared"
  const cacheKey = sha256(canonicalJson({
    prompt, provider,
    model: opts.model ?? null,
    effort: opts.effort ?? null,
    schema: opts.schema ?? null,
    isolation,
  }))
  if (replay) {
    const hit = replay.match(callIndex, cacheKey)
    if (hit) { journal.completeCached(...); return hit.value }
  }
  await semaphore.acquire(signal)
  let worktree: WorktreeHandle | null = null
  try {
    journal.beginAgentCall({ callIndex, cacheKey, provider, isolation, ... })
    const cwd = isolation === "worktree"
      ? (worktree = await createAgentWorktree({ runId, callIndex, workspaceRoot })).path
      : workspaceRoot
    const run = (p) => runProvider({
      provider, prompt: p, model: opts.model, effort: opts.effort, workspace: cwd,
    })
    const result = opts.schema
      ? await enforceSchema({ schema: opts.schema, prompt, run, journal, callIndex })
      : (await run(prompt)).finalResponse
    journal.completeAgentCall(...)
    return result
  } catch (e) {
    journal.failAgentCall(...)
    throw e
  } finally {
    semaphore.release()
    if (worktree) await finalizeAgentWorktree(worktree)  // §7.1b
  }
}
```

`runProvider` wraps `runLocalAgentProvider` with **`effort`** (not `thinking`) on `LocalAgentRunInput`. **No** `local_agent_sessions` dual-write v1.

### 7.1b `isolation: 'worktree'` (must-have)

Inspired by CC: expensive (~setup+disk); use when parallel **mutators** would conflict. Not a read-only switch.

| Rule | Spec |
|---|---|
| Default | Omit / undefined → agent `cwd` = workflow `workspaceRoot` (shared checkout). |
| `"worktree"` | Fresh git worktree under managed root (reuse `config.worktreeRoot` / existing git-worktrees helpers). |
| Base | Pin to workspace HEAD (or open-workspace base SHA if known) at **run start**; all worktrees for the run share that pin unless documented otherwise. |
| Path layout | e.g. `<worktreeRoot>/wf/<runId>/c<callIndex>/` or UUID; must stay inside managed root. |
| Adapter cwd | Provider runs with `workspace: worktreePath`. |
| Success + dirty | **Preserve** worktree; journal `worktreePath` + `dirty: true` on agent_call / event data. **Do not** auto-merge/cherry-pick into source. |
| Success + clean | Optional auto-remove (CC: remove if unchanged). v1: remove if `git status` clean. |
| Failure / cancel | Preserve for diagnosis; retention e.g. 7d cleanup job later; v1: leave on disk + path in journal. |
| Handoff | Later stages **do not** see worktree files unless they use the same path or agent return text lists paths. Prefer **schema returns** for findings; implementer stages that must compose should use **shared** isolation or sequential shared agents. |
| Parallel safety | Multiple `isolation: 'worktree'` agents concurrent = OK. Mixing worktree + shared writers = caller responsibility (skill: don’t). |
| Non-git workspace | `isolation: 'worktree'` → throw clear error (worktrees require git). |
| Cost | Skill: use only for parallel mutators. |
| Cache key | Includes `isolation` so resume doesn’t reuse shared result for worktree call. |

Events/data extras:

```ts
// agent_call_started / completed data
{ worktreePath?: string, isolation: "shared" | "worktree", dirty?: boolean }
```

**Not v1:** auto-apply worktree diffs to main checkout; multi-worktree merge tools.
#### Structured output (`workflow-schema.ts`)

Inspired by CC `schema` → StructuredOutput:

1. Augment prompt: respond with **only** JSON conforming to schema.  
2. Run provider.  
3. Extract JSON (fences strip + balanced-brace).  
4. Ajv validate (`allErrors: true`, `strict: false`).  
5. On fail: journal `schema_retry`; re-run with error text; reuse `providerSessionId` if adapter returned one (max 2 retries).  
6. Exhaustion → throw; parallel → null.

---

### 7.2 `parallel(thunks)`

#### Spec (CC)

```ts
function parallel<T>(thunks: Array<() => Promise<T>>): Promise<Array<T | null>>
```

| Rule | Spec |
|---|---|
| Barrier | Await all thunks before resolve. |
| Error | Thunk throw / agent throw → that index `null`; **parallel never rejects**. |
| Empty | `[]` → `[]`. |
| Cap | Max **4096** thunks (hard error). |
| Concurrency | Limited by agent semaphore only (thunks can start together; agents queue). |

#### Implementation

```js
async function parallel(thunks) {
  assertMaxItems(thunks.length)
  const results = await Promise.all(
    thunks.map(t => t().then(v => v, () => null))
  )
  return results
}
```

---

### 7.3 `pipeline(items, ...stages)`

#### Spec (CC)

```ts
type Stage = (prev: any, originalItem: any, index: number) => any | Promise<any>

function pipeline(items: any[], ...stages: Stage[]): Promise<any[]>
```

| Rule | Spec |
|---|---|
| Sync | **No barrier** between stages across items. |
| Per item | Sequential stages for that item’s chain. |
| Stage args | `(prevResult, originalItem, index)`. First stage `prev` = item. |
| Throw | That item becomes `null`; remaining stages skipped for it. |
| Cap | Max **4096** items. |
| Wall-clock | ≈ slowest item chain (true concurrency across items). |

#### Implementation sketch

```js
async function pipeline(items, ...stages) {
  assertMaxItems(items.length)
  return Promise.all(items.map((item, index) =>
    (async () => {
      let prev = item
      for (const stage of stages) {
        try { prev = await stage(prev, item, index) }
        catch { return null }
      }
      return prev
    })()
  ))
}
```

---

### 7.4 `phase(title)`

#### Spec (CC)

```ts
function phase(title: string): void
```

| Rule | Spec |
|---|---|
| Effect | Sets **current phase** for subsequent agents without `opts.phase`. |
| Events | Journal `phase_started` (and optional end on next phase). |
| Concurrency | **AsyncLocalStorage** so concurrent pipeline chains don’t race. |
| UI | CLI `--follow` / MCP events group by phase; match `meta.phases[].title` when possible. |

```js
function phase(title) {
  alsPhase.enterWith(title) // or run with ALS in engine wrapper
  journal.appendEvent({ type: 'phase_started', phase: title })
}
```

Prefer documenting: inside concurrent stages set `opts.phase` explicitly (same advice as CC).

---

### 7.5 `log(message)`

#### Spec (CC)

```ts
function log(message: string): void
```

- Journal `log` event; data truncated per §8.  
- CLI follow prints narrator lines.  
- Skill: log drops/caps (“no silent caps”).

`console.log` → same path.

---

### 7.6 `args`

#### Spec (CC)

```ts
const args: unknown  // frozen; from run input; undefined if omitted
```

| Rule | Spec |
|---|---|
| MCP | Pass real JSON object/array — not stringified JSON string. |
| CLI | `--arg k=v` → object; values JSON-parsed when valid. |
| Freeze | `Object.freeze` deep where practical. |
| Resume | Same args required for max cache hits when prompts embed args. |

---

### 7.7 `budget` (stub v1)

#### Spec (CC shape, stub values)

```ts
const budget = Object.freeze({
  total: null as number | null,
  spent(): number { return 0 },
  remaining(): number { return Infinity },
})
```

| Future | Wire `total` from CLI/MCP optional `maxAgentCalls` or token directive; hard-throw when exceeded. |
| v1 | Shape present so scripts/skills match CC; loops must still use dry-round or count, not infinite budget loops. |

Skill warns: do not `while (budget.remaining() > x)` without other exit — remaining is Infinity.

---

### 7.8 `workflow(nameOrRef, args?)` — nested

#### How CC behaves (inspiration)

- `workflow(name | { scriptPath }, args?)`  
- Runs child **inline** in same run.  
- Shares concurrency cap, agent counter, abort, token budget.  
- Child agents appear nested in progress UI.  
- **Depth 1 only** — nest inside child throws.  
- Return value = child’s script return.  
- Errors: unknown name / unreadable path / syntax → throw.

#### DevSpace v1

```ts
function workflow(
  nameOrRef: string | { scriptPath: string },
  childArgs?: unknown,
): Promise<unknown>
```

| Rule | Spec |
|---|---|
| `string` | Resolve named file (§6). |
| `{ scriptPath }` | Absolute/resolved path to `.js` (must pass root allowlist if enforced). |
| Depth | `nestDepth` ALS/counter; `> 1` → throw. |
| Shared | Same journal runId, semaphore, call-index sequence, cancel signal. |
| Meta | Child meta used for phase titles optionally; run name stays parent. |
| Events | Optional `phase` prefix or `label: nest:childName`. |
| No new process | In-process second script execute. |
| Resume | Child `agent()` calls continue global callIndex — replay still works. |

```js
async function workflow(nameOrRef, childArgs) {
  if (nestDepth >= 1) throw new Error('workflow() nesting limited to one level')
  const source = resolveNestedSource(nameOrRef, workspaceRoot)
  const parsed = parseWorkflowScript(source)
  return executeNested({ parsed, args: childArgs, nestDepth: nestDepth + 1, ...sharedDeps })
}
```

---

## 8. Size caps (education + defaults)

### Why caps exist

Without bounds:

- One agent can return multi‑MB logs → SQLite bloat, slow drain.  
- MCP tool results can exceed host message limits.  
- Event `dataJson` spam freezes `--follow`.  
- Malicious/buggy script `return` of huge graphs.

This is **not** semantic truncation of “coverage”; it’s **transport/storage safety**. Skill still says: if you intentionally sample files, `log()` that you did.

### Recommended v1 limits

| Asset | Cap | On exceed |
|---|---|---|
| Event `dataJson` | ~8 KiB string | Truncate + `"truncated": true` |
| `responseText` on agent_calls | e.g. 1 MiB | Truncate stored copy; prefer schema path for structure |
| `structuredJson` | e.g. 256 KiB | Fail agent call (throw) |
| Script `return` → `resultJson` | e.g. 256 KiB | Fail run `errorKind: 'result_too_large'` |
| `args` JSON | e.g. 64 KiB | Reject at createRun |
| Inline script source | e.g. 512 KiB | Reject at parse |
| Events drain page | limit param default 100–500 | Cursor `nextSeq` |

Numbers can be constants in `workflow-store.ts`; tune later.

---

## 9. Cancel, heartbeat, reap

| Step | Spec |
|---|---|
| Heartbeat | Worker every 5s updates `heartbeatAt`; polls `cancelRequested`. |
| Cooperative | Set flag → worker AbortController → journal `run_cancelled` → group SIGTERM. |
| Hard | After ≤5s: `terminateProcessTree` on pid; mark cancelled. |
| Reap | `heartbeat` stale >60s **and** `kill(pid,0)` dead → mark failed `errorKind: 'heartbeat'`. |
| Sleep gap | Liveness check avoids false fail after laptop sleep. |

Adapters: no individual abort API — accepted; group-kill is backstop.

---

## 10. Resume / replay

| Piece | Spec |
|---|---|
| New run | `--resume` / `resumeFromRunId` creates new run with `resumedFromRunId`. |
| Cache key | `sha256(canonicalJson({ prompt, provider, model, effort, schema, isolation }))` |
| Match | (1) same callIndex + key (2) on first miss, consume-once by key (fan-out order). |
| Record | Cache hits written as new rows `from_cache=1` so chains chain. |
| Determinism | Bans make prompt construction stable if args fixed. |

Document CC divergence (consume-once) in skill.

---

## 11. Journal schema (behavioral)

### `workflow_runs`

id, name, source, scriptPath, scriptHash, workspaceRoot, workspaceId?, argsJson, status (`starting|running|completed|failed|cancelled`), error?, errorKind?, resultJson?, pid?, heartbeatAt?, cancelRequested, resumedFromRunId?, timestamps.

### `workflow_events`

(runId, seq) PK; type enum including `run_started`, `phase_started`, `log`, `agent_call_*`, `schema_retry`, `run_*`; phase; label; dataJson truncated.

### `workflow_agent_calls`

(runId, callIndex) PK; cacheKey; provider; model; label; phase; status; fromCache; providerSessionId?; responseText; structuredJson?; error?; times.

Adapter `items[]` **not** persisted.

---

## 12. Access model: prompt + isolation (no writeMode)

### What Claude Code does

CC `agent()` opts include `label`, `phase`, `schema`, `model`, `effort`, **`isolation`**, `agentType` — **not** `writeMode`.

| Layer | Role |
|---|---|
| Host permission mode | Approve / bypass tools |
| `agentType` / tools | Read-oriented vs full agents |
| **`isolation: 'worktree'`** | Mutations in private tree; no auto-merge |
| **Prompt** | “Do not modify files” / implementer instructions |

### What DevSpace does in v1

| Layer | Behavior |
|---|---|
| API | **No writeMode**; **yes `isolation?: 'worktree'`** |
| Adapter | Fixed yolo-style policy (current profile behavior) |
| Isolation | Engine creates managed worktree; cwd for that agent only |
| Skill | RO vs write **prompts** + when to set isolation |

```text
READ-ONLY reviewer:
- Do not modify files. Return findings via schema.

IMPLEMENTER (shared tree — sequential):
- Minimal edits; report paths.

IMPLEMENTER (parallel):
- isolation: 'worktree'
- Report worktree-relative paths + summary in return value.
- Orchestrator decides merge; engine will not auto-merge.
```
---

## 13. File changes (explicit non-primitive)

| Approach | v1 |
|---|---|
| Shared workspace; later agents see prior edits on disk | Yes |
| Return structured paths/findings between stages | Yes (schema) |
| Auto git snapshot / diff after each agent | **No** |
| Per-agent worktree (`isolation: 'worktree'`) | **Yes v1** (must-have; §7.1b) |
| Host `show_changes` after whole workflow | Optional host behavior; not engine |

---

## 14. End-to-end authoring examples

### Fan-out review (ChatGPT or local agent)

```js
export const meta = {
  name: 'fanout-review',
  description: 'Two reviewers then synthesize',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
}

const S = { /* FINDINGS schema */ }
phase('Review')
const reviews = await parallel([
  () => agent('Read-only review security…', { provider: 'claude', label: 'sec', schema: S }),
  () => agent('Read-only review tests…', { provider: 'codex', label: 'test', schema: S }),
])
phase('Synthesize')
const summary = await agent(
  `Merge findings:\n${JSON.stringify(reviews.filter(Boolean))}`,
  { label: 'merge', schema: { type: 'object', properties: { summary: { type: 'string' } }, required: ['summary'] } },
)
return { reviews, summary }
```

### Pipeline over files (coding agent CLI)

```js
export const meta = {
  name: 'migrate-files',
  description: 'Per-file transform',
  phases: [{ title: 'Edit' }],
}

const files = args.files
return pipeline(
  files,
  (f) => agent(`Update imports in ${f}. Minimal edit. Report path.`, {
    label: `edit:${f}`,
    phase: 'Edit',
  }),
)
```

---

## 15. Implementation checklist (by primitive)

| Primitive / surface | Module | Tests focus |
|---|---|---|
| meta parse | `workflow-script.ts` | purity, line nos, missing meta |
| sandbox bans | `workflow-sandbox.ts` | Date/Math throw; console→log |
| agent | `workflow-api.ts` | provider resolve, throw, callIndex order |
| schema | `workflow-schema.ts` | retry, validate, exhaust |
| parallel | `workflow-api.ts` | null on error, barrier |
| pipeline | `workflow-api.ts` | no-barrier proof, stage args |
| phase ALS | `workflow-api.ts` | concurrent chains |
| log / args / budget | `workflow-api.ts` | freeze, stub budget |
| workflow nest | `workflow-api.ts` + engine | depth 1, shared journal |
| store | `workflow-store.ts` | seq, reap, cancel |
| replay | `workflow-replay.ts` | index+key, consume-once |
| CLI | `cli.ts` | run/status/cancel/ls/__worker |
| MCP | `workflow-tools.ts` | yield, survive disconnect |
| skill | `skills/dynamic-workflows` | education |
| providers config | `user-config` / init / availability | ordered default |

---

## 16. Non-goals recap (v1)

- MCP raw agent tools  
- `writeMode` on `agent()` (isolation **is** in scope)  
- Auto-merge of worktrees into source checkout  
- Real host token budget  
- Auto file-change / diff events per stage  
- MCP run list  
- Dashboard  
- Dual-write `local_agent_sessions`  

---

## 17. `effort` rename (profiles + runtime + agent opts)

| Surface today | Target |
|---|---|
| Profile YAML `thinking:` | `effort:` |
| CLI `devspace agents run --thinking` | `--effort` |
| `LocalAgentRecord.thinking` / DB column | `effort` (migration: rename column or accept both briefly) |
| `LocalAgentRunInput.thinking` | `effort` |
| Adapter mapping (`modelReasoningEffort`, claude effort, pi `--thinking`) | Read from `input.effort` |
| Docs / examples / skill | `effort` only |
| Workflow `agent()` opts | `effort` only |
| Workflow journal / cache key | `effort` |

Provider passthrough values stay free strings (`low`, `high`, `xhigh`, …) — DevSpace does not translate between providers.

**Compat (optional short window):** read profile `thinking` if `effort` missing; CLI accept `--thinking` as alias deprecated. Prefer clean break if you’re fine breaking profile files (examples are under our control).

## 18. Open only if product changes mind

1. Exact byte constants for §8.  
2. Nested `{ scriptPath }` must be under workspace only?  
3. Worktree retention days / cleanup job timing.  
4. Whether `agents run` CLI also gains `--isolation worktree` (workflow-first is enough for v1).  
