---
name: dynamic-workflows
description: Orchestrate multi-agent coding workflows via DevSpace Dynamic Workflows (CLI or MCP).
---

# Dynamic Workflows

Use this skill when the user wants multi-step, multi-agent orchestration — fan-out
review, migrate-and-verify, research panels — **not** a single subagent turn.

## Entry points

| Host | Surface |
|---|---|
| Coding agent (Claude Code, Codex, pi, …) | CLI + this skill |
| ChatGPT / MCP client | MCP tools `run_workflow` / `workflow_status` / `workflow_cancel` |

```bash
devspace workflow run --file path/to/script.js [--arg k=v]... [--follow]
devspace workflow run --script-path path/to/script.js [--resume <runId>] [--follow]
devspace workflow run --name review-auth [--follow]
devspace workflow run --resume <runId>
devspace workflow status <runId> [--follow]
devspace workflow cancel <runId>
devspace workflow ls
devspace workflow calls <runId>
devspace workflow call <runId> <callIndex>
devspace workflow tui [runId]
```

Project named scripts live under `.devspace/workflows/<name>.js`.

## Script shape

```js
export const meta = {
  name: 'review-auth',
  description: 'Fan-out review of auth changes',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
  // optional DevSpace:
  // defaultProvider: 'codex',
  // concurrency: 4,
}

phase('Review')
const findings = await parallel([
  () => agent('Review for correctness…', { label: 'correctness' }),
  () => agent('Review for security…', { label: 'security' }),
])
phase('Synthesize')
const summary = await agent(`Synthesize: ${JSON.stringify(findings)}`)
return { summary, findings }
```

### Primitives

| API | Notes |
|---|---|
| `agent(prompt, opts?)` | Throws on failure. `opts`: `label`, `phase`, `schema`, `model`, `effort`, `profile` or `provider`, `isolation: 'worktree'` |
| `parallel(thunks)` | Barrier; throw → `null` slot |
| `pipeline(items, ...stages)` | Per-item chains; no cross-item barrier |
| `phase(title)` / `log(msg)` | Progress; journaled |
| `args` | Run input (object preferred) |
| `workflow(name\|{scriptPath}, args?)` | Nested, depth 1, shared call index |

**No `writeMode`.** Teach read-only vs write in the prompt. Use `isolation: 'worktree'` when parallel mutators would conflict (git required).

### Determinism bans

`Date.now()`, `Math.random()`, and `new Date()` without args throw. Pass timestamps via `args` if needed.

### Schema

```js
const out = await agent('Return JSON findings', {
  schema: {
    type: 'object',
    properties: { bugs: { type: 'array', items: { type: 'string' } } },
    required: ['bugs'],
  },
})
// out is validated object; engine retries ≤2 on invalid JSON
// codex/claude: native structured output first, then prompt repair; others: prompt+Ajv
```

### Providers

Profiles exposed by `open_workspace` may be selected with `opts.profile`. The
profile supplies instructions, provider, model, and effort defaults; per-call
`model` and `effort` override those defaults. `profile` and `provider` are
mutually exclusive.

Without a profile, default provider resolution is `opts.provider` →
`meta.defaultProvider` → first currently available provider.

### Resume

Failed and cancelled runs are terminal. Recovery creates a **new** run:

1. Inspect the prior run with `workflow status`, `workflow calls`, and
   `workflow call`.
2. Edit the persisted `scriptPath` reported by the run, or pass a different
   `--script-path`.
3. Keep prompts and agent options stable for completed calls whose return values
   should be reused.
4. Run `devspace workflow run --resume <runId>` (optionally with
   `--script-path <path>`).

Replay walks the prior run in call-index order and reuses the longest unchanged
prefix. The first failed, interrupted, changed, missing, corrupt, or unavailable
result executes live and closes replay for every later call, even when a later
cache key happens to match. Exact return values are stored separately from
bounded UI previews.

Replay restores an agent's **return value**, not its execution. Shared-checkout
calls assume their existing filesystem effects are still present. Worktree calls
are never reused unless their exact worktree can be restored, so they currently
end the reusable prefix and run live.

Return values must fit the replay budget (~1 MiB JSON). Oversized returns fail
the `agent()` call with `result_too_large` — prefer summaries or paths to large
artifacts on disk.

### Cancel

`workflow cancel` sets a cooperative flag; worker aborts then hard-kills if needed.

## When to use CLI vs MCP

- **CLI**: host agent can shell; prefer for long runs + `--follow`.
- **TUI**: `devspace workflow tui` opens a read-only live view for workflows associated with the current working directory.
- **MCP**: ChatGPT plans; call `run_workflow`, then `workflow_status` until terminal. With full widgets enabled, workflow tool cards and the `open_workspace` dashboard show read-only live activity, including workflows launched through the CLI. Disconnecting MCP does **not** kill the worker.

## Worked mini-examples

**1. Parallel review**

```js
export const meta = { name: 'p-review', description: 'Two reviewers' }
const [a, b] = await parallel([
  () => agent('Correctness review of the diff', { label: 'corr' }),
  () => agent('Security review of the diff', { label: 'sec' }),
])
return { a, b }
```

**2. Pipeline with schema**

```js
export const meta = { name: 'pipe', description: 'Find then fix plan' }
return await pipeline(
  args.files,
  (file) => agent(`List bugs in ${file}`, { schema: { type: 'object', properties: { bugs: { type: 'array', items: { type: 'string' } } }, required: ['bugs'] } }),
  (findings, file) => agent(`Plan fixes for ${file}: ${JSON.stringify(findings)}`),
)
```

**3. Isolation for parallel writers**

```js
export const meta = { name: 'iso', description: 'Parallel mutators' }
await parallel([
  () => agent('Implement feature A in isolation', { isolation: 'worktree', label: 'a' }),
  () => agent('Implement feature B in isolation', { isolation: 'worktree', label: 'b' }),
])
// dirty worktrees preserved; compose via return text / shared follow-up
```
