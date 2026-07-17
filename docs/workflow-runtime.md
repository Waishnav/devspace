# Restricted JavaScript workflow runtime

DevSpace can run a bounded JavaScript workflow that coordinates the same durable local-agent workflows exposed through CLI and MCP. The script is orchestration code only: provider execution, retries, policy enforcement, worktrees, persistence, and cancellation remain owned by the shared workflow store and supervisor.

## Run a script

```bash
devspace workflows script ./review.workflow.js \
  --args-json '{"topic":"authentication"}' \
  --idempotency-key review-auth-v1 \
  --json
```

The script must be inside the canonical `DEVSPACE_WORKSPACE_ROOT` and use a `.js` or `.mjs` extension. `--args-json` must contain a JSON object. The command emits one versioned JSON envelope and waits for the script to reach a terminal state.

## Script contract

```js
// @devspace-workflow {"version":1,"name":"review","maxAgentCalls":4,"maxConcurrency":2,"timeoutMs":600000}
export default async function ({ agent, parallel, pipeline, phase, log, args, budget }) {
  const reviews = await phase("review", () => parallel([
    () => agent({ target: "security", prompt: `Review ${args.topic}` }),
    () => agent({ target: "tests", prompt: `Test ${args.topic}` })
  ]));

  const summary = await pipeline([
    (items) => agent({
      target: "reviewer",
      prompt: `Synthesize: ${JSON.stringify(items)}`
    })
  ], reviews);

  log("review complete", { workflowId: summary.workflowId });
  return { reviews, summary };
}
```

The optional first non-empty line is strict JSON metadata. Supported fields are:

- `version`: must be `1`.
- `name`: at most 128 characters.
- `description`: at most 1,024 characters.
- `maxAgentCalls`: 1–64; default 16.
- `maxConcurrency`: 1–16; default 4.
- `timeoutMs`: 1–86,400,000; default 15 minutes.

Unknown metadata and `agent()` fields are rejected.

## Primitives

- `agent(options)`: submits one durable local-agent workflow and returns `{ workflowId, status, finalResponse }`. Options support `target`, `prompt`, `model`, `thinking`, `access`, `timeoutMs`, and the existing bounded read-only retry policy.
- `parallel(tasks)`: runs task functions concurrently. Actual agent dispatch remains bounded by `maxConcurrency` and supervisor limits.
- `pipeline(tasks, initialValue)`: awaits task functions in sequence, passing each result to the next task.
- `phase(name, task)`: emits durable `phase.started` and `phase.completed` runtime events.
- `log(message, data)`: emits a bounded durable log event.
- `args`: deeply frozen JSON supplied by `--args-json`.
- `budget`: deeply frozen effective `maxAgentCalls`, `maxConcurrency`, and `timeoutMs` values.

Every `agent()` promise must be awaited, directly or through `parallel`, `pipeline`, or another awaited operation. Returning while calls are outstanding fails the runtime and requests cancellation of active children.

## Isolation and limits

The workflow body runs in a separate Node process with the permission model enabled, an empty environment, no inherited stdio, a 64 MiB old-space limit, and a `vm` context that disables string and WebAssembly code generation. The context does not expose Node APIs, imports, `process`, `require`, ambient environment variables, filesystem, network, database handles, or the orchestrator itself.

Source, arguments, logs, event payloads, results, call counts, concurrency, and wall-clock duration are bounded. Scripts can only cause agent execution through `agent()`.

This is a defense-in-depth boundary for trusted workspace workflow files, not a general-purpose multi-tenant JavaScript hosting service. Keep Node current because the boundary relies on Node's permission model and VM implementation.

## Durability and replay

Runtime runs, events, and each indexed `agent()` call are journaled in SQLite. Reusing an idempotency key with identical source, arguments, metadata, budget, and workspace returns the existing successful result. Reusing it with different input is rejected.

After a failed or interrupted runtime, invoking the same request re-executes the orchestration function from the beginning. A completed call prefix is replayed only when the call index and normalized request hash match exactly; divergence fails closed. In-flight child workflow IDs are reused rather than submitted twice.

Replay does not make arbitrary side effects safe. The restricted runtime intentionally offers no raw filesystem, network, shell, or database primitive. `workspace_write` agents use the workflow scheduler's isolated managed-worktree semantics and are not automatically retried.
