# Script contract

A workflow script is plain JavaScript that starts with a pure-literal `meta` export, then runs in an async context with only the injected orchestration primitives available.

## Minimal shape

```js
export const meta = {
  name: 'find-flaky-tests',
  description: 'Find flaky tests and propose fixes', // shown in permission dialog
  phases: [
    { title: 'Scan', detail: 'grep test logs for retries' },
    { title: 'Fix', detail: 'one agent per flaky test', model: 'sonnet' },
  ],
  // optional: whenToUse — shown in workflow lists
}

// body — async context; await freely
phase('Scan')
const flaky = await agent('grep CI logs for retry markers', { schema: FLAKY_SCHEMA })
// ...
return { flaky }
```

## `meta` rules

| Rule | Detail |
|---|---|
| Position | Must be the **first statement** in the script |
| Purity | **Pure literal only** — no variables, function calls, spreads, or template interpolation |
| Required | `name`, `description` |
| Optional | `whenToUse`, `phases` |
| Phase entries | `{ title, detail?, model? }` |
| Phase titles | Must match `phase('…')` call strings **exactly** for UI grouping; unmatched `phase()` still gets its own progress group |
| Per-phase model | Optional override for agents in that phase’s UI group (agent-level `opts.model` still applies per call) |
| Permission UX | `description` is what the user sees in the approval dialog |

Invalid example (not pure literal):

```js
const n = 'review'
export const meta = { name: n, description: `Review ${topic}` } // ❌
```

## Language

| Allowed | Forbidden |
|---|---|
| Plain JavaScript | TypeScript annotations, interfaces, generics |
| `async` body with top-level `await` | Node APIs (`fs`, `process`, `require`, …) |
| `JSON`, `Math`, `Array`, `Object`, `Map`, `Set`, … | Filesystem, network, subprocess |
| Template strings / normal expressions in the **body** | Non-determinism listed below |

Type annotations like `: string[]` **fail to parse**. Keep types in comments or in JSON Schema objects as plain data.

## Determinism bans (resume safety)

These throw if called in the script (argless / pure entropy):

- `Date.now()`
- `Math.random()`
- argless `new Date()`

**Why:** [Resume](./resume.md) replays the longest unchanged prefix of `agent()` calls by hashing prompt + options. If the script branched on wall-clock or random, cache identity would lie and partial replay would be unsafe.

**What to do instead:**

- Pass fixed timestamps / seeds via `args`.
- Stamp wall-clock **after** the workflow returns, in the coordinator.
- For “random-like” diversity among agents, vary **prompt text or label by index** (deterministic in the script, different per worker).

## Only escape hatches into models

From the script you can only:

1. Call **`agent()`** — spawn a subagent (tools, optional schema).  
2. Call **`workflow()`** — run one nested saved/path workflow (one level only).  

There is no raw shell, no write-file, no HTTP from the orchestration body. That is intentional: orchestration stays pure; side effects live inside agents under normal permission/tool policy.

## Return value

Whatever the script `return`s becomes the workflow result delivered to the coordinator (via task notification). Prefer structured objects:

```js
return { confirmed, dropped, stats: { found: seen.size } }
```

Subagents should return **raw data** (or schema objects), not user essays — the coordinator narrates.

## Real-world example (implement → review → repair → verify)

Condensed from a session script:

```js
export const meta = {
  name: 'implement-workflow-foundation',
  description: 'Implement and verify durable workflow foundation',
  phases: [
    { title: 'Implement', detail: 'build store and orchestrator', model: 'sonnet' },
    { title: 'Review', detail: 'audit correctness and tests' },
    { title: 'Repair', detail: 'apply verified fixes', model: 'sonnet' },
    { title: 'Verify', detail: 'run full validation' },
  ],
}

phase('Implement')
const implementation = await agent(`…implementation prompt…`, {
  label: 'implement:durable-foundation',
  phase: 'Implement',
  effort: 'medium',
  agentType: 'claude',
})

phase('Review')
const FINDINGS = { /* JSON Schema */ }
const reviews = await parallel([
  () => agent(`…persistence audit…\n${implementation}`, {
    label: 'review:persistence', phase: 'Review', schema: FINDINGS, effort: 'medium', agentType: 'claude',
  }),
  () => agent(`…correctness audit…\n${implementation}`, {
    label: 'review:correctness', phase: 'Review', schema: FINDINGS, effort: 'medium', agentType: 'claude',
  }),
  () => agent(`…test quality audit…\n${implementation}`, {
    label: 'review:tests', phase: 'Review', schema: FINDINGS, effort: 'low', agentType: 'claude',
  }),
]).then(xs => xs.filter(Boolean))

phase('Repair')
const repair = await agent(`…fix from ${JSON.stringify(reviews)}…`, {
  label: 'repair:review-findings', phase: 'Repair', effort: 'medium', agentType: 'claude',
})

phase('Verify')
const verification = await agent(`…gates…`, {
  label: 'verify:full-gates', phase: 'Verify', effort: 'low', agentType: 'claude',
})

return { implementation, reviews, repair, verification }
```

## Next

- [Primitives overview](./primitives.md)
- [agent()](./agent.md)
