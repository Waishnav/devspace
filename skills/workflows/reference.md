# Writing DevSpace workflows

A workflow is one JavaScript file. It runs in an isolated QuickJS sandbox with no filesystem, network, `import`,
`require`, or timers: the only capabilities are the primitives below. Save named workflows as
`.devspace/workflows/<name>.js` in the project, or run any file with `devspace workflow run --file <path>`.

## Shape

```js
export const meta = {
  name: "review-auth",
  description: "Review auth changes from two perspectives",
  concurrency: 2,
};

const reviews = await phase("Review", (agent) => parallel(
  [
    { target: "codex", focus: "correctness" },
    { target: "claude", focus: "security" },
  ],
  ({ target, focus }) => agent(`Review the auth diff for ${focus}. Cite files.`, { target, label: focus }),
));

const summary = await phase("Synthesize", (agent) => agent(
  `Merge these reviews into one prioritized list: ${JSON.stringify(reviews)}`,
  { target: "codex", label: "summary" },
));

return { reviews, summary };
```

- The body runs inside an async function: use top-level `await`, and `return` the run's result. The result must be
  JSON-compatible.
- `meta` is optional. When present it must be the first statement, and it is parsed as data, never executed:
  - `name`: string, at most 128 characters (default `"workflow"`).
  - `description`: string, at most 2048 characters.
  - `concurrency`: integer 1–16 (default 4). Caps how many agent calls this run executes at once.
  - Values must be literal single-line strings or numbers. No other fields, expressions, or variables.

## Primitives

| Primitive | Behavior |
| --- | --- |
| `agent(prompt, options)` | Runs one subagent turn and resolves to its final response: a string, or the parsed JSON value when `options.schema` is set. Rejects if the agent fails or stops. |
| `phase(name, (agent) => ...)` | Groups calls under a named phase in the event log. Use the `agent` passed to the callback so each call is tagged with the phase. Resolves to the callback's value. |
| `parallel(items, worker, concurrency?)` | Calls `worker(item, index)` for every item, at most `concurrency` at a time (default `meta.concurrency`, maximum 16). Never rejects: resolves to one `{ status: "completed", value }` or `{ status: "failed", error: { code, message, retryable } }` per item, in input order. |
| `pipeline(items, ...stages)` | Passes each item through the stages in order, calling `stage(value, item, index)` where `value` is the previous stage's result. Items run concurrently like `parallel` and resolve to the same per-item outcomes. |
| `workflow(name, args?)` | Runs another named workflow from `.devspace/workflows/` and resolves to its result. |
| `log(...values)` | Records JSON-compatible progress in the run's event log. |
| `args` | The frozen JSON arguments passed with `--args` or `--args-file`; `{}` when none were passed. |

Because `parallel` and `pipeline` report failures per item instead of rejecting, check `status` before using
`value`:

```js
const results = await parallel(files, (file) => agent(`Summarize ${file}.`, { target: "codex" }));
const summaries = results.filter((r) => r.status === "completed").map((r) => r.value);
const failures = results.filter((r) => r.status === "failed").map((r) => r.error.message);
```

## `agent` options

| Option | Meaning |
| --- | --- |
| `target` | **Required.** A provider or profile name from `devspace agents targets`. |
| `model`, `effort` | Override the target's model or reasoning effort. |
| `label` | Short name shown in `devspace workflow calls`. |
| `schema` | JSON Schema for a structured response (see below). |
| `writeMode` | `"read_only"` or `"allowed"`. Defaults to the run's authority and can never exceed it. |
| `isolation` | `"worktree"`: run this call in its own Git worktree created from committed `HEAD`. |
| `workspace` | A logical name (letters, digits, `_`, `-`; at most 64) that calls in this run share. Never a path. |

Any other option is rejected. Each prompt should be self-contained: a subagent sees only its prompt and the
project, not the rest of the workflow.

### Structured responses

Pass `schema` when a later step consumes the result. DevSpace validates the response, asks the same agent once to
fix invalid JSON (read-only, and it counts toward the turn budget), then resolves to the parsed value.

```js
const { bugs } = await agent("List the bugs in the diff as JSON.", {
  target: "codex",
  schema: {
    type: "object",
    properties: { bugs: { type: "array", items: { type: "string" } } },
    required: ["bugs"],
  },
});
```

Schemas are strict draft-07 with inline structural constraints only: at most 16 KiB, 512 nodes, and 16 levels deep.
`$ref`, `$dynamicRef`, `$recursiveRef`, `$async`, `pattern`, `patternProperties`, and `format` are rejected.

### Edits

Runs are read-only unless started with `devspace workflow run ... --write-mode allowed`. In a writing run, give
editing calls `writeMode: "allowed"`. Add `isolation: "worktree"` when parallel calls might edit the same files, so
each works in its own worktree; isolated worktrees do not see uncommitted changes. Worktrees are kept for
inspection afterwards.

## Resume

`devspace workflow run --resume <id>` reruns the script with the original arguments. Completed read-only calls are
reused as long as the script makes the same calls in the same order with the same prompts and options; from the first
call that differs, everything runs fresh. Runs that made editing calls cannot be resumed. Keep prompts deterministic
(no timestamps or random values) so resume can reuse work.

## Limits

| Boundary | Limit |
| --- | --- |
| Agent turns per run | 128, including schema corrections |
| Nested `workflow()` calls | 8 per run, one level deep |
| Script wall clock | 15 minutes |
| Script source / arguments | 64 KiB / 128 KiB |
| Agent response / run result | 256 KiB |
| `log` and `phase` events | 64 KiB per run |
| Sandbox heap / stack | 32 MiB / 512 KiB |
