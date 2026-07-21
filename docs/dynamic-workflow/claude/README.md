# Claude Code Dynamic Workflows

In-depth reference for Claude Code’s **dynamic workflow** system: the model-facing `Workflow` tool, the JavaScript script contract, every primitive injected into the script, resume/budget semantics, quality patterns, and how this enables a stronger model to orchestrate subagents one level above ordinary tool use.

| Document | Contents |
|---|---|
| [Architecture](./architecture.md) | Three layers, control flow vs worker content, mental model |
| [Opt-in & Ultracode](./opt-in.md) | When the model may call Workflow; standing multi-agent mode |
| [Workflow tool API](./workflow-tool.md) | Tool inputs, return envelope, launch/iterate/named workflows |
| [Script contract](./script-contract.md) | `export const meta`, language rules, determinism bans |
| [Primitives overview](./primitives.md) | Map of all script hooks |
| [agent()](./agent.md) | Spawn API, schema, model/effort, worktree, agentType |
| [pipeline() & parallel()](./concurrency.md) | No-barrier default vs barrier; when each is correct |
| [phase, log, args, budget, workflow()](./control-and-io.md) | Progress UX, parameterization, token ceiling, nesting |
| [Limits & sandbox](./limits.md) | Concurrency caps, agent caps, script isolation |
| [Resume & journal](./resume.md) | `resumeFromRunId`, cache identity, `journal.jsonl` |
| [Quality patterns](./patterns.md) | Adversarial verify, judge panel, loop-until-dry, … |
| [Lifecycle & UX](./lifecycle.md) | Permission, `/workflows`, notifications, multi-phase |
| [One level above](./orchestration.md) | Bigger brain orchestrates smaller hands |
| [Use cases](./usecases.md) | Review fleets, migrations, research, self-repair |
| [Cheatsheet](./cheatsheet.md) | One-page API card |

Related: standalone HTML overview at [`docs/claude-code-dynamic-workflows.html`](../../claude-code-dynamic-workflows.html).

---

## One-sentence thesis

**Deterministic control flow + stochastic workers + one orchestrator brain.**

A single agent loop confuses *what to do next* with *how to do the work*. Dynamic workflows split them: the orchestrator model authors a short plain-JS script; the harness runs loops, conditionals, and fan-out as **code**; only `agent()` escapes into a model with tools.

## Why it exists

| Without workflows | With workflows |
|---|---|
| Fan-out is ad-hoc tool spam each turn | Fan-out is `parallel` / `pipeline` in a script |
| Verification is optional and forgettable | Verification is a stage in the graph |
| One context holds plan + all tool churn | Workers isolate tool churn; script aggregates returns |
| Scale = longer single conversation | Scale = fleet size × stages under budget |

## Scope of this doc set

- **In scope:** model-facing API as exposed by Claude Code ~2.1.x (`Workflow` / `RunWorkflow` tool, script primitives, opt-in, resume, budget, patterns).
- **Out of scope:** Anthropic product marketing, undocumented internal harness code, DevSpace’s separate durable workflow engine (see feature branches / other docs if present).

Source basis: Claude Code Workflow tool description, session `workflows/scripts/*.js` examples, and engine rules encoded in the tool prompt (opt-in, ultracode, resume, concurrency).
