---
name: subagents
description: Delegate focused coding, research, review, or verification work to a bounded DevSpace subagent. Use when a task benefits from separate context, a specialist perspective, or a follow-up with the same worker.
---

# DevSpace subagents

Subagents are optional. Use your normal tools for routine work; delegate only when a separate worker materially helps through independent context, specialization, or follow-up.

Run the `devspace` CLI through your shell tool from the project the subagent should work in (the git root of the current directory). Commands print compact XML fragments by default. Read that output directly. Add `--json` only when a program, not a model, parses the output.

## Choose a target

Discover usable targets instead of guessing names:

```bash
devspace agents targets
```

Each line is one of:

- `<provider name="codex" .../>`: an installed coding agent you can run directly.
- `<profile name="..." provider="...">description</profile>`: a named role (instructions plus provider) defined in `.devspace/agents/` or `~/.devspace/agents/`.
- `<unavailable name="cursor">reason</unavailable>`: a provider that cannot run on this machine, with the reason. Do not use it.
- `<disabled>`: subagents are switched off in the DevSpace config; tell the user instead of retrying.

Pass the `name` as `<profile-or-provider>`. Prefer a matching profile; otherwise use a provider. Keep the default model and effort unless the task needs an override (`--model`, `--effort`).

## Start work

Give the subagent a self-contained brief with the objective, relevant paths, constraints, context it cannot infer, and the expected result. It receives this brief (and its profile instructions), not your conversation.

```bash
devspace agents run <profile-or-provider> "<brief>"
devspace agents run <profile-or-provider> --model <model> --effort <effort> "<brief>"
```

The command returns `<agent id="agt_..." status="running" turn="trn_..."/>` immediately. Keep the id for waiting, inspection, or follow-up. The agent keeps running if your command or session ends.

Add `--request-id <key>` when a retry is possible (a flaky network, a scheduled job). Running again with the same key, project, and arguments returns the existing agent instead of starting a duplicate; the key (letters, digits, `. _ : -`, up to 128 characters) becomes the agent id. The same key with a different brief is an `AGENT_CONFLICT` error.

### Write modes

`--write-mode` limits what the subagent may change:

| Mode | Meaning |
| --- | --- |
| `read_only` | Reads and searches only. Use for review, research, and verification. |
| `allowed` (default) | May edit files inside the project, sandboxed where the provider supports it. |
| `full_access` | No sandbox. Use only when the user explicitly asks for it. |

A follow-up can lower the mode but never raise it. Providers differ in what they can enforce; if one cannot honor a mode, the command fails with an error that says so. Subagents run with the local user's authority, so choose the narrowest mode that fits the task.

## Wait

When you need the result before continuing:

```bash
devspace agents wait <id>
devspace agents wait <id> <id> --timeout 60
```

Without `--timeout` it blocks until every named agent finishes. Many agent hosts cap how long one shell command may run, so always pass `--timeout` (60 to 120 seconds is safe) and call `wait` again while the agent is still running. Do not poll `show` when `wait` can express the dependency.

For a short task, start and wait in one command:

```bash
devspace agents run <profile-or-provider> --wait --timeout 90 "<brief>"
```

On timeout the agent is not stopped; use the printed id to `wait` again.

Completed output is the element text. Failures carry `code` and `retryable` attributes plus a `<cause>` when the provider explained itself. Unfinished work has `status="running" wait="timeout"`.

### Exit codes

`run --wait`, `continue --wait`, and `wait` exit with:

| Code | Meaning |
| --- | --- |
| 0 | completed |
| 1 | command error: bad usage, unknown or unavailable target, workspace conflict, daemon failure |
| 2 | the agent failed |
| 3 | the agent was stopped |
| 4 | the wait timed out; the agent is still running |

With several ids the worst outcome wins: 2, then 3, then 4. Without `--wait`, `run` exits 0 once the agent has started.

## Inspect

```bash
devspace agents show <id>      # immediate snapshot
devspace agents ls             # agents for this project
devspace agents events <id>    # what the current turn did: tool calls, messages, start and end
```

`events --follow` keeps printing until the turn ends. Use it when the user wants to watch progress, not as a substitute for `wait`. Empty `ls` results print nothing.

## Continue or stop

Continue an agent when its existing context helps; start a new one for unrelated work.

```bash
devspace agents continue <id> "<follow-up brief>"
devspace agents wait <id> --timeout 60
```

`continue` accepts the same `--wait`, `--model`, `--effort`, and `--write-mode` options as `run`. Stop work that is no longer needed:

```bash
devspace agents stop <id>
```

Stopping keeps the agent record as `stopped`. Agents are scoped to the project they were started in.

## JSON output

With `--json` every command prints exactly one JSON value on stdout and errors as `{"error":{"code","message","retryable",...}}`. `run` and `continue` print `{id,status,turnId}`; `run --wait` and `show` print `{id,status,turnId,response?|error?|wait?}`; `wait` prints an array of those; `targets` prints `{enabled,targets,unavailable}`. `status` is `running`, `completed`, `failed`, or `stopped`.

## Good uses

- Review a change for correctness, security, or missing tests (`read_only`).
- Investigate a bounded part of a codebase and report findings (`read_only`).
- Implement one isolated change with clear acceptance criteria.
- Run a focused verification pass after other work.
