# `pipeline()` & `parallel()`

These two combinators are the heart of multi-agent structure. Using the wrong one wastes wall-clock or forces incorrect synchronization.

## Quick contrast

| | `pipeline` | `parallel` |
|---|---|---|
| Input | `items[]` + stage functions | `thunks[]` of `() => Promise` |
| Sync model | **No barrier** between stages | **Barrier** — wait for all thunks |
| Wall-clock | ≈ slowest **item chain** | ≈ slowest **thunk** (then next barrier stage) |
| Failure | Stage throw → that item becomes `null`, later stages skipped for it | Thunk throw / agent error → slot `null`; call never rejects |
| Default for multi-stage? | **Yes** | No — only when you need all results together |

---

## `pipeline`

### Signature

```ts
pipeline(
  items: any[],
  stage1: (prev, originalItem, index) => any | Promise<any>,
  stage2?: (prev, originalItem, index) => any | Promise<any>,
  // ...
): Promise<any[]>
```

### Semantics

- Each **item** flows through **all stages independently**.  
- Item A may be in stage 3 while item B is still in stage 1.  
- Every stage receives `(prevResult, originalItem, index)`:
  - Use `originalItem` / `index` to label work without stuffing identity only into stage-1 returns.  
- A stage that **throws** drops that item to `null` and skips remaining stages for that item.  
- Max items per call: **4096** (hard error if exceeded) — see [limits](./limits.md).

### Canonical multi-stage pattern

Review by dimension, then verify each finding **as soon as that dimension finishes** (not after all dimensions finish):

```js
export const meta = {
  name: 'review-changes',
  description: 'Review changed files across dimensions, verify each finding',
  phases: [{ title: 'Review' }, { title: 'Verify' }],
}

const DIMENSIONS = [
  { key: 'bugs', prompt: '…' },
  { key: 'perf', prompt: '…' },
]

const results = await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, {
    label: `review:${d.key}`,
    phase: 'Review',
    schema: FINDINGS_SCHEMA,
  }),
  review => parallel(
    review.findings.map(f => () =>
      agent(`Adversarially verify: ${f.title}`, {
        label: `verify:${f.file}`,
        phase: 'Verify',
        schema: VERDICT_SCHEMA,
      }).then(v => ({ ...f, verdict: v }))
    )
  )
)

const confirmed = results
  .flat()
  .filter(Boolean)
  .filter(f => f.verdict?.isReal)

return { confirmed }
// Dimension "bugs" findings verify while "perf" is still reviewing.
```

### Transform inside a stage (no extra barrier)

```js
// ❌ Smell: barrier only to flatten
const a = await parallel(items.map(i => () => agent(…)))
const b = a.filter(Boolean).flatMap(x => x.findings)
const c = await parallel(b.map(f => () => agent(verify(f))))

// ✅ Pipeline with transform in a stage
const c = await pipeline(
  items,
  i => agent(…),
  r => r.findings,                    // pure transform
  f => agent(verify(f), { schema: V }) // or map to parallel inside if many findings
)
```

If one item produces many findings, a stage may return `parallel(findings.map(...))` as in the canonical example.

---

## `parallel`

### Signature

```ts
parallel(thunks: Array<() => Promise<any>>): Promise<any[]>
```

### Semantics

- Runs thunks **concurrently**.  
- **Barrier:** does not resolve until every thunk settles.  
- A throwing thunk (or agent error) becomes **`null`** in that index — the `parallel` call **itself never rejects**.  
- Always `.filter(Boolean)` before treating results as data.  
- Same concurrency / item caps as overall engine ([limits](./limits.md)).

### When a barrier is correct

Use `parallel` (or a barrier between pipeline stages implemented via collecting all items) **only** when stage N needs **cross-item** context from **all** of stage N−1:

1. **Dedup / merge** across the full set before expensive work.  
2. **Early-exit** if total count is zero (“0 bugs → skip verification”).  
3. Next prompt **references “the other findings”** for comparison.

```js
// Correct barrier: need ALL findings before expensive verification
const all = await parallel(
  DIMENSIONS.map(d => () => agent(d.prompt, { schema: FINDINGS_SCHEMA }))
)
const deduped = dedupeByFileAndLine(
  all.filter(Boolean).flatMap(r => r.findings)
)
if (!deduped.length) {
  log('0 findings — skip verify')
  return { confirmed: [] }
}
const verified = await parallel(
  deduped.map(f => () => agent(verifyPrompt(f), { schema: VERDICT_SCHEMA }))
)
```

### When a barrier is NOT justified

| Bad reason | Do this instead |
|---|---|
| “I need to flatten/map/filter first” | Transform inside a `pipeline` stage |
| “Stages are conceptually separate” | `pipeline` already models separate stages without sync |
| “It’s cleaner code” | Barrier latency is real — if 5 finders run and the slowest is 3× the fastest, a barrier wastes most of the fast agents’ idle time |

**Smell test:** if you wrote `parallel → transform → parallel` with no cross-item dependency, rewrite as `pipeline`.

---

## Nested concurrency

Stages of a `pipeline` may call `parallel` (per item). Outer `parallel` may launch whole pipelines. Nested `workflow()` shares the parent concurrency pool.

```js
// Per-item: many judges after one finder
await pipeline(
  targets,
  t => agent(findPrompt(t), { schema: BUGS }),
  found => parallel(
    found.bugs.map(b => () => agent(judgePrompt(b), { schema: VERDICT }))
  )
)
```

## Concurrency cap interaction

Only ~`min(16, cpu_cores - 2)` agents run at once per workflow; the rest **queue**. You can still pass large arrays — they complete, they just don’t all run simultaneously. See [limits](./limits.md).

## Decision flowchart

```
Need multi-stage over a list?
  │
  ├─ Does stage N need the FULL set from stage N-1?
  │     yes → parallel (barrier) then next stage
  │     no  → pipeline(items, stage1, stage2, …)
  │
  └─ Single fan-out, one stage only?
        → parallel([() => agent…, …])  or  pipeline(items, oneStage)
```

## Next

- [phase, log, args, budget, workflow()](./control-and-io.md)
- [Patterns](./patterns.md)
