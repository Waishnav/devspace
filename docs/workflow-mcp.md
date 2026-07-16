# Durable workflow MCP tools

DevSpace exposes durable local-agent workflows when subagents are enabled (`DEVSPACE_SUBAGENTS=1`). Workflow execution is owned by the DevSpace process and its detached supervisor, not by an individual MCP transport. Closing or reconnecting an MCP session does not cancel submitted work.

## Tools

All tools require `workspaceId`. A workflow ID alone is never authorization: the workflow must belong to the same workspace ID and current canonical workspace root.

### `workflow_run`

Submit either one local agent or a versioned DAG.

Single-agent example:

```json
{
  "workspaceId": "ws_...",
  "target": "reviewer",
  "prompt": "Review the authentication changes",
  "access": "read_only",
  "timeoutMs": 120000,
  "retry": {
    "maxAttempts": 2,
    "retryOn": ["provider_failed"],
    "backoffMs": 1000
  },
  "idempotencyKey": "auth-review-v1"
}
```

DAG example:

```json
{
  "workspaceId": "ws_...",
  "dag": {
    "version": 1,
    "access": "read_only",
    "maxConcurrency": 3,
    "nodes": [
      { "key": "tests", "target": "qa", "prompt": "Run focused tests" },
      { "key": "security", "target": "reviewer", "prompt": "Audit security" },
      { "key": "summary", "target": "claude", "prompt": "Synthesize the findings" }
    ],
    "edges": [
      { "from": "tests", "to": "summary" },
      { "from": "security", "to": "summary" }
    ]
  }
}
```

The DAG is rejected before persistence when it exceeds 64 nodes or 256 edges, uses duplicate or unsafe keys, references missing endpoints, contains duplicate edges or a cycle, requests an unsupported target or access mode, or exceeds timeout/retry/concurrency bounds.

### `workflow_status`

Returns the current redacted run and node states.

### `workflow_wait`

Waits for at most 300 seconds and returns the latest state. A timeout is not cancellation and does not destroy the result; callers may wait again.

### `workflow_events`

Reads ordered lifecycle events using an `after` cursor and a limit of at most 1,000. MCP event projections omit prompts, roots, profile bodies, environment data, claim tokens, process IDs, leases, and provider session IDs.

### `workflow_cancel`

Durably requests cancellation. Repeated requests are idempotent. Ready and pending nodes are terminalized, while active provider handles receive cancellation through the supervisor.

## Scheduling semantics

- Ready nodes are selected fairly across runs using persisted last-dispatch order.
- Both a process-wide supervisor limit and each run's persisted `maxConcurrency` are enforced.
- A node becomes ready only after all predecessors succeed.
- Exhausted failure skips unopened dependents and cancels active siblings.
- A run succeeds only after every node succeeds or is validly skipped; failures and user cancellation converge deterministically.
- Claims and heartbeats are lease-fenced. Stale attempts cannot append events or complete a replacement attempt.

## Retry semantics

Retries are opt-in and default to one attempt. Only `provider_failed` and `timed_out` may be configured as retryable. Each retry creates a new durable attempt and emits `node.retry_scheduled`.

Automatic retries are limited to `read_only` nodes. DevSpace does not retry worker-loss/unknown-outcome failures or `workspace_write` side effects automatically.

## Worktree isolation

Every `workspace_write` attempt receives a unique detached Git worktree at the base SHA pinned when the workflow was submitted.

- Changes are never merged, copied, committed, rebased, cherry-picked, pushed, or applied to the source checkout automatically.
- A successful attempt is durably completed before guarded cleanup.
- Failed or cancelled attempt worktrees are preserved for diagnosis with a seven-day retention timestamp.
- Cleanup verifies managed-root containment, persisted workflow/node/attempt ownership, Git worktree registration, and the expected base SHA. A failed verification preserves the directory and records `cleanup_failed`; there is no unverified recursive-delete fallback.
- Dependent nodes do not automatically inherit predecessor filesystem changes. Handoffs must use durable results/artifacts rather than an implicit shared working tree.

## CLI compatibility

Existing `devspace workflows run|status|wait|events|cancel` commands use the same submission snapshots and durable store. MCP and CLI can observe the same workflow when they use the same workspace ID and root. The CLI remains the shell-compatible fallback for parent harnesses that cannot call MCP tools directly.
