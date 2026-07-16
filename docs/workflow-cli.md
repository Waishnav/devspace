# Workflow CLI

DevSpace workflows are durable, single-agent runs intended for shell parent processes. Submission stores an immutable execution snapshot and wakes a detached supervisor. The workflow continues after the submitting shell exits.

## Workspace identity

Every command requires a workspace identity and canonical workspace root. The root must be inside `DEVSPACE_ALLOWED_ROOTS`.

```sh
export DEVSPACE_WORKSPACE_ID="checkout-42"
export DEVSPACE_WORKSPACE_ROOT="$(git rev-parse --show-toplevel)"
export DEVSPACE_ALLOWED_ROOTS="$HOME/src"
```

A workflow ID does not grant access by itself. Status, events, wait, and cancellation must use the same workspace ID and canonical root used at submission.

## Submit and wait

`run --json` writes exactly one versioned JSON object to stdout after the request is durable and supervisor wakeup has been requested.

```sh
accepted="$({
  devspace workflows run reviewer \
    --prompt "Review the current change" \
    --idempotency-key "review-$GITHUB_SHA" \
    --json
})"
workflow_id="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).workflow.id)' "$accepted")"

# The submitting process may exit here. Another process can wait later.
result="$(devspace workflows wait "$workflow_id" --timeout-ms 300000 --after 0 --json)"
status="$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).workflow.status)' "$result")"
```

`wait` is bounded, repeatable, non-destructive, and exits zero when the timeout expires or when the workflow reaches `failed` or `cancelled`. Inspect `timedOut` and `workflow.status` in the JSON response.

The maximum wait timeout is 300000 milliseconds. Use the returned `cursor` with `--after` to replay only newer events:

```sh
devspace workflows events "$workflow_id" --after "$cursor" --json
devspace workflows wait "$workflow_id" --after "$cursor" --timeout-ms 300000 --json
```

## Other commands

```sh
devspace workflows status "$workflow_id" --json
devspace workflows cancel "$workflow_id" --json
```

Cancellation is idempotent. Pending work is cancelled without dispatch; active providers receive cooperative cancellation and process cleanup through their existing provider handles.

## Submission options

```text
--prompt <task>                 required; no positional prompt is accepted
--idempotency-key <key>         optional durable deduplication key
--model <model>                 optional provider model override
--thinking <setting>            optional provider thinking override
--access read_only|workspace_write
--timeout-ms <milliseconds>     optional node execution timeout
```

The persisted snapshot includes the resolved profile body and hash, profile name, provider, model, thinking setting, effective access/environment policy, canonical workspace root, prompt, and timeout. Later profile-file changes do not affect an accepted workflow.

JSON errors use the same versioned envelope and a nonzero exit code. Diagnostics go to stderr; prompts and provider output are never written to diagnostic logs.
