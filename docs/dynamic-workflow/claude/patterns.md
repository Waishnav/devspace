# Quality patterns

These are **not** extra APIs. They are recipes composed from [`agent`](./agent.md), [`pipeline` / `parallel`](./concurrency.md), [`budget`](./control-and-io.md), and [`log`](./control-and-io.md). Pick by task; compose freely.

## Scale to the ask

| User language | Shape |
|---|---|
| “Find any bugs” | Few finders, single-vote verify |
| “Thoroughly audit” / “be comprehensive” | Larger finder pool, 3–5 vote adversarial pass, synthesis |
| Unsure on research/review/audit | Lean thorough |
| Quick check | Lean brief |

---

## Adversarial verify

Spawn N independent skeptics per claim, each prompted to **REFUTE**. Kill if ≥ majority refute. Prevents plausible-but-wrong findings from surviving.

```js
const votes = await parallel(
  Array.from({ length: 3 }, () => () =>
    agent(
      `Try to refute: ${claim}. Default to refuted=true if uncertain.`,
      { schema: VERDICT, phase: 'Verify', effort: 'high' }
    )
  )
)
const survives =
  votes.filter(Boolean).filter(v => !v.refuted).length >= 2
```

---

## Perspective-diverse verify

When a finding can fail in more than one way, give each verifier a **distinct lens** (correctness, security, perf, does-it-reproduce) instead of N identical refuters. Diversity catches failure modes redundancy cannot.

```js
const lenses = ['correctness', 'security', 'repro']
const votes = await parallel(
  lenses.map(lens => () =>
    agent(`Judge "${desc}" via the ${lens} lens — real?`, {
      schema: VERDICT,
      phase: 'Verify',
      label: `judge:${lens}`,
    })
  )
)
const real = votes.filter(Boolean).filter(v => v.real).length >= 2
```

---

## Judge panel (design)

Generate N independent attempts from different angles (MVP-first, risk-first, user-first). Score with parallel judges. Synthesize from the winner while grafting best ideas from runners-up. Beats single-attempt iteration when the solution space is wide.

```js
const ANGLES = ['mvp-first', 'risk-first', 'user-first']
const drafts = await parallel(
  ANGLES.map(a => () =>
    agent(`Propose a design (${a}). Constraints: ${constraints}`, {
      schema: DESIGN_SCHEMA,
      phase: 'Design',
      label: `draft:${a}`,
    })
  )
).then(xs => xs.filter(Boolean))

const scored = await parallel(
  drafts.map(d => () =>
    agent(`Score this design vs criteria…\n${JSON.stringify(d)}`, {
      schema: SCORE_SCHEMA,
      phase: 'Score',
    })
  )
).then(xs => xs.filter(Boolean))

const winner = pickWinner(drafts, scored)
const synthesis = await agent(
  `Synthesize final design from winner + graft runners-up…`,
  { schema: DESIGN_SCHEMA, phase: 'Synthesize', effort: 'high' }
)
return { winner, synthesis, runnersUp: drafts }
```

---

## Loop-until-dry

Unknown-size discovery (bugs, issues, edge cases): keep spawning finders until **K consecutive rounds** return nothing new. Simple `while (count < N)` misses the tail.

**Critical:** dedup against **all `seen`**, not only `confirmed`. If you only track confirmed, judge-rejected findings reappear every round and the loop never converges.

```js
const seen = new Set()
const confirmed = []
let dry = 0

while (dry < 2) {
  const found = (
    await parallel(
      FINDERS.map(f => () =>
        agent(f.prompt, { phase: 'Find', schema: BUGS })
      )
    )
  )
    .filter(Boolean)
    .flatMap(r => r.bugs)

  const fresh = found.filter(b => !seen.has(key(b)))
  if (!fresh.length) {
    dry++
    log(`dry round ${dry}/2`)
    continue
  }
  dry = 0
  fresh.forEach(b => seen.add(key(b)))
  log(`${fresh.length} fresh findings (${seen.size} seen total)`)

  const judged = await parallel(
    fresh.map(b => () =>
      parallel(
        ['correctness', 'security', 'repro'].map(lens => () =>
          agent(`Judge "${b.desc}" via ${lens} — real?`, {
            phase: 'Verify',
            schema: VERDICT,
          })
        )
      ).then(vs => ({
        b,
        real: vs.filter(Boolean).filter(v => v.real).length >= 2,
      }))
    )
  )

  confirmed.push(...judged.filter(v => v.real).map(v => v.b))
}

return confirmed
```

Combine with [budget](./control-and-io.md#budget) for cost-bounded open-ended hunts:

```js
while (dry < 2 && budget.total && budget.remaining() > 50_000) {
  // …
}
```

---

## Multi-modal sweep

Parallel agents each search a **different way** (by-container, by-content, by-entity, by-time). Each is blind to what the others surface — covers angles one search cannot.

```js
const MODES = [
  { key: 'by-path', prompt: 'Find X by directory layout…' },
  { key: 'by-symbol', prompt: 'Find X by type/symbol names…' },
  { key: 'by-test', prompt: 'Find X by failing or related tests…' },
  { key: 'by-history', prompt: 'Find X by recent git history…' },
]

const sweeps = await parallel(
  MODES.map(m => () =>
    agent(m.prompt, {
      phase: 'Sweep',
      label: `sweep:${m.key}`,
      schema: HITS_SCHEMA,
      effort: 'low',
    })
  )
).then(xs => xs.filter(Boolean))

const merged = dedupe(sweeps.flatMap(s => s.hits))
// then deep-read top hits, then synthesize
```

---

## Completeness critic

A final agent asks what is missing — modality not run, claim unverified, source unread. Output becomes the next work round.

```js
const gaps = await agent(
  `Given work done:\n${JSON.stringify(summary)}\nWhat is missing?`,
  { schema: GAPS_SCHEMA, phase: 'Critic', effort: 'medium' }
)
if (gaps.items.length) {
  log(`critic found ${gaps.items.length} gaps`)
  // feed gaps into another pipeline / loop iteration
}
```

---

## Self-repair implementation loop

Encode a real engineering process as a script:

```text
Implement → multi-reviewer parallel → repair from structured findings → verify gates
```

See the implement/review/repair/verify example in [script contract](./script-contract.md).

Tips:

- Reviewers **read-only**; repair agent owns writes.  
- Structured `FINDINGS` schema forces actionable file/line/fix fields.  
- Final verify re-runs typecheck/tests and reports residual risk.  
- Resume after fixing only the repair prompt if implement+review were good.

---

## Review pipeline (default multi-stage)

Already detailed in [concurrency](./concurrency.md):

```text
dimensions → (per dimension) findings → (per finding) adversarial verify
```

Use barrier+dedup only when verification must see the global merged set first.

---

## No silent caps

If you bound coverage:

```js
const MAX = 40
if (sites.length > MAX) {
  log(`transforming ${MAX}/${sites.length} sites; remainder skipped`)
}
const batch = sites.slice(0, MAX)
```

Silent truncation reads as full coverage.

---

## Compose novel harnesses

The list is not exhaustive. Valid compositions include tournament brackets, staged escalation (cheap finder → expensive judge only on survivors), and multi-phase product delivery under ultracode ([lifecycle](./lifecycle.md)).

## Next

- [Lifecycle & UX](./lifecycle.md)
- [Orchestration altitude](./orchestration.md)
