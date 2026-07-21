# One level above agents

Classic multi-agent demos put several peers in a chat room and hope coordination emerges. Dynamic workflows **invert** that:

> **Coordination is a program** written by a high-capability model.  
> **Workers are replaceable execution units.**

That is “one level above” ordinary agent tool use.

## Split of responsibility

### Orchestrator (main session)

- Understand user intent and constraints  
- Discover the work-list (files, bugs, modules, APIs)  
- Choose pattern (pipeline vs barrier, depth vs breadth)  
- Author the script, schemas, and worker prompts  
- Allocate model / effort tiers per stage  
- Interpret structured returns; decide the next phase  
- Talk to the human; own the correctness narrative  

### Workers (`agent()`)

- Execute one bounded prompt with tools  
- Return raw data or schema-validated objects  
- Stay isolated (optional worktree)  
- Do **not** redesign the global plan  
- May be cheaper/faster models for mechanical stages  
- May be specialized `agentType`s (reviewer, explorer, …)  

### Engine

- Run control flow faithfully  
- Enforce concurrency, agent caps, budget hard stop  
- Journal for resume  
- Present progress UI  

## Why altitude matters

| Problem in a flat agent loop | Workflow fix |
|---|---|
| Plan and tool churn share one context | Workers isolate tool churn; script aggregates returns only |
| Model “forgets” to verify | Verify is a stage in code |
| Fan-out is improvised each turn | Fan-out is `parallel` / `pipeline` |
| Hard to scale thoroughness | Scale fleet size, votes, dry rounds, budget |
| Parallel edits stomp each other | `isolation: 'worktree'` on mutators |

```
User intent
   │
   ▼
┌──────────────────────────────────────────┐
│  Orchestrator model (main session)       │
│  · plans · schemas · phase selection     │
│  · Workflow({ script, args })            │
└───────────────────┬──────────────────────┘
                    │ deterministic JS spine
        ┌───────────┼───────────┐
        ▼           ▼           ▼
   agent()      agent()      agent()
   worker A     worker B     worker C
        │           │           │
        └───────────┼───────────┘
                    ▼
            structured returns
                    │
                    ▼
          orchestrator synthesizes
                    │
                    ▼
              user-facing answer
```

## Model tiering pattern

Keep the **session model strong** for orchestration (authoring scripts, reading results, deciding phases).

Inside the workflow:

| Stage | Typical choice |
|---|---|
| Mechanical map / extract | `effort: 'low'`; optional smaller `model` |
| Default work | **Omit `model`** — inherit session model |
| Hard judges / design | higher `effort`; keep strong model |
| Parallel mutators | same model + `isolation: 'worktree'` |

When unsure about `model`, **omit**. Wrong downgrades are worse than paying full price on a small fleet.

## Structured handoffs

The interface between altitude layers is **data**, not chat:

```js
// worker → script
{ findings: [{ file, line, issue, severity }] }

// script → orchestrator
{ confirmed, dropped, stats }

// orchestrator → user
narrative + residual risk + links to paths
```

Schemas make handoffs machine-checkable. Prefer them at every stage boundary that feeds another stage.

## What the orchestrator must not outsource

- Final user-facing judgment (“is this safe to merge?”) without reading key evidence  
- Opt-in / cost honesty  
- Choosing silent truncation  
- Replacing a missing verification stage with “the workers looked careful”  

Workers can be wrong in correlated ways; adversarial / diverse-lens patterns exist to fight that ([patterns](./patterns.md)).

## Comparison: Agent tool vs Workflow altitude

| | Single `Agent` | `Workflow` |
|---|---|---|
| Altitude | Peer subagent | Programmed fleet under orchestrator |
| Coordination | Prompt prose | Code |
| Resume multi-step graph | Weak | Prefix journal |
| Best for | One bounded digression | Structured multi-agent jobs |

## Enabling “bigger brain, many hands”

Dynamic workflows let you:

1. Put the **expensive reasoning** in graph design and synthesis.  
2. Put the **expensive tokens** in parallel worker contexts that do not pollute each other.  
3. Put the **reliability** in deterministic stages (verify, majority, dry-stop).  
4. Put the **human** at phase boundaries instead of inside every tool call.

That is the product of the feature — not just “more agents.”

## Next

- [Use cases](./usecases.md)
- [Cheatsheet](./cheatsheet.md)
