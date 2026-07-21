# `phase`, `log`, `args`, `budget`, `workflow()`

Progress UX, parameterization, token ceilings, and one-level nesting.

---

## `phase`

```ts
phase(title: string): void
```

- Starts a **progress group** in `/workflows`.  
- Subsequent `agent()` calls **without** `opts.phase` group under this title.  
- Titles should match `meta.phases[].title` exactly for clean UI; unmatched titles still get their own group.  
- Inside concurrent stages, prefer **`opts.phase`** on each `agent()` to avoid races on the global phase state:

```js
// Global phase — fine for sequential sections
phase('Implement')
await agent('…', { label: 'impl' })

// Concurrent — set phase per agent
await parallel([
  () => agent('…', { phase: 'Review', label: 'r1' }),
  () => agent('…', { phase: 'Review', label: 'r2' }),
])
```

`phase` is UX only — it does not create isolation, budget buckets, or barriers.

---

## `log`

```ts
log(message: string): void
```

- Emits a **narrator line** above the progress tree.  
- Use for counts, early exits, dropped coverage, loop progress.  

**Rule: no silent caps.** If the workflow bounds coverage (top-N, sampling, “first 20 files”), `log()` what was dropped. Silent truncation reads as “we covered everything.”

```js
if (files.length > 50) {
  log(`scoping to first 50 of ${files.length} files`)
  files = files.slice(0, 50)
}
```

---

## `args`

```ts
args: any  // Workflow({ args }) value, or undefined if omitted
```

### Rules

1. Value is **verbatim** from the tool call.  
2. Pass **real** JSON arrays/objects in the tool invocation — **not** a stringified JSON blob.  

```js
// ✅
Workflow({ script, args: ['a.ts', 'b.ts'] })
// in script: args.map(f => …)

// ❌
Workflow({ script, args: '["a.ts","b.ts"]' })
// args is a string → args.map throws
```

3. Primary channel for **parameterizing** named workflows (research question, path list, config).  
4. Primary channel for values that must stay **stable across resume** (fixed timestamps, seeds) — see [script determinism](./script-contract.md).

```js
// script
const topic = args?.topic ?? 'authentication'
const files = args?.files ?? []
await agent(`Review ${topic} in ${files.join(', ')}`, { schema: FINDINGS })
```

---

## `budget`

```ts
budget: {
  total: number | null
  spent(): number
  remaining(): number  // max(0, total - spent) or Infinity if no target
}
```

### Semantics

| Field / method | Meaning |
|---|---|
| `total` | Turn token target from user “+500k”-style directives; `null` if unset |
| `spent()` | Output tokens spent this turn across **main loop + all workflows** (shared pool) |
| `remaining()` | `max(0, total - spent())`, or **`Infinity`** if no target |

### Hard ceiling

Once `spent()` reaches `total`, further **`agent()` calls throw**. This is not advisory.

### Guard loops

Without a target, `remaining()` is `Infinity` and a `while (budget.remaining() > …)` loop runs until the **1000-agent** lifetime cap. Always guard:

```js
const bugs = []
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent('Find bugs in this codebase.', { schema: BUGS_SCHEMA })
  bugs.push(...result.bugs)
  log(`${bugs.length} found, ${Math.round(budget.remaining() / 1000)}k remaining`)
}
```

### Static fleet sizing

```js
const FLEET = budget.total
  ? Math.floor(budget.total / 100_000)
  : 5
```

### Loop-until-count (no budget)

```js
const bugs = []
while (bugs.length < 10) {
  const result = await agent('Find bugs…', { schema: BUGS_SCHEMA })
  bugs.push(...result.bugs)
  log(`${bugs.length}/10 found`)
}
```

Prefer budget-aware or dry-round stops for open-ended hunts ([patterns](./patterns.md)).

---

## Nested `workflow()`

```ts
workflow(
  nameOrRef: string | { scriptPath: string },
  args?: any
): Promise<any>
```

### Semantics

| Aspect | Detail |
|---|---|
| Purpose | Run another workflow **inline** as a sub-step; return its return value |
| `string` | Name in saved/built-in registry (same as `Workflow({ name })`) |
| `{ scriptPath }` | Script file on disk (e.g. previously persisted) |
| Shared with parent | Concurrency cap, agent counter, abort signal, token `budget` |
| UI | Child agents under a nested group in `/workflows` |
| Nesting depth | **One level only** — `workflow()` inside a child **throws** |
| Errors | Unknown name / unreadable path / child syntax error → throw (catch to handle) |

```js
const map = await workflow('understand-subsystem', { root: 'src/auth' })
const plan = await workflow('design-panel', { context: map })
return { map, plan }
```

Use nesting to compose **reusable** named workflows. Prefer sequential top-level `Workflow` tool calls across turns when the coordinator must read results and replan with the user.

---

## Next

- [Limits & sandbox](./limits.md)
- [Resume & journal](./resume.md)
