# Cheatsheet

One-page API card. Details in the linked docs.

## Tool

```js
Workflow({
  script?,          // inline JS; must start with pure-literal meta
  name?,            // built-in or .claude/workflows/
  scriptPath?,      // persisted path; wins over script/name
  args?,            // verbatim → global args (real JSON, not stringified)
  resumeFromRunId?, // ^wf_[a-z0-9-]{6,}$  stop prior run first
})
// need: script | name | scriptPath
// returns async launch: taskId, runId, scriptPath, transcriptDir, …
```

[workflow-tool.md](./workflow-tool.md) · [opt-in.md](./opt-in.md)

## Script header

```js
export const meta = {
  name: '…',              // required, pure literal
  description: '…',       // required — permission dialog
  phases: [               // optional
    { title: 'Scan', detail: '…', model: 'sonnet' },
  ],
  // whenToUse?: '…'
}
// plain JS only — no TS types
// no Date.now / Math.random / bare new Date
```

[script-contract.md](./script-contract.md)

## Primitives

```ts
agent(prompt, {
  label?, phase?, schema?, model?, effort?,
  isolation?: 'worktree', agentType?,
}): Promise<string | object | null>

pipeline(items, stage1, stage2, …): Promise<any[]>
// stage(prev, originalItem, index) — NO barrier between stages

parallel(thunks: Array<() => Promise<any>>): Promise<any[]>
// BARRIER; slots null on error; never rejects

phase(title: string): void
log(message: string): void

args: any
budget: { total: number|null, spent(): number, remaining(): number }

workflow(name | { scriptPath }, args?): Promise<any>
// nest depth 1 only
```

[primitives.md](./primitives.md) · [agent.md](./agent.md) · [concurrency.md](./concurrency.md) · [control-and-io.md](./control-and-io.md)

## Rules of thumb

1. Default multi-stage → **`pipeline`**; barrier only for cross-item merge.  
2. Always **`.filter(Boolean)`** on parallel / nullable agent results.  
3. Prefer **`schema`** for structured handoffs.  
4. Guard budget loops: **`budget.total && budget.remaining() > …`**.  
5. No entropy in scripts (resume safety).  
6. **`isolation: 'worktree'`** only for parallel mutators.  
7. **`log()`** anything a silent cap would hide.  
8. Hybrid: scout → Workflow → synthesize → maybe next phase.  
9. Omit **`model`** unless tier fit is clear.  
10. Dedup open-ended hunts against **`seen`**, not only confirmed.

## Caps (engine)

| Cap | Value |
|---|---|
| Concurrent agents | `min(16, cores-2)` / workflow (queue rest) |
| Lifetime agents | 1000 / run |
| Items / parallel|pipeline | 4096 |
| Nested workflow | depth 1 |
| Budget | hard throw when spent ≥ total |

[limits.md](./limits.md)

## Resume

```js
// stop prior run, then:
Workflow({
  scriptPath,
  resumeFromRunId: runId,
  args: sameArgs,
})
// longest unchanged agent() prefix → cache
// read transcriptDir/journal.jsonl if results look wrong
```

[resume.md](./resume.md)

## Pattern stubs

```js
// adversarial verify
const votes = await parallel(Array.from({ length: 3 }, () => () =>
  agent(`Refute: ${claim}. Default refuted=true if uncertain.`, { schema: V })
))
const ok = votes.filter(Boolean).filter(v => !v.refuted).length >= 2

// loop-until-budget
while (budget.total && budget.remaining() > 50_000) {
  const r = await agent('…', { schema: S })
  /* accumulate */ log(`${budget.remaining()} left`)
}

// canonical review pipeline
await pipeline(
  DIMENSIONS,
  d => agent(d.prompt, { phase: 'Review', schema: F }),
  review => parallel(review.findings.map(f => () =>
    agent(`Verify: ${f.title}`, { phase: 'Verify', schema: V })
      .then(v => ({ ...f, verdict: v }))
  ))
)
```

[patterns.md](./patterns.md)

## Opt-in (must have one)

- User said `ultracode` / session ultracode on  
- User asked for workflow / fan-out / multi-agent orchestration  
- Skill/command requires Workflow  
- Named workflow requested  

Else: single `Agent` or ask.

## Altitude

| Layer | Owns |
|---|---|
| Orchestrator | Intent, graph, schemas, synthesis, user |
| Script | Loops, fan-out, votes, budget stops |
| Workers | Tools, content, optional worktree |
| Engine | Caps, journal, UI, permissions plumbing |

[orchestration.md](./orchestration.md) · [usecases.md](./usecases.md)

## Index

[README](./README.md) · [Architecture](./architecture.md) · [Lifecycle](./lifecycle.md)
