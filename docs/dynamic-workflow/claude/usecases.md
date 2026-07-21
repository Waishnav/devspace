# Use cases

Workloads that were awkward or unreliable as a single flat agent loop, and how dynamic workflows fit them. Pair with [patterns](./patterns.md) and [orchestration](./orchestration.md).

## Comprehensive code review

**Goal:** High confidence that findings are real before the user acts.

**Shape:**

```text
scout diff → dimensions (security, correctness, tests, perf)
  → (pipeline) per-dimension findings
  → adversarial / multi-lens verify per finding
  → return survivors only
```

**Why workflow:** Verification is not optional prose — it is stages. Vote count scales with “thoroughly audit” vs “any issues.”

**Primitives:** `pipeline`, `parallel`, `schema`, higher `effort` on judges.

---

## Large migrations / refactors

**Goal:** Touch many call sites without stomping edits or losing progress.

**Shape:**

```text
discover sites → pipeline(site → transform → local verify)
  isolation: 'worktree' on mutators
  resume after fixing one stage’s prompt
```

**Why workflow:** One context cannot hold hundreds of site-specific tool traces. Prefix resume avoids redoing finished sites when the transform prompt improves.

**Primitives:** `pipeline`, `isolation: 'worktree'`, `resumeFromRunId`, `log` for skipped tails.

---

## Research & multi-source synthesis

**Goal:** Broad coverage then deep reading then a cited synthesis.

**Shape:**

```text
multi-modal sweep (parallel angles)
  → merge/dedup hits
  → deep-read top sources (pipeline)
  → completeness critic
  → synthesize
```

**Why workflow:** Sweeps are embarrassingly parallel; synthesis needs the merged set (barrier). Budget bounds open-ended browsing.

**Primitives:** `parallel`, barrier merge, `budget`, critic `agent`.

---

## Design exploration

**Goal:** Explore a wide solution space without anchoring on the first idea.

**Shape:**

```text
N drafts from different angles (parallel)
  → score panel (parallel)
  → synthesize winner + graft runners-up
```

**Why workflow:** Single-thread iteration biases early. Independent drafts + structured scores beat one long chat.

**Primitives:** judge panel pattern, `schema` for design objects, high effort on synthesis.

---

## Unknown-size bug / issue hunts

**Goal:** Keep finding until the map is dry, not until an arbitrary count.

**Shape:**

```text
loop-until-dry:
  parallel finders → dedup vs seen → multi-lens judge → accumulate confirmed
```

**Why workflow:** `while (n < 10)` misses the tail; dry rounds + `seen` set converge. Budget optional hard stop.

**Primitives:** loops, `parallel`, `Set` dedup, `budget.total && …`.

---

## Self-repair implementation

**Goal:** Ship a change with independent review pressure, not self-congratulation.

**Shape:**

```text
implement → parallel reviewers (schema findings)
  → repair agent applies real issues
  → verify gates (typecheck/tests)
```

**Why workflow:** Separation of implementer and reviewers; structured findings; deterministic phase order.

**Primitives:** sequential `phase`s, `parallel` reviewers, schema, medium/low effort mix.

**Example skeleton:** [script contract](./script-contract.md).

---

## Heterogeneous agent fleets

**Goal:** Specialists for map / edit / audit under one plan.

**Shape:**

```text
explorer agentType (read-only map)
  → implementer agentType (edits, maybe worktree)
  → reviewer agentType (schema audit)
```

**Why workflow:** `agentType` + model/effort per stage without the user manually jockeying three chats.

**Primitives:** `agentType`, `model`/`effort` overrides, nested `workflow` for reusable specialist packs.

---

## Phased product delivery under ultracode

**Goal:** Maximum exhaustiveness for multi-day product work with human checkpoints.

**Shape:**

```text
turn 1: Understand workflow
turn 2: Design workflow
turn 3: Implement+repair workflow
turn 4: Review/audit workflow
```

**Why workflow:** Standing opt-in; each workflow is a well-scoped fan-out; coordinator synthesizes between turns.

**Primitives:** full stack + [lifecycle](./lifecycle.md) multi-phase.

---

## What this feature deliberately is not

| Not | Because |
|---|---|
| Free-form multi-agent chat room | Workers do not negotiate the plan with each other |
| Silent always-on multi-agent | Cost; requires [opt-in](./opt-in.md) / ultracode |
| Multi-day durable external job system | Resume is session-oriented prefix replay, not external leases |
| Replacement for small tasks | Overhead of scripting + fleet is real; use single Agent or inline tools |

---

## Choosing a shape quickly

| Symptom | Reach for |
|---|---|
| Many independent units | `pipeline` or `parallel` fan-out |
| “I’m not sure we covered it” | multi-modal sweep + completeness critic |
| “Findings feel flaky” | adversarial / multi-lens verify |
| “Solution space is wide” | judge panel |
| “Don’t know how many exist” | loop-until-dry |
| “Parallel edits conflict” | `isolation: 'worktree'` |
| “Reran everything after a prompt tweak” | `resumeFromRunId` + stable prefix |

## Next

- [Cheatsheet](./cheatsheet.md)
- [README index](./README.md)
