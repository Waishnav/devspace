# Primitives overview

The workflow script body is an async JS context with a **closed** API surface. Only these hooks are injected. Everything else is ordinary JavaScript (with [determinism bans](./script-contract.md)).

## Inventory

| Primitive | Kind | Role |
|---|---|---|
| [`agent`](./agent.md) | async call | Spawn one subagent; get string or schema-validated object |
| [`pipeline`](./concurrency.md#pipeline) | combinator | Per-item multi-stage fan-out **without** barriers |
| [`parallel`](./concurrency.md#parallel) | combinator | Concurrent thunks; **barrier** until all complete |
| [`phase`](./control-and-io.md#phase) | side effect | Start a progress group for following agents |
| [`log`](./control-and-io.md#log) | side effect | Narrator line in `/workflows` progress UI |
| [`args`](./control-and-io.md#args) | binding | `Workflow({ args })` value, verbatim |
| [`budget`](./control-and-io.md#budget) | binding | Shared turn token ceiling: `total`, `spent()`, `remaining()` |
| [`workflow`](./control-and-io.md#nested-workflow) | async call | Run one nested named/path workflow (max depth 1) |

## How they compose

```
meta (literal header)
  │
  ▼
phase / log  ─────────────────────────── UX only
  │
  ├── agent  ─────────────────────────── unit of model work
  │
  ├── parallel([() => agent…, …])  ──── barrier fan-out
  │
  ├── pipeline(items, s1, s2, …)  ───── streaming multi-stage
  │         └── stages may call agent / parallel
  │
  ├── budget.*  ──────────────────────── scale / stop loops
  │
  └── workflow(name|path)  ───────────── nested graph (1 level)
```

## Design rules (short)

1. **Default multi-stage shape is `pipeline`**, not barrier-then-map.  
2. Use **`parallel` only** when stage N needs the **full** stage N−1 result set.  
3. Always **`.filter(Boolean)`** after `parallel` / nullable `agent` results.  
4. Prefer **`schema`** on `agent` for structured returns — no JSON parse roulette.  
5. **`log()`** anything a silent cap would hide (top-N, drops, early exit).  
6. Guard budget loops with **`budget.total &&`** (else `remaining()` is `Infinity`).  
7. Put identity for later stages in **`(prev, originalItem, index)`**, not only in stage-1 return blobs.

## Not primitives (but matter)

| Concern | Where documented |
|---|---|
| Tool launch API | [workflow-tool.md](./workflow-tool.md) |
| Script / meta rules | [script-contract.md](./script-contract.md) |
| Caps & isolation | [limits.md](./limits.md) |
| Resume cache | [resume.md](./resume.md) |
| Recipes | [patterns.md](./patterns.md) |

## Next

- [agent()](./agent.md)
- [pipeline & parallel](./concurrency.md)
- [phase, log, args, budget, workflow()](./control-and-io.md)
