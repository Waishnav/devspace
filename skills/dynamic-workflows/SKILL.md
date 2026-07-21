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
devspace workflow run --name review-auth [--follow]
devspace workflow run --resume <runId>
devspace workflow status <runId> [--follow]
devspace workflow cancel <runId>
devspace workflow ls
```

Named scripts: `.devspace/workflows/<name>.js` or `workflows/<name>.js`.

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
| `agent(prompt, opts?)` | Throws on failure. `opts`: `label`, `phase`, `schema`, `model`, `effort`, `provider`, `isolation: 'worktree'` |
| `parallel(thunks)` | Barrier; throw → `null` slot |
| `pipeline(items, ...stages)` | Per-item chains; no cross-item barrier |
| `phase(title)` / `log(msg)` | Progress; journaled |
| `args` | Run input (object preferred) |
| `budget` | Stub: `total: null`, `remaining(): Infinity` — do not loop on budget alone |
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

Default: first **enabled ∩ available** provider (`agentProviders.enabled` in config, else all live providers in product order). Override with `opts.provider` or `meta.defaultProvider`.

### Resume

`devspace workflow run --resume <runId>` creates a **new** run that replays completed agent calls by cache key (callIndex+key, then consume-once by key).

### Cancel

`workflow cancel` sets a cooperative flag; worker aborts then hard-kills if needed.

## When to use CLI vs MCP

- **CLI**: host agent can shell; prefer for long runs + `--follow`.
- **MCP**: ChatGPT plans; call `run_workflow`, then `workflow_status` until terminal. Disconnecting MCP does **not** kill the worker.

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
