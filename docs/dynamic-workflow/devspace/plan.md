# DevSpace Dynamic Workflow Engine — Plan

Builds on the locked bigger-model plan. Scope = **this worktree only**.  
Subagents stay **CLI-only**. Workflows get **CLI + MCP** over shared primitives.

---

## 0. Non-goals / locks

| Lock | Meaning |
|---|---|
| No MCP `agent_run` / `agent_wait` / `agent_show` | Subagent feature surface remains `devspace agents *` (+ skill + shell). |
| Workflow workers call adapters **in-process** | `runLocalAgentProvider` / same registry as CLI worker. No shell-out to `agents run` for `agent()`. |
| No dashboard v1 | Events via store drain + CLI `--follow` / MCP status long-poll. |
| CC script API parity | `meta`, `agent`, `parallel`, `pipeline`, `phase`, `log`, `args`, `budget`, `workflow` + determinism bans. |
| Yolo sub-agents | Fixed write-capable adapter policy; **no** `writeMode` on `agent()`. |
| `isolation: 'worktree'` | **Must-have** on `agent()` (CC-like); default shared checkout. |
| `effort` (not `thinking`) | Profiles, CLI, store, adapters, `agent()` opts — rename across stack. |
| `budget` stub v1 | `{ total: null, spent: () => 0, remaining: () => Infinity }`. |
| Dual surface | `devspace workflow *` **and** MCP `run_workflow` / `workflow_status` / `workflow_cancel`. |
| All 6 providers v1 | codex/claude/opencode/pi/cursor/copilot via existing adapters. |
| `agentProviders.enabled` | Ordered config from onboarding; default provider = first enabled ∩ live. |
| Resume-by-replay right after engine core | Same milestone order as locked plan. |

---

## 1. Control planes (do not conflate)

```
A) One-shot subagents (existing, unchanged API)
   host/shell → devspace agents run|show|ls
              → detached __worker → adapters → local_agent_sessions

B) Dynamic workflows (new)
   host MCP / CLI → run row + spawn workflow __worker
                 → sandboxed script
                 → agent() → adapters (in-process)
                 → workflow_* tables (not local_agent_sessions)
```

**Implication:** `devspace agents ls` does **not** list workflow-spawned agents. Observability = workflow events + `workflow_agent_calls`. Optional later dual-write — not v1.

---

## 2. Architecture

```
┌─ CLI: workflow run|status|cancel|ls ─┐     ┌─ MCP: run_workflow|status|cancel ─┐
│  parse / create run / spawn          │     │  same primitives via workflow-tools │
└──────────────────┬───────────────────┘     └──────────────────┬────────────────┘
                   ▼                                            │
            WorkflowStore (SQLite WAL) ◄────────────────────────┘
                   │
                   │ detached: node cli.js workflow __worker <runId>
                   ▼
            workflow-engine + sandbox + api
                   │
                   │ agent()  [semaphore]
                   ▼
            runLocalAgentProvider(provider, input)   ← existing adapters
                   │
                   ▼
            journal: events + agent_calls (+ schema retries)
```

Server/CLI = **launcher + journal reader**. Worker owns execution, heartbeat, cancel watch, self group-kill.

---

## 3. Accept bigger plan as-is (core)

Keep their file split (flat `src/`):

| Module | Role |
|---|---|
| `workflow-script.ts` | meta extract + wrap + `vm.Script` |
| `workflow-sandbox.ts` | context, determinism bans, console→log |
| `workflow-store.ts` | runs / events / agent_calls / cancel / reap |
| `workflow-api.ts` | agent/parallel/pipeline/phase/log/args/budget/workflow + semaphore |
| `workflow-engine.ts` | execute + `__worker` guts |
| `workflow-replay.ts` | resume cache |
| `workflow-schema.ts` | Ajv + retries |
| `workflow-files.ts` | named + persist scriptPath |
| `workflow-tools.ts` | MCP registration |
| `skills/dynamic-workflows/SKILL.md` | teaching |

DB migration **v4** (v3 = `local_agent_sessions` ✓).  
Tables: `workflow_runs`, `workflow_events`, `workflow_agent_calls` as specified.  
Spawn pattern copy `spawnAgentWorker` (detached, stdio ignore, unref).

API semantics: keep their CC-parity table (throws vs parallel→null, pipeline stages, ALS for phase, nested workflow depth 1, budget stub).

MCP contracts + yield windows: keep (status max ~110s matches `MAX_POLL_YIELD_MS`).

Milestones 1→8: keep order and verifiability.

---

## 4. Refinements / deltas on the bigger plan

### 4.1 Explicit separation from subagent CLI

In SKILL + serverInstructions + tool descriptions:

- Workflows = multi-agent **graphs**.  
- One-off second opinions = still `devspace agents run` (CLI/skill).  
- Do **not** tell models to implement workflows by shelling many `agents run` when `run_workflow` exists.

### 4.2 `agent()` backend = adapters, not CLI

```ts
// conceptual
runProvider({ provider, prompt, workspace, model, effort, providerSessionId? })
  → runLocalAgentProvider(provider, { prompt, workspace, writeMode: "allowed", model, effort, providerSessionId? })
```

- Schema retries reuse `providerSessionId` when adapter returns it (codex/claude path).  
- Do not create `local_agent_sessions` rows per call (avoids polluting `agents ls`, simpler cancel).  
- If product later wants unified list, add a flag — not v1.
- `workspace` is either shared `workspaceRoot` or a managed worktree path when `opts.isolation === 'worktree'`.

### 4.3 Provider resolution + config

Config add (see primitives-spec §3):

```ts
agentProviders?: {
  enabled: AgentProviderId[]   // order = preference; [0] = default
  detectedAt?: string
  lastProbe?: Array<{ id, available, detail? }>
}
```

Algorithm: `opts.provider` → `meta.defaultProvider` → first of `enabled ∩ liveAvailable`.  
Missing `agentProviders` → compat all-available in code order.  
Onboarding (`init`/`doctor`) probes PATH and writes `enabled`.  
Unknown/unavailable: fail that `agent()` (throw → parallel null).

### 4.4 Skills gating fix (required, not optional)

Today `effectiveSkillPaths` drops **entire** bundled dir if user has seeded `subagent-delegation` — hides any new bundled skill.

v1: include bundled **per-skill** (user copy wins on name collision). Seed `dynamic-workflows` in `user-config` next to subagent skill.

### 4.5 MCP vs CLI symmetry

| Op | CLI | MCP |
|---|---|---|
| Start | `workflow run --file\|--name\|--resume` | `run_workflow` |
| Poll | `status --follow` | `workflow_status` long-poll |
| Cancel | `cancel` | `workflow_cancel` |
| List | `ls` | (optional later; status by id enough v1) |

Same store. Detached worker survives MCP session death (critical acceptance test).

### 4.6 Replay: document deliberate CC divergence

CC: longest unchanged **call-index** prefix.  
v1: index+key, then **consume-once cacheKey** fallback (fan-out completion order).  

Document in SKILL under Resume. Do not pretend full CC resume identity.

### 4.7 Sandbox choice

Locked: `node:vm` + shadow Date/Math + no require/process/fetch/timers.  
Host wall-clock max (default 6h).  
Not SES (not in this tree; avoid new heavy dep). Accept vm is not a security boundary for hostile multi-tenant — DevSpace is single-user local.

### 4.8 Cancel / kill

1. `cancelRequested` flag.  
2. Worker heartbeat (5s) → AbortController + journal `run_cancelled` + group SIGTERM.  
3. Hard path after ≤5s: `terminateProcessTree` pid shim (existing `process-platform`).  

Known: in-flight adapter SDKs may not abort cleanly; group-kill is the backstop (already accepted).

### 4.9 Pi timeout

Document `PI_AGENT_TIMEOUT_MS = 120_000` in SKILL. Follow-up: make configurable — not milestone blocker.

### 4.10 Script authoring feedback

`run_workflow` / CLI parse **before** spawn. Syntax/meta errors return cheat-sheet snippet (tool desc + error). Line numbers preserved via export-strip + lineOffset.

### 4.11 Concurrency

`min(16, max(1, os.availableParallelism()-2))`, clamp by `meta.concurrency` if set. Semaphore gates **`agent()` only** (not pure JS stages).

### 4.12 Named workflows paths

1. `<workspace>/.devspace/workflows/<name>.js`  
2. `~/.devspace/workflows/<name>.js` (via config dir helper used by profiles)  

Name: `[a-z0-9-]+`. Persist exact source to `<stateDir>/workflows/runs/<runId>.js` for resume/edit.

### 4.13 `workflow()` nest

Same run, shared journal/semaphore/call counter, depth ≤ 1. Resolve name via `workflow-files`. No new process.

### 4.14 package.json

- Direct dep: `ajv`  
- Tests: append new `*.test.ts` to existing per-file tsx chain  
- Node engines already `>=22.19` (ok for `availableParallelism`)

### 4.15 Docs location

Keep design notes under `docs/dynamic-workflow/devspace/` (this plan + later runtime notes). Claude reference stays under `docs/dynamic-workflow/claude/`.

### 4.16 `effort` rename (profiles + agent stack)

| Today | Target |
|---|---|
| Profile `thinking:` | `effort:` |
| CLI `--thinking` | `--effort` (+ short deprecation alias optional) |
| DB/store `thinking` | `effort` (rename column in new mig or dual-read) |
| `LocalAgentRunInput.thinking` | `effort` |
| Workflow `agent()` opts | `effort` only |
| Replay cache key | includes `effort` |

Provider-native strings pass through unchanged.

### 4.17 `isolation: 'worktree'` (must-have)

- Opt-in per call: `agent(prompt, { isolation: 'worktree', … })`.  
- Default: shared `workspaceRoot`.  
- Create under `config.worktreeRoot` / existing git-worktrees helpers; pin base SHA at run start.  
- Adapter `cwd` = worktree path.  
- Clean success → auto-remove; dirty/fail/cancel → preserve + journal `worktreePath`.  
- **No** auto-merge into source.  
- Non-git workspace → throw.  
- Cache key includes `isolation`.  
- Module touch: extend `workflow-api` + small worktree helper (wrap `git-worktrees.ts`).  
- Skill: use for parallel mutators only.

### 4.18 Milestone impact

| Milestone | Extra |
|---|---|
| **3 Engine** | `isolation` path with fake/temp git repos in tests |
| **4 Worker+CLI** | real worktree create/cleanup; journal fields |
| **5 Resume** | cache key includes isolation |
| **8 Teach** | skill isolation + effort; seed `agentProviders` docs |
| Cross-cutting | rename `thinking`→`effort` in profile/CLI/store/adapters (can land with M3–4) |
| Config | `agentProviders` on user-config + init probe (with M4 or M8) |

---

## 5. Script API (v1 contract — implement exactly)

```js
export const meta = {
  name: '…',
  description: '…',
  phases: [{ title: '…', detail?: '…' }],
  // devspace-only:
  defaultProvider?: 'codex'|'claude'|…,
  concurrency?: number,
}

phase('Review')
const rows = await parallel([
  () => agent(p1, { provider: 'claude', label: 'r1', effort: 'high', schema: S }),
  () => agent(p2, { provider: 'codex', label: 'r2', schema: S }),
])
const mut = await agent(implPrompt, {
  provider: 'codex',
  isolation: 'worktree',   // parallel-safe writes
  schema: DiffSummary,
})
const out = await pipeline(items, stage1, stage2)
log('…')
// args, budget (stub), workflow(name, args?)
return { … }
```

Determinism bans: `Date.now`, `Math.random`, argless `new Date` → `WorkflowDeterminismError`.

---

## 6. Milestones (same spine, sharper exit criteria)

| # | Deliverable | Done when |
|---|---|---|
| **1 Journal** | schema + mig v4 + store + tests | create/append/drain/reap unit green |
| **2 Script/sandbox** | parse + vm + bans | meta edge cases + line nos + bans green |
| **3 Engine core** | api+engine, fake provider | semaphore, parallel null, pipeline no-barrier, phase ALS, nest depth |
| **4 Worker+CLI** | router, spawn, heartbeat, cancel, files | `--follow` log-only + 1 real provider; kill -9 → reap; cancel → group empty |
| **5 Resume** | replay + `--resume` | cancel mid-run; resume shows cached prefix events |
| **6 Schema** | ajv enforce + retries | bad JSON → schema_retry → success/exhaust |
| **7 MCP** | 3 tools + server wiring | Inspector: run+status; **kill MCP, worker still finishes** |
| **8 Teach** | skill, seed, skills.ts fix, instructions | fresh + pre-seeded config both advertise skill |

E2E: `npm test` + `npm run typecheck`; live fan-out 2 providers CLI; same MCP; cancel+resume.

---

## 7. Mapping to existing code (touch list)

| Existing | Use |
|---|---|
| `local-agent-adapters.ts` / `runLocalAgentProvider` | `agent()` backend |
| `local-agent-availability.ts` | provider pick / error text |
| `local-agent-store.ts` | **pattern only** (not dual-write) |
| `cli.ts` `spawnAgentWorker` / `agents __worker` | copy for `workflow __worker` |
| `process-platform.terminateProcessTree` | hard cancel |
| `db/client` WAL + busy_timeout 5000 | multi-process journal |
| `server.ts` `registerAppTool` + `config.subagents` gate | tools only if subagents on |
| `skills.ts` / `user-config.ts` | gate fix + seed |
| `process-sessions` yield bounds | MCP status yield caps |

---

## 8. Risk register (accepted + one process risk)

| Risk | Mitigation |
|---|---|
| Adapter no abort | group-kill worker |
| Daemonizing child escapes group | document; SIGTERM+adapter finally |
| Pi 120s cap | SKILL note |
| Replay key fallback ≠ CC | document |
| Laptop sleep heartbeat false fail | `kill(pid,0)` before reap |
| Host model still shells `agents run` for graphs | skill + tool cheat-sheet steer to `run_workflow` |
| Long MCP poll vs proxy timeouts | yield ≤110s; client re-calls status |

---

## 9. What we explicitly do **not** build in v1

- MCP tools for raw subagents  
- Dashboard / live TUI  
- Real token `budget` tied to host  
- `writeMode` on `agent()` (isolation **is** in scope)  
- Auto-merge of agent worktrees into source checkout  
- Auto file-change / diff events per stage  
- Declaring DAG JSON alternate API (script is the API)  
- Dual-write to `local_agent_sessions`  
- SES lockdown  

---

## 10. Implementation order for a coding agent

1. Mig + store (no behavior risk).  
2. Script + sandbox (pure).  
3. Engine against fakes (locks API).  
4. Wire CLI worker to real adapters.  
5. Replay.  
6. Schema.  
7. MCP.  
8. Skill/docs/gating.

Do not open MCP before CLI smoke — debug path must work headless without a host.

---

## Resolved questions (see also [primitives-spec.md](./primitives-spec.md))

1. **Default provider:** `opts.provider` → `meta.defaultProvider` → first of **onboarding-configured** `agentProviders.enabled` ∩ live available. Full config schema in primitives-spec §3.  
2. **writeMode:** **not in v1 API**; skill teaches prompt-based RO/write.  
3. **Isolation:** **`isolation?: 'worktree'` is v1 must-have** on `agent()`; default shared; no auto-merge.  
4. **Effort rename:** `thinking` → **`effort`** across profiles, CLI, store, adapters, `agent()` opts, cache keys.  
5. **MCP list:** skip; **CLI** `workflow ls` yes.  
6. **Size caps:** transport/storage bounds (§8 of primitives-spec); not “coverage” truncation.  
7. **Nested workflow:** CC-like `name | { scriptPath }`, depth 1, shared journal/semaphore.  
8. **Cancel:** cooperative flag → then group-kill.  

**File-change tracking:** out of scope.  
**Schema:** `opts.schema` + Ajv + retries — in scope.