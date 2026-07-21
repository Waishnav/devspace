# `agent()`

The only primitive that spends model/tool budget on real work. Everything else in the script is control flow, UX, or nesting.

## Signature

```ts
agent(
  prompt: string,
  opts?: {
    label?: string
    phase?: string
    schema?: object          // JSON Schema
    model?: string           // e.g. session model ids / 'sonnet' | 'opus' | 'haiku'
    effort?: 'low' | 'medium' | 'high' | 'xhigh' | 'max'
    isolation?: 'worktree'
    agentType?: string       // registry name: 'general-purpose', 'code-reviewer', 'claude', …
  }
): Promise<any>
```

## Return value

| Mode | Resolves to |
|---|---|
| No `schema` | Final assistant text (`string`) |
| With `schema` | **Validated object** matching the JSON Schema (StructuredOutput tool; model retries on mismatch) |
| User skip / terminal API death after retries | `null` |

Always treat results as possibly null when fan-out is large:

```js
const rows = (await parallel(tasks)).filter(Boolean)
```

## Semantics

1. Spawns a **subagent** with its own tool loop (Read, Bash, Edit, …).  
2. Subagents are instructed that their **final text/object is the return value** to the coordinator script — not a user-facing message.  
3. Prompt should be **self-contained**: workers do not inherit the full main-session transcript.  
4. Session-connected **MCP tools** are reachable via ToolSearch (on-demand schemas). Interactively authenticated MCP may be missing in headless/cron.  
5. Errors in the agent path surface as `null` for that call in combinators that swallow rejections; check journals if results look empty ([resume](./resume.md)).

## Options

### `label`

Short string for `/workflows` progress UI (e.g. `review:security`, `verify:src/auth.ts`). Does not affect model behavior.

### `phase`

Explicit progress group assignment. **Prefer this inside `pipeline` / `parallel` stages** to avoid races on the global `phase()` state. Same string → same group box. Should match titles in `meta.phases` when you want tidy UI.

### `schema`

JSON Schema object. Forces structured output:

- Validation at the tool-call layer.  
- `agent()` returns the object — no `JSON.parse` of prose.  
- Composes with `agentType` (StructuredOutput instruction is appended to that agent’s system prompt).

Example:

```js
const FINDINGS = {
  type: 'object',
  properties: {
    findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          file: { type: 'string' },
          line: { type: 'integer' },
          issue: { type: 'string' },
          severity: { type: 'string', enum: ['critical', 'high', 'medium', 'low'] },
        },
        required: ['file', 'line', 'issue', 'severity'],
        additionalProperties: false,
      },
    },
    summary: { type: 'string' },
  },
  required: ['findings', 'summary'],
  additionalProperties: false,
}

const result = await agent(
  'Review auth changes for session fixation. Read-only. Cite file:line.',
  {
    label: 'review:auth',
    phase: 'Review',
    schema: FINDINGS,
    effort: 'medium',
  }
)
// result.findings is already shaped
```

### `model`

Override the model for this call.

- **Default: omit** — inherit the main-loop / session model (almost always correct).  
- Set only when you are confident a different tier fits (e.g. small model for mechanical map, large for hard judge).  
- When unsure, omit.

### `effort`

Reasoning effort for this call: `'low' | 'medium' | 'high' | 'xhigh' | 'max'`.

- Omit → inherit session effort.  
- Use `'low'` for cheap mechanical stages (enumerate files, simple extract).  
- Reserve higher tiers for hard verify / judge / design stages.

### `isolation: 'worktree'`

Runs the agent in a **fresh git worktree**.

| Property | Detail |
|---|---|
| Cost | Expensive (~200–500ms setup + disk) per agent |
| When | **Only** when agents **mutate files in parallel** and would otherwise conflict |
| Cleanup | Auto-removed if unchanged |
| When not | Read-only review, single writer, sequential pipeline of mutators on one tree |

### `agentType`

Custom subagent from the **same registry as the Agent tool** (e.g. `general-purpose`, `code-reviewer`, `Explore`, project-defined types, or `claude` where configured).

- Overrides the default workflow subagent personality/tools policy for that call.  
- Composes with `schema`.

## Prompting workers well

Workers start with **only** the prompt you pass (+ profile/system for `agentType`). Patterns:

**Implementation**

```text
Goal: …
Context: …
Relevant files: …
Acceptance criteria:
- …
Rules:
- Keep changes focused
- Do not unrelated-refactor
- Report blockers clearly
```

**Read-only investigation**

```text
Question: …
Scope: …
Rules:
- Do not modify files
- Cite paths and symbols
- Separate facts from guesses
```

**Structured judge / refuter**

```text
Try to REFUTE: <claim>
Default to refuted=true if uncertain.
Return only via the schema fields.
```

Pass prior stage data by **embedding it in the prompt** (stringified structured JSON), not by shared mutable state — scripts have no shared worker memory beyond what you thread through returns.

## Cost & altitude tips

| Stage kind | Typical opts |
|---|---|
| Enumerate / map / extract | `effort: 'low'`, maybe smaller `model` |
| Implement / edit | inherit model; medium effort; `isolation: 'worktree'` if parallel |
| Review dimension | schema + medium effort |
| Adversarial judge | higher effort; schema; independent prompts |
| Final verify gates | low/medium; focused prompt |

The orchestrator stays high-altitude by keeping **structure** in the script and **content** in workers. See [orchestration](./orchestration.md).

## Null and failure hygiene

```js
const reviews = await parallel([
  () => agent(p1, { schema: FINDINGS }),
  () => agent(p2, { schema: FINDINGS }),
  () => agent(p3, { schema: FINDINGS }),
]).then(xs => xs.filter(Boolean))

if (!reviews.length) {
  log('all reviewers failed or were skipped')
  return { confirmed: [], error: 'no_reviews' }
}
```

Before claiming “workflow returned empty,” read `transcriptDir/journal.jsonl` — cached or failed agents may explain it ([resume](./resume.md)).

## Next

- [pipeline & parallel](./concurrency.md)
- [Patterns](./patterns.md)
