---
name: subagents
description: Delegate focused coding, research, review, or verification work to a bounded DevSpace subagent. Use when a task benefits from separate context, a specialist perspective, or a follow-up with the same worker.
---

# DevSpace subagents

Use the DevSpace CLI through the shell or process tool. Run commands from the project the subagent should work on.

## Choose a target

Discover usable targets instead of guessing names:

```bash
devspace agents targets --json
```

Configured profiles include a description and may define provider, model, effort, and task instructions. Choose a matching profile when one fits. Use a provider target when no profile fits or a specific provider is needed.

Usually rely on the target's configured model and effort. Pass `--model` or `--effort` only with a value supported by that provider. DevSpace passes these values through without translating them between providers.

## Start work

Give the subagent a self-contained brief. Include the objective, relevant paths, constraints, decisions it needs from the current conversation, and the expected result. The subagent receives the brief and its profile instructions, not the parent conversation.

```bash
devspace agents run <profile-or-provider> "<brief>" --json
devspace agents run <profile-or-provider> --model <model> --effort <effort> "<brief>" --json
```

The result contains a DevSpace agent `id` and its current status. Execution continues independently, so retain the ID for later inspection or follow-up.

## Inspect and continue

```bash
devspace agents show <id> --json
devspace agents continue <id> "<follow-up brief>" --json
devspace agents ls --json
```

- `show` waits briefly for active work, then returns the current status and any
  available response or error.
- `continue` gives the same subagent another turn with its existing provider
  session and context.
- `ls` returns sessions belonging to the current project.

Run `devspace agents show <id> --json` again later while the status is `running`.
`completed` includes the response. `failed` includes a structured error, and
`stopped` is terminal without a successful response. Continue an agent when its
existing context is useful; start another agent for unrelated work.

## Good uses

- Review a change for correctness, security, or missing tests.
- Investigate a bounded part of a codebase and report findings.
- Implement one isolated change with clear acceptance criteria.
- Run a focused verification pass after other work.
