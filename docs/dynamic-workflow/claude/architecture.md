# Architecture

## Three layers

```
User intent
   │
   ▼
┌──────────────────────────────────────────┐
│  1. Coordinator (main session model)     │
│  · talks to user · scouts work-list      │
│  · authors / selects script              │
│  · calls Workflow({ script, args })      │
│  · synthesizes return value for user     │
└───────────────────┬──────────────────────┘
                    │ Workflow tool (async)
                    ▼
┌──────────────────────────────────────────┐
│  2. Workflow engine (JS runtime)         │
│  · parses export const meta              │
│  · runs script in async context          │
│  · hosts agent/pipeline/parallel/…       │
│  · enforces concurrency & agent caps     │
│  · journals each agent() for resume      │
└───────────────────┬──────────────────────┘
                    │ agent() × N
        ┌───────────┼───────────┐
        ▼           ▼           ▼
┌────────────┐ ┌────────────┐ ┌────────────┐
│ Subagent A │ │ Subagent B │ │ Subagent C │
│ own tools  │ │ own tools  │ │ own tools  │
│ optional   │ │ schema /   │ │ worktree / │
│ return     │ │ model /    │ │ agentType  │
│ text|obj   │ │ effort     │ │            │
└────────────┘ └────────────┘ └────────────┘
```

### 1. Coordinator (main loop)

- Owns the conversation with the human.
- Scouts the repo / discovers the work-list *before* orchestration when possible (hybrid default).
- Decides whether Workflow is allowed ([opt-in](./opt-in.md)).
- Authors or selects the script and `args`.
- Receives the script’s return value after completion and narrates / chains the next phase.

The coordinator is the **only** place that should redesign the global plan. Workers execute units; they do not renegotiate the graph with each other.

### 2. Workflow engine

- Not another chat peer. It is a **small concurrent orchestration runtime**.
- Script language: plain JavaScript (not TypeScript).
- Injected APIs only: see [primitives](./primitives.md).
- Progress UI: `/workflows` groups agents by `phase` / `label`.
- Persistence: script path under session directory, `runId`, transcripts, `journal.jsonl`.

### 3. Subagents

- Full tool loops of their own (Read, Bash, Edit, MCP via ToolSearch, …).
- Final text **is** the return value (or a schema-validated object) — not a user-facing essay unless the prompt asks for one.
- Optional isolation (`isolation: 'worktree'`), model, effort, and `agentType` overrides per call.

## Mental model

```js
// Coordinator decides STRUCTURE
Workflow({ script, args })
  → JS engine runs control flow
    → agent(prompt, opts) × N   // workers decide CONTENT
  → script return value
→ coordinator narrates to user
```

| Concern | Who owns it |
|---|---|
| User intent, product judgment | Coordinator |
| Graph shape (fan-out, verify, merge) | Script (authored by coordinator) |
| Tool use, file reads, edits | Subagents |
| Concurrency caps, resume cache, budget hard stop | Engine |
| Permission to multi-agent at all | User (opt-in / ultracode) |

## Hybrid default

You do **not** need the full orchestration shape before starting the *task*. You need it before the *orchestration step*:

1. Scout inline (list files, scope diff, find call sites).
2. Build the work-list in the coordinator context.
3. Call `Workflow` to pipeline over that list.
4. Read the result; optionally chain another workflow for the next phase.

For larger product work, prefer **several well-scoped workflows across turns** over one forever-script.

## What is not a layer

- Workers do not form a free-form multi-agent chat room.
- The script has no filesystem or network — it cannot “just run shell.” Escape is only `agent()` / nested `workflow()`.
- The Workflow tool returns **immediately** (async launch). Completion arrives via task notification; live progress is `/workflows`.

## Next

- [Opt-in & Ultracode](./opt-in.md)
- [Workflow tool API](./workflow-tool.md)
