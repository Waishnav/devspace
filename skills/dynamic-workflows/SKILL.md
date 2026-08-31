---
name: dynamic-workflows
description: Create and run resumable multi-agent orchestration with the DevSpace CLI. Use when work needs programmed fan-out, multiple phases, per-item pipelines, structured aggregation, isolated parallel writers, or recovery after a failed workflow; use a direct subagent for one bounded delegation.
---

# DevSpace Dynamic Workflows

Use the DevSpace CLI through the host's shell or process tool. Run commands from the project the workflow should operate on. DevSpace scopes runs to the host workspace when supplied, otherwise to the current Git repository or project directory.

Prefer `--json` from an agent harness: it starts or inspects work without holding one tool call open. Retain the returned workflow id and poll explicitly. Use `--follow` only when streaming output is useful and the shell tool supports a long-running process. Do not combine `--json` and `--follow`.

## Run and inspect

```bash
devspace workflow run --name <name> [--arg key=value]... --json
devspace workflow run --file <path> [--arg key=value]... --json
devspace workflow status <run-id> --json
devspace workflow calls <run-id> --json
devspace workflow call <run-id> <call-index> --json
devspace workflow cancel <run-id> --json
devspace workflow ls --json
```

Named workflows live at `.devspace/workflows/<name>.js`. `--script-path` is an alias for `--file`. `--arg key=value` accepts repeated run inputs through the script's `args` value.

Poll `status --json` until the workflow reaches `completed`, `failed`, or `cancelled`. Use `calls` for the compact child-call list and `call` for one call's prompt, result, or error.

## Write a workflow

The first executable statement must export literal metadata. The script then uses the provided orchestration primitives and returns a JSON-compatible result.

```js
export const meta = {
  name: 'review-auth',
  description: 'Review auth changes from two perspectives',
  phases: [{ title: 'Review' }, { title: 'Synthesize' }],
  concurrency: 2,
}

phase('Review')
const findings = await parallel([
  () => agent('Review the auth diff for correctness.', { label: 'correctness' }),
  () => agent('Review the auth diff for security.', { label: 'security' }),
])

phase('Synthesize')
const summary = await agent(
  `Synthesize these findings: ${JSON.stringify(findings)}`,
  { label: 'summary' },
)

return { findings, summary }
```

Available primitives:

- `agent(prompt, options?)` delegates one bounded task. Options are `label`, `phase`, `schema`, `profile`, `provider`, `model`, `effort`, and `isolation: 'worktree'`. `profile` and `provider` are mutually exclusive.
- `parallel([thunks])` runs independent tasks concurrently and preserves input order. A failed branch produces `null` in its slot.
- `pipeline(items, ...stages)` processes each item through dependent stages; failed item chains produce `null` without stopping unrelated items.
- `phase(title)` and `log(message)` record meaningful progress.
- `workflow(nameOrRef, args?)` composes another named workflow or `{ scriptPath }` one level deep.
- `args` contains values passed with `--arg`.

Use `devspace agents targets --json` before choosing a profile or provider. Prefer profiles for reusable role instructions and defaults. Only pass model or effort overrides when their exact values are already known.

Use `schema` when later workflow steps need typed JSON rather than prose:

```js
const review = await agent('Return the discovered bugs.', {
  schema: {
    type: 'object',
    properties: {
      bugs: { type: 'array', items: { type: 'string' } },
    },
    required: ['bugs'],
  },
})
```

Use `isolation: 'worktree'` for parallel agents that may modify overlapping checkouts. Shared isolation is appropriate for readers or intentionally sequential writers.

Workflow scripts must be replayable: do not use `Date.now()`, `Math.random()`, or `new Date()` without an argument. Pass changing values through `args`.

## Recover a run

Failed and cancelled runs are terminal. Inspect the prior run, fix or replace its script, then create a resumed run:

```bash
devspace workflow status <run-id> --json
devspace workflow calls <run-id> --json
devspace workflow call <run-id> <call-index> --json
devspace workflow run --resume <run-id> --json
devspace workflow run --resume <run-id> --file <updated-script> --json
```

Keep completed calls' prompts and options stable when their results should be reused. Resume reuses the unchanged successful prefix and executes from the first call that failed, changed, or cannot be reused.

A completed `isolation: 'worktree'` call cannot be reused because its checkout is not restored. When resume reaches one, that call and every later call execute again, even if their inputs are unchanged. Do not assume mutations from the prior isolated checkout are present in the resumed run.

## Good uses

- Fan out a change review across correctness, security, and tests, then synthesize it.
- Analyze many files with the same staged pipeline.
- Run parallel implementations in isolated worktrees and compare their results.
- Encode a repeatable migrate, review, and verify sequence.
